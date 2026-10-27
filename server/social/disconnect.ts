import type { Env } from "../types";
import { now } from "../types";
import { json } from "../db";
import type { PlatformId } from "../../shared/social";

/**
 * Forgets what YouTube told us about an account's posts (video IDs, links, counts and the channel's name), as the
 * YouTube API Services policies ask once we can no longer refresh it. The posts stay in the history, without them.
 */
export const forgetYouTubePosts = (env: Env, accountId: string) =>
  env.DB.prepare(
    "UPDATE publications SET external_id=NULL,url=NULL,account_name='',views=NULL,likes=NULL,comments=NULL,shares=NULL,saves=NULL,metrics_at=NULL,metrics_error=NULL WHERE account_id=? AND platform='youtube'",
  ).bind(accountId);

/**
 * Removes a connected account: posts still scheduled to it are cancelled, series stop posting to it and, for YouTube,
 * what YouTube told us about its posts is forgotten; the rest of its published history stays (its account becomes
 * "disconnected"). The account_busy trigger refuses while a video is being published to it.
 */
export async function removeAccount(env: Env, userId: string, account: { id: string; platform: PlatformId }) {
  const using = (await env.DB.prepare("SELECT id,settings FROM series WHERE user_id=? AND settings LIKE ?").bind(userId, `%${account.id}%`).all<{ id: string; settings: string }>()).results;
  const t = now();
  await env.DB.batch([
    env.DB.prepare("UPDATE publications SET status='canceled',updated_at=? WHERE account_id=? AND status='scheduled'").bind(t, account.id),
    ...(account.platform === "youtube" ? [forgetYouTubePosts(env, account.id)] : []),
    env.DB.prepare("DELETE FROM social_accounts WHERE id=? AND user_id=?").bind(account.id, userId),
    ...using.map((s) => {
      const settings = json<any>(s.settings, {});
      if (Array.isArray(settings.accounts)) settings.accounts = settings.accounts.filter((x: unknown) => x !== account.id);
      return env.DB.prepare("UPDATE series SET settings=?,updated_at=? WHERE id=?").bind(JSON.stringify(settings), t, s.id);
    }),
  ]);
}
