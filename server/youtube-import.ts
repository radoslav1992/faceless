import { HTTPException } from "hono/http-exception";
import type { DbUser, Env } from "./types";
import { MB, now, uid } from "./types";
import { json as stored } from "./db";
import { hit } from "./security";
import { allowance } from "./billing";
import { storeStream } from "./storage";
import { releaseRender, renderFile } from "./renderer";
import { freshTokens, markExpired, type AccountRow } from "./social/credentials";
import { bearer, json, send } from "./social/http";
import { SocialError } from "./social/errors";
import { API, READ_SCOPE } from "./social/youtube";
import { planById, type Plan } from "../shared/plans";
import { isoSeconds, YOUTUBE_VIDEO } from "../shared/youtube";
import type { RenderPayload } from "../shared/render";

// Videos imported for clips from the person's own YouTube channel (a beta behind YOUTUBE_IMPORT, paid plans). Only a
// channel they connected (for posting, server/social/youtube.ts) counts: the YouTube Data API says which channel a
// video is on, and anything else is refused, so people only clip what is theirs. The video is downloaded by the
// renderer's own download container (operation 'youtube', renderer/server.py) and then checked like an upload.
// YouTube can refuse downloads from servers at any time; the person is then told to upload the file instead.

export const youtubeImport = (env: Env) => env.YOUTUBE_IMPORT === "true";
/** Listings of the person's channel videos per hour (each costs YouTube API quota). */
export const LISTINGS_PER_HOUR = 30;
/** Videos listed per channel: its latest uploads. */
const LISTED = 25;
/** Bytes reserved per second of a video while it downloads (1080p at up to 16 Mbit/s), plus a margin. */
const BYTES_PER_SECOND = 2 * MB, MARGIN = 50 * MB;

/** A video of the person's channel as the import picker shows it; `problem` says why it can't be imported. */
export type OwnVideo = { id: string; title: string; seconds: number; published: string | null; privacy: string; problem: string | null };

const reconnect = () => new HTTPException(409, { message: "Your YouTube connection has expired. Reconnect the channel on the Channels page." });
/** The person's connected YouTube channels. */
async function channels(env: Env, userId: string) {
  return (await env.DB.prepare("SELECT * FROM social_accounts WHERE user_id=? AND platform='youtube' AND status='active' ORDER BY created_at LIMIT 5")
    .bind(userId).all<AccountRow>()).results;
}
/** A YouTube Data API read with a channel's tokens (refreshed when needed). */
async function google(env: Env, account: AccountRow, path: string, params: Record<string, string>) {
  let accessToken: string;
  try {
    const tokens = await freshTokens(env, account);
    // People can untick the read permission when they connect; without it nothing can be listed.
    if (tokens.scope && !tokens.scope.split(" ").includes(READ_SCOPE)) throw reconnect();
    accessToken = tokens.accessToken;
  } catch (e) {
    if (e instanceof SocialError && e.code === "AUTH_EXPIRED") { await markExpired(env, account.id); throw reconnect(); }
    throw e instanceof HTTPException ? e : new HTTPException(502, { message: "YouTube didn't answer. Try again in a minute." });
  }
  let r: Response;
  try {
    r = await send("youtube", `${API}/${path}?${new URLSearchParams(params)}`, { headers: bearer(accessToken), timeout: 15_000 });
  } catch {
    throw new HTTPException(502, { message: "YouTube didn't answer. Try again in a minute." });
  }
  if (r.status === 401) { await markExpired(env, account.id); throw reconnect(); }
  if (!r.ok) throw new HTTPException(502, { message: "YouTube didn't answer. Try again in a minute." });
  return json(r);
}

/** Why a video (a videos.list item) can't be imported on this plan, or null. */
function problemOf(item: any, plan: Plan): string | null {
  const seconds = isoSeconds(item?.contentDetails?.duration);
  if (item?.snippet?.liveBroadcastContent && item.snippet.liveBroadcastContent !== "none") return "Live streams and premieres can be imported once they've finished.";
  if (item?.status?.uploadStatus && item.status.uploadStatus !== "processed") return "YouTube is still processing this video. Try again when it's done.";
  if (item?.status?.privacyStatus === "private") return "This video is private on YouTube. Make it unlisted or public, then import it.";
  if (item?.contentDetails?.contentRating?.ytRating === "ytAgeRestricted") return "Age-restricted videos can't be imported. Download it in YouTube Studio and upload the file.";
  if (seconds === null || seconds < 20) return "Clips need a video of at least 20 seconds.";
  if (seconds > plan.videoMinutes * 60) return `Videos can be up to ${plan.videoMinutes / 60} hours long.`;
  return null;
}
function ownVideo(item: any, plan: Plan): OwnVideo | null {
  if (typeof item?.id !== "string" || !YOUTUBE_VIDEO.test(item.id)) return null;
  return {
    id: item.id, title: String(item.snippet?.title || "YouTube video").slice(0, 160), seconds: isoSeconds(item.contentDetails?.duration) || 0,
    published: typeof item.snippet?.publishedAt === "string" ? item.snippet.publishedAt : null, privacy: String(item.status?.privacyStatus || ""),
    problem: problemOf(item, plan),
  };
}
async function paidPlan(env: Env, user: DbUser) {
  const plan = planById((await allowance(env, user)).plan);
  if (plan.id === "free") throw new HTTPException(402, { message: "Importing from YouTube is part of the paid plans. Upload the file instead, or choose a plan." });
  return plan;
}

/**
 * The latest uploads of the person's connected channels, for the import picker (3 quota units per channel). Says
 * when the feature is off, the plan doesn't include it or no channel is connected, instead of failing.
 */
export async function ownVideos(env: Env, user: DbUser) {
  if (!youtubeImport(env)) return { enabled: false as const, reason: "off" as const, channels: [] };
  const plan = planById((await allowance(env, user)).plan);
  if (plan.id === "free") return { enabled: false as const, reason: "plan" as const, channels: [] };
  const accounts = await channels(env, user.id);
  if (!accounts.length) return { enabled: true as const, reason: "no-channel" as const, channels: [] };
  if ((await hit(env, "youtube-listings", 3600, user.id)) > LISTINGS_PER_HOUR) throw new HTTPException(429, { message: "That's a lot of refreshing. Try again in a few minutes." });
  const out = [];
  for (const account of accounts) {
    // https://developers.google.com/youtube/v3/docs/channels/list, playlistItems/list and videos/list: 1 unit each.
    const channel = await google(env, account, "channels", { part: "contentDetails", id: account.external_id });
    const uploads = channel?.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    let videos: OwnVideo[] = [];
    if (typeof uploads === "string" && /^[\w-]{10,64}$/.test(uploads)) {
      const items = await google(env, account, "playlistItems", { part: "contentDetails", playlistId: uploads, maxResults: String(LISTED) });
      const ids = (Array.isArray(items?.items) ? items.items : []).map((i: any) => i?.contentDetails?.videoId).filter((id: unknown) => typeof id === "string" && YOUTUBE_VIDEO.test(id));
      if (ids.length) {
        const found = await google(env, account, "videos", { part: "snippet,contentDetails,status", id: ids.join(",") });
        const byId = new Map<string, OwnVideo>();
        for (const item of Array.isArray(found?.items) ? found.items : []) {
          const v = ownVideo(item, plan);
          if (v && item?.snippet?.channelId === account.external_id) byId.set(v.id, v);
        }
        videos = ids.map((id: string) => byId.get(id)).filter(Boolean) as OwnVideo[];
      }
    }
    out.push({ id: account.id, name: account.name, videos });
  }
  return { enabled: true as const, reason: null, channels: out };
}

/**
 * Checks that a YouTube video is on one of the person's connected channels and can be imported on their plan. Returns
 * what the import is made of: its title, length and the size to reserve.
 */
export async function ownYoutubeVideo(env: Env, user: DbUser, videoId: string) {
  const plan = await paidPlan(env, user);
  const accounts = await channels(env, user.id);
  if (!accounts.length) throw new HTTPException(409, { message: "Connect your YouTube channel on the Channels page to import its videos." });
  const found = await google(env, accounts[0], "videos", { part: "snippet,contentDetails,status", id: videoId });
  const item = Array.isArray(found?.items) ? found.items.find((i: any) => i?.id === videoId) : null;
  if (!item) throw new HTTPException(404, { message: "We couldn't find this video on YouTube. Check the link." });
  const channel = accounts.find((a) => a.external_id === item.snippet?.channelId);
  if (!channel)
    throw new HTTPException(403, { message: "Only videos from your own YouTube channel can be imported. Connect that channel on the Channels page, or upload the file." });
  const video = ownVideo(item, plan)!;
  if (video.problem) throw new HTTPException(422, { message: video.problem });
  const max = plan.videoMb * MB;
  return { plan, title: video.title, seconds: video.seconds, channel: channel.external_id, limit: Math.min(max, Math.ceil(video.seconds * BYTES_PER_SECOND + MARGIN)) };
}

/** The renderer's download job for an imported YouTube video still to download, or null (a link, gone or done). */
export async function youtubeJob(e: Env, assetId: string): Promise<RenderPayload | null> {
  const a = await e.DB.prepare("SELECT meta,status FROM media_assets WHERE id=?").bind(assetId).first<{ meta: string; status: string }>();
  const meta = stored<any>(a?.meta, {});
  if (a?.status !== "checking" || typeof meta.import?.youtube !== "string" || !YOUTUBE_VIDEO.test(meta.import.youtube)) return null;
  // Seen working, so maintenance does not take a long download for a check that never answered.
  await e.DB.prepare("UPDATE media_assets SET updated_at=? WHERE id=?").bind(now(), assetId).run();
  return { id: uid(), operation: "youtube", video: meta.import.youtube, maxSeconds: Number(meta.maxSeconds) || 600, maxBytes: Number(meta.import.limit) || 0 };
}
/**
 * Moves a downloaded YouTube video from the download container into storage (never past the size reserved for it);
 * false when the import was deleted or failed meanwhile (the file is then not kept).
 */
export async function storeYoutube(e: Env, assetId: string, slot: number, jobId: string): Promise<boolean> {
  const a = await e.DB.prepare("SELECT object_key,meta,status FROM media_assets WHERE id=?").bind(assetId).first<{ object_key: string; meta: string; status: string }>();
  const limit = Number(stored<any>(a?.meta, {}).import?.limit) || 0;
  if (!a || a.status !== "checking" || !limit) {
    await releaseRender(e, slot, jobId);
    return false;
  }
  await e.DB.prepare("UPDATE media_assets SET updated_at=? WHERE id=?").bind(now(), assetId).run();
  const bytes = await storeStream(e, a.object_key, await renderFile(e, slot, jobId, 0), limit, "video/mp4");
  const kept = await e.DB.prepare("UPDATE media_assets SET bytes=?,meta=json_remove(meta,'$.import'),updated_at=? WHERE id=? AND status='checking'").bind(bytes, now(), assetId).run();
  await releaseRender(e, slot, jobId);
  if (!kept.meta?.changes) {
    await e.MEDIA.delete(a.object_key);
    return false;
  }
  return true;
}
