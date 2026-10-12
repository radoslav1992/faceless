import { captionAss, emptyAss, withItems, withWatermark } from "./caption-ass";
import { styledCaptions, type CaptionWord } from "../shared/captions";
import { overlayItems, revealSeconds, type TextLook } from "../shared/overlay";
import { motionFor } from "../shared/layers";
import { FPS, storySegments, storyTiming, type StoryScene } from "../shared/story";
import { FRAME, type ComposePayload, type ComposeSegment } from "../shared/render";
import { trackKey, type HighlightSpec, type Spec, type StorySpec } from "../shared/formats";
import { cutWords, keptDuration, windowCuts } from "../shared/cuts";
import { clipWords } from "../shared/speech";
import { trackWindow } from "../shared/track";
import { paneWindow, placedPanes, splitHeights } from "../shared/highlights";

// A video's spec → the renderer payload. Pure: every referenced file is resolved beforehand (R2 key, length) and
// inputs are R2 keys here; the workflow turns them into capability links. Times are seconds on the output clock.

/**
 * A resolved file: its R2 key, what it is, its length, its picture size, whether it is AI-made, and (a clip's video)
 * the words said in it, on its own clock.
 */
export type Media = { key: string; kind: "image" | "video" | "audio"; duration: number; ai?: boolean; width?: number; height?: number; words?: CaptionWord[] };
export type PlanContext = {
  /** Media by asset ID or library ID. */
  media: Record<string, Media>;
  /** The voiceover (the AI voice or the owner's recording) and its words on its clock. */
  narration?: { key: string; duration: number; words: CaptionWord[] };
  /** A small mark in the corner of every video (the free trial's), or empty. */
  watermark: string;
};
export type Plan = { compose: Omit<ComposePayload, "id" | "urls"> & { keys: string[] } };

const { width: W, height: H } = FRAME;
const MAX_SECONDS = 180;
const round = (n: number) => Math.round(n * 100) / 100;

class Inputs {
  keys: string[] = [];
  add(key: string) {
    const i = this.keys.indexOf(key);
    if (i >= 0) return i;
    this.keys.push(key);
    return this.keys.length - 1;
  }
}
function need(ctx: PlanContext, id: string | undefined): Media {
  const m = id ? ctx.media[id] : undefined;
  if (!m) throw new Error("MEDIA_INPUT");
  return m;
}
/** A clip repeated (from its start) to fill `duration`: short clips loop instead of freezing. */
function fillWithClip(input: number, clip: number, duration: number): ComposeSegment[] {
  const out: ComposeSegment[] = [];
  const length = clip > 0.5 ? clip : duration;
  for (let t = 0; t < duration - 0.05 && out.length < 40; t += length)
    out.push({ kind: "video", input, trim: 0, duration: round(Math.min(length, duration - t)), audio: 0 });
  return out;
}
/** On-screen text shown from `from` to `to`; its entrance animation starts at `from`. */
function text(ass: string, value: string, look: TextLook, from: number, to: number) {
  return value.trim() && to > from ? withItems(ass, overlayItems(value, look, W, H, { start: from, end: to }), from, to) : ass;
}
/** The output's length: the segments less the overlaps of their transitions. */
const total = (segments: ComposeSegment[]) => round(segments.reduce((n, s) => n + s.duration - (s.transition?.duration ?? 0), 0));
/**
 * A scene's picture for `seconds` (its segment, transitions included): its AI clip, or its AI picture moving slowly,
 * or the owner's image or video, or a library clip or picture. A clip shorter than its scene loops, except AI clips
 * (made for the scene, they hold their last frame for the moment of a transition).
 */
function sceneSegment(ctx: PlanContext, inputs: Inputs, scene: StoryScene, seconds: number, n: number): ComposeSegment {
  const id = scene.source === "clip" ? scene.clipId || scene.imageId : scene.source === "image" ? scene.imageId : scene.source === "own" ? scene.assetId : scene.libraryId;
  const m = need(ctx, id);
  if (m.kind === "image") return { kind: "image", input: inputs.add(m.key), duration: seconds, motion: motionFor(n) };
  if (m.kind !== "video") throw new Error("MEDIA_INPUT");
  const loop = scene.source !== "clip" && m.duration > 0.5 && m.duration < seconds - 1;
  return { kind: "video", input: inputs.add(m.key), trim: 0, duration: seconds, audio: 0, ...(loop && { loop }) };
}

/**
 * A narrated video: a picture per scene on the voiceover's clock with a transition centred on every scene edge (the
 * segments overlap by them, so they add up to the voice exactly) — or one background clip looping under the whole
 * voice — the voice as one track, subtitles over it all, music under it, and the headline on top.
 */
export function planRender(spec: Spec, ctx: PlanContext): Plan {
  return spec.format === "highlight" ? planHighlight(spec, ctx) : planStory(spec, ctx);
}
function planStory(spec: StorySpec, ctx: PlanContext): Plan {
  const inputs = new Inputs();
  const narration = ctx.narration;
  if (!narration) throw new Error("MEDIA_INPUT");
  if (narration.duration > MAX_SECONDS + 0.5) throw new Error("MEDIA_TOO_LONG");
  const timing = storyTiming(spec.scenes, narration.words, Math.min(MAX_SECONDS, narration.duration));
  const d = timing.frames / FPS;
  let segments: ComposeSegment[];
  if (spec.backdrop) {
    const clip = need(ctx, spec.backdrop.assetId || spec.backdrop.libraryId);
    if (clip.kind === "image") segments = [{ kind: "image", input: inputs.add(clip.key), duration: round(d), motion: motionFor(0) }];
    else if (clip.kind === "video") segments = fillWithClip(inputs.add(clip.key), clip.duration, round(d));
    else throw new Error("MEDIA_INPUT");
  } else {
    segments = storySegments(timing, spec.scenes.map((s) => s.transition)).map((part) => {
      const segment = sceneSegment(ctx, inputs, spec.scenes[part.scene], part.frames / FPS, part.scene);
      return part.transition ? { ...segment, transition: { kind: part.transition.kind, duration: part.transition.frames / FPS } } : segment;
    });
  }
  const voice: ComposePayload["voice"] = { input: inputs.add(narration.key), start: 0, volume: 1 };
  // Subtitles only from real word timings (never from estimates); with a headline on top they stay at the bottom.
  let ass = spec.captions.enabled && narration.words.length ? captionAss(styledCaptions(timing.words, spec.captions.style)) : emptyAss(W, H);
  const headline = spec.headline;
  const until = headline ? (headline.seconds > 0 ? Math.min(d, headline.seconds) : d) : 0;
  if (headline) ass = text(ass, headline.text, headline.look, 0, until);
  // The cover: the first picture once the first words (and the headline) are on screen.
  const first = timing.words[Math.min(timing.words.length - 1, 3)];
  let coverAt = Math.max(0.3, Math.min((first?.end ?? 1) + 0.1, spec.backdrop ? d - 0.2 : timing.scenes[0].end - 0.2));
  if (headline) coverAt = Math.max(coverAt, Math.min(until - 0.1, revealSeconds(headline.text, headline.look, W, H, until) + 0.05));
  const length = total(segments);
  if (length > MAX_SECONDS + 0.5) throw new Error("MEDIA_TOO_LONG");
  const track = spec.music, id = track?.trackId || track?.assetId;
  const music = track && id ? { input: inputs.add(need(ctx, id).key), volume: track.volume, duck: [[0, d]] as [number, number][] } : null;
  // Marked as AI-made when its voice, or any picture, clip or track in it, is (EU AI Act Art. 50, platform AI labels).
  const synthetic = spec.narration.kind === "voice" || Object.values(ctx.media).some((m) => m.ai && inputs.keys.includes(m.key));
  return {
    compose: {
      operation: "compose", width: W, height: H, segments, voice, music, overlay: null,
      ass: ctx.watermark ? withWatermark(ass, ctx.watermark, W, H) : ass, coverAt: Math.min(coverAt, Math.max(0, length - 0.1)), synthetic, keys: inputs.keys,
    },
  };
}

/**
 * A clip of a long video: its moment with long pauses (and fillers) cut out, framed in its layout — following the
 * speaker, a fixed crop, the whole picture over a blur, or two windows stacked — with its own sound, captions of what
 * is said (the same words and cuts the editor previews), the hook title on top and music under it. Nothing in it is
 * AI-made.
 */
function planHighlight(spec: HighlightSpec, ctx: PlanContext): Plan {
  const inputs = new Inputs();
  const video = need(ctx, spec.source.assetId);
  if (video.kind !== "video") throw new Error("MEDIA_INPUT");
  const start = Math.min(spec.source.start, Math.max(0, video.duration - 1));
  const window = round(Math.max(1, Math.min(spec.source.end, video.duration || spec.source.end) - start));
  const words = video.words || [];
  const keep = spec.cuts.enabled && words.length ? windowCuts(words, start, window, { maxPause: 0.6, fillers: spec.cuts.fillers }) : null;
  const d = keep ? keptDuration(keep, window) : window;
  if (d > MAX_SECONDS + 0.5) throw new Error("MEDIA_TOO_LONG");
  const segment: ComposeSegment = { kind: "video", input: inputs.add(video.key), trim: start, duration: d, audio: 1, ...(keep && { keep }) };
  const tracked = spec.tracked?.key === trackKey(spec) ? spec.tracked.track : null;
  const sourceW = video.width || 1920, sourceH = video.height || 1080;
  const layout = spec.layout;
  if (layout.kind === "follow") {
    const path = trackWindow(tracked?.points, start, window);
    if (path.length) segment.follow = path;
  } else if (layout.kind === "fit") {
    segment.fit = "contain";
  } else if (layout.kind === "crop") {
    segment.panes = [{ ...paneWindow(layout.pane, sourceW, sourceH, W, H), height: H }];
  } else {
    const heights = splitHeights(layout.ratio, H);
    segment.panes = placedPanes(layout, tracked?.faces).map((pane, k) => ({ ...paneWindow(pane, sourceW, sourceH, W, heights[k]), height: heights[k] }));
  }
  // Captions only from the transcript's real word timings, cut like the picture.
  const spoken = cutWords(clipWords(words, start, window, 0), keep);
  let ass = spec.captions.enabled && spoken.length ? captionAss(styledCaptions(spoken, spec.captions.style, spec.captions.position)) : emptyAss(W, H);
  const headline = spec.headline;
  const until = headline ? (headline.seconds > 0 ? Math.min(d, headline.seconds) : d) : 0;
  if (headline) ass = text(ass, headline.text, headline.look, 0, until);
  let coverAt = Math.min(1.2, d / 2);
  if (headline) coverAt = Math.max(coverAt, Math.min(until - 0.1, revealSeconds(headline.text, headline.look, W, H, until) + 0.05));
  const track = spec.music, id = track?.trackId || track?.assetId;
  const music = track && id ? { input: inputs.add(need(ctx, id).key), volume: track.volume, duck: [[0, d]] as [number, number][] } : null;
  return {
    compose: {
      operation: "compose", width: W, height: H, segments: [segment], voice: null, music, overlay: null,
      // The owner's own video: AI-made only through a library track marked as made with AI.
      ass: ctx.watermark ? withWatermark(ass, ctx.watermark, W, H) : ass, coverAt: Math.min(coverAt, Math.max(0, d - 0.1)),
      synthetic: Object.values(ctx.media).some((m) => m.ai && inputs.keys.includes(m.key)), keys: inputs.keys,
    },
  };
}
