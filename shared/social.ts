// What each network accepts from us, used to check a video before it is scheduled and to label the UI.
export const platformIds = ["tiktok", "youtube", "instagram"] as const;
export type PlatformId = (typeof platformIds)[number];
export const platforms: Record<PlatformId, {
  name: string; short: string; color: string; captionMax: number; video: { min: number; max: number }; note: string;
}> = {
  tiktok: { name: "TikTok", short: "TikTok", color: "#111111", captionMax: 2200, video: { min: 3, max: 600 }, note: "Posts to your TikTok profile." },
  youtube: { name: "YouTube", short: "Shorts", color: "#ff0000", captionMax: 5000, video: { min: 1, max: 180 }, note: "Shorts up to 3 minutes." },
  instagram: { name: "Instagram", short: "Reels", color: "#e1306c", captionMax: 2200, video: { min: 3, max: 900 }, note: "Reels on professional (business or creator) accounts." },
};
export const isPlatform = (p: string): p is PlatformId => (platformIds as readonly string[]).includes(p);

/** At most `max` UTF-16 units (what the networks count), never splitting a surrogate pair. */
export function clipText(text: string, max: number) {
  if (text.length <= max) return text;
  let out = text.slice(0, max);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out.trimEnd();
}

const hashtag = (t: unknown) => typeof t === "string" && /^#?[\p{L}\p{N}_]{1,60}$/u.test(t.trim()) ? (t.trim().startsWith("#") ? t.trim() : `#${t.trim()}`) : "";

/**
 * The text a post carries: the caption, a blank line and the hashtags (at most 30), cut to the network's limit with
 * the hashtags kept. Also what people paste into a TikTok draft, which can't carry it.
 */
export function postCaption(caption: string, tags: readonly unknown[], platform: PlatformId) {
  const hashtags = tags.map(hashtag).filter(Boolean).slice(0, 30);
  const max = platforms[platform].captionMax;
  const tail = hashtags.join(" ");
  const text = !tail ? clipText(caption, max)
    : tail.length + 2 >= max ? clipText(`${caption}\n\n${tail}`, max)
    : [clipText(caption, max - tail.length - 2), tail].filter(Boolean).join("\n\n");
  return { text, hashtags };
}
