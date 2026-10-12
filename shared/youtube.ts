// YouTube videos imported for clips (server/youtube-import.ts): only from a channel the person has connected, so only
// their own videos. The ID of a video in any of YouTube's link forms, and the length YouTube's API gives.

/** A YouTube video ID: 11 characters of letters, digits, "-" and "_". */
export const YOUTUBE_VIDEO = /^[A-Za-z0-9_-]{11}$/;

/**
 * The video ID of a YouTube link (youtube.com/watch?v=…, youtu.be/…, /shorts/…, /live/…, /embed/…, m. and music.
 * hosts, youtube-nocookie.com), or null for anything else.
 */
export function youtubeId(raw: string): string | null {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { return null; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase().replace(/^(www|m|music)\./, "");
  let id: string | null = null;
  if (host === "youtu.be") id = url.pathname.split("/")[1] || null;
  else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    const [, first, second] = url.pathname.split("/");
    if (first === "watch") id = url.searchParams.get("v");
    else if (["shorts", "live", "embed", "v"].includes(first)) id = second || null;
  }
  return id && YOUTUBE_VIDEO.test(id) ? id : null;
}

/** Seconds of an ISO 8601 duration as YouTube gives it ("PT1H2M3S", "P1DT2H"), or null. */
export function isoSeconds(value: unknown): number | null {
  const m = typeof value === "string" ? /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value) : null;
  if (!m || value === "P" || value === "PT") return null;
  return Number(m[1] || 0) * 86400 + Number(m[2] || 0) * 3600 + Number(m[3] || 0) * 60 + Number(m[4] || 0);
}
