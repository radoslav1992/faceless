import type { Env } from "../types";
import { providerFetch, ProviderError } from "./http";

// HeyGen (API v3), ported from rech-bg's server/video-heygen.ts: its avatars ("looks", stock or the account's own)
// and avatar videos lip-synced to an audio file. Here the audio is always the video's ElevenLabs narration (a
// capability link HeyGen fetches); HeyGen only animates the avatar. Paid calls carry an Idempotency-Key, and the
// provider's copy of a video is deleted once ours is saved. Provider messages are never stored or logged.

const API = "https://api.heygen.com/v3";
/** Engines: Avatar IV animates photo and video avatars, Avatar V needs a video avatar (most stock avatars). */
export type HeyGenEngine = "avatar_iv" | "avatar_v";
const ID = /^[a-zA-Z0-9_-]{1,160}$/;
function validId(id: unknown): string {
  if (typeof id !== "string" || !ID.test(id)) throw new ProviderError("AVATAR_FAILED");
  return id;
}
export const heygenEnabled = (env: Env) => !!env.HEYGEN_API_KEY?.trim();
function headers(env: Env) {
  const key = env.HEYGEN_API_KEY?.trim();
  if (!key) throw new ProviderError("AVATAR_UNAVAILABLE");
  return { "x-api-key": key };
}
/** A refusal as a short code: the key or the account's credits, too many requests, or anything else. */
async function failure(r: Response) {
  await r.body?.cancel();
  return new ProviderError(r.status === 401 || r.status === 402 || r.status === 403 ? "AVATAR_UNAVAILABLE" : r.status === 429 ? "AVATAR_BUSY" : "AVATAR_FAILED");
}
async function call(env: Env, path: string, init: RequestInit & { timeout?: number } = {}) {
  const { timeout = 45000, ...rest } = init;
  const r = await providerFetch(`${API}${path}`, { ...rest, headers: { ...headers(env), ...(rest.headers as Record<string, string>) }, signal: AbortSignal.timeout(timeout) })
    .catch((e) => { throw e instanceof ProviderError ? e : new ProviderError("AVATAR_FAILED"); });
  if (!r.ok) throw await failure(r);
  return r;
}

/** The fields of a look (avatar) we use; names, genders and tags are short display text. */
export function lookSummary(look: any) {
  const text = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\p{Cc}<>]/gu, "").trim().slice(0, max) : "");
  const engines = Array.isArray(look?.supported_api_engines)
    ? (look.supported_api_engines as unknown[]).filter((e): e is string => typeof e === "string" && /^[a-z0-9_]{1,40}$/.test(e)).slice(0, 10)
    : [];
  return {
    status: (look?.status === "processing" ? "processing" : look?.status === "completed" ? "completed" : "failed") as "processing" | "completed" | "failed",
    name: text(look?.name, 60),
    gender: ((g: string) => (g === "female" || g === "male" ? g : ""))(text(look?.gender, 20).toLowerCase()) as "female" | "male" | "",
    tags: Array.isArray(look?.tags) ? (look.tags as unknown[]).map((t) => text(t, 40)).filter(Boolean).slice(0, 12) : [],
    engines,
    previewImageUrl: typeof look?.preview_image_url === "string" ? (look.preview_image_url as string) : null,
  };
}
export type LookSummary = ReturnType<typeof lookSummary>;

/** One avatar (look) of the account or HeyGen's stock library. */
export async function getLook(env: Env, lookId: string) {
  const body = await (await call(env, `/avatars/looks/${validId(lookId)}`)).json() as any;
  if (body?.error || body?.data?.id !== lookId) throw new ProviderError("AVATAR_FAILED");
  return { id: lookId, ...lookSummary(body.data) };
}
/** One page (50) of HeyGen's stock avatars, for administrators to pick from. */
export async function listStockLooks(env: Env, token?: string) {
  const query = new URLSearchParams({ ownership: "public", limit: "50", ...(token ? { token } : {}) });
  const body = await (await call(env, `/avatars/looks?${query}`)).json() as any;
  const list = Array.isArray(body?.data) ? body.data : Array.isArray(body?.data?.items) ? body.data.items : Array.isArray(body?.data?.looks) ? body.data.looks : null;
  if (body?.error || !list) throw new ProviderError("AVATAR_FAILED");
  const next = body?.next_token ?? body?.data?.next_token;
  return {
    looks: (list as any[]).filter((l) => typeof l?.id === "string" && ID.test(l.id)).map((l) => ({ id: l.id as string, ...lookSummary(l) })),
    nextToken: (body?.has_more ?? body?.data?.has_more) !== false && typeof next === "string" && /^[\w.~+/=-]{1,1000}$/.test(next) ? next : null,
  };
}

const MAX_PREVIEW = 5 * 1024 * 1024;
function heygenImageUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") ||
      !["heygen.ai", "heygen.com"].some((h) => url.hostname === h || url.hostname.endsWith(`.${h}`)))
    throw new ProviderError("AVATAR_FAILED");
  return url.href;
}
/**
 * A HeyGen-hosted image (an avatar's preview): https on heygen.ai or heygen.com only (each redirect too), no
 * credentials sent, at most 5 MB, and only JPEG, PNG or WebP by its bytes.
 */
export async function fetchHeyGenImage(src: string): Promise<{ bytes: Uint8Array<ArrayBuffer>; mime: "image/jpeg" | "image/png" | "image/webp" }> {
  let next = heygenImageUrl(src);
  for (let hop = 0; hop <= 2; hop++) {
    const r = await fetch(next, { redirect: "manual", signal: AbortSignal.timeout(20000) });
    if (r.status >= 300 && r.status < 400) {
      await r.body?.cancel();
      const location = r.headers.get("Location");
      if (!location || hop === 2) break;
      next = heygenImageUrl(new URL(location, next).href);
      continue;
    }
    if (!r.ok || !r.body || Number(r.headers.get("Content-Length")) > MAX_PREVIEW) { await r.body?.cancel(); break; }
    const bytes = new Uint8Array(await r.arrayBuffer());
    if (bytes.length > MAX_PREVIEW) break;
    const ascii = (from: number, to: number) => String.fromCharCode(...bytes.slice(from, to));
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { bytes, mime: "image/jpeg" };
    if ([137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b)) return { bytes, mime: "image/png" };
    if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return { bytes, mime: "image/webp" };
    break;
  }
  throw new ProviderError("AVATAR_FAILED");
}

/**
 * Asks for an avatar video lip-synced to `audio` (paid once: `key` is the Idempotency-Key, so a resent request finds
 * the same video). The video keeps the avatar's own shape; the render crops it to the vertical frame.
 */
export async function submitAvatarVideo(env: Env, key: string, lookId: string, engine: HeyGenEngine, audio: string) {
  const r = await call(env, "/videos", {
    method: "POST", timeout: 60000,
    headers: { "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify({
      type: "avatar", avatar_id: validId(lookId), engine: { type: engine }, audio_url: audio,
      title: `Presenter ${key}`.slice(0, 100), resolution: "1080p", aspect_ratio: "auto", output_format: "mp4",
    }),
  });
  const body = await r.json() as any;
  if (body?.error || !body?.data?.video_id) throw new ProviderError("AVATAR_FAILED");
  return validId(body.data.video_id);
}
/** An avatar video's state: still being made, or done with its download link. */
export async function avatarVideoStatus(env: Env, videoId: string): Promise<{ done: false } | { done: true; url: string }> {
  const body = await (await call(env, `/videos/${validId(videoId)}`)).json() as any;
  const data = body?.data;
  if (body?.error || !data || data.id !== videoId) throw new ProviderError("AVATAR_FAILED");
  if (["waiting", "pending", "processing"].includes(data.status)) return { done: false };
  if (data.status === "completed" && typeof data.video_url === "string" && data.video_url) return { done: true, url: data.video_url };
  throw new ProviderError(/moderat|policy/i.test(String(data.failure_message || data.failure_code || "")) ? "AVATAR_REJECTED" : "AVATAR_FAILED");
}
/** Deletes HeyGen's copy of a video (already gone counts as deleted). */
export async function deleteAvatarVideo(env: Env, videoId: string) {
  const r = await providerFetch(`${API}/videos/${validId(videoId)}`, { method: "DELETE", headers: headers(env), signal: AbortSignal.timeout(15000) });
  await r.body?.cancel();
  if (!r.ok && r.status !== 404) throw new ProviderError("AVATAR_FAILED");
}
