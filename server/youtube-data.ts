import type { Env } from "./types";
import { DAY, now } from "./types";
import { youtube } from "./social/youtube";
import { SocialError } from "./social/errors";
import { accountLabel, freshTokens, markExpired, type AccountRow } from "./social/credentials";
import { removeAccount } from "./social/disconnect";

// The YouTube API Services Developer Policies let us keep what YouTube tells us only while we can refresh it, and ask us
// to delete it once a person's authorization ends. Disconnecting a channel forgets it at once (social/disconnect.ts);
// the daily maintenance (keepYouTubeData) does the rest:
// - connected channels: authorization and the channel's name, handle and picture are checked again every week;
// - a connection that stopped working (revoked at Google, or the channel deleted) is removed after LOST_DAYS unless
//   the person reconnects it;
// - a post whose video ID and counts haven't been refreshed for STALE_DAYS (stats are read weekly while the channel is
//   connected, metrics.ts) loses them.
// The periods are in the privacy policy (src/public/Legal.tsx, "YouTube API Services") and docs/SOCIAL.md.

/** A connected channel is checked again after this long (the check runs daily, so within a week). */
export const CHECK_EVERY = 6 * DAY;
/** A YouTube connection that stopped working is removed this many days later, unless reconnected. */
export const LOST_DAYS = 14;
/** YouTube data of a post not refreshed for this many days is deleted. */
export const STALE_DAYS = 30;

export async function keepYouTubeData(env: Env, t = now()) {
  const checked = await checkChannels(env, t);
  const removed = await removeLost(env, t);
  const forgotten = await forgetStale(env, t);
  if (checked || removed || forgotten) console.log("YouTube data kept current", { checked, removed, forgotten });
}

/**
 * Channels not checked for CHECK_EVERY: a token refresh confirms the authorization still stands and the channel's
 * details are read again (also on the posts made to it). A refused authorization, or a channel that is gone, makes
 * the connection expired; anything else is tried again the next day.
 */
async function checkChannels(env: Env, t: number) {
  const due = (await env.DB.prepare(
    "SELECT * FROM social_accounts WHERE platform='youtube' AND status='active' AND COALESCE(profile_at,created_at)<? ORDER BY COALESCE(profile_at,created_at) LIMIT 50",
  ).bind(t - CHECK_EVERY).all<AccountRow>()).results;
  let checked = 0;
  for (const account of due) {
    try {
      const p = await youtube.profile!(env, await freshTokens(env, account));
      if (p.externalId !== account.external_id) throw new SocialError("NO_CHANNEL");
      const fresh = { name: p.name, handle: p.handle ?? null };
      await env.DB.batch([
        env.DB.prepare("UPDATE social_accounts SET name=?,handle=?,avatar_url=?,profile_at=?,updated_at=? WHERE id=?")
          .bind(fresh.name, fresh.handle, p.avatarUrl ?? null, t, t, account.id),
        env.DB.prepare("UPDATE publications SET account_name=?1 WHERE account_id=?2 AND platform='youtube' AND account_name<>?1").bind(accountLabel(fresh), account.id),
      ]);
      checked++;
    } catch (e) {
      const code = e instanceof SocialError ? e.code : (e as Error)?.name || "Error";
      console.warn("YouTube channel check failed", { account: account.id, code });
      if (code === "AUTH_EXPIRED" || code === "NO_CHANNEL") await markExpired(env, account.id);
    }
  }
  return checked;
}

/** Connections that stopped working LOST_DAYS ago are removed like a disconnection; one with a post in progress waits. */
async function removeLost(env: Env, t: number) {
  const lost = (await env.DB.prepare("SELECT id,user_id,platform FROM social_accounts WHERE platform='youtube' AND status<>'active' AND updated_at<? LIMIT 50")
    .bind(t - LOST_DAYS * DAY).all<Pick<AccountRow, "id" | "user_id" | "platform">>()).results;
  let removed = 0;
  for (const a of lost) {
    try {
      await removeAccount(env, a.user_id, a);
      removed++;
    } catch {
      console.warn("Lost YouTube connection not removed yet", { account: a.id });
    }
  }
  return removed;
}

/** Posts whose video ID and counts weren't refreshed for STALE_DAYS (the video was deleted, or the stats can't be read). */
async function forgetStale(env: Env, t: number) {
  const r = await env.DB.prepare(
    `UPDATE publications SET external_id=NULL,url=NULL,views=NULL,likes=NULL,comments=NULL,shares=NULL,saves=NULL,metrics_at=NULL
     WHERE id IN (SELECT id FROM publications WHERE platform='youtube' AND status='published' AND external_id IS NOT NULL AND COALESCE(metrics_at,published_at)<? LIMIT 500)`,
  ).bind(t - STALE_DAYS * DAY).run();
  return r.meta.changes || 0;
}
