import { z } from "zod";
import { CLIP_CREDITS, CLIP_SECONDS, videoCredits, type ClipQuality } from "./credits";
import type { StorySpec } from "./formats";
import { filmSpec } from "./film";

// Product ads (a test, for administrators only): a short ad filmed from the owner's photos of a product.
//   - The owner uploads one to four photos of the product and says what it is; the writer writes a few shots with a
//     line of voiceover each (server/story.ts).
//   - Every shot's picture is drawn with the photos as references, so it shows that very product in the shot's
//     setting; the shot is then filmed from its picture by the video model, again with the photos, so the product
//     keeps its shape, colours and label while the camera or a hand moves (server/providers/fal.ts adShotRequest:
//     MiniMax H3 Max, billed by the second).
//   - It is put together like a cinematic video (shared/film.ts): the shots change on hard cuts and their own sound
//     plays quietly under the recorded voice and the music; the film's grade and grain are left out, so the product
//     keeps its colours.
// It is the `product` of a video of kind "ad" (shared/templates.ts). Its price is the usual one: the video by its
// length, plus every shot as a high-quality clip by its length (shared/credits.ts).

/** How many photos of the product an ad takes: the video model's free allowance of reference pictures covers four. */
export const PRODUCT_PHOTOS_MAX = 4;
/** A shot costs what the film's shots cost: about $0.08 a second of clip (two credits per five seconds). */
export const AD_CLIP_QUALITY: ClipQuality = "high";
/** The lengths an ad is offered in (seconds of voiceover). */
export const adLengths = [15, 20, 30] as const;

export const productSchema = z.object({
  /** The owner's photos of the product (their uploads), the first one the main view. */
  assets: z.array(z.uuid()).min(1).max(PRODUCT_PHOTOS_MAX).refine((ids) => new Set(ids).size === ids.length, "Add each photo once."),
  /** What the product is called, as the owner wrote it (shown to the picture and video models with the photos). */
  name: z.string().trim().max(80).default(""),
});
export type Product = z.infer<typeof productSchema>;

/** How each shot is framed, in turn: an ad varies its distance to the product. */
const SHOTS = ["a close-up product shot", "a medium shot of the product in use", "a hero shot of the product, centred and clear", "a detail shot of the product's surface", "a wide lifestyle shot with the product in it"];
/** How each shot moves, in turn: slow moves keep the product's shape. */
const MOVES = ["A slow push-in on the product", "A slow orbit around the product", "A gentle handheld move as the product is used", "A slow pull-back that reveals the setting", "A locked-off camera, only the hands and the light move"];
const named = (name: string) => (name.trim() ? ` (${name.trim().replace(/[.!?]$/, "")})` : "");
/** Added to shot `n`'s picture description: the product is the one in the photos, framed as an ad would. */
export const adStill = (n: number, name = "") =>
  ` The product${named(name)} is the one in the reference photos, shown clearly and whole unless the shot is a detail. Composed as ${SHOTS[n % SHOTS.length]} from an advertisement: clean light, shallow depth of field, nothing cluttered.`;
/** The description sent to the video model with shot `n`'s picture: what happens, the camera's move, and the sound. */
export const adClipPrompt = (description: string, n: number) =>
  `${description.trim().replace(/([^.!?])$/, "$1.")} ${MOVES[n % MOVES.length]}. Natural, physically plausible motion at real speed; the product stays exactly as it is, with the same shape, proportions, colours and label, never morphing. Sound: only what the shot would sound like (the product being handled, the room), no speech, no voices and no music.`.slice(0, 900);
/** What the video model is told about the photos sent with a shot (its "Image 1" onwards). */
export const productNote = (photos: number, name = "") =>
  `${photos === 1 ? "Image 1 is a photo" : `Images 1 to ${photos} are photos`} of the product${named(name)}: keep it looking exactly as in ${photos === 1 ? "it" : "them"} from every side, with the same shape, colours, materials, label and logo.`;

/**
 * A drafted video as a product ad: every scene a shot filmed from its picture (5 or 10 s, by the script's estimated
 * timing) on a hard cut, with the product's photos; no recurring character of the writer's (the product is the one
 * in the photos), no background clip, no presenter and no sound effects from the library.
 */
export function adSpec(spec: StorySpec, product: Product): StorySpec {
  const { sounds: _sounds, ...filmed } = filmSpec({ ...spec, backdrop: null, presenter: null }, { quality: AD_CLIP_QUALITY });
  return { ...filmed, kind: "ad", subject: "", product, scenes: filmed.scenes.map(({ soundId: _soundId, ...s }) => s) };
}
/** Roughly what an ad of `seconds` costs before it is written: the video and a shot for every five seconds of it. */
export const adCredits = (seconds: number) => videoCredits(seconds) + CLIP_CREDITS[AD_CLIP_QUALITY] * Math.ceil(seconds / CLIP_SECONDS);
