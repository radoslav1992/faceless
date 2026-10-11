import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Columns2, Crop, Expand, Gamepad2, ScanFace } from "lucide-react";
import { api, seconds, useApi, type Asset, type LibraryItem } from "../lib";
import { Switch } from "../ui";
import { LibraryPicker } from "./pickers";
import { CaptionStylePicker, EditorSection } from "./CaptionPickers";
import { ClipPreview, previewCuts, type ClipSource } from "./ClipPreview";
import { keptDuration } from "../../shared/cuts";
import { trackKey, type HighlightSpec } from "../../shared/formats";
import {
  choiceOf, HIGHLIGHT_MAX_SECONDS, HIGHLIGHT_MIN_SECONDS, HIGHLIGHT_TITLE_SECONDS, layoutChoiceIds, layoutChoices, layoutFor, paneWindow, placedPanes,
  scoreParts, splitHeights, titleLook, type Layout, type LayoutChoice, type Pane,
} from "../../shared/highlights";
import { FRAME } from "../../shared/render";
import type { CaptionWord } from "../../shared/captions";
import "./clips.css";

// The clip editor (a video of format "highlight", shared/highlights.ts): the moment on a trim bar that snaps to word
// edges, the layout and its windows over the source picture, captions, the hook title, pauses cut out, music and the
// post's text — next to a preview that frames and cuts it as the render will.

/** Words loaded around a moment: a long video's transcript is fetched a stretch at a time. */
const STRETCH = 90;
type Loaded = { asset: Asset; from: number; to: number; words: CaptionWord[] };
/** A clip's video and the words said from a little before its moment to a little after (loaded again when it moves away). */
export function useClipSource(assetId: string, start: number, end: number) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const covered = !!loaded && loaded.asset.id === assetId && loaded.from <= Math.max(0, start - 20) && loaded.to >= end + 20;
  useEffect(() => {
    if (covered) return;
    const from = Math.max(0, Math.floor((start - STRETCH) / 30) * 30), to = Math.ceil((end + STRETCH) / 30) * 30;
    let live = true;
    const t = setTimeout(() => {
      api<{ asset: Asset & { transcript: { words: CaptionWord[] } | null } }>(`/media/${assetId}?from=${from}&to=${to}`)
        .then(({ asset }) => { if (live) { setLoaded({ asset, from, to, words: asset.transcript?.words || [] }); setError(null); } })
        .catch((e) => { if (live) setError(e instanceof Error ? e.message : "This video couldn't be loaded."); });
    }, loaded ? 250 : 0);
    return () => { live = false; clearTimeout(t); };
  }, [assetId, start, end, covered, loaded]);
  const source: ClipSource | null = loaded && loaded.asset.id === assetId
    ? { url: loaded.asset.url, duration: loaded.asset.duration, width: loaded.asset.width || 1920, height: loaded.asset.height || 1080, words: loaded.words }
    : null;
  return { source, asset: loaded?.asset ?? null, error };
}

const r1 = (n: number) => Math.round(n * 10) / 10;
/** "1:05.3" */
const at = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
/**
 * The moment on a bar of its surroundings: drag either edge (it snaps to the nearest word edge) or the moment itself;
 * arrow keys move an edge by a tenth of a second (a second with Shift).
 */
export function TrimBar({ start, end, duration, words, onChange }: {
  start: number; end: number; duration: number; words: CaptionWord[]; onChange: (start: number, end: number) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ part: "start" | "end" | "both"; from: number; to: number; at: number; start: number; end: number } | null>(null);
  // The view stays put while dragging, so the bar does not slide under the pointer.
  const [view, setView] = useState(() => ({ from: Math.max(0, start - 20), to: Math.min(duration || end + 20, end + 20) }));
  useEffect(() => {
    if (drag.current) return;
    setView({ from: Math.max(0, start - 20), to: Math.min(duration || end + 20, end + 20) });
  }, [start, end, duration]);
  const span = Math.max(1, view.to - view.from), share = (t: number) => ((t - view.from) / span) * 100;
  const inView = useMemo(() => words.filter((w) => w.end >= view.from && w.start <= view.to), [words, view]);
  const snap = (t: number, edge: "start" | "end") => {
    let best = t, gap = 0.35;
    for (const w of inView) {
      const x = edge === "start" ? w.start : w.end;
      if (Math.abs(x - t) < gap) { best = x; gap = Math.abs(x - t); }
    }
    return best;
  };
  const limit = duration || end;
  const set = (a: number, b: number) => {
    const s = Math.max(0, Math.min(a, limit - HIGHLIGHT_MIN_SECONDS));
    const e = Math.min(limit, Math.max(b, s + HIGHLIGHT_MIN_SECONDS), s + HIGHLIGHT_MAX_SECONDS);
    onChange(r1(s), r1(e));
  };
  const timeAt = (clientX: number) => {
    const rect = box.current!.getBoundingClientRect();
    return view.from + ((clientX - rect.left) / rect.width) * span;
  };
  const down = (part: "start" | "end" | "both") => (e: ReactPointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    drag.current = { part, from: view.from, to: view.to, at: timeAt(e.clientX), start, end };
  };
  const move = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const t = timeAt(e.clientX);
    if (d.part === "start") set(snap(t, "start"), d.end);
    else if (d.part === "end") set(d.start, snap(t, "end"));
    else { const shift = t - d.at; set(d.start + shift, d.end + shift); }
  };
  const up = () => { drag.current = null; setView({ from: Math.max(0, start - 20), to: Math.min(duration || end + 20, end + 20) }); };
  const keys = (part: "start" | "end") => (e: ReactKeyboardEvent) => {
    const step = e.shiftKey ? 1 : 0.1, d = e.key === "ArrowLeft" || e.key === "ArrowDown" ? -step : e.key === "ArrowRight" || e.key === "ArrowUp" ? step : 0;
    if (!d) return;
    e.preventDefault();
    if (part === "start") set(start + d, end);
    else set(start, end + d);
  };
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div ref={box} className="trim-bar" onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
        {inView.map((w, i) => <span key={i} className={`trim-word${w.start >= start && w.end <= end ? " on" : ""}`} style={{ left: `${share(w.start)}%`, width: `${Math.max(0.3, share(w.end) - share(w.start))}%` }} />)}
        <div className="trim-range" style={{ left: `${share(start)}%`, width: `${share(end) - share(start)}%` }} onPointerDown={down("both")} />
        <button type="button" className="trim-handle" style={{ left: `${share(start)}%` }} onPointerDown={down("start")} onKeyDown={keys("start")}
          role="slider" aria-label="Clip starts at" aria-valuemin={0} aria-valuemax={Math.round(limit)} aria-valuenow={start} aria-valuetext={at(start)} />
        <button type="button" className="trim-handle" style={{ left: `${share(end)}%` }} onPointerDown={down("end")} onKeyDown={keys("end")}
          role="slider" aria-label="Clip ends at" aria-valuemin={0} aria-valuemax={Math.round(limit)} aria-valuenow={end} aria-valuetext={at(end)} />
      </div>
      <div className="row between small muted"><span>{at(start)}</span><strong style={{ color: "var(--text)" }}>{r1(end - start)} s</strong><span>{at(end)}</span></div>
    </div>
  );
}

const layoutIcons: Record<LayoutChoice, typeof ScanFace> = { follow: ScanFace, speakers: Columns2, screen: Gamepad2, crop: Crop, fit: Expand };
/** The five layouts as tiles. */
export function LayoutPicker({ value, onChange }: { value: LayoutChoice; onChange: (choice: LayoutChoice) => void }) {
  return (
    <div className="layout-grid" role="radiogroup" aria-label="Layout">
      {layoutChoiceIds.map((id) => {
        const Icon = layoutIcons[id];
        return (
          <button key={id} type="button" role="radio" aria-checked={value === id} className="layout-tile" onClick={() => onChange(id)}>
            <Icon size={20} aria-hidden="true" />
            <strong>{layoutChoices[id].name}</strong>
            <small>{layoutChoices[id].about}</small>
          </button>
        );
      })}
    </div>
  );
}

/**
 * The source picture with the layout's windows over it: drag a window to move it (arrow keys too), zoom it with its
 * slider. "Two speakers" places itself on the people found until a window is moved.
 */
export function PaneEditor({ source, at: frameAt, layout, faces, onChange }: {
  source: ClipSource; at: number; layout: Extract<Layout, { kind: "crop" | "split" }>; faces: [number, number][] | null; onChange: (layout: Layout) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ k: number; x: number; y: number; pane: Pane } | null>(null);
  const panes: Pane[] = layout.kind === "crop" ? [layout.pane] : placedPanes(layout, faces);
  const heights = layout.kind === "crop" ? [FRAME.height] : splitHeights(layout.ratio, FRAME.height);
  const names = layout.kind === "crop" ? ["Crop"] : layout.preset === "screen" ? ["Camera (top)", "Screen (bottom)"] : ["Top speaker", "Bottom speaker"];
  const put = (k: number, pane: Pane) => {
    if (layout.kind === "crop") return onChange({ ...layout, pane });
    const both = [...panes];
    both[k] = pane;
    onChange({ ...layout, top: both[0], bottom: both[1], auto: false });
  };
  const clampShare = (n: number) => Math.round(Math.min(1, Math.max(0, n)) * 1000) / 1000;
  const move = (e: ReactPointerEvent) => {
    const d = drag.current, rect = box.current?.getBoundingClientRect();
    if (!d || !rect) return;
    put(d.k, { ...d.pane, x: clampShare(d.pane.x + (e.clientX - d.x) / rect.width), y: clampShare(d.pane.y + (e.clientY - d.y) / rect.height) });
  };
  const keys = (k: number) => (e: ReactKeyboardEvent) => {
    const step = e.shiftKey ? 0.05 : 0.01;
    const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0, dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
    if (!dx && !dy) return;
    e.preventDefault();
    put(k, { ...panes[k], x: clampShare(panes[k].x + dx), y: clampShare(panes[k].y + dy) });
  };
  return (
    <div className="stack" style={{ gap: 10 }}>
      <div ref={box} className="pane-editor" style={{ aspectRatio: `${source.width} / ${source.height}` }} onPointerMove={move} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
        <video src={source.url} muted preload="metadata" playsInline aria-hidden="true" tabIndex={-1} onLoadedMetadata={(e) => { e.currentTarget.currentTime = frameAt; }} />
        {panes.map((pane, k) => {
          const w = paneWindow(pane, source.width, source.height, FRAME.width, heights[k]);
          return (
            <button key={k} type="button" className={`pane-box p${k}`} style={{ left: `${w.x * 100}%`, top: `${w.y * 100}%`, width: `${w.w * 100}%`, height: `${w.h * 100}%` }}
              aria-label={`${names[k]}: drag or use the arrow keys to move it`} onKeyDown={keys(k)}
              onPointerDown={(e) => { e.preventDefault(); (e.target as HTMLElement).setPointerCapture?.(e.pointerId); drag.current = { k, x: e.clientX, y: e.clientY, pane }; }}>
              <span>{names[k]}</span>
            </button>
          );
        })}
      </div>
      {panes.map((pane, k) => (
        <label key={k} className="row small" style={{ gap: 10 }}>
          <span style={{ minWidth: 120 }}>{names[k]} zoom</span>
          <input type="range" className="grow" min={1} max={4} step={0.05} value={pane.zoom} onChange={(e) => put(k, { ...pane, zoom: Number(e.target.value) })} />
          <span className="muted" style={{ minWidth: 36 }}>{pane.zoom.toFixed(1)}×</span>
        </label>
      ))}
      {layout.kind === "split" && (
        <label className="row small" style={{ gap: 10 }}>
          <span style={{ minWidth: 120 }}>Top takes</span>
          <input type="range" className="grow" min={0.3} max={0.7} step={0.01} value={layout.ratio} onChange={(e) => onChange({ ...layout, ratio: Number(e.target.value) })} />
          <span className="muted" style={{ minWidth: 36 }}>{Math.round(layout.ratio * 100)}%</span>
        </label>
      )}
      {layout.kind === "split" && layout.preset === "speakers" && (
        <p className="muted small">{layout.auto ? (faces ? "Placed on the two people found in this moment." : "Placed on the two people seen most once the clip is made. Move a window to place it yourself.") : "You placed these windows."}
          {!layout.auto && <> <button type="button" className="link" onClick={() => onChange({ ...layout, auto: true })}>Place them on the people found</button></>}</p>
      )}
    </div>
  );
}

/** A clip's whole editor: preview, moment, layout, captions, hook title, cuts, music and post text. */
export function HighlightEditor({ spec, onChange }: { spec: HighlightSpec; onChange: (spec: HighlightSpec) => void }) {
  const { source, error } = useClipSource(spec.source.assetId, spec.source.start, spec.source.end);
  const music = useApi<{ items: LibraryItem[] }>("/library?kind=music");
  const [picker, setPicker] = useState(false);
  const [tags, setTags] = useState(spec.hashtags.join(" "));
  useEffect(() => setTags(spec.hashtags.join(" ")), [spec.hashtags]);
  const set = (change: Partial<HighlightSpec>) => onChange({ ...spec, ...change });
  const length = spec.source.end - spec.source.start;
  const keep = source ? previewCuts(source.words, spec.source.start, length, spec.cuts) : null;
  const tracked = spec.tracked?.key === trackKey(spec) ? spec.tracked.track : null;
  const choice = choiceOf(spec.layout);
  const track = spec.music?.trackId ? music.data?.items.find((i) => i.id === spec.music!.trackId) : null;
  const chooseLayout = (next: LayoutChoice) => {
    const layout = next === choice ? spec.layout : layoutFor(next);
    set({ layout, captions: { ...spec.captions, position: layout.kind === "split" ? "middle" : spec.captions.position === "middle" ? "bottom" : spec.captions.position } });
  };
  if (error) return <p className="notice bad">{error}</p>;
  if (!source) return <div className="loading-page" role="status">Loading the video…</div>;
  return (
    <div className="clip-editor">
      <div className="clip-editor-preview stack">
        <ClipPreview spec={spec} source={source} />
        <p className="muted small">{seconds(keptDuration(keep, length))} · {layoutChoices[choice].name}{spec.layout.kind === "follow" && !tracked ? " · the speaker is found when it's made" : ""}</p>
        {spec.moment && (
          <div className="moment-note small">
            <span className={`score-badge ${scoreTone(spec.moment.score)}`}>{spec.moment.score}</span>
            <span>{spec.moment.why || "Clip score"}</span>
          </div>
        )}
      </div>
      <div className="stack" style={{ gap: 0 }}>
        <EditorSection title="Moment" hint="Drag the edges, or the moment itself. Edges snap to words.">
          <TrimBar start={spec.source.start} end={spec.source.end} duration={source.duration} words={source.words}
            onChange={(start, end) => set({ source: { ...spec.source, start, end } })} />
          {source.words.length ? (
            <div className="stack" style={{ gap: 8 }}>
              <div className="row between small">
                <span><strong>Remove pauses</strong><br /><span className="muted">{spec.cuts.enabled ? `${seconds(length)} → ${seconds(keptDuration(keep, length))}` : "Cut long silences out"}</span></span>
                <Switch checked={spec.cuts.enabled} onChange={(enabled) => set({ cuts: { ...spec.cuts, enabled } })} label="Remove pauses" />
              </div>
              {spec.cuts.enabled && (
                <div className="row between small">
                  <span>Filler words too <span className="muted">(um, uh)</span></span>
                  <Switch checked={spec.cuts.fillers} onChange={(fillers) => set({ cuts: { ...spec.cuts, fillers } })} label="Remove filler words" />
                </div>
              )}
            </div>
          ) : <p className="muted small">Pauses can be cut and captions shown once the video's speech is found.</p>}
        </EditorSection>
        <EditorSection title="Layout">
          <LayoutPicker value={choice} onChange={chooseLayout} />
          {(spec.layout.kind === "crop" || spec.layout.kind === "split") && (
            <PaneEditor source={source} at={spec.source.start + 0.5} layout={spec.layout} faces={tracked?.faces ?? null} onChange={(layout) => set({ layout })} />
          )}
        </EditorSection>
        <EditorSection title="Captions" action={<Switch checked={spec.captions.enabled} onChange={(enabled) => set({ captions: { ...spec.captions, enabled } })} label="Captions" />}>
          {spec.captions.enabled && (
            <>
              <div className="seg small-seg" role="group" aria-label="Where the captions sit">
                {(["top", "middle", "bottom"] as const).map((p) => <button key={p} type="button" aria-pressed={spec.captions.position === p} onClick={() => set({ captions: { ...spec.captions, position: p } })}>{p[0].toUpperCase() + p.slice(1)}</button>)}
              </div>
              <CaptionStylePicker value={spec.captions.style} onChange={(style) => set({ captions: { ...spec.captions, style } })} />
            </>
          )}
        </EditorSection>
        <EditorSection title="Hook title" action={<Switch checked={!!spec.headline} onChange={(on) => set({ headline: on ? { text: spec.title || "Wait for it", look: titleLook(), seconds: HIGHLIGHT_TITLE_SECONDS } : null })} label="Hook title" />}>
          {spec.headline && (
            <>
              <input className="input" maxLength={140} value={spec.headline.text} aria-label="Hook title"
                onChange={(e) => set({ headline: { ...spec.headline!, text: e.target.value } })} />
              <div className="seg small-seg" role="group" aria-label="How long the title stays">
                {[3, 5, 0].map((n) => <button key={n} type="button" aria-pressed={spec.headline!.seconds === n} onClick={() => set({ headline: { ...spec.headline!, seconds: n } })}>{n ? `${n} s` : "Whole clip"}</button>)}
              </div>
            </>
          )}
        </EditorSection>
        <EditorSection title="Music" hint="Played quietly under the voices.">
          <div className="row wrap" style={{ gap: 10 }}>
            <span className="small">{track ? track.name : spec.music ? "Your track" : "No music"}</span>
            <button type="button" className="btn sm" onClick={() => setPicker(true)}>{spec.music ? "Change" : "Add music"}</button>
            {spec.music && <button type="button" className="btn sm ghost" onClick={() => set({ music: null })}>Remove</button>}
          </div>
          {spec.music && (
            <label className="row small" style={{ gap: 10 }}>
              <span>Volume</span>
              <input type="range" className="grow" min={0} max={0.6} step={0.02} value={spec.music.volume} onChange={(e) => set({ music: { ...spec.music!, volume: Number(e.target.value) } })} />
            </label>
          )}
        </EditorSection>
        <EditorSection title="Post text">
          <label className="field"><span className="small">Title <span className="muted">(YouTube title and the clip's name)</span></span>
            <input className="input" maxLength={100} value={spec.title} onChange={(e) => set({ title: e.target.value })} />
          </label>
          <label className="field"><span className="small">Description</span>
            <textarea className="textarea" rows={3} maxLength={2200} value={spec.caption} onChange={(e) => set({ caption: e.target.value })} />
          </label>
          <label className="field"><span className="small">Hashtags <span className="muted">(separated by spaces)</span></span>
            <input className="input" value={tags} onChange={(e) => setTags(e.target.value)}
              onBlur={() => set({ hashtags: tags.split(/[\s,]+/).map((t) => t.replace(/[^\p{L}\p{N}_#]/gu, "")).filter((t) => /^#?[\p{L}\p{N}_]{1,60}$/u.test(t)).map((t) => (t.startsWith("#") ? t : `#${t}`)).slice(0, 15) })} />
          </label>
        </EditorSection>
      </div>
      {picker && <LibraryPicker kind="music" onClose={() => setPicker(false)}
        onPick={(i) => { set({ music: { trackId: i.id, volume: spec.music?.volume ?? 0.15 } }); setPicker(false); }} />}
    </div>
  );
}

/** The colour of a clip score: strong, good or plain. */
export const scoreTone = (score: number) => (score >= 80 ? "high" : score >= 60 ? "mid" : "low");
/** "Hook 8 · Payoff 7 · Stands alone 7 · Energy 6" */
export const scoreLine = (scores: Record<keyof typeof scoreParts, number>) =>
  (Object.keys(scoreParts) as (keyof typeof scoreParts)[]).map((k) => `${scoreParts[k].name} ${scores[k]}`).join(" · ");
