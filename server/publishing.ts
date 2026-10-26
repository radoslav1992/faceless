import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { App, Env } from "./types";
import { DAY, HOUR, MINUTE, now, uid } from "./types";
import { json, ownedVideo } from "./db";
import { safeEqual, token } from "./security";
import { isPlatform, KIDS_QUESTION, platforms, type PlatformId } from "../shared/social";
import { LATE_GRACE, seriesSettingsSchema } from "../shared/series";
import { failureMessage } from "./social";
import { accountLabel, freshTokens, markExpired, type AccountRow } from "./social/credentials";
import { unfit, type VideoRow } from "./social/post";

// Posting made videos on connected accounts: now, at a chosen time, or — for a series' episodes — at their slot. The
// cron hands due publications to the Publication workflow (publish-workflow.ts) once their video is ready.

export const publishing = new Hono<App>();
/** Capability links the networks fetch media from (no session; publications.token). */
export const publishMedia = new Hono<{ Bindings: Env }>();

/** The earliest and latest a video can be scheduled, from now. */
const LEAD = MINUTE, HORIZON = 180 * DAY;
/** A media link works this long after the publication was claimed. */
const LINK_TTL = 24 * HOUR;
/** A publication 'publishing' this long is given up (the workflow polls for at most about an hour). */
const STUCK = 2 * HOUR;
/** A scheduled video still being made this long after its last change is given up (an edit's render that never finished). */
const WAIT_FOR_RENDER = 6 * HOUR;
const BATCH = 25;

const id = z.string().regex(/^[0-9a-f-]{36}$/i);
const atSchema = z.number().int().positive();

function checkTime(at: number) {
  const t = now();
  if (at < t + LEAD || at > t + HORIZON) throw new HTTPException(400, { message: "Pick a time at least a minute from now and within the next 180 days." });
}
/** Accounts by ID, owned by the user; missing ones are left out. */
async function accountsById(env: Env, userId: string, ids: string[]) {
  if (!ids.length) return [];
  const rows = await env.DB.prepare(`SELECT * FROM social_accounts WHERE user_id=? AND id IN (${ids.map(() => "?").join(",")})`)
    .bind(userId, ...ids).all<AccountRow>();
  return rows.results;
}
/** How the posts go out: privately, and the creator's answer to YouTube's "made for kids" (null: not given). */
type PostOptions = { private: boolean; madeForKids: boolean | null };
/** One 'scheduled' publication per account; with `ignoreDuplicates`, one already scheduled or published is skipped. */
async function insertPublications(env: Env, video: VideoRow, accounts: AccountRow[], at: number, ignoreDuplicates: boolean, o: PostOptions) {
  const t = now();
  const created = accounts.map((a) => ({ id: uid(), account: a }));
  const kids = o.madeForKids === null ? null : o.madeForKids ? 1 : 0;
  const statements = created.map(({ id, account }) =>
    env.DB.prepare(`INSERT ${ignoreDuplicates ? "OR IGNORE " : ""}INTO publications(id,user_id,video_id,account_id,account_name,platform,scheduled_at,private,made_for_kids,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,'scheduled',?,?)`)
      .bind(id, video.user_id, video.id, account.id, accountLabel(account), account.platform, at, o.private ? 1 : 0, account.platform === "youtube" ? kids : null, t, t));
  try {
    const results = await env.DB.batch(statements);
    return created.filter((_, i) => (results[i] as any)?.meta?.changes !== 0).map((c) => c.id);
  } catch (e) {
    if (String((e as Error)?.message || e).includes("UNIQUE"))
      throw new HTTPException(409, { message: "This video is already scheduled or published on one of these accounts." });
    throw e;
  }
}
/** A publication with its account (and its stats from the network, once read), as the browser sees it. */
const SELECT_PUBLICATION =
  "SELECT p.id,p.video_id AS videoId,p.account_id AS accountId,p.platform,p.scheduled_at AS scheduledAt,p.status,p.private,p.draft,p.attempts,p.url,p.external_id AS externalId,p.error,p.published_at AS publishedAt,p.views,p.likes,p.comments,p.shares,p.saves,p.metrics_at AS metricsAt,COALESCE(a.name,NULLIF(p.account_name,''),'Disconnected account') AS accountName,a.handle AS accountHandle FROM publications p LEFT JOIN social_accounts a ON a.id=p.account_id";

/** Why an account cannot take this video now, or null. */
function refusal(a: AccountRow, video: VideoRow, privately: boolean) {
  if (a.status !== "active" || (a.expires_at && a.expires_at < now())) return `Reconnect your ${platforms[a.platform].name} account (${a.name}) first.`;
  if (privately && a.platform === "instagram") return "Instagram can't post privately. Leave it out, or post publicly.";
  return unfit(video, a.platform);
}
/** Posts a ready video to accounts: now (in a minute) or at `at`. Approves an episode still waiting for review. */
publishing.post("/videos/:id/publish", async (c) => {
  const user = c.get("user");
  const body = z.object({
    accountIds: z.array(z.uuid()).min(1).max(30), at: atSchema.optional(), private: z.boolean().default(false),
    /** YouTube's audience question, required when posting to YouTube. */
    madeForKids: z.boolean().optional(),
  }).parse(await c.req.json());
  const video: VideoRow = await ownedVideo(c.env, user.id, c.req.param("id"));
  if (video.render_status !== "ready") throw new HTTPException(409, { message: "This video is still being made. Post it when it's ready." });
  const ids = [...new Set(body.accountIds)];
  const accounts = await accountsById(c.env, user.id, ids);
  if (accounts.length !== ids.length) throw new HTTPException(404, { message: "Social account not found." });
  for (const a of accounts) {
    const problem = refusal(a, video, body.private);
    if (problem) throw new HTTPException(409, { message: problem });
  }
  if (body.madeForKids === undefined && accounts.some((a) => a.platform === "youtube"))
    throw new HTTPException(400, { message: `Say whether this video is made for kids. ${KIDS_QUESTION}` });
  const at = body.at ?? now() + LEAD;
  checkTime(at);
  const created = await insertPublications(c.env, video, accounts, at, false, { private: body.private, madeForKids: body.madeForKids ?? null });
  // Posting it is approving it (once its posts are saved).
  if (video.status !== "approved") await c.env.DB.prepare("UPDATE videos SET status='approved',reviewed_at=?,updated_at=? WHERE id=?").bind(now(), now(), video.id).run();
  const rows = await c.env.DB.prepare(`${SELECT_PUBLICATION} WHERE p.video_id=? AND p.user_id=? AND p.id IN (${created.map(() => "?").join(",")}) ORDER BY p.scheduled_at`)
    .bind(video.id, user.id, ...created).all();
  return c.json({ scheduledAt: at, publications: rows.results }, 201);
});

/** Everything scheduled and posted in a range (the schedule view), with each video's title and cover. */
publishing.get("/publications", async (c) => {
  const user = c.get("user");
  const t = now();
  const q = z.object({ from: z.coerce.number().int().optional(), to: z.coerce.number().int().optional() })
    .parse({ from: c.req.query("from") || undefined, to: c.req.query("to") || undefined });
  const from = q.from ?? t - 7 * DAY, to = q.to ?? from + 42 * DAY;
  if (to <= from || to - from > 100 * DAY) throw new HTTPException(400, { message: "Choose a range of up to 100 days." });
  const rows = await c.env.DB.prepare(
    `${SELECT_PUBLICATION.replace(" FROM publications p", ",v.title,v.hook,v.series_id AS seriesId,v.cover_asset AS coverAsset,v.render_status AS renderStatus FROM publications p JOIN videos v ON v.id=p.video_id")} WHERE p.user_id=? AND p.scheduled_at>=? AND p.scheduled_at<? AND p.status!='canceled' ORDER BY p.scheduled_at LIMIT 1000`,
  ).bind(user.id, from, to).all();
  return c.json({ publications: rows.results });
});
publishing.get("/videos/:id/publications", async (c) => {
  const user = c.get("user");
  const video = await ownedVideo(c.env, user.id, c.req.param("id"));
  const rows = await c.env.DB.prepare(`${SELECT_PUBLICATION} WHERE p.video_id=? AND p.user_id=? ORDER BY p.scheduled_at DESC LIMIT 200`).bind(video.id, user.id).all();
  return c.json({ publications: rows.results });
});

async function ownedPublication(env: Env, userId: string, publicationId: string) {
  const p = id.safeParse(publicationId).success
    ? await env.DB.prepare("SELECT * FROM publications WHERE id=? AND user_id=?").bind(publicationId, userId).first<any>()
    : null;
  if (!p) throw new HTTPException(404, { message: "Scheduled post not found." });
  return p;
}
publishing.patch("/publications/:id", async (c) => {
  const user = c.get("user");
  const { at } = z.object({ at: atSchema }).parse(await c.req.json());
  const p = await ownedPublication(c.env, user.id, c.req.param("id"));
  checkTime(at);
  const r = await c.env.DB.prepare("UPDATE publications SET scheduled_at=?,updated_at=? WHERE id=? AND user_id=? AND status='scheduled'").bind(at, now(), p.id, user.id).run();
  if (!r.meta.changes) throw new HTTPException(409, { message: "Only posts that are still scheduled can be moved." });
  return c.json({ ok: true, scheduledAt: at });
});
publishing.delete("/publications/:id", async (c) => {
  const user = c.get("user");
  const p = await ownedPublication(c.env, user.id, c.req.param("id"));
  const r = await c.env.DB.prepare("UPDATE publications SET status='canceled',updated_at=? WHERE id=? AND user_id=? AND status='scheduled'").bind(now(), p.id, user.id).run();
  if (!r.meta.changes) throw new HTTPException(409, { message: "This post is already being published or done, so it can't be canceled." });
  return c.json({ ok: true });
});
publishing.post("/publications/:id/retry", async (c) => {
  const user = c.get("user");
  const p = await ownedPublication(c.env, user.id, c.req.param("id"));
  if (p.status !== "failed") throw new HTTPException(409, { message: "Only failed posts can be retried." });
  const account = await c.env.DB.prepare("SELECT * FROM social_accounts WHERE id=? AND user_id=?").bind(p.account_id, user.id).first<AccountRow>();
  if (!account || account.status !== "active") {
    const name = isPlatform(String(p.platform)) ? platforms[p.platform as PlatformId].name : "social";
    throw new HTTPException(409, { message: `Reconnect your ${name} account, then try again.` });
  }
  const video = await ownedVideo(c.env, user.id, p.video_id);
  if (video.render_status !== "ready") throw new HTTPException(409, { message: "This video isn't ready to post." });
  try {
    const r = await c.env.DB.prepare(
      "UPDATE publications SET status='scheduled',scheduled_at=?,error=NULL,ticket=NULL,token=NULL,claimed_at=NULL,updated_at=? WHERE id=? AND user_id=? AND status='failed'",
    ).bind(now() + LEAD, now(), p.id, user.id).run();
    if (!r.meta.changes) throw new HTTPException(409, { message: "Only failed posts can be retried." });
  } catch (e) {
    if (String((e as Error)?.message || e).includes("UNIQUE"))
      throw new HTTPException(409, { message: "This video is already scheduled or published on that account." });
    throw e;
  }
  return c.json({ ok: true, scheduledAt: now() + LEAD });
});

/** Parses a single "bytes=a-b" range against a file of `size` bytes; null when absent, "invalid" when unsatisfiable. */
function byteRange(header: string | undefined, size: number): { offset: number; length: number } | null | "invalid" {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (!m[1] && !m[2])) return "invalid";
  if (!m[1]) {
    const suffix = Number(m[2]);
    if (!suffix) return "invalid";
    const length = Math.min(suffix, size);
    return { offset: size - length, length };
  }
  const start = Number(m[1]);
  const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  if (start >= size || end < start) return "invalid";
  return { offset: start, length: end - start + 1 };
}

publishMedia.get("/:publicationId/:file", async (c) => {
  const notFound = () => c.json({ error: "Not found." }, 404);
  const file = /^(\d{1,2})(?:\.(?:mp4|jpg|png|webp|bin))?$/.exec(c.req.param("file"));
  const given = c.req.query("token") || "";
  if (!file || !id.safeParse(c.req.param("publicationId")).success || !/^[0-9a-f]{64}$/.test(given)) return notFound();
  const n = Number(file[1]);
  const row = await c.env.DB.prepare(
    "SELECT p.status,p.token,p.claimed_at,p.platform,p.user_id,v.video_asset FROM publications p JOIN videos v ON v.id=p.video_id WHERE p.id=?",
  ).bind(c.req.param("publicationId")).first<any>();
  if (!row || row.status !== "publishing" || !row.token || !safeEqual(row.token, given) || !row.claimed_at || row.claimed_at + LINK_TTL < now() || !isPlatform(row.platform))
    return notFound();
  const assetId = n === 0 ? row.video_asset : null;
  if (typeof assetId !== "string") return notFound();
  const asset = await c.env.DB.prepare("SELECT object_key,mime FROM media_assets WHERE id=? AND user_id=?").bind(assetId, row.user_id).first<{ object_key: string; mime: string }>();
  const head = asset ? await c.env.MEDIA.head(asset.object_key) : null;
  if (!asset || !head) return notFound();
  const size = head.size;
  const range = byteRange(c.req.header("Range"), size);
  const headers = new Headers({
    "Content-Type": asset.mime || head.httpMetadata?.contentType || "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
  });
  if (range === "invalid") {
    headers.set("Content-Range", `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }
  const object = await c.env.MEDIA.get(asset.object_key, range ? { range } : {});
  if (!object || !("body" in object)) return notFound();
  headers.set("Content-Length", String(range ? range.length : size));
  if (range) headers.set("Content-Range", `bytes ${range.offset}-${range.offset + range.length - 1}/${size}`);
  return new Response(c.req.method === "HEAD" ? null : object.body, { status: range ? 206 : 200, headers });
});

/**
 * An approved, ready episode of a series goes to the series' channels at its slot (at once when the slot passed less
 * than LATE_GRACE ago; a later one is left for the owner to post by hand). Returns how many publications were created;
 * accounts it is already scheduled or published on are skipped.
 */
export async function scheduleEpisode(env: Env, videoId: string): Promise<number> {
  const video = await env.DB.prepare("SELECT * FROM videos WHERE id=?").bind(videoId).first<VideoRow & { series_id: string | null; slot_at: number | null }>();
  if (!video || video.status !== "approved" || video.render_status !== "ready" || !video.series_id) return 0;
  const s = await env.DB.prepare("SELECT settings,status FROM series WHERE id=? AND user_id=?").bind(video.series_id, video.user_id).first<{ settings: string; status: string }>();
  if (!s || s.status !== "active") return 0;
  const parsed = seriesSettingsSchema.safeParse(json(s.settings, {}));
  if (!parsed.success || !parsed.data.accounts.length) return 0;
  const t = now();
  const slot = video.slot_at ?? t;
  if (slot < t - LATE_GRACE) return 0;
  const accounts = (await accountsById(env, video.user_id, parsed.data.accounts)).filter((a) => !refusal(a, video, parsed.data.private));
  if (!accounts.length) return 0;
  // A series saved before it asked "made for kids" has no answer: YouTube then applies the channel's own setting.
  return (await insertPublications(env, video, accounts, Math.max(slot, t + LEAD), true, { private: parsed.data.private, madeForKids: parsed.data.madeForKids })).length;
}
/** Cancels what a series still had scheduled (paused or deleted). */
export async function cancelScheduled(env: Env, userId: string, seriesId: string) {
  await env.DB.prepare("UPDATE publications SET status='canceled',updated_at=? WHERE user_id=? AND status='scheduled' AND video_id IN (SELECT id FROM videos WHERE series_id=?)")
    .bind(now(), userId, seriesId).run();
}

/**
 * Cron, every minute: claims due publications whose video is ready (each gets a media-link token and its attempt
 * number) and starts a Publication workflow for each; a video still being made waits (up to WAIT_FOR_RENDER, or fails
 * at once when its making failed); publications stuck in 'publishing' are given up.
 */
export async function dispatchDue(env: Env): Promise<void> {
  const t = now();
  const stuck = await env.DB.prepare("SELECT id,platform FROM publications WHERE status='publishing' AND COALESCE(claimed_at,updated_at)<? LIMIT 100")
    .bind(t - STUCK).all<{ id: string; platform: string }>();
  for (const s of stuck.results) {
    await env.DB.prepare("UPDATE publications SET status='failed',error=?,token=NULL,updated_at=? WHERE id=? AND status='publishing' AND COALESCE(claimed_at,updated_at)<?")
      .bind(failureMessage(isPlatform(s.platform) ? s.platform : null, "TIMEOUT"), t, s.id, t - STUCK).run();
    console.warn("Publication timed out", { publicationId: s.id, code: "TIMEOUT" });
  }
  // Due, but the video's making failed (or never finished): nothing to post.
  await env.DB.prepare(
    `UPDATE publications SET status='failed',error=?,updated_at=? WHERE status='scheduled' AND scheduled_at<=? AND video_id IN (SELECT id FROM videos WHERE render_status='failed' OR (render_status IN ('queued','running') AND updated_at<?))`,
  ).bind("The video couldn't be made in time, so nothing was posted. Open it, make it again and post it.", t, t, t - WAIT_FOR_RENDER).run();
  if (!env.PUBLISH) {
    console.error("Publishing is not configured: the PUBLISH workflow binding is missing");
    return;
  }
  const due = await env.DB.prepare(
    "SELECT p.id FROM publications p JOIN videos v ON v.id=p.video_id WHERE p.status='scheduled' AND p.scheduled_at<=? AND v.render_status='ready' ORDER BY p.scheduled_at LIMIT ?",
  ).bind(t, BATCH).all<{ id: string }>();
  for (const { id: pubId } of due.results) {
    const claimed = await env.DB.prepare(
      "UPDATE publications SET status='publishing',claimed_at=?,token=?,ticket=NULL,attempts=attempts+1,updated_at=? WHERE id=? AND status='scheduled' AND scheduled_at<=? RETURNING attempts",
    ).bind(t, token(), t, pubId, t).first<{ attempts: number }>();
    if (!claimed) continue;
    const instance = `pub-${pubId}-${claimed.attempts}`;
    try {
      await env.PUBLISH.create({ id: instance, params: { publicationId: pubId } });
    } catch (e) {
      // Created before the error arrived: it runs. Otherwise the publication waits for the next minute.
      const exists = await env.PUBLISH.get(instance).then(() => true, () => false);
      if (exists) continue;
      console.error("Publication workflow could not start", { publicationId: pubId, error: (e as Error)?.name });
      await env.DB.prepare("UPDATE publications SET status='scheduled',token=NULL,claimed_at=NULL,updated_at=? WHERE id=? AND status='publishing'").bind(now(), pubId).run();
    }
  }
}

/**
 * Maintenance (daily is enough): renews Instagram's 60-day tokens in their last 10 days, so accounts that rarely
 * publish stay connected, and marks connections that ended as expired.
 */
export async function refreshAccounts(env: Env): Promise<void> {
  const t = now();
  await env.DB.prepare("UPDATE social_accounts SET status='expired',updated_at=? WHERE status='active' AND expires_at IS NOT NULL AND expires_at<?").bind(t, t).run();
  const due = await env.DB.prepare("SELECT * FROM social_accounts WHERE status='active' AND platform='instagram' AND expires_at<? ORDER BY expires_at LIMIT 50")
    .bind(t + 10 * DAY).all<AccountRow>();
  for (const account of due.results) {
    try {
      await freshTokens(env, account);
    } catch (e) {
      const code = (e as Error)?.message || "ERROR";
      console.warn("Social token renewal failed", { platform: account.platform, account: account.id, code });
      if (code === "SOCIAL_AUTH_EXPIRED") await markExpired(env, account.id);
    }
  }
}
