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
//
// Two video models are being compared (the product's `model`):
//   - "minimax", as above: MiniMax H3 Max films every shot on its own, from a picture drawn for it.
//   - "seedance": Seedance films the whole ad in one shot. No pictures are drawn: one request takes the photos and
//     all the shots' descriptions and returns one clip, cut from shot to shot by the model itself, up to 15 seconds
//     long (server/providers/fal.ts oneShotRequest). It is made after the voice, as long as the voice, and plays
//     behind the whole video with its own sound, as the video's background clip (`backdrop`), under the voice, the
//     subtitles and the music. It costs about three times as much to run, and as many credits more.

/** How many photos of the product an ad takes: the video model's free allowance of reference pictures covers four. */
export const PRODUCT_PHOTOS_MAX = 4;
/** A shot costs what the film's shots cost: about $0.08 a second of clip (two credits per five seconds). */
export const AD_CLIP_QUALITY: ClipQuality = "high";
/** The lengths an ad is offered in (seconds of voiceover). */
export const adLengths = [15, 20, 30] as const;
/** The video models an ad is filmed with: MiniMax H3 Max shot by shot, or Seedance in one shot. */
export const adModels = ["minimax", "seedance"] as const;
export type AdModel = (typeof adModels)[number];
export const adModelNames: Record<AdModel, string> = { minimax: "MiniMax H3 Max · shot by shot", seedance: "Seedance 2.0 Fast · one shot" };
/** A one-shot ad is one clip of 4 to 15 seconds (what Seedance makes in one request). */
export const ONE_SHOT_SECONDS = { min: 4, max: 15 } as const;
/** Credits per five seconds of a one-shot ad: about $0.24 a second to run, three times a shot's $0.08. */
export const ONE_SHOT_CREDITS = 6;
/** How loud a one-shot ad's own sound plays under the voice and the music (0–1). */
export const ONE_SHOT_SOUND = 0.3;

export const productSchema = z.object({
  /** The owner's photos of the product (their uploads), the first one the main view. */
  assets: z.array(z.uuid()).min(1).max(PRODUCT_PHOTOS_MAX).refine((ids) => new Set(ids).size === ids.length, "Add each photo once."),
  /** What the product is called, as the owner wrote it (shown to the picture and video models with the photos). */
  name: z.string().trim().max(80).default(""),
  /** The video model it is filmed with: shot by shot, or in one shot. */
  model: z.enum(adModels).default("minimax"),
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
  // In one shot: the scenes are the voiceover's lines and the shots' descriptions; the one clip is made with the video.
  if (product.model === "seedance") {
    const { sounds: _sounds, film: _film, ...rest } = spec;
    return { ...rest, kind: "ad", subject: "", product, backdrop: null, presenter: null, scenes: spec.scenes.map(({ soundId: _soundId, ...s }) => ({ ...s, source: "image" as const, transition: "cut" as const })) };
  }
  const { sounds: _sounds, ...filmed } = filmSpec({ ...spec, backdrop: null, presenter: null }, { quality: AD_CLIP_QUALITY });
  return { ...filmed, kind: "ad", subject: "", product, scenes: filmed.scenes.map(({ soundId: _soundId, ...s }) => s) };
}
/** How long a one-shot ad's clip is asked for, for a voice of `seconds`: whole seconds, within what one request makes. */
export const oneShotSeconds = (seconds: number) => Math.min(ONE_SHOT_SECONDS.max, Math.max(ONE_SHOT_SECONDS.min, Math.ceil(seconds + 0.3)));
/** What a one-shot clip of `seconds` costs. */
export const oneShotCredits = (seconds: number) => ONE_SHOT_CREDITS * Math.ceil(oneShotSeconds(seconds) / CLIP_SECONDS);
/**
 * The description sent to the video model for an ad in one shot: every shot in order, cut together by the model, with
 * the product as in the photos (its "@Image1" onwards), its own sound and nothing spoken or written.
 */
export function oneShotPrompt(shots: string[], photos: number, name = "") {
  const list = shots.map((d, n) => `Shot ${n + 1}: ${d.trim().replace(/[.!?]$/, "")}.`).join(" ");
  const images = photos === 1 ? "@Image1 is a photo" : `@Image1 to @Image${photos} are photos`;
  return (`A vertical advertisement for a product${named(name)}, ${shots.length} shots of about the same length joined by hard cuts. ${images} of the product: it looks exactly like ${photos === 1 ? "that" : "those"} in every shot, with the same shape, colours, materials, label and logo, never morphing. `
    + `${list} Clean advertising light, shallow depth of field, slow camera moves, natural motion at real speed. Sound: only what the shots would sound like, no speech, no voice-over and no music. No captions, titles or other text on screen.`).slice(0, 1900);
}
/** Roughly what an ad of `seconds` costs before it is written: the video, and its shots (or its one shot). */
export const adCredits = (seconds: number, model: AdModel = "minimax") =>
  videoCredits(seconds) + (model === "seedance" ? oneShotCredits(seconds) : CLIP_CREDITS[AD_CLIP_QUALITY] * Math.ceil(seconds / CLIP_SECONDS));
