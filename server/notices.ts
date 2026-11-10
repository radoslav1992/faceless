import type { Env } from "./types";
import { json } from "./db";
import { PRODUCT } from "../shared/brand";
import { platforms, type PlatformId } from "../shared/social";
import { siteUrl } from "./config";
import { sendMail } from "./security";

// E-mails about posting that stopped working. Without them an autopilot fails in silence: a series keeps making (and
// charging for) episodes that never reach the channel. Each is sent once, by the code that makes the change it tells
// about, and never fails that code: a notice that could not be sent is only logged.

const mail = (env: Env, to: string, subject: string, lines: string[]) => sendMail(env, to, subject, [...lines, "", `— ${PRODUCT.name}`].join("\n"));
const networkName = (platform: string) => (platform in platforms ? platforms[platform as PlatformId].name : "your channel");
const unsent = (what: string, id: string) => (e: unknown) => console.warn(`${what} notice not sent`, { id, error: (e as Error)?.name });

/**
 * A connected channel has to be connected again (its access expired or was withdrawn). Called once, when the account
 * turns from active to expired; names the running series that post to it, which make episodes but can't post them.
 */
export async function accountExpiredNotice(env: Env, accountId: string) {
  const a = await env.DB.prepare("SELECT a.user_id,a.platform,a.name,a.handle,u.email FROM social_accounts a JOIN users u ON u.id=a.user_id WHERE a.id=?")
    .bind(accountId).first<{ user_id: string; platform: string; name: string; handle: string | null; email: string }>();
  if (!a) return;
  const series = (await env.DB.prepare("SELECT name,settings FROM series WHERE user_id=? AND status='active' ORDER BY created_at LIMIT 200").bind(a.user_id).all<{ name: string; settings: string }>()).results
    .filter((s) => (json<{ accounts?: unknown }>(s.settings, {}).accounts as unknown[] | undefined)?.includes(accountId))
    .map((s) => `“${s.name}”`);
  const network = networkName(a.platform), channel = a.handle ? `${a.name} (@${a.handle})` : a.name;
  await mail(env, a.email, `Reconnect your ${network} channel “${a.name}”`, [
    `${PRODUCT.name} can no longer post to your ${network} channel ${channel}: its access expired or was withdrawn.`,
    "",
    series.length
      ? `Your series ${series.slice(0, 10).join(", ")} ${series.length === 1 ? "posts" : "post"} to it. New episodes are still made, but they are not posted there until you reconnect the channel.`
      : "Videos scheduled for it are not posted until you reconnect it.",
    ...(a.platform === "youtube" ? ["", "A YouTube channel that is not reconnected within 14 days is removed, with its posts' YouTube links and stats."] : []),
    "",
    `Reconnect it: ${siteUrl(env)}/app/channels`,
  ]).catch(unsent("Expired channel", accountId));
}

/**
 * A post failed for good. Called once, when the publication turns failed. An episode's owner hears about it when the
 * series sends notices; a video posted by hand always (it was scheduled for a time its owner may not be watching).
 * A channel that needs reconnecting has its own notice (accountExpiredNotice), so that reason is left to it.
 */
export async function postFailedNotice(env: Env, publicationId: string, reason: string) {
  const p = await env.DB.prepare(
    "SELECT p.platform,p.video_id,v.title,v.hook,u.email,s.name AS series_name,s.settings AS series_settings FROM publications p JOIN videos v ON v.id=p.video_id JOIN users u ON u.id=p.user_id LEFT JOIN series s ON s.id=v.series_id WHERE p.id=?",
  ).bind(publicationId).first<{ platform: string; video_id: string; title: string | null; hook: string | null; email: string; series_name: string | null; series_settings: string | null }>();
  if (!p) return;
  if (p.series_settings && json<{ notify?: boolean }>(p.series_settings, {}).notify === false) return;
  const network = networkName(p.platform), title = p.title || p.hook || "Your video";
  await mail(env, p.email, `“${title}” wasn't posted to ${network}`, [
    p.series_name ? `An episode of your series “${p.series_name}” could not be posted to ${network}.` : `Your video could not be posted to ${network}.`,
    "",
    reason,
    "",
    `Open the video to post it again: ${siteUrl(env)}/app/videos/${p.video_id}`,
  ]).catch(unsent("Failed post", publicationId));
}
