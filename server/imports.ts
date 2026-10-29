import { HTTPException } from "hono/http-exception";
import type { DbUser, Env } from "./types";
import { HOUR, MB, now, uid } from "./types";
import { siteUrl } from "./config";
import { dbFailure, json } from "./db";
import { hit, token } from "./security";
import { extOf, mediaKey, storeStream } from "./storage";
import { allowance } from "./billing";
import { requireVerified } from "./videos";
import { PRODUCT } from "../shared/brand";
import { planById, type Plan } from "../shared/plans";

// Videos imported from a link, for Clips: a direct link to an MP4, MOV or WebM file, or a Dropbox or Google Drive share
// link. The link is checked and opened once while the person waits (so a web page or a missing file is refused at
// once); the workflow then downloads the file into storage (`downloadImport`) and checks it like an upload. Pages of
// video platforms are not fetched: they serve pages, not files, and YouTube's terms don't allow downloading its videos.
// Only public https hosts are fetched (no addresses, no local names, never this site), on every redirect too.

/** Links opened per person and hour (refused ones included), and imports downloading at once. */
export const LINKS_PER_HOUR = 30, ACTIVE_IMPORTS = 3;
const REDIRECTS = 5;

const platforms: [RegExp, string][] = [
  [/(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/, "YouTube"],
  [/(^|\.)tiktok\.com$/, "TikTok"],
  [/(^|\.)instagram\.com$/, "Instagram"],
  [/(^|\.)(facebook\.com|fb\.watch)$/, "Facebook"],
  [/(^|\.)(x\.com|twitter\.com)$/, "X"],
  [/(^|\.)twitch\.tv$/, "Twitch"],
  [/(^|\.)vimeo\.com$/, "Vimeo"],
  [/(^|\.)kick\.com$/, "Kick"],
];

/** Why a link can't be imported, in plain words (the codes are what the workflow throws). */
const failures: Record<string, string> = {
  LINK_INVALID: "Paste a link that starts with https://.",
  LINK_PRIVATE: "This link can't be reached from our servers. Use a public link to the video file.",
  LINK_PAGE: "That link opens a web page, not a video file. Use a direct link to the file, or a Dropbox or Google Drive link shared with anyone who has it.",
  LINK_MISSING: "The video at this link couldn't be opened: it may be private, moved or deleted. Check that anyone with the link can open it.",
  LINK_FORMAT: "This link isn't an MP4, MOV or WebM video.",
  LINK_FAILED: "This video couldn't be downloaded from its link. Try again, or upload the file.",
  LINK_TIMEOUT: "Downloading this video took too long. Try again, or upload the file.",
  MEDIA_SIZE: "This video is larger than your plan takes: up to 500 MB on the free trial and 2 GB on paid plans.",
  MEDIA_EMPTY: "The file at this link is empty.",
};
/** The message for a failed import (a code from this module or storeStream; anything else is a failed download). */
export function importFailure(error: unknown) {
  const e = error as Error;
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return failures.LINK_TIMEOUT;
  return failures[e?.message] || failures.LINK_FAILED;
}

/**
 * A link that may be fetched: https on the default port, a public host name (no IP address, local or reserved name,
 * nor this site), no credentials. Pages of video platforms are refused with what to do instead.
 */
export function checkedUrl(e: Env, raw: string): URL {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new Error("LINK_INVALID"); }
  if (url.protocol !== "https:" || raw.length > 2000) throw new Error("LINK_INVALID");
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const platform = platforms.find(([pattern]) => pattern.test(host))?.[1];
  if (platform) throw new PlatformLink(platform);
  let site = "";
  try { site = new URL(siteUrl(e)).hostname; } catch { /* no site configured */ }
  if (url.username || url.password || (url.port && url.port !== "443") || !host.includes(".") || /^[\d.]+$/.test(host) || host.startsWith("[")
    || /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home|corp|arpa|test|invalid|example)$/.test(host) || host === site)
    throw new Error("LINK_PRIVATE");
  return url;
}
/** A link to a video platform's page, refused with what to do instead. */
export class PlatformLink extends Error {
  constructor(readonly platform: string) {
    super("LINK_PLATFORM");
  }
  get advice() {
    return this.platform === "YouTube"
      ? "YouTube links can't be imported: YouTube's terms don't allow downloading its videos. If it's your own video, download it in YouTube Studio (Content → ⋮ → Download) and upload the file here."
      : `${this.platform} links can't be imported. Download your video from ${this.platform} and upload the file, or paste a direct link to the file.`;
  }
}

/** Share links turned into the file itself: Dropbox (`dl=1`) and Google Drive (its download address). */
export function fileLink(url: URL): URL {
  const host = url.hostname.toLowerCase();
  if (host === "dropbox.com" || host === "www.dropbox.com") {
    const u = new URL(url.href);
    u.hostname = "www.dropbox.com";
    u.searchParams.delete("raw");
    u.searchParams.set("dl", "1");
    return u;
  }
  if (host === "drive.google.com") {
    const id = url.pathname.match(/^\/file\/d\/([\w-]+)/)?.[1] || (/^\/(open|uc)$/.test(url.pathname) ? url.searchParams.get("id") : null);
    if (id && /^[\w-]{10,200}$/.test(id)) {
      const u = new URL("https://drive.usercontent.google.com/download");
      u.searchParams.set("id", id);
      u.searchParams.set("export", "download");
      u.searchParams.set("confirm", "t");
      const key = url.searchParams.get("resourcekey");
      if (key && /^[\w-]{1,100}$/.test(key)) u.searchParams.set("resourcekey", key);
      return u;
    }
  }
  return url;
}

/** Opens a link, following at most five redirects; every hop must pass `checkedUrl`. */
async function openLink(e: Env, href: string, signal: AbortSignal): Promise<{ response: Response; url: URL }> {
  let url = checkedUrl(e, href);
  for (let hop = 0; hop <= REDIRECTS; hop++) {
    const response = await fetch(url.href, {
      redirect: "manual", signal,
      headers: { Accept: "video/*,application/octet-stream;q=0.9,*/*;q=0.5", "User-Agent": `${PRODUCT.name} video import (+${siteUrl(e)})` },
    });
    if (response.status < 300 || response.status >= 400) {
      if ([401, 403, 404, 410].includes(response.status)) { await response.body?.cancel(); throw new Error("LINK_MISSING"); }
      if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error("LINK_FAILED"); }
      // A page (a sign-in, a preview, a "file not found") is never a video.
      if (/^(text\/|application\/(json|xml|xhtml))/i.test(response.headers.get("Content-Type") || "")) { await response.body.cancel(); throw new Error("LINK_PAGE"); }
      return { response, url };
    }
    const next = response.headers.get("Location");
    await response.body?.cancel();
    if (!next) throw new Error("LINK_FAILED");
    // A redirect to a page of a video platform says what to do; anywhere else not allowed is out of reach.
    try { url = checkedUrl(e, new URL(next, url).href); } catch (error) { throw error instanceof PlatformLink ? error : new Error("LINK_PRIVATE"); }
  }
  throw new Error("LINK_FAILED");
}

/** The video format of a file's first bytes: MP4 or MOV (ISO boxes), WebM (Matroska); null for anything else. */
export function videoMime(b: Uint8Array): string | null {
  const box = b.length >= 12 ? String.fromCharCode(...b.subarray(4, 8)) : "";
  if (box === "ftyp") return String.fromCharCode(...b.subarray(8, 12)) === "qt  " ? "video/quicktime" : "video/mp4";
  if (["moov", "mdat", "wide", "free", "skip"].includes(box)) return "video/quicktime";
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "video/webm";
  return null;
}
/** The file's name: from Content-Disposition, else the link's last path part with an extension, else its host. */
function fileName(response: Response, url: URL, link: URL) {
  const disposition = response.headers.get("Content-Disposition") || "";
  const decode = (s: string | undefined) => { try { return s ? decodeURIComponent(s) : ""; } catch { return ""; } };
  const name = decode(disposition.match(/filename\*=utf-8''([^;]+)/i)?.[1]) || disposition.match(/filename="?([^";]+)"?/i)?.[1] || decode(url.pathname.split("/").filter(Boolean).at(-1));
  // eslint-disable-next-line no-control-regex -- control characters never belong in a name
  const clean = name.replace(/[\u0000-\u001f\u007f/\\]/g, "").replace(/\s+/g, " ").trim().slice(0, 160);
  return /\.\w{2,4}$/.test(clean) ? clean : `Video from ${link.hostname.replace(/^www\./, "")}`;
}

/**
 * Opens a link while the person waits: it must lead to a video file (its first bytes say which format) of a size the
 * plan takes. Returns the file's link to download, format, size (when told) and name.
 */
async function probe(e: Env, raw: string) {
  const link = fileLink(checkedUrl(e, raw));
  const { response, url } = await openLink(e, link.href, AbortSignal.timeout(15000));
  const reader = response.body!.getReader();
  let first = new Uint8Array(0);
  try {
    while (first.length < 64) {
      const { done, value } = await reader.read();
      if (done) break;
      const joined = new Uint8Array(first.length + value.length);
      joined.set(first);
      joined.set(value, first.length);
      first = joined;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const mime = videoMime(first);
  if (!mime) throw new Error(first.length ? "LINK_FORMAT" : "MEDIA_EMPTY");
  const length = Number(response.headers.get("Content-Length"));
  return { link: link.href, mime, bytes: Number.isSafeInteger(length) && length > 0 ? length : null, name: fileName(response, url, link) };
}

/**
 * Imports a video from a link for clips: checks and opens the link at once, reserves its size in the person's storage
 * and starts the download (the workflow, `importId`). The file then shows as checking, like an upload.
 */
export async function importLink(env: Env, user: DbUser, raw: string) {
  requireVerified(user);
  if (!env.CONTENT) throw new HTTPException(503, { message: "Importing videos is being set up. Please upload the file instead." });
  if ((await hit(env, "import-links", HOUR, user.id)) > LINKS_PER_HOUR) throw new HTTPException(429, { message: "That's a lot of links for one hour. Try again later." });
  const active = await env.DB.prepare("SELECT COUNT(*) AS n FROM media_assets WHERE user_id=? AND status='checking' AND json_extract(meta,'$.import') IS NOT NULL")
    .bind(user.id).first<{ n: number }>();
  if ((active?.n || 0) >= ACTIVE_IMPORTS) throw new HTTPException(429, { message: `${ACTIVE_IMPORTS} videos are being imported for you. Wait for one to finish, then try again.` });
  let found: Awaited<ReturnType<typeof probe>>;
  try {
    found = await probe(env, raw);
  } catch (e) {
    throw new HTTPException(422, { message: e instanceof PlatformLink ? e.advice : importFailure(e) });
  }
  const plan = planById((await allowance(env, user)).plan), max = plan.videoMb * MB;
  if (found.bytes && found.bytes > max)
    throw new HTTPException(413, { message: `Videos can be up to ${(max / MB).toLocaleString("en-US")} MB${plan.id === "free" ? " on the free trial; paid plans take videos up to 2 hours" : ""}.` });
  // The size is reserved now (the plan's largest video when the link doesn't tell), so imports can't overfill storage.
  return startImport(env, user, plan, { name: found.name, mime: found.mime, bytes: found.bytes || max, source: { url: found.link, limit: found.bytes || max } });
}

/**
 * Creates an imported video (checking, `meta.import` saying where it comes from and the bytes it may take, which are
 * reserved in the person's storage now) and starts its download in the workflow.
 */
async function startImport(env: Env, user: DbUser, plan: Plan, d: { name: string; mime: string; bytes: number; source: Record<string, unknown> }) {
  const id = uid();
  try {
    await env.DB.prepare(
      "INSERT INTO media_assets(id,user_id,kind,name,object_key,mime,bytes,status,meta,created_at,updated_at) VALUES (?,?,'upload',?,?,?,?,'checking',?,?,?)",
    ).bind(
      id, user.id, d.name, mediaKey(user.id, id, extOf(d.mime)), d.mime, d.bytes,
      JSON.stringify({ token: token(), maxSeconds: (plan.videoMinutes || 10) * 60, import: { ...d.source, at: now() } }), now(), now(),
    ).run();
  } catch (e) {
    dbFailure(e);
  }
  if (!env.CONTENT) throw new HTTPException(503, { message: "The import couldn't start. Please try again." });
  try {
    await env.CONTENT.create({ id: `import-${id}`, params: { importId: id } });
  } catch {
    await env.DB.prepare("DELETE FROM media_assets WHERE id=?").bind(id).run();
    throw new HTTPException(503, { message: "The import couldn't start. Please try again." });
  }
  return id;
}

/**
 * The workflow's download of an imported video into storage; false when there is nothing to download (the import was
 * deleted or already failed). The link is followed again, under the same rules; the file may not grow past the size
 * reserved for it.
 */
export async function downloadImport(e: Env, assetId: string): Promise<boolean> {
  const a = await e.DB.prepare("SELECT object_key,mime,meta,status FROM media_assets WHERE id=?").bind(assetId).first<{ object_key: string; mime: string; meta: string; status: string }>();
  const link = json<any>(a?.meta, {}).import;
  if (!a || a.status !== "checking" || typeof link?.url !== "string") return false;
  // Seen working, so maintenance does not take a long download for a check that never answered.
  await e.DB.prepare("UPDATE media_assets SET updated_at=? WHERE id=?").bind(now(), assetId).run();
  const { response } = await openLink(e, link.url, AbortSignal.timeout(40 * 60000));
  const bytes = await storeStream(e, a.object_key, response, Number(link.limit) || 0, a.mime);
  const kept = await e.DB.prepare("UPDATE media_assets SET bytes=?,meta=json_remove(meta,'$.import'),updated_at=? WHERE id=? AND status='checking'").bind(bytes, now(), assetId).run();
  // Deleted (or failed by maintenance) while it downloaded: the file is not kept.
  if (!kept.meta?.changes) {
    await e.MEDIA.delete(a.object_key);
    return false;
  }
  return true;
}
