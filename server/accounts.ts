import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { App, DbUser, Env } from "./types";
import { now, uid, MINUTE } from "./types";
import { dbFailure, json } from "./db";
import { allowance } from "./billing";
import { defer, rate, sha, token } from "./security";
import { siteUrl } from "./config";
import { encryptionReady, seal } from "./crypto";
import { planById } from "../shared/plans";
import { isPlatform, platformIds, platforms, type PlatformId } from "../shared/social";
import { socialPlatforms, SocialError } from "./social";
import { codeVerifier } from "./social/http";
import { tiktokDrafts } from "./social/tiktok";
import { connectionExpiry, revokeAccess } from "./social/credentials";
import { STATS_WINDOW } from "./metrics";
import { isAdmin } from "./auth";

// Connecting social accounts with OAuth, listing and disconnecting them. Tokens are sealed with TOKEN_ENCRYPTION_KEY
// and never leave the server.

export const accounts = new Hono<App>();
const STATE_TTL = 10 * MINUTE;

const ready = (env: Env, platform: PlatformId) => encryptionReady(env) && socialPlatforms[platform].configured(env);
/**
 * Whether this person may connect the network: administrators always (to try it before launch), everyone else once it
 * is listed in SOCIAL_OPEN (comma-separated platform IDs). Until then people see "Coming soon".
 */
export function linkable(env: Env, user: DbUser, platform: PlatformId) {
  if (isAdmin(env, user)) return true;
  return (env.SOCIAL_OPEN || "").toLowerCase().split(",").map((s) => s.trim()).includes(platform);
}
const redirectUri = (env: Env, request: Request, platform: PlatformId) => `${siteUrl(env, request)}/api/accounts/callback/${platform}`;

/** The account limit of the user's plan, and how many accounts they have connected. */
async function limits(env: Env, user: App["Variables"]["user"]) {
  const plan = planById((await allowance(env, user)).plan);
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM social_accounts WHERE user_id=?").bind(user.id).first<{ n: number }>();
  return { max: plan.accounts as number, used: Number(row?.n) || 0 };
}

accounts.get("/", async (c) => {
  const user = c.get("user");
  const t = now();
  const rows = await c.env.DB.prepare(
    "SELECT id,platform,name,handle,avatar_url,status,expires_at,created_at FROM social_accounts WHERE user_id=? ORDER BY created_at",
  ).bind(user.id).all<any>();
  return c.json({
    accounts: rows.results.map((a) => ({
      id: a.id,
      platform: a.platform,
      name: a.name,
      handle: a.handle,
      avatarUrl: a.avatar_url,
      // A connection that ended is shown as expired even before maintenance or a publish notices.
      status: a.status === "active" && a.expires_at && a.expires_at < t ? "expired" : a.status,
      createdAt: a.created_at,
    })),
    // soon: not open to this person yet ("Coming soon"); drafts: videos arrive in the person's TikTok inbox for them to
    // post (server/social/tiktok.ts).
    platforms: platformIds.map((id) => ({
      id, name: platforms[id].name, configured: ready(c.env, id), soon: !linkable(c.env, user, id), drafts: id === "tiktok" && tiktokDrafts(c.env),
    })),
    limit: await limits(c.env, user),
  });
});

accounts.post("/connect", async (c) => {
  const user = c.get("user");
  const d = z.object({ platform: z.enum(platformIds), back: z.string().regex(/^\/app\/[a-z0-9/-]{0,80}$/).optional() }).parse(await c.req.json());
  if (!linkable(c.env, user, d.platform)) throw new HTTPException(403, { message: `Posting to ${platforms[d.platform].name} is coming soon.` });
  const { max, used } = await limits(c.env, user);
  if (max <= 0) throw new HTTPException(402, { message: "Connecting social accounts needs a plan." });
  if (used >= max) {
    // At the limit, an account that needs reconnecting can still be renewed (the callback allows no new ones).
    const renewable = await c.env.DB.prepare("SELECT 1 FROM social_accounts WHERE user_id=? AND platform=? AND (status!='active' OR expires_at<?)")
      .bind(user.id, d.platform, now()).first();
    if (!renewable) throw new HTTPException(402, { message: `Your plan includes ${max} social account${max === 1 ? "" : "s"}. Disconnect one or upgrade to connect more.` });
  }
  if (!ready(c.env, d.platform))
    throw new HTTPException(503, { message: encryptionReady(c.env) ? `Connecting ${platforms[d.platform].name} is not available yet.` : "Social publishing is not set up yet." });
  await rate(c, "social-connect", 30, 3600, user.id);
  const state = token(), verifier = codeVerifier();
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM oauth_states WHERE expires_at<?").bind(now()),
    c.env.DB.prepare("INSERT INTO oauth_states(state_hash,user_id,platform,verifier,back,expires_at) VALUES (?,?,?,?,?,?)")
      .bind(await sha(state), user.id, d.platform, verifier, d.back || "/app/channels", now() + STATE_TTL),
  ]);
  const url = await socialPlatforms[d.platform].authorizeUrl(c.env, { state, redirectUri: redirectUri(c.env, c.req.raw, d.platform), codeVerifier: verifier });
  return c.json({ url });
});

/** Where the browser lands after the network's consent screen (the page the connection started from); only short codes go into the URL. */
function back(page: string | null, outcome: Record<string, string>) {
  const path = page && /^\/app\/[a-z0-9/-]{0,80}$/.test(page) ? page : "/app/channels";
  return `${path}?${new URLSearchParams(outcome)}`;
}
function errorCode(e: unknown) {
  if (!(e instanceof SocialError)) return "failed";
  if (e.code === "PERMISSION") return "permissions";
  if (e.code === "NO_CHANNEL") return "no_channel";
  if (e.code === "NOT_CONFIGURED") return "unavailable";
  if (e.code === "AUTH_EXPIRED") return "expired";
  return "failed";
}

// A top-level navigation from the network (GET; the Lax session cookie is sent). The state is single-use, short-lived
// and bound to the user who started the connection.
accounts.get("/callback/:platform", async (c) => {
  const user = c.get("user");
  const platform = c.req.param("platform");
  const state = c.req.query("state") || "";
  if (!isPlatform(platform)) return c.redirect(back(null, { error: "failed" }), 302);
  const row = /^[0-9a-f]{64}$/.test(state)
    ? await c.env.DB.prepare("DELETE FROM oauth_states WHERE state_hash=? RETURNING *").bind(await sha(state)).first<any>()
    : null;
  if (!row || row.user_id !== user.id || row.platform !== platform || row.expires_at < now())
    return c.redirect(back(row?.user_id === user.id ? row.back : null, { error: "expired" }), 302);
  const page: string = row.back;
  // Declined on the consent screen (or the network reported another problem).
  if (c.req.query("error") || !c.req.query("code")) return c.redirect(back(page, { error: "denied" }), 302);
  try {
    if (!ready(c.env, platform)) return c.redirect(back(page, { error: "unavailable" }), 302);
    const { tokens, profile } = await socialPlatforms[platform].exchange(c.env, {
      code: c.req.query("code")!,
      redirectUri: redirectUri(c.env, c.req.raw, platform),
      codeVerifier: row.verifier,
    });
    const existing = await c.env.DB.prepare("SELECT id FROM social_accounts WHERE user_id=? AND platform=? AND external_id=?")
      .bind(user.id, platform, profile.externalId).first();
    if (!existing) {
      const { max, used } = await limits(c.env, user);
      if (used >= max) return c.redirect(back(page, { error: "limit" }), 302);
    }
    const t = now();
    const text = (s: string | undefined, max: number) => (s ? s.replace(/[\p{Cc}]/gu, "").trim().slice(0, max) || null : null);
    const avatar = profile.avatarUrl && /^https:\/\//.test(profile.avatarUrl) && profile.avatarUrl.length <= 2000 ? profile.avatarUrl : null;
    await c.env.DB.prepare(
      `INSERT INTO social_accounts(id,user_id,platform,external_id,name,handle,avatar_url,credentials,expires_at,status,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,'active',?,?)
       ON CONFLICT(user_id,platform,external_id) DO UPDATE SET name=excluded.name,handle=excluded.handle,avatar_url=excluded.avatar_url,
         credentials=excluded.credentials,expires_at=excluded.expires_at,status='active',updated_at=excluded.updated_at`,
    ).bind(
      uid(), user.id, platform, profile.externalId.slice(0, 200), text(profile.name, 100) || platforms[platform].name,
      text(profile.handle, 100), avatar, await seal(c.env, tokens), connectionExpiry(platform, tokens), t, t,
    ).run();
    // A reconnection may grant the stats scopes: its recent posts are read again on the next stats pass (and stop
    // asking to reconnect at once).
    await c.env.DB.prepare(
      "UPDATE publications SET metrics_checked_at=NULL,metrics_error=NULL WHERE status='published' AND published_at>? AND account_id=(SELECT id FROM social_accounts WHERE user_id=? AND platform=? AND external_id=?)",
    ).bind(t - STATS_WINDOW, user.id, platform, profile.externalId.slice(0, 200)).run();
    return c.redirect(back(page, { connected: platform }), 302);
  } catch (e) {
    console.warn("Social account connection failed", { platform, code: e instanceof SocialError ? e.code : e instanceof Error ? e.name : "Error" });
    return c.redirect(back(page, { error: errorCode(e) }), 302);
  }
});

accounts.delete("/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const account = await c.env.DB.prepare("SELECT id,platform,credentials FROM social_accounts WHERE id=? AND user_id=?").bind(id, user.id)
    .first<{ id: string; platform: PlatformId; credentials: string }>();
  if (!account) throw new HTTPException(404, { message: "Social account not found." });
  // Posts still scheduled to it are cancelled and series stop posting to it; published history stays (its account
  // becomes "disconnected"). The account_busy trigger refuses while a video is being published to it.
  const using = (await c.env.DB.prepare("SELECT id,settings FROM series WHERE user_id=? AND settings LIKE ?").bind(user.id, `%${id}%`).all<{ id: string; settings: string }>()).results;
  const t = now();
  try {
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE publications SET status='canceled',updated_at=? WHERE account_id=? AND status='scheduled'").bind(t, id),
      c.env.DB.prepare("DELETE FROM social_accounts WHERE id=? AND user_id=?").bind(id, user.id),
      ...using.map((s) => {
        const settings = json<any>(s.settings, {});
        if (Array.isArray(settings.accounts)) settings.accounts = settings.accounts.filter((x: unknown) => x !== id);
        return c.env.DB.prepare("UPDATE series SET settings=?,updated_at=? WHERE id=?").bind(JSON.stringify(settings), t, s.id);
      }),
    ]);
  } catch (e) {
    dbFailure(e);
  }
  await defer(c, revokeAccess(c.env, account));
  return c.json({ ok: true });
});
