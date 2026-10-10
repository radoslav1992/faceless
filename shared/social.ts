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
