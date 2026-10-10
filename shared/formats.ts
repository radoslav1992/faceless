import { z } from "zod";
import { captionStyles, type CaptionStyle } from "./captions";
import { clipCredits, pictureCredits, speechSeconds, videoCredits, voiceCredits } from "./credits";
import { defaultLook, textLookSchema } from "./overlay";
import { videoKinds } from "./templates";
import {
  clipPrompt, narrationKey, narrationSchema, scenePrompt, storySceneSchema, storyScript, storyStyleIds, STORY_MAX_CHARS, STORY_MAX_SCENES, type StoryStyle,
} from "./story";

// The editable description ("spec") of a video: a narrated video (shared/story.ts) whose scenes reference media by ID
// (the owner's uploads, the shared library, AI pictures and clips once made) or ask for AI media with a description.
// The server owns everything under `generated` (the recorded voice and its word timings): an edit from the browser
// never sets it.

const uuid = z.uuid();
/** A library track or an own upload (audio), at a volume. */
export const musicSchema = z
  .object({ trackId: uuid.optional(), assetId: uuid.optional(), volume: z.number().min(0).max(1).default(0.25) })
  .refine((m) => !!m.trackId !== !!m.assetId, "Choose one track.")
  .nullable()
  .default(null);
export type Music = z.infer<typeof musicSchema>;

const hashtag = z.string().trim().regex(/^#?[\p{L}\p{N}_]{1,60}$/u).transform((t) => (t.startsWith("#") ? t : `#${t}`));
const generatedVoice = z.object({
  /** What the voice was made from; a change asks for a new (paid) recording. */
  key: z.string().max(200),
  voiceAssetId: uuid.optional(),
  words: z.array(z.object({ text: z.string().max(80), start: z.number(), end: z.number() })).max(2000).default([]),
});
export type Generated = z.infer<typeof generatedVoice>;

/**
 * A narrated video: the voiceover, its scenes (words, picture, transition) in one picture style with one recurring
 * subject, subtitles over the whole voice and music under it. `generated` is the AI voice once recorded.
 */
/** On-screen title over the top of the video: a POV line, a character's name, a storytime question. */
export const headlineSchema = z.object({
  text: z.string().trim().min(1).max(140),
  look: textLookSchema.default({ ...defaultLook(), position: "top", background: "#ffffff", color: "#111111", stroke: 0 }),
  /** Seconds it stays (0: the whole video). */
  seconds: z.number().min(0).max(180).default(0),
});
export type Headline = z.infer<typeof headlineSchema>;
/** One clip (the owner's video or a library clip) that loops behind the whole video instead of a picture per scene. */
export const backdropSchema = z.object({ libraryId: uuid.optional(), assetId: uuid.optional() })
  .refine((b) => !!b.libraryId !== !!b.assetId, "Choose one background clip.");
export type Backdrop = z.infer<typeof backdropSchema>;

export const storySpec = z.object({
  format: z.literal("story").default("story"),
  /** The video type it was made as (shared/templates.ts). */
  kind: z.enum(videoKinds).default("story"),
  narration: narrationSchema,
  /** The narration's language (ISO 639-1), read by the AI voice. */
  language: z.string().regex(/^[a-z]{2,3}$/).default("en"),
  scenes: z.array(storySceneSchema).min(1).max(STORY_MAX_SCENES)
    .refine((scenes) => storyScript(scenes).length <= STORY_MAX_CHARS * 2, "The script is too long for one video."),
  style: z.enum(storyStyleIds as [StoryStyle, ...StoryStyle[]]).default("doodle"),
  /** One description of the recurring subject or character, repeated in every scene's picture prompt. */
  subject: z.string().trim().max(300).default(""),
  captions: z.object({ enabled: z.boolean().default(true), style: z.enum(captionStyles).default("keyword" satisfies CaptionStyle) }).default({ enabled: true, style: "keyword" }),
  headline: headlineSchema.nullable().default(null),
  backdrop: backdropSchema.nullable().default(null),
  music: musicSchema,
  generated: generatedVoice.optional(),
  /** Post text (TikTok description, Instagram caption, YouTube description). */
  caption: z.string().trim().max(2200).default(""),
  hashtags: z.array(hashtag).max(15).default([]),
  /** YouTube title (and the video's name in the app). */
  title: z.string().trim().max(100).default(""),
  /** Short topic label, e.g. "The octopus heart". */
  topic: z.string().trim().max(60).default(""),
});
export const specSchema = storySpec;
export type StorySpec = z.infer<typeof storySpec>;
export type Spec = StorySpec;

/** The AI voice is recorded for the video's current words and voice (no new recording is paid). */
export function narrationCurrent(spec: StorySpec) {
  return spec.narration.kind === "voice" && !!spec.generated?.voiceAssetId && spec.generated.key === narrationKey(spec.narration.voiceId, storyScript(spec.scenes));
}

/**
 * An AI picture or clip to make: its asset goes to `key` of the scene at `path`. A clip `from` a picture is made from
 * the asset in that field of the same scene (made earlier in the same run); `seconds`: its length.
 */
export type PendingMedia = { kind: "image" | "clip"; prompt: string; path: (string | number)[]; key: string; from?: string; seconds?: 5 | 10 };
/** Every AI picture or clip the video still asks for, pictures first and then the clips made from them. */
export function pendingMedia(spec: Spec): PendingMedia[] {
  const out: PendingMedia[] = [];
  // A background clip replaces the pictures of every scene.
  if (spec.backdrop) return out;
  spec.scenes.forEach((s, i) => {
    if ((s.source === "image" || s.source === "clip") && !s.imageId)
      out.push({ kind: "image", prompt: scenePrompt(s.description, spec.subject, spec.style), path: ["scenes", i], key: "imageId" });
  });
  spec.scenes.forEach((s, i) => {
    if (s.source === "clip" && !s.clipId) out.push({ kind: "clip", prompt: clipPrompt(s.description), path: ["scenes", i], key: "clipId", from: "imageId", seconds: s.clipSeconds });
  });
  return out;
}
/**
 * Credits to make a video ready. A new video costs its length (narration and every picture included, `seconds`: the
 * owner's recording when it narrates); a made one only what an edit asks for again: new narration for changed words,
 * new pictures. AI clips are paid by their length either way.
 */
export function specCredits(spec: Spec, initial: boolean, seconds?: number) {
  const pending = pendingMedia(spec);
  const clips = clipCredits(pending.filter((m) => m.kind === "clip").map((m) => m.seconds ?? 5));
  if (initial) return videoCredits(seconds ?? spokenSeconds(spec)) + clips;
  const voice = spec.narration.kind === "voice" && !narrationCurrent(spec) ? voiceCredits(storyScript(spec.scenes)) : 0;
  return voice + pictureCredits(pending.filter((m) => m.kind === "image").length) + clips;
}
export { voiceCredits, speechSeconds };

/** How long the narration speaks, which a new video is charged by: its recorded words, else the script's estimate. */
export function spokenSeconds(spec: Spec) {
  return narrationCurrent(spec) && spec.generated?.words.length ? spec.generated.words.at(-1)!.end : speechSeconds(storyScript(spec.scenes));
}
/** Rough length of the finished video in seconds (the real one is known after rendering). */
export function estimatedSeconds(spec: Spec) {
  return spokenSeconds(spec) + (narrationCurrent(spec) && spec.generated?.words.length ? 0.3 : 0.5);
}
/** All of the owner's media asset IDs a spec references, for ownership checks. */
export function referencedAssets(spec: Spec): string[] {
  const ids: (string | undefined)[] = [];
  if (spec.narration.kind === "upload") ids.push(spec.narration.assetId);
  for (const s of spec.scenes) ids.push(s.imageId, s.clipId, s.assetId);
  if (spec.music?.assetId) ids.push(spec.music.assetId);
  if (spec.backdrop?.assetId) ids.push(spec.backdrop.assetId);
  return [...new Set(ids.filter((x): x is string => !!x))];
}
/** Library items a spec references. */
export function referencedLibrary(spec: Spec): string[] {
  const ids: (string | undefined)[] = [spec.music?.trackId, spec.backdrop?.libraryId, ...spec.scenes.map((s) => s.libraryId)];
  return [...new Set(ids.filter((x): x is string => !!x))];
}
/** The hook shown in lists: the first sentence. */
export function specHook(spec: Spec) {
  return storyScript(spec.scenes).split(/(?<=[.!?…])\s/)[0] || spec.topic || "";
}
/** The parts of a spec that change the picture or sound; edits elsewhere (caption, hashtags, title) need no new render. */
export function visualPart(spec: Spec) {
  const { caption: _c, hashtags: _h, title: _t, topic: _o, ...rest } = spec;
  return JSON.stringify(rest);
}
