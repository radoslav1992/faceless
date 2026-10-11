import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Pause, Play } from "lucide-react";
import { styledCaptions, type CaptionWord } from "../../shared/captions";
import { overlayItems } from "../../shared/overlay";
import { FRAME } from "../../shared/render";
import { cutWords, keptDuration, toCutTime, toSourceTime, windowCuts, type KeepRange } from "../../shared/cuts";
import { clipWords } from "../../shared/speech";
import { followLeft, trackX } from "../../shared/track";
import { paneWindow, placedPanes, splitHeights, type Layout } from "../../shared/highlights";
import { trackKey, type HighlightSpec } from "../../shared/formats";
import type { Track } from "../../shared/track";
import { drawCaptions, drawItems, fitCanvas, loadCaptionFonts, onFrame } from "./caption-canvas";
import "./post.css";

// A clip of a long video as it will be made (server/render-plan.ts planHighlight): the moment played with its pauses
// cut out (shared/cuts.ts), each frame of the source drawn into the 9:16 frame by its layout — following the speaker's
// path, a fixed window, the whole picture over a blur, or two windows stacked — with the captions and the hook title
// drawn by the caption engine on the cut clip's clock.

/** What the editor knows of a clip's video: its link, length, picture size and the words heard around the moment. */
export type ClipSource = { url: string; duration: number; width: number; height: number; words: CaptionWord[] };
const { width: W, height: H } = FRAME;

/** The parts of [start, start + length) that instant cuts keep, on the moment's own clock; null without cuts. */
export function previewCuts(words: CaptionWord[], start: number, length: number, cuts: { enabled: boolean; fillers: boolean }): KeepRange[] | null {
  return cuts.enabled && words.length ? windowCuts(words, start, length, { maxPause: 0.6, fillers: cuts.fillers }) : null;
}

/** Draws video frame `v` (at source time `t`) into the frame by the layout, as the renderer crops and scales it. */
export function drawLayout(ctx: CanvasRenderingContext2D, v: HTMLVideoElement, layout: Layout, track: Track | null, t: number) {
  const vw = v.videoWidth, vh = v.videoHeight;
  if (!vw || !vh) return;
  const window = (box: { x: number; y: number; w: number; h: number }, top: number, height: number) =>
    ctx.drawImage(v, box.x * vw, box.y * vh, box.w * vw, box.h * vh, 0, top, W, height);
  const cover = Math.max(W / vw, H / vh), dw = vw * cover, dh = vh * cover;
  switch (layout.kind) {
    case "follow":
      // The 9:16 crop around the speaker's path (centred until it is measured), kept inside the picture.
      ctx.drawImage(v, followLeft(dw, W, trackX(track?.points, t)), (H - dh) / 2, dw, dh);
      break;
    case "fit": {
      ctx.save();
      ctx.filter = "blur(28px) brightness(0.6)";
      ctx.drawImage(v, (W - dw) / 2, (H - dh) / 2, dw, dh);
      ctx.restore();
      const fit = Math.min(W / vw, H / vh);
      ctx.drawImage(v, (W - vw * fit) / 2, (H - vh * fit) / 2, vw * fit, vh * fit);
      break;
    }
    case "crop":
      window(paneWindow(layout.pane, vw, vh, W, H), 0, H);
      break;
    case "split": {
      const [top, bottom] = placedPanes(layout, track?.faces);
      const [a, b] = splitHeights(layout.ratio, H);
      window(paneWindow(top, vw, vh, W, a), 0, a);
      window(paneWindow(bottom, vw, vh, W, b), a, b);
      break;
    }
  }
}

export function ClipPreview({ spec, source, label = "Preview of the clip" }: { spec: HighlightSpec; source: ClipSource; label?: string }) {
  const video = useRef<HTMLVideoElement>(null), canvas = useRef<HTMLCanvasElement>(null), bar = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const start = spec.source.start;
  const length = Math.max(1, Math.min(spec.source.end, source.duration || spec.source.end) - start);
  const { enabled, fillers } = spec.cuts;
  const keep = useMemo(() => previewCuts(source.words, start, length, { enabled, fillers }), [source.words, start, length, enabled, fillers]);
  // The kept parts on the video's own clock (without cuts: the whole moment); the preview plays them and loops.
  const ranges = useMemo<KeepRange[]>(() => (keep || [[0, length]]).map(([a, b]) => [a + start, b + start]), [keep, start, length]);
  const total = keptDuration(keep, length);
  const spoken = useMemo(() => cutWords(clipWords(source.words, start, length, 0), keep), [source.words, start, length, keep]);
  const { enabled: captionsOn, style, position } = spec.captions;
  const captions = useMemo(() => (captionsOn && spoken.length ? styledCaptions(spoken, style, position) : null), [captionsOn, style, position, spoken]);
  const headline = spec.headline;
  const until = headline ? (headline.seconds > 0 ? Math.min(total, headline.seconds) : total) : 0;
  const titleItems = useMemo(() => (headline?.text.trim() ? overlayItems(headline.text, headline.look, W, H, { start: 0, end: until }) : null), [headline, until]);
  const track = spec.tracked?.key === trackKey(spec) ? spec.tracked.track : null;
  const layout = spec.layout;
  useEffect(() => { loadCaptionFonts(); }, []);
  // A new moment (or new cuts) starts from its beginning.
  useEffect(() => {
    const v = video.current;
    if (v && v.readyState >= 1) v.currentTime = ranges[0][0];
  }, [ranges]);
  useEffect(() => onFrame(() => {
    const v = video.current, c = canvas.current;
    if (!v || !c) return;
    let t = v.currentTime;
    if (v.readyState >= 1) {
      // Inside the kept parts only: a cut jumps to the next part, the end loops back to the start.
      const i = ranges.findIndex(([, b]) => t < b - 0.02);
      if (i < 0) { t = ranges[0][0]; v.currentTime = t; }
      else if (t < ranges[i][0] - 0.05) { t = ranges[i][0]; v.currentTime = t; }
    }
    const out = toCutTime(t - start, keep) ?? 0;
    const k = fitCanvas(c, W, H), ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#0b0d12";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.setTransform(k, 0, 0, k, 0, 0);
    if (v.readyState >= 2) drawLayout(ctx, v, layout, track, t);
    if (captions) drawCaptions(ctx, W, H, out, captions);
    if (titleItems && out < until) drawItems(ctx, titleItems, out);
    if (bar.current) bar.current.style.width = `${Math.min(100, (out / Math.max(0.1, total)) * 100)}%`;
  }), [ranges, keep, start, layout, track, captions, titleItems, until, total]);
  const toggle = () => {
    const v = video.current;
    if (!v) return;
    if (v.paused) void v.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
    else { v.pause(); setPlaying(false); }
  };
  const seek = (e: ReactPointerEvent<HTMLDivElement>) => {
    const v = video.current, box = e.currentTarget.getBoundingClientRect();
    if (!v || v.readyState < 1) return;
    v.currentTime = start + toSourceTime(((e.clientX - box.left) / box.width) * total, keep);
  };
  return (
    <div className="phone-frame clip-preview">
      <video ref={video} className="clip-source" src={source.url} preload="auto" playsInline aria-hidden="true" tabIndex={-1}
        onLoadedMetadata={(e) => { e.currentTarget.currentTime = ranges[0][0]; }} onPause={() => setPlaying(false)} onPlay={() => setPlaying(true)} />
      <canvas ref={canvas} className="tp-canvas" role="img" aria-label={label} />
      <button type="button" className="sp-play" onClick={toggle} aria-label={playing ? "Pause the preview" : "Play the preview"}>
        {playing ? <Pause size={20} /> : <Play size={20} />}
      </button>
      <div className="clip-progress" onPointerDown={seek} role="presentation"><span ref={bar} /></div>
    </div>
  );
}
