import { json } from "../db";
import { platforms, postCaption, type PlatformId } from "../../shared/social";
import { clip } from "./http";

// How a video goes out on a network: its text, title and checks.

export type VideoRow = {
  id: string;
  user_id: string;
  spec: string;
  hook: string;
  caption: string;
  title: string;
  status: string;
  render_status: string;
  video_asset: string | null;
  cover_asset: string | null;
  duration: number;
};

/** The text to publish: caption, a blank line and the hashtags, cut to the network's limit (hashtags kept). */
export function postText(video: VideoRow, platform: PlatformId) {
  const spec = json<any>(video.spec, {});
  const caption = String(video.caption || spec.caption || "").trim();
  const { text, hashtags } = postCaption(caption, Array.isArray(spec.hashtags) ? spec.hashtags : [], platform);
  const firstLine = caption.split("\n").find((l) => l.trim())?.trim() || "";
  const title = clip(String(spec.title || video.title || firstLine || video.hook || "").replace(/\s+/g, " ").trim(), 100);
  return { text, caption, hashtags, title };
}

/** AI media in the video (an AI voice, AI pictures or clips): disclosed where the network asks. */
export function synthetic(video: VideoRow) {
  const spec = json<any>(video.spec, {});
  return spec.narration?.kind === "voice" || (spec.scenes || []).some((s: any) => s?.source === "image" || s?.source === "clip") || !!spec.generated;
}

const span = (s: number) => (s % 60 === 0 ? `${s / 60} minute${s === 60 ? "" : "s"}` : `${s} seconds`);

/** Why the video cannot go to this network as it is, or null. */
export function unfit(video: VideoRow, platform: PlatformId): string | null {
  const facts = platforms[platform];
  if (!video.video_asset) return "This video isn't made yet.";
  const d = Number(video.duration) || 0;
  if (d && d < facts.video.min) return `This video is too short for ${facts.name}: it needs at least ${span(facts.video.min)}.`;
  if (d > facts.video.max) return `This video is too long for ${facts.name}: the limit is ${span(facts.video.max)}.`;
  return null;
}
