import { z } from "zod";
import { captionStyles, type CaptionStyle } from "./captions";
import { clipCredits, highlightCredits, pictureCredits, presenterCredits, speechSeconds, videoCredits, voiceCredits, type ClipModel, type ClipQuality } from "./credits";
import { presenterScene, presenterSchema } from "./presenter";
import { defaultLook, textLookSchema } from "./overlay";
import { videoKinds } from "./templates";
import { HIGHLIGHT_MAX_SECONDS, HIGHLIGHT_MIN_SECONDS, layoutSchema } from "./highlights";
import { LONG_VIDEO_SECONDS } from "./speech";
import { trackSchema } from "./track";
import {
  clipPrompt, narrationKey, narrationSchema, placeKey, placeOf, placeSchema, scenePrompt, storySceneSchema, storyScript, storyStyleIds, STORY_MAX_CHARS, STORY_MAX_PLACES, STORY_MAX_SCENES, voicedScript, type StoryStyle,
} from "./story";

// The editable description ("spec") of a video, one of two formats:
// - "story": a narrated video (shared/story.ts) whose scenes reference media by ID (the owner's uploads, the shared
//   library, AI pictures and clips once made) or ask for AI media with a description;
// - "highlight": a clip of one of the owner's long videos (shared/highlights.ts), cut, framed and captioned.
// The server owns `generated` (a story's recorded voice and its word timings), `presented` (its presenter's video) and
// `tracked` (where a clip's people are): an edit from the browser never sets them.

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
  /** The world of the whole video (place and era, time of day, light, colours), repeated in every picture prompt. */
  look: z.string().trim().max(300).default(""),
  /** The places scenes are set in (by `place`), each described once; labels differ. */
  places: z.array(placeSchema).max(STORY_MAX_PLACES).default([])
    .refine((places) => new Set(places.map((p) => placeKey(p.label))).size === places.length, "Give each place its own name."),
  captions: z.object({ enabled: z.boolean().default(true), style: z.enum(captionStyles).default("keyword" satisfies CaptionStyle) }).default({ enabled: true, style: "keyword" }),
  headline: headlineSchema.nullable().default(null),
  backdrop: backdropSchema.nullable().default(null),
  music: musicSchema,
  /** An on-screen presenter speaking the AI voice (shared/presenter.ts); needs the AI voice and no background clip. */
  presenter: presenterSchema.nullable().default(null),
  generated: generatedVoice.optional(),
  /** Server-owned: the presenter's video, made for `key` (presenterKey: the avatar, its quality and the words) from the recording `voiceAssetId`. */
  presented: z.object({ key: z.string().max(300), assetId: uuid, voiceAssetId: uuid }).optional(),
  /** Post text (TikTok description, Instagram caption, YouTube description). */
  caption: z.string().trim().max(2200).default(""),
  hashtags: z.array(hashtag).max(15).default([]),
  /** YouTube title (and the video's name in the app). */
  title: z.string().trim().max(100).default(""),
  /** Short topic label, e.g. "The octopus heart". */
  topic: z.string().trim().max(60).default(""),
});
export type StorySpec = z.infer<typeof storySpec>;

/** A clip: seconds `start` to `end` of one of the owner's (long) videos. */
export const highlightSourceSchema = z.object({
  assetId: uuid,
  start: z.number().min(0).max(LONG_VIDEO_SECONDS),
  end: z.number().min(0).max(LONG_VIDEO_SECONDS),
}).refine((s) => s.end - s.start >= HIGHLIGHT_MIN_SECONDS - 0.01 && s.end - s.start <= HIGHLIGHT_MAX_SECONDS + 0.01,
  `A clip lasts ${HIGHLIGHT_MIN_SECONDS} seconds to ${HIGHLIGHT_MAX_SECONDS / 60} minutes.`);
export const highlightSpec = z.object({
  format: z.literal("highlight"),
  kind: z.literal("highlight").default("highlight"),
  source: highlightSourceSchema,
  /** Instant cuts (shared/cuts.ts): long pauses, and filler sounds with `fillers`, are cut out. */
  cuts: z.object({ enabled: z.boolean().default(true), fillers: z.boolean().default(true) }).default({ enabled: true, fillers: true }),
  layout: layoutSchema.default({ kind: "follow" }),
  /** Captions of what is said (the video's transcript), in one of the styles. */
  captions: z.object({
    enabled: z.boolean().default(true),
    style: z.enum(captionStyles).default("bold" satisfies CaptionStyle),
    position: z.enum(["bottom", "middle", "top"]).default("bottom"),
  }).default({ enabled: true, style: "bold", position: "bottom" }),
  /** The hook title over the first seconds (or the whole clip). */
  headline: headlineSchema.nullable().default(null),
  music: musicSchema,
  /** What the writer said of the moment when it was found (shown with the clip; never rendered). */
  moment: z.object({ score: z.number().int().min(0).max(99), why: z.string().trim().max(200).default("") }).nullable().default(null),
  /** Server-owned: where the people are in this moment (measured when it is made), for `key` = trackKey. */
  tracked: z.object({ key: z.string().max(200), track: trackSchema }).optional(),
  caption: z.string().trim().max(2200).default(""),
  hashtags: z.array(hashtag).max(15).default([]),
  title: z.string().trim().max(100).default(""),
  topic: z.string().trim().max(60).default(""),
});
export type HighlightSpec = z.infer<typeof highlightSpec>;

/** Either format; a spec without one is a story (videos saved before clips existed). */
export const specSchema = z.discriminatedUnion("format", [storySpec, highlightSpec]);
export type Spec = StorySpec | HighlightSpec;
export const isHighlight = (spec: Spec): spec is HighlightSpec => spec.format === "highlight";
/** The speaker tracker's version: a better tracker measures every clip again the next time it is made. */
export const TRACKER = 2;
/** The moment a clip's people were measured for, by this tracker: a new moment (or tracker) needs a new measurement. */
export const trackKey = (spec: HighlightSpec) => `${spec.source.assetId}:${spec.source.start}:${spec.source.end}@${TRACKER}`;
/** How much of moment `b` lies inside moment `a` (0–1), for re-pricing a moved clip. */
export function momentOverlap(a: { start: number; end: number }, b: { start: number; end: number }) {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start)) / Math.max(0.01, b.end - b.start);
}

/** The AI voice is recorded for the video's current words and voice (no new recording is paid). */
export function narrationCurrent(spec: StorySpec) {
  return spec.narration.kind === "voice" && !!spec.generated?.voiceAssetId && spec.generated.key === narrationKey(spec.narration.voiceId, voicedScript(spec.scenes));
}

/** What a presenter video is made from: the avatar, its quality and the AI voice's words (a change needs a new one). */
export const presenterKey = (spec: StorySpec) =>
  spec.presenter && spec.narration.kind === "voice"
    ? `${spec.presenter.avatarId}:${spec.presenter.quality}:${narrationKey(spec.narration.voiceId, voicedScript(spec.scenes))}` : "";
/**
 * The presenter's video is made for the video's current avatar, quality and words, from the recording it keeps (no
 * new one is paid). A new recording always needs a new presenter video: the lips follow the recording.
 */
export const presenterCurrent = (spec: StorySpec) =>
  !!spec.presenter && narrationCurrent(spec) && !!spec.presented && spec.presented.key === presenterKey(spec) && spec.presented.voiceAssetId === spec.generated?.voiceAssetId;
/** Whether scene `index` of a story shows its presenter instead of a picture. */
export const showsPresenter = (spec: StorySpec, index: number) =>
  !!spec.presenter && !spec.backdrop && presenterScene(spec.presenter.layout, spec.scenes[index], index);
/** Whether the video shows its presenter at all (in "Presenter + pictures", scenes with chosen media keep them). */
export const presenterShown = (spec: StorySpec) => spec.scenes.some((_, i) => showsPresenter(spec, i));
/** Whether the video needs a new presenter video (paid): it shows a presenter that has none for its avatar, quality and words. */
export const presenterNeeded = (spec: StorySpec) => presenterShown(spec) && !presenterCurrent(spec);

/**
 * An AI picture or clip to make: its asset goes to `key` of the scene at `path`. A clip `from` a picture is made from
 * the asset in that field of the same scene (made earlier in the same run); `seconds`: its length.
 */
export type PendingMedia = {
  kind: "image" | "clip"; prompt: string; path: (string | number)[]; key: string; from?: string; seconds?: 5 | 10; quality?: ClipQuality;
  /** The clip model an administrator chose for the scene. */
  clipModel?: ClipModel;
};
/** Every AI picture or clip the video still asks for, pictures first and then the clips made from them. */
export function pendingMedia(spec: Spec): PendingMedia[] {
  const out: PendingMedia[] = [];
  // A clip of a long video asks for no AI media; a background clip replaces the pictures of every scene.
  if (isHighlight(spec) || spec.backdrop) return out;
  // A scene the presenter speaks on shows no picture.
  spec.scenes.forEach((s, i) => {
    if ((s.source === "image" || s.source === "clip") && !s.imageId && !showsPresenter(spec, i))
      out.push({ kind: "image", prompt: scenePrompt(s.description, spec.subject, spec.style, spec.look, placeOf(spec.places, s.place)), path: ["scenes", i], key: "imageId" });
  });
  spec.scenes.forEach((s, i) => {
    if (s.source === "clip" && !s.clipId && !showsPresenter(spec, i))
      out.push({ kind: "clip", prompt: clipPrompt(s.description), path: ["scenes", i], key: "clipId", from: "imageId", seconds: s.clipSeconds, quality: s.clipQuality, clipModel: s.clipModel });
  });
  return out;
}
/**
 * Credits to make a video ready. A new video costs its length (narration and every picture included, `seconds`: the
 * owner's recording when it narrates); a made one only what an edit asks for again: new narration for changed words,
 * new pictures. AI clips are paid by their length either way, and a presenter by the voice's length whenever it has no
 * video for the current avatar, quality and words. A clip of a long video costs its moment's length, and again only
 * when an edit (from `before`, the stored spec) moves it mostly onto other footage.
 */
export function specCredits(spec: Spec, initial: boolean, seconds?: number, before?: Spec) {
  // A clip: its moment's length when it is new, or moved mostly onto other footage of the video; other edits are free.
  if (isHighlight(spec)) {
    const length = spec.source.end - spec.source.start;
    if (initial) return highlightCredits(length);
    const kept = before && isHighlight(before) && before.source.assetId === spec.source.assetId && momentOverlap(before.source, spec.source) >= 0.5;
    return kept || !before ? 0 : highlightCredits(length);
  }
  const pending = pendingMedia(spec);
  const clips = clipCredits(pending.filter((m) => m.kind === "clip").map((m) => ({ seconds: m.seconds ?? 5, quality: m.quality })));
  const presenter = spec.presenter && presenterNeeded(spec) ? presenterCredits(spokenSeconds(spec), spec.presenter.quality) : 0;
  if (initial) return videoCredits(seconds ?? spokenSeconds(spec)) + clips + presenter;
  const voice = spec.narration.kind === "voice" && !narrationCurrent(spec) ? voiceCredits(storyScript(spec.scenes)) : 0;
  return voice + pictureCredits(pending.filter((m) => m.kind === "image").length) + clips + presenter;
}
export { voiceCredits, speechSeconds };

/** How long the narration speaks, which a new video is charged by: its recorded words, else the script's estimate. */
export function spokenSeconds(spec: Spec) {
  if (isHighlight(spec)) return spec.source.end - spec.source.start;
  return narrationCurrent(spec) && spec.generated?.words.length ? spec.generated.words.at(-1)!.end : speechSeconds(storyScript(spec.scenes));
}
/** Rough length of the finished video in seconds (the real one is known after rendering). */
export function estimatedSeconds(spec: Spec) {
  if (isHighlight(spec)) return spokenSeconds(spec);
  return spokenSeconds(spec) + (narrationCurrent(spec) && spec.generated?.words.length ? 0.3 : 0.5);
}
/** All of the owner's media asset IDs a spec references, for ownership checks. */
export function referencedAssets(spec: Spec): string[] {
  const ids: (string | undefined)[] = [];
  if (isHighlight(spec)) {
    ids.push(spec.source.assetId, spec.music?.assetId);
    return [...new Set(ids.filter((x): x is string => !!x))];
  }
  if (spec.narration.kind === "upload") ids.push(spec.narration.assetId);
  ids.push(spec.presented?.assetId);
  for (const s of spec.scenes) ids.push(s.imageId, s.clipId, s.assetId);
  if (spec.music?.assetId) ids.push(spec.music.assetId);
  if (spec.backdrop?.assetId) ids.push(spec.backdrop.assetId);
  return [...new Set(ids.filter((x): x is string => !!x))];
}
/** Library items a spec references. */
export function referencedLibrary(spec: Spec): string[] {
  if (isHighlight(spec)) return spec.music?.trackId ? [spec.music.trackId] : [];
  const ids: (string | undefined)[] = [spec.music?.trackId, spec.backdrop?.libraryId, ...spec.scenes.map((s) => s.libraryId)];
  return [...new Set(ids.filter((x): x is string => !!x))];
}
/** The hook shown in lists: the first sentence. */
export function specHook(spec: Spec) {
  if (isHighlight(spec)) return spec.headline?.text || spec.title || spec.topic || "Clip";
  return storyScript(spec.scenes).split(/(?<=[.!?…])\s/)[0] || spec.topic || "";
}
/**
 * The parts of a spec that change the picture or sound; edits elsewhere (caption, hashtags, title, a clip's moment
 * note) need no new render.
 */
export function visualPart(spec: Spec) {
  const { caption: _c, hashtags: _h, title: _t, topic: _o, ...rest } = spec;
  if ("moment" in rest) delete (rest as Partial<HighlightSpec>).moment;
  return JSON.stringify(rest);
}
