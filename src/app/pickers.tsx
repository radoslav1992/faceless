/**
 * Shared pickers, upload helpers and small building blocks for the dashboard pages.
 *
 * Modals
 * - <MediaPicker type title? allowUpload? onPick onClose />
 *     type: "image" | "video" | "audio" — only ready assets of this type are listed, newest first.
 *     title?: string — the modal heading (default "Choose an image" / "Choose a video" / "Choose a track").
 *     allowUpload?: boolean — show an upload button (default true); a file uploaded here is selected once ready.
 *     onPick(asset: Asset) — called once with the chosen, ready asset. The picker does not close itself:
 *       unmount it in onPick (onClose is not called).
 *     onClose() — Cancel, Escape or a click on the backdrop.
 * - <VoicePicker value onPick(id) onClose /> — every voice offered (Admin → Voices) with a play button for its sample,
 *     filtered by gender and accent; VoiceSelect opens it.
 * - <LibraryPicker kind title? onPick onClose />
 *     kind: "clip" | "music" | "image" | "scene" (a clip or a picture) — the shared library (GET /api/library?kind=&q=).
 *     A search over names, descriptions and tags (on the server), tag filter chips (every chosen tag must match), 12
 *     items a page, clips preview on hover/focus (poster = item.thumb), music has a play button, items made with AI
 *     say so. onPick(item: LibraryItem) / onClose() as for MediaPicker.
 * - <ConfirmDialog title confirmLabel? danger? onConfirm onClose>body</ConfirmDialog>
 *     A confirmation for destructive actions. onConfirm may return a promise: the dialog shows a spinner, toasts
 *     the error if it rejects (and stays open), and calls onClose when it resolves.
 *
 * Uploads
 * - useUploads({ only?, onDone?, concurrency? }) → { items, add(files), dismiss(key), clearFinished(), busy }
 *     Chunked uploads through uploadFile() (src/lib.tsx), three at a time, with per-file progress and the
 *     server's checking/failed states. onDone(asset) runs for every finished upload (ready or failed).
 * - <UploadList items onDismiss? action?(item) /> — progress rows for useUploads items.
 * - <FileButton accept multiple? label? className? disabled? onFiles(files) /> — a button that opens the file chooser.
 * - <UploadButton type? multiple? label? className? disabled? onUploaded?(asset) />
 *     Self-contained: uploads the chosen files, shows progress in the button and toasts failures.
 * - <DropZone onFiles disabled? label? className?>children</DropZone> — accepts files dropped on its area.
 * - ACCEPT[type], mediaTypeOf(file)
 *
 * Fields
 * - <VoiceSelect value onChange label? /> — the chosen voice with its sample's play button; "Change" opens VoicePicker.
 * - <MusicChoice label mood trackId moodName onChange small? /> — a mood the writer picks a track for, or a library
 *     track chosen (and heard) in LibraryPicker, shown with its play button.
 *
 * Other helpers
 * - <Tabs label value onChange items idBase? /> — ARIA tabs with arrow-key navigation; pair with tabPanel(idBase, value).
 * - useHoverPlay() → { videoRef, handlers } — a muted preview that plays while the pointer or focus is on its card.
 * - usePreviewAudio() → { playing, toggle(id, url), stop() } — one audio preview at a time.
 * - useRetryKey() → { key(body), settle(error?) } — idempotency keys that survive a retry after a network TypeError.
 * - useStableCallback(fn) — a stable function that always calls the latest `fn` (use it for Modal's onClose).
 * - useSignedInUser(), creditBlock(user, cost), assetKindLabel(kind), formatDate(unix), ago(unix), Empty, GridSkeleton.
 */
import {
  useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState,
  type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode,
} from "react";
import { Link } from "react-router-dom";
import { AlertCircle, Check, CheckCircle2, ChevronLeft, ChevronRight, Mic, Music, Pause, Play, Search, Upload, UploadCloud } from "lucide-react";
import { Modal, Spinner, useToast } from "../ui";
import { errorText, newKey, seconds, uploadFile, useApi, useAuth, useVoices, bytes as formatBytes, type Asset, type LibraryItem, type LibraryKind, type User } from "../lib";
import type { Voice } from "../../shared/voices";
import { musicMoods, type MusicMood } from "../../shared/series";
import { planById } from "../../shared/plans";
import "./pages.css";

export type MediaType = "image" | "video" | "audio";

/* ------------------------------------------------------------------------------------------------ small helpers */

/** A stable function that always runs the latest `fn` (Modal re-focuses itself whenever its onClose changes). */
export function useStableCallback<A extends unknown[], R>(fn: (...args: A) => R) {
  const ref = useRef(fn);
  useLayoutEffect(() => {
    ref.current = fn;
  });
  return useCallback((...args: A) => ref.current(...args), []);
}

/** The signed-in person (pages under the dashboard layout always have one). */
export function useSignedInUser(): User {
  const { user } = useAuth();
  if (!user) throw new Error("This page needs a signed-in user.");
  return user;
}

/**
 * Idempotency keys for paid requests: the same body sent again after a network failure (a TypeError, so the request
 * may have arrived) reuses its key; anything else gets a fresh one.
 */
export function useRetryKey() {
  const last = useRef<{ body: string; key: string } | null>(null);
  return useMemo(() => ({
    key(body: unknown) {
      const text = JSON.stringify(body);
      if (!last.current || last.current.body !== text) last.current = { body: text, key: newKey() };
      return last.current.key;
    },
    settle(error?: unknown) {
      if (!(error instanceof TypeError)) last.current = null;
    },
  }), []);
}

/** Why AI work costing `cost` credits can't start now, or null. */
export function creditBlock(user: User, cost: number): { text: string; to?: string; action?: string } | null {
  if (!user.verified) return { text: "Confirm your email to make videos. We sent you a link when you signed up." };
  if (user.trialEnded) return { text: "Your free trial has ended. Choose a plan to keep creating.", to: "/app/billing", action: "See plans" };
  if (user.limit - user.used < cost) return { text: `This needs ${cost} credit${cost === 1 ? "" : "s"} and you have ${Math.max(0, user.limit - user.used)} left.`, to: "/app/billing", action: "Get more credits" };
  return null;
}
export function CreditBlockNotice({ block }: { block: ReturnType<typeof creditBlock> }) {
  if (!block) return null;
  return (
    <div className="notice warn" role="note">
      {block.text} {block.to && <Link to={block.to} className="link">{block.action}</Link>}
    </div>
  );
}

const kindLabels: Record<string, string> = { upload: "Upload", ai_image: "AI picture", ai_clip: "AI clip", voice: "Voice", render: "Video", cover: "Cover" };
export const assetKindLabel = (kind: string) => kindLabels[kind] || "File";

export const formatDate = (unix: number, withTime = false) =>
  new Date(unix * 1000).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}) });
/** "just now", "5 min ago", "3 h ago", "2 days ago", or the date. */
export function ago(unix: number) {
  const s = Math.max(0, Date.now() / 1000 - unix);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} day${s < 2 * 86400 ? "" : "s"} ago`;
  return formatDate(unix);
}

export function Empty({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty empty-card">
      {icon && <span className="empty-icon" aria-hidden="true">{icon}</span>}
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}
export function GridSkeleton({ count = 8, tall = false, className = "lib-grid" }: { count?: number; tall?: boolean; className?: string }) {
  return (
    <div className={className} aria-busy="true" aria-label="Loading">
      {Array.from({ length: count }, (_, i) => <div key={i} className="skeleton" style={{ aspectRatio: tall ? "9 / 16" : "1" }} />)}
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------ tabs */

export type TabItem<T extends string> = { id: T; label: ReactNode; count?: number };
/** ARIA tabs: one tab stop, arrow keys / Home / End move between tabs. */
export function Tabs<T extends string>({ label, value, onChange, items, idBase }: { label: string; value: T; onChange: (v: T) => void; items: TabItem<T>[]; idBase?: string }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: ReactKeyboardEvent, i: number) => {
    const n = items.length;
    const next = e.key === "ArrowRight" ? (i + 1) % n : e.key === "ArrowLeft" ? (i - 1 + n) % n : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    onChange(items[next].id);
    refs.current[next]?.focus();
  };
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {items.map((t, i) => (
        <button
          key={t.id} type="button" role="tab" ref={(el) => { refs.current[i] = el; }}
          id={idBase ? `${idBase}-tab-${t.id}` : undefined} aria-controls={idBase ? `${idBase}-panel` : undefined}
          aria-selected={t.id === value} tabIndex={t.id === value ? 0 : -1}
          onClick={() => onChange(t.id)} onKeyDown={(e) => onKey(e, i)}
        >
          {t.label}{t.count !== undefined && <span className="tab-count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}
/** Props for the panel that belongs to <Tabs idBase=…>. */
export const tabPanel = (idBase: string, value: string) => ({ role: "tabpanel" as const, id: `${idBase}-panel`, "aria-labelledby": `${idBase}-tab-${value}` });

/* ------------------------------------------------------------------------------------------------ confirm */

export function ConfirmDialog({ title, children, confirmLabel = "Delete", danger = true, disabled = false, onConfirm, onClose }: {
  title: string; children?: ReactNode; confirmLabel?: string; danger?: boolean; disabled?: boolean;
  onConfirm: () => unknown | Promise<unknown>; onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const close = useStableCallback(() => { if (!busy) onClose(); });
  const confirm = async () => {
    setBusy(true);
    try {
      await onConfirm();
      setBusy(false);
      onClose();
    } catch (e) {
      toast(errorText(e), "bad");
      setBusy(false);
    }
  };
  return (
    <Modal title={title} onClose={close} footer={
      <>
        <button type="button" className="btn" onClick={close} disabled={busy}>Cancel</button>
        <button type="button" className={`btn ${danger ? "danger-solid" : "primary"}`} onClick={confirm} disabled={busy || disabled}>
          {busy && <Spinner label="Working" />}{confirmLabel}
        </button>
      </>
    }>
      <div className="stack">{children}</div>
    </Modal>
  );
}

/* ------------------------------------------------------------------------------------------------ previews */

/** A muted, looping preview: spread `handlers` on the card and give the <video> `videoRef`. */
export function useHoverPlay() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const handlers = useMemo(() => {
    const play = () => { void videoRef.current?.play().catch(() => {}); };
    const stop = () => {
      const v = videoRef.current;
      if (!v) return;
      v.pause();
      try { v.currentTime = 0; } catch { /* not seekable yet */ }
    };
    return { onMouseEnter: play, onMouseLeave: stop, onFocus: play, onBlur: stop };
  }, []);
  return { videoRef, handlers };
}
/** A video URL that shows its first frame without a poster (most browsers then load only the metadata). */
export const firstFrame = (url: string) => `${url}#t=0.1`;

/** One audio preview at a time (starting another stops the first). */
export function usePreviewAudio() {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const stop = useCallback(() => {
    audio.current?.pause();
    audio.current = null;
    setPlaying(null);
  }, []);
  useEffect(() => () => { audio.current?.pause(); }, []);
  const toggle = useCallback((id: string, url: string) => {
    if (audio.current && audio.current.dataset.id === id) { stop(); return; }
    audio.current?.pause();
    const a = new Audio(url);
    a.dataset.id = id;
    audio.current = a;
    a.onended = () => { if (audio.current === a) stop(); };
    setPlaying(id);
    void a.play().catch(() => { if (audio.current === a) stop(); });
  }, [stop]);
  return { playing, toggle, stop };
}
export function PlayButton({ playing, onClick, label }: { playing: boolean; onClick: () => void; label: string }) {
  return (
    <button type="button" className="play-btn" onClick={onClick} aria-label={`${playing ? "Pause" : "Play"} ${label}`} aria-pressed={playing}>
      {playing ? <Pause size={18} /> : <Play size={18} />}
    </button>
  );
}

/* ------------------------------------------------------------------------------------------------ voices */

/** "Warm storyteller · British" */
const voiceAbout = (v: Voice) => [v.description, v.accent].filter(Boolean).join(" · ");
/** A voice's sample to play, or a quiet placeholder for one without. */
function VoiceSample({ voice, audio }: { voice: Voice | undefined; audio: ReturnType<typeof usePreviewAudio> }) {
  if (!voice?.preview) return <span className="play-btn none" title="No sample yet" aria-hidden="true"><Mic size={18} /></span>;
  return <PlayButton playing={audio.playing === voice.id} onClick={() => audio.toggle(voice.id, voice.preview!)} label={`a sample of ${voice.name}`} />;
}
/**
 * The narration voice: the chosen one with a play button for its sample, and Change, which opens VoicePicker (every
 * voice offered, each with its sample). A video or series keeps its voice when it is no longer offered.
 */
export function VoiceSelect({ value, onChange, label = "Voice" }: { value: string; onChange: (id: string) => void; label?: string }) {
  const { voices, loading, byId } = useVoices();
  const audio = usePreviewAudio();
  const [open, setOpen] = useState(false);
  const current = byId(value);
  const name = current?.name ?? (loading ? "Loading voices…" : `${value[0]?.toUpperCase()}${value.slice(1)}`);
  const about = current ? voiceAbout(current) : loading ? "" : "No longer offered";
  return (
    <div className="voice-select">
      <VoiceSample voice={current} audio={audio} />
      <button type="button" className="voice-choose" disabled={loading || !voices.length} onClick={() => { audio.stop(); setOpen(true); }}
        aria-label={`${label}: ${name}${about ? `, ${about}` : ""}. Change`} aria-haspopup="dialog">
        <span className="grow" style={{ minWidth: 0 }}>
          <span className="name">{name}</span>
          {about && <span className="small muted about">{about}</span>}
        </span>
        <span className="small accent-text voice-change" aria-hidden="true">Change</span>
      </button>
      {open && <VoicePicker value={value} onClose={() => setOpen(false)} onPick={(id) => { setOpen(false); onChange(id); }} />}
    </div>
  );
}
const genderNames = { female: "Female", male: "Male", neutral: "Neutral" } as const;
/** Every voice offered (Admin → Voices) with its sample to play, filtered by gender and accent. */
export function VoicePicker({ value, onPick, onClose }: { value: string; onPick: (id: string) => void; onClose: () => void }) {
  const { voices, loading } = useVoices();
  const audio = usePreviewAudio();
  const [chosen, setChosen] = useState(value);
  const [gender, setGender] = useState<Voice["gender"]>("");
  const [accent, setAccent] = useState("");
  const close = useStableCallback(() => { audio.stop(); onClose(); });
  const pick = (id: string) => { audio.stop(); onPick(id); };
  const genders = (["female", "male", "neutral"] as const).filter((g) => voices.some((v) => v.gender === g));
  const accents = [...new Set(voices.map((v) => v.accent).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const shown = voices.filter((v) => (!gender || v.gender === gender) && (!accent || v.accent === accent));
  const selected = voices.find((v) => v.id === chosen);
  return (
    <Modal title="Choose a voice" onClose={close} wide footer={
      <>
        <button type="button" className="btn" onClick={close}>Cancel</button>
        <button type="button" className="btn primary" disabled={!selected} onClick={() => selected && pick(selected.id)}>
          <Check size={16} aria-hidden="true" />{selected ? `Use ${selected.name}` : "Use this voice"}
        </button>
      </>
    }>
      <p className="small muted" style={{ margin: "0 0 12px" }}>Play a sample to hear a voice. The whole video is narrated in the voice you choose.</p>
      {(genders.length > 1 || accents.length > 1) && (
        <div className="tag-filter">
          {genders.length > 1 && (
            <span className="filter-group" role="group" aria-label="Voice">
              <button type="button" className="chip button" aria-pressed={!gender} onClick={() => setGender("")}>All</button>
              {genders.map((g) => <button key={g} type="button" className="chip button" aria-pressed={gender === g} onClick={() => setGender(gender === g ? "" : g)}>{genderNames[g]}</button>)}
            </span>
          )}
          {accents.length > 1 && (
            <span className="filter-group" role="group" aria-label="Accent">
              {accents.map((a) => <button key={a} type="button" className="chip button tag-chip" aria-pressed={accent === a} onClick={() => setAccent(accent === a ? "" : a)}>{a}</button>)}
            </span>
          )}
        </div>
      )}
      {loading ? <div className="stack">{Array.from({ length: 6 }, (_, i) => <div key={i} className="skeleton" style={{ height: 58 }} />)}</div> : !shown.length ? (
        <div className="empty">
          <h3>No voice is all of these</h3>
          <button type="button" className="btn" onClick={() => { setGender(""); setAccent(""); }}>Clear filters</button>
        </div>
      ) : (
        <ul className="pick-rows list-plain">
          {shown.map((v) => (
            <li key={v.id} className={`pick-row${v.id === chosen ? " selected" : ""}`}>
              <VoiceSample voice={v} audio={audio} />
              <button type="button" className="choose" aria-pressed={v.id === chosen} onClick={() => setChosen(v.id)} onDoubleClick={() => pick(v.id)}>
                <span className="grow" style={{ minWidth: 0 }}>
                  <span className="name" style={{ display: "block" }}>{v.name}</span>
                  {v.description && <span className="small pick-description">{v.description}</span>}
                  <span className="small muted">{[v.gender ? genderNames[v.gender] : "", v.accent, v.age].filter(Boolean).join(" · ") || (v.preview ? "" : "No sample yet")}</span>
                </span>
                {v.id === chosen && <Check size={18} aria-hidden="true" />}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
/** For something new: when `value` is not an offered voice (a template's voice hidden since), the default voice. */
export function useOfferedVoice(value: string, onChange: (id: string) => void, enabled = true) {
  const { voices, loading, fallback } = useVoices();
  const change = useStableCallback(onChange);
  useEffect(() => {
    if (enabled && !loading && fallback && !voices.some((v) => v.id === value)) change(fallback);
  }, [enabled, loading, fallback, voices, value, change]);
}

/* ------------------------------------------------------------------------------------------------ music */

/**
 * Background music: a mood the writer picks a library track for (`moodName` names each: "Pick one that fits", "No
 * music", "Calm"…), or a library track chosen in LibraryPicker, where every track can be heard first; a chosen track is
 * shown with its own play button.
 */
export function MusicChoice({ label, mood, trackId, moodName, onChange, small = false }: {
  label: string; mood: MusicMood; trackId: string | null; moodName: (m: MusicMood) => string;
  onChange: (music: { mood: MusicMood; trackId: string | null }) => void; small?: boolean;
}) {
  const id = useId();
  const audio = usePreviewAudio();
  const [picking, setPicking] = useState(false);
  // The track just picked; one chosen before (a series being edited) is looked up.
  const [picked, setPicked] = useState<LibraryItem | null>(null);
  const looked = useApi<{ items: LibraryItem[] }>(trackId && picked?.id !== trackId ? `/library?ids=${trackId}` : null);
  const track = picked?.id === trackId ? picked : looked.data?.items.find((i) => i.id === trackId) ?? null;
  // Tracks to choose from: the library may have none yet.
  const library = useApi<{ items: LibraryItem[] }>("/library?kind=music&limit=1");
  const tracks = !!trackId || !!library.data?.items.length;
  const choose = () => { audio.stop(); setPicking(true); };
  return (
    <div className="field">
      <span className={small ? "small" : undefined}><label htmlFor={id}>{label}</label></span>
      <select id={id} className="select" value={trackId ? "track" : mood} onChange={(e) => {
        audio.stop();
        if (e.target.value === "track") setPicking(true);
        else onChange({ mood: e.target.value as MusicMood, trackId: null });
      }}>
        {musicMoods.map((m) => <option key={m} value={m}>{moodName(m)}</option>)}
        {tracks && <option value="track">{trackId ? `Track: ${track?.name ?? "chosen in the library"}` : "A track I choose (hear them first)…"}</option>}
      </select>
      {trackId ? (
        <div className="music-track">
          {track ? <PlayButton playing={audio.playing === track.id} onClick={() => audio.toggle(track.id, track.url)} label={track.name} />
            : <span className="play-btn none" aria-hidden="true"><Music size={18} /></span>}
          <span className="grow" style={{ minWidth: 0 }}>
            <span className="name">{track?.name ?? (looked.loading ? "Loading…" : "No longer in the library")}</span>
            {track && <span className="small muted">{[track.category, seconds(track.duration), track.tags.join(", ")].filter(Boolean).join(" · ")}</span>}
          </span>
          <button type="button" className="btn sm" onClick={choose}>Change</button>
        </div>
      ) : tracks && mood !== "none" && (
        <span className="hint"><button type="button" className="link" onClick={choose}>Listen to the tracks</button> and choose one yourself.</span>
      )}
      {picking && <LibraryPicker kind="music" onClose={() => setPicking(false)} onPick={(i) => { setPicked(i); setPicking(false); onChange({ mood, trackId: i.id }); }} />}
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------ uploads */

const MB = 1024 * 1024;
const types: Record<string, MediaType> = {
  "image/jpeg": "image", "image/png": "image", "image/webp": "image",
  "video/mp4": "video", "video/quicktime": "video", "video/webm": "video",
  "audio/mpeg": "audio", "audio/wav": "audio", "audio/x-wav": "audio", "audio/mp4": "audio", "audio/x-m4a": "audio", "audio/aac": "audio", "audio/ogg": "audio",
};
/** The server's limits per type (server/media.ts): videos up to the plan's (long videos for clips on paid plans). */
const limits: Record<MediaType, number> = { image: 20 * MB, video: 500 * MB, audio: 50 * MB };
const limitFor = (type: MediaType, plan?: string) => (type === "video" ? planById(plan).videoMb * MB : limits[type]);
export const ACCEPT: Record<MediaType | "any", string> = {
  image: "image/jpeg,image/png,image/webp",
  video: "video/mp4,video/quicktime,video/webm,.mov",
  audio: "audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/x-m4a,audio/aac,audio/ogg,.mp3,.m4a,.wav,.ogg",
  any: "",
};
ACCEPT.any = [ACCEPT.image, ACCEPT.video, ACCEPT.audio].join(",");
export function mediaTypeOf(file: File): MediaType | null {
  const t = types[file.type.toLowerCase()];
  if (t) return t;
  if (!file.type && /\.mov$/i.test(file.name)) return "video";
  return null;
}
const typeWords: Record<MediaType, { one: string; many: string }> = {
  image: { one: "an image", many: "Images" }, video: { one: "a video", many: "Videos" }, audio: { one: "an audio track", many: "Tracks" },
};

export type Upload = {
  key: string; name: string; bytes: number; type: MediaType | null; progress: number;
  status: "queued" | "uploading" | "checking" | "ready" | "failed"; error: string | null; asset: Asset | null;
};
export type Uploads = ReturnType<typeof useUploads>;
export function useUploads(options: { only?: MediaType; onDone?: (asset: Asset) => void; concurrency?: number } = {}) {
  const [items, setItems] = useState<Upload[]>([]);
  const plan = useAuth().user?.plan;
  const settings = useRef({ plan, ...options });
  useLayoutEffect(() => {
    settings.current = { plan, ...options };
  });
  const queue = useRef<{ key: string; file: File }[]>([]);
  const active = useRef(0);
  const set = useCallback((key: string, change: Partial<Upload>) => setItems((all) => all.map((i) => (i.key === key ? { ...i, ...change } : i))), []);
  const pump = useCallback(function next() {
    while (active.current < (settings.current.concurrency || 3) && queue.current.length) {
      const job = queue.current.shift();
      if (!job) break;
      active.current++;
      void (async () => {
        set(job.key, { status: "uploading" });
        try {
          const asset = await uploadFile(job.file, (share) =>
            set(job.key, share >= 1 ? { progress: 1, status: "checking" } : { progress: share }));
          set(job.key, { status: asset.status === "ready" ? "ready" : asset.status === "failed" ? "failed" : "checking", error: asset.error, asset, progress: 1 });
          settings.current.onDone?.(asset);
        } catch (e) {
          set(job.key, { status: "failed", error: errorText(e) });
        } finally {
          active.current--;
          next();
        }
      })();
    }
  }, [set]);
  const add = useCallback((files: Iterable<File>) => {
    const fresh: Upload[] = [];
    const only = settings.current.only;
    for (const file of files) {
      const type = mediaTypeOf(file);
      const problem = !type
        ? only ? `Choose ${typeWords[only].one} file.` : "This file type isn't supported. Upload JPG, PNG or WebP images, MP4, MOV or WebM videos, or MP3, WAV, M4A or OGG tracks."
        : only && type !== only ? `Choose ${typeWords[only].one} file.`
        : file.size > limitFor(type, settings.current.plan)
          ? `${typeWords[type].many} can be up to ${(limitFor(type, settings.current.plan) / MB).toLocaleString("en-US")} MB${type === "video" && planById(settings.current.plan).id === "free" ? " on the free trial (paid plans take videos up to 2 hours)" : ""}.`
        : file.size < 24 ? "This file is empty." : null;
      const key = newKey();
      fresh.push({ key, name: file.name, bytes: file.size, type, progress: 0, status: problem ? "failed" : "queued", error: problem, asset: null });
      if (!problem) queue.current.push({ key, file });
    }
    setItems((all) => [...fresh, ...all]);
    pump();
  }, [pump]);
  const dismiss = useCallback((key: string) => setItems((all) => all.filter((i) => i.key !== key)), []);
  const clearFinished = useCallback(() => setItems((all) => all.filter((i) => i.status === "queued" || i.status === "uploading" || (i.status === "checking" && !i.asset))), []);
  const busy = items.some((i) => i.status === "queued" || i.status === "uploading" || (i.status === "checking" && !i.asset));
  return { items, add, dismiss, clearFinished, busy };
}

function uploadStatus(u: Upload) {
  if (u.status === "queued") return "Waiting…";
  if (u.status === "uploading") return `Uploading · ${Math.round(u.progress * 100)}% of ${formatBytes(u.bytes)}`;
  if (u.status === "checking") return u.asset ? "Still checking. It appears in your library when it's ready." : "Checking the file…";
  if (u.status === "ready") return "Ready";
  return u.error || "This file can't be used.";
}
export function UploadList({ items, onDismiss, action }: { items: Upload[]; onDismiss?: (key: string) => void; action?: (item: Upload) => ReactNode }) {
  if (!items.length) return null;
  // Announce how many are done rather than every progress step.
  const working = items.filter((u) => u.status === "queued" || u.status === "uploading" || u.status === "checking").length;
  const ready = items.filter((u) => u.status === "ready").length, failed = items.filter((u) => u.status === "failed").length;
  return (
    <>
      <p className="sr-only" aria-live="polite">{[working && `${working} uploading`, ready && `${ready} ready`, failed && `${failed} failed`].filter(Boolean).join(", ")}</p>
      <ul className="uploads list-plain" aria-label="Uploads">
        {items.map((u) => {
          const working = u.status === "queued" || u.status === "uploading" || (u.status === "checking" && !u.asset);
          return (
            <li key={u.key} className={`upload-row${u.status === "failed" ? " failed" : ""}`}>
              {working ? <Spinner label="Uploading" /> : u.status === "failed" ? <AlertCircle size={20} color="var(--red)" aria-hidden="true" /> : u.status === "ready" ? <CheckCircle2 size={20} color="var(--green)" aria-hidden="true" /> : <Spinner label="Checking" />}
              <div className="grow">
                <div className="name">{u.name}</div>
                <div className="status">{uploadStatus(u)}</div>
                {u.status === "uploading" && <div className="meter" role="progressbar" aria-label={`Uploading ${u.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(u.progress * 100)}><span style={{ width: `${Math.max(3, u.progress * 100)}%` }} /></div>}
              </div>
              <div className="row">
                {action?.(u)}
                {onDismiss && !working && <button type="button" className="btn sm ghost" onClick={() => onDismiss(u.key)} aria-label={`Dismiss ${u.name}`}>Dismiss</button>}
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}

/** A button that opens the file chooser. */
export function FileButton({ accept, multiple = false, label = "Upload", className = "btn", disabled = false, icon, onFiles }: {
  accept: string; multiple?: boolean; label?: ReactNode; className?: string; disabled?: boolean; icon?: ReactNode; onFiles: (files: File[]) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" className={className} onClick={() => input.current?.click()} disabled={disabled}>
        {icon ?? <Upload size={16} aria-hidden="true" />}{label}
      </button>
      <input
        ref={input} type="file" accept={accept} multiple={multiple} hidden tabIndex={-1} aria-hidden="true"
        onChange={(e) => {
          const files = [...(e.target.files || [])];
          e.target.value = "";
          if (files.length) onFiles(files);
        }}
      />
    </>
  );
}

/** Uploads the chosen files itself: progress in the button, failures as toasts, `onUploaded` per ready file. */
export function UploadButton({ type, multiple = false, label = "Upload", className = "btn", disabled = false, onUploaded }: {
  type?: MediaType; multiple?: boolean; label?: string; className?: string; disabled?: boolean; onUploaded?: (asset: Asset) => void;
}) {
  const toast = useToast();
  const uploads = useUploads({
    only: type,
    onDone: (asset) => {
      if (asset.status === "ready") onUploaded?.(asset);
      else if (asset.status === "failed") toast(`${asset.name}: ${asset.error || "This file can't be used."}`, "bad");
    },
  });
  const { items, dismiss } = uploads;
  // Problems found before the upload (type, size) and network errors are toasted once, then dropped.
  useEffect(() => {
    for (const u of items) {
      if (u.status === "failed" && !u.asset) { toast(`${u.name}: ${u.error}`, "bad"); dismiss(u.key); }
      else if (u.status === "ready" || u.status === "failed") dismiss(u.key);
    }
  }, [items, dismiss, toast]);
  const working = items.filter((u) => u.status !== "ready" && u.status !== "failed");
  const share = working.length ? working.reduce((n, u) => n + u.progress, 0) / working.length : 0;
  return (
    <FileButton
      accept={type ? ACCEPT[type] : ACCEPT.any} multiple={multiple} className={className} disabled={disabled || working.length > 0}
      icon={working.length ? <Spinner label="Uploading" /> : undefined}
      label={working.length ? (share >= 1 ? "Checking…" : `Uploading ${Math.round(share * 100)}%`) : label}
      onFiles={uploads.add}
    />
  );
}

/** Accepts files dropped anywhere on its area (with a visible overlay while dragging). */
export function DropZone({ onFiles, disabled = false, label = "Drop files to upload", className = "", children }: {
  onFiles: (files: File[]) => void; disabled?: boolean; label?: string; className?: string; children: ReactNode;
}) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const hasFiles = (e: ReactDragEvent) => !disabled && [...e.dataTransfer.types].includes("Files");
  return (
    <div
      className={`dropzone ${className}`}
      onDragEnter={(e) => { if (!hasFiles(e)) return; e.preventDefault(); depth.current++; setOver(true); }}
      onDragOver={(e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }}
      onDragLeave={() => { depth.current = Math.max(0, depth.current - 1); if (!depth.current) setOver(false); }}
      onDrop={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth.current = 0;
        setOver(false);
        if (e.dataTransfer.files.length) onFiles([...e.dataTransfer.files]);
      }}
    >
      {children}
      {over && <div className="drop-overlay" aria-hidden="true"><UploadCloud size={36} />{label}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------ MediaPicker */

export type MediaPickerProps = {
  type: MediaType;
  title?: string;
  onPick: (asset: Asset) => void;
  onClose: () => void;
  allowUpload?: boolean;
};
const pickTitles: Record<MediaType, string> = { image: "Choose an image", video: "Choose a video", audio: "Choose a track" };

export function MediaPicker({ type, title, onPick, onClose, allowUpload = true }: MediaPickerProps) {
  const { data, loading, error, reload, setData } = useApi<{ assets: Asset[] }>(`/media?type=${type}&source=library&limit=200`);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const audio = usePreviewAudio();
  const close = useStableCallback(onClose);
  const uploads = useUploads({
    only: type,
    onDone: (asset) => {
      if (asset.status !== "ready") return;
      setData((d) => ({ ...d, assets: [asset, ...(d?.assets || []).filter((a) => a.id !== asset.id)] }));
      setSelected(asset.id);
    },
  });
  const ready = (data?.assets || []).filter((a) => a.status === "ready");
  const q = query.trim().toLowerCase();
  const shown = q ? ready.filter((a) => a.name.toLowerCase().includes(q)) : ready;
  const chosen = ready.find((a) => a.id === selected) || null;
  const pick = (asset: Asset) => { audio.stop(); onPick(asset); };
  const visibleUploads = uploads.items.filter((u) => u.status !== "ready");
  const word = type === "audio" ? "track" : type;
  return (
    <Modal title={title || pickTitles[type]} onClose={close} wide footer={
      <>
        <button type="button" className="btn" onClick={close}>Cancel</button>
        <button type="button" className="btn primary" disabled={!chosen} onClick={() => chosen && pick(chosen)}>
          <Check size={16} aria-hidden="true" />Use this {word}
        </button>
      </>
    }>
      <div className="pick-toolbar">
        {ready.length > 8 && (
          <label className="search">
            <Search size={16} aria-hidden="true" />
            <span className="sr-only">Search by name</span>
            <input className="input" type="search" placeholder="Search by name" value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
        )}
        {allowUpload && (
          <FileButton accept={ACCEPT[type]} label={`Upload ${word === "track" ? "a track" : word === "image" ? "an image" : "a video"}`} className="btn" onFiles={(files) => uploads.add(files.slice(0, 1))} disabled={uploads.busy} />
        )}
      </div>
      {visibleUploads.length > 0 && <div style={{ marginBottom: 14 }}><UploadList items={visibleUploads} onDismiss={uploads.dismiss} /></div>}
      {loading ? (
        <GridSkeleton count={8} tall={type === "video"} className="pick-grid" />
      ) : error ? (
        <div className="notice bad" role="alert">{error} <button type="button" className="link" onClick={() => void reload()}>Try again</button></div>
      ) : !ready.length ? (
        <div className="empty">
          <span className="empty-icon" aria-hidden="true">{type === "audio" ? <Music size={24} /> : <UploadCloud size={24} />}</span>
          <h3>No {word}s in your library yet</h3>
          <p>{allowUpload ? `Upload ${word === "image" ? "an image" : word === "video" ? "a video" : "a track"} and it's ready to use here.` : "Add some in your Library first."}</p>
        </div>
      ) : !shown.length ? (
        <p className="muted center">Nothing matches “{query}”.</p>
      ) : type === "audio" ? (
        <ul className="pick-rows list-plain">
          {shown.map((a) => (
            <li key={a.id} className={`pick-row${a.id === selected ? " selected" : ""}`}>
              <PlayButton playing={audio.playing === a.id} onClick={() => audio.toggle(a.id, a.url)} label={a.name} />
              <button type="button" className="choose" aria-pressed={a.id === selected} onClick={() => setSelected(a.id)} onDoubleClick={() => pick(a)}>
                <span className="grow">
                  <span className="name" style={{ display: "block" }}>{a.name}</span>
                  <span className="small muted">{seconds(a.duration)} · {formatBytes(a.bytes)}</span>
                </span>
                {a.id === selected && <Check size={18} aria-hidden="true" />}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="pick-grid">
          {shown.map((a) => <PickTile key={a.id} asset={a} selected={a.id === selected} onSelect={() => setSelected(a.id)} onPick={() => pick(a)} />)}
        </div>
      )}
    </Modal>
  );
}
function PickTile({ asset, selected, onSelect, onPick }: { asset: Asset; selected: boolean; onSelect: () => void; onPick: () => void }) {
  const { videoRef, handlers } = useHoverPlay();
  const video = asset.mime.startsWith("video/");
  return (
    <button type="button" className={`pick-item${video ? " tall" : ""}`} aria-pressed={selected} onClick={onSelect} onDoubleClick={onPick} {...(video ? handlers : {})}
      aria-label={`${asset.name}${video ? `, ${seconds(asset.duration)}` : ""}`}>
      {video
        ? <video ref={videoRef} src={firstFrame(asset.url)} muted loop playsInline preload="metadata" aria-hidden="true" />
        : <img src={asset.url} alt="" loading="lazy" decoding="async" />}
      {video && <span className="chip dark pick-duration">{seconds(asset.duration)}</span>}
      {selected && <span className="pick-check" aria-hidden="true"><Check size={15} /></span>}
      <span className="pick-name" aria-hidden="true">{asset.name}</span>
    </button>
  );
}

/* ------------------------------------------------------------------------------------------------ LibraryPicker */

/** "scene": a clip or a picture, for a scene. */
export type LibraryPickerKind = LibraryKind | "scene";
export type LibraryPickerProps = { kind: LibraryPickerKind; title?: string; onPick: (item: LibraryItem) => void; onClose: () => void };
const libraryTitles: Record<LibraryPickerKind, string> = { clip: "Choose a clip", music: "Choose music", image: "Choose a picture", scene: "Choose a clip or picture" };
const libraryWords: Record<LibraryPickerKind, string> = { clip: "clips", music: "tracks", image: "pictures", scene: "clips and pictures" };
const PAGE = 12;
/** A value that follows `value` once it has stopped changing for `ms`. */
export function useSettled<T>(value: T, ms: number) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

export function LibraryPicker({ kind, title, onPick, onClose }: LibraryPickerProps) {
  const [query, setQuery] = useState("");
  const [only, setOnly] = useState<"all" | "clip" | "image">("all");
  const search = useSettled(query.trim(), 300);
  const kinds = kind === "scene" ? (only === "all" ? "clip,image" : only) : kind;
  // The library is searched on the server (names, descriptions and tags); tags then narrow what was found.
  const { data, loading, error, reload } = useApi<{ items: LibraryItem[]; tags: string[] }>(`/library?${new URLSearchParams({ kind: kinds, ...(search && { q: search }) })}`);
  const [tags, setTags] = useState<string[]>([]);
  const [page, setPage] = useState(0);
  const [chosen, setChosen] = useState<LibraryItem | null>(null);
  const audio = usePreviewAudio();
  const close = useStableCallback(onClose);
  const all = data?.items || [];
  const items = all.filter((i) => tags.every((t) => i.tags.some((x) => x.toLowerCase() === t.toLowerCase())));
  const pages = Math.max(1, Math.ceil(items.length / PAGE));
  const current = Math.min(page, pages - 1);
  const shown = items.slice(current * PAGE, current * PAGE + PAGE);
  useEffect(() => setPage(0), [search, only]);
  const toggleTag = (t: string) => {
    setTags((list) => (list.includes(t) ? list.filter((x) => x !== t) : [...list, t]));
    setPage(0);
  };
  const pick = (item: LibraryItem) => { audio.stop(); onPick(item); };
  const music = kind === "music";
  const filtered = !!search || only !== "all";
  const useLabel = !chosen ? (music ? "Use this track" : kind === "image" ? "Use this picture" : "Use this clip")
    : chosen.kind === "music" ? "Use this track" : chosen.kind === "image" ? "Use this picture" : "Use this clip";
  return (
    <Modal title={title || libraryTitles[kind]} onClose={close} wide footer={
      <>
        <button type="button" className="btn" onClick={close}>Cancel</button>
        <button type="button" className="btn primary" disabled={!chosen} onClick={() => chosen && pick(chosen)}>
          <Check size={16} aria-hidden="true" />{useLabel}
        </button>
      </>
    }>
      <div className="pick-toolbar">
        <label className="search">
          <Search size={16} aria-hidden="true" />
          <span className="sr-only">Search the library</span>
          <input className="input" type="search" placeholder={music ? "Search tracks: calm, upbeat, piano…" : "Search: ocean, city at night, cat…"} value={query}
            onChange={(e) => setQuery(e.target.value)} maxLength={100} />
        </label>
        {loading && data && <Spinner label="Searching" />}
        {kind === "scene" && (
          <div className="seg small-seg" role="group" aria-label="Show">
            {(["all", "clip", "image"] as const).map((k) => (
              <button key={k} type="button" aria-pressed={only === k} onClick={() => setOnly(k)}>{k === "all" ? "All" : k === "clip" ? "Clips" : "Pictures"}</button>
            ))}
          </div>
        )}
      </div>
      {!!data?.tags.length && (
        <div className="tag-filter" role="group" aria-label="Filter by tag">
          <button type="button" className="chip button" aria-pressed={!tags.length} onClick={() => { setTags([]); setPage(0); }}>All</button>
          {data.tags.map((t) => (
            <button key={t} type="button" className="chip button tag-chip" aria-pressed={tags.includes(t)} onClick={() => toggleTag(t)}>{t}</button>
          ))}
        </div>
      )}
      {loading && !data ? (
        music ? <div className="stack">{Array.from({ length: 6 }, (_, i) => <div key={i} className="skeleton" style={{ height: 58 }} />)}</div>
          : <GridSkeleton count={8} tall={kind !== "image"} className="pick-grid" />
      ) : error ? (
        <div className="notice bad" role="alert">{error} <button type="button" className="link" onClick={() => void reload()}>Try again</button></div>
      ) : !all.length && !filtered ? (
        <div className="empty">
          <span className="empty-icon" aria-hidden="true">{music ? <Music size={24} /> : <UploadCloud size={24} />}</span>
          <h3>The library is empty for now</h3>
          <p>We're adding {libraryWords[kind]} soon. You can use your own uploads meanwhile.</p>
        </div>
      ) : !all.length ? (
        <div className="empty">
          <h3>Nothing matches{search ? ` “${search}”` : ""}</h3>
          <p>Try other words, or fewer of them.</p>
          {search && <button type="button" className="btn" onClick={() => setQuery("")}>Clear the search</button>}
        </div>
      ) : !items.length ? (
        <div className="empty">
          <h3>Nothing has all of these tags</h3>
          <button type="button" className="btn" onClick={() => setTags([])}>Clear filters</button>
        </div>
      ) : music ? (
        <ul className="pick-rows list-plain">
          {shown.map((t) => (
            <li key={t.id} className={`pick-row${t.id === chosen?.id ? " selected" : ""}`}>
              <PlayButton playing={audio.playing === t.id} onClick={() => audio.toggle(t.id, t.url)} label={t.name} />
              <button type="button" className="choose" aria-pressed={t.id === chosen?.id} onClick={() => setChosen(t)} onDoubleClick={() => pick(t)}>
                <span className="grow" style={{ minWidth: 0 }}>
                  <span className="name" style={{ display: "block" }}>{t.name}{t.ai && <span className="chip pick-ai">AI</span>}</span>
                  {t.description && <span className="small pick-description">{t.description}</span>}
                  <span className="small muted">{[t.category, seconds(t.duration), t.tags.join(", ")].filter(Boolean).join(" · ")}</span>
                </span>
                {t.id === chosen?.id && <Check size={18} aria-hidden="true" />}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="pick-grid">
          {shown.map((c) => <LibraryTile key={c.id} item={c} tall={kind !== "image"} selected={c.id === chosen?.id} onSelect={() => setChosen(c)} onPick={() => pick(c)} />)}
        </div>
      )}
      {chosen && !music && (chosen.description || chosen.tags.length > 0) && (
        <p className="pick-detail small" aria-live="polite">
          <strong>{chosen.name}</strong>{chosen.category && <> · {chosen.category}</>}{chosen.description && <> · {chosen.description}</>}{chosen.tags.length > 0 && <span className="muted"> · {chosen.tags.join(", ")}</span>}
        </p>
      )}
      {pages > 1 && (
        <nav className="pager" aria-label="Pages">
          <button type="button" className="btn sm" onClick={() => setPage(current - 1)} disabled={current === 0} aria-label="Previous page"><ChevronLeft size={16} /></button>
          <span aria-live="polite">Page {current + 1} of {pages}</span>
          <button type="button" className="btn sm" onClick={() => setPage(current + 1)} disabled={current >= pages - 1} aria-label="Next page"><ChevronRight size={16} /></button>
        </nav>
      )}
    </Modal>
  );
}
/** A library clip (plays on hover or focus) or picture. */
function LibraryTile({ item, tall, selected, onSelect, onPick }: { item: LibraryItem; tall: boolean; selected: boolean; onSelect: () => void; onPick: () => void }) {
  const { videoRef, handlers } = useHoverPlay();
  const video = item.kind === "clip";
  const about = [item.name, video ? seconds(item.duration) : "picture", item.category, item.description, item.tags.join(", "), item.ai ? "made with AI" : ""].filter(Boolean).join(", ");
  return (
    <button type="button" className={`pick-item${tall ? " tall" : ""}`} aria-pressed={selected} onClick={onSelect} onDoubleClick={onPick} {...(video ? handlers : {})}
      aria-label={about} title={item.description || item.name}>
      {video
        ? <video ref={videoRef} src={item.thumb ? item.url : firstFrame(item.url)} poster={item.thumb || undefined} muted loop playsInline preload={item.thumb ? "none" : "metadata"} aria-hidden="true" />
        : <img src={item.thumb || item.url} alt="" loading="lazy" decoding="async" />}
      <span className="pick-badges" aria-hidden="true">
        {video && <span className="chip dark">{seconds(item.duration)}</span>}
        {item.ai && <span className="chip dark">AI</span>}
      </span>
      {selected && <span className="pick-check" aria-hidden="true"><Check size={15} /></span>}
      <span className="pick-name" aria-hidden="true">{item.name}</span>
    </button>
  );
}
