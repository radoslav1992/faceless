import { z } from "zod";
import { presenterQualities, type PresenterQuality } from "./credits";

// An on-screen presenter: an avatar from the shared avatar library (Admin → Presenters, HeyGen's avatars) who speaks the
// video's AI voice, lip-synced to it. The voice stays the ElevenLabs narration; the avatar service only animates the
// avatar to it, once for the whole voice, so scene edits, timing and the layout never need a new presenter video.

export { presenterQualities, type PresenterQuality };
/** The avatar service's engine for each quality (an avatar offers the qualities its engines allow). */
export const PRESENTER_ENGINES: Record<PresenterQuality, "avatar_iv" | "avatar_v"> = { regular: "avatar_iv", high: "avatar_v" };
export const presenterQualityInfo: Record<PresenterQuality, { name: string; note: string }> = {
  regular: { name: "Regular", note: "Natural lip-sync and expressions" },
  high: { name: "High", note: "The most lifelike motion" },
};
/**
 * "mix": the presenter on the first scene and every other one, pictures between (a scene with the owner's or a
 * library's media keeps it); "full": the presenter on every scene.
 */
export const presenterLayouts = ["mix", "full"] as const;
export type PresenterLayout = (typeof presenterLayouts)[number];
export const presenterLayoutInfo: Record<PresenterLayout, { name: string; note: string }> = {
  mix: { name: "Presenter + pictures", note: "On camera for the hook and every other scene, pictures between" },
  full: { name: "Presenter only", note: "On camera the whole video" },
};
export const presenterSchema = z.object({
  avatarId: z.uuid(),
  quality: z.enum(presenterQualities).default("regular"),
  layout: z.enum(presenterLayouts).default("mix"),
});
export type Presenter = z.infer<typeof presenterSchema>;
/** Whether scene `index` shows the presenter in `layout`. */
export function presenterScene(layout: PresenterLayout, scene: { source: string }, index: number) {
  if (layout === "full") return true;
  return index % 2 === 0 && (scene.source === "image" || scene.source === "clip");
}
/** An avatar as people choose it (GET /api/public/avatars). */
export type Avatar = { id: string; name: string; gender: "female" | "male" | ""; preview: string | null; qualities: PresenterQuality[] };
