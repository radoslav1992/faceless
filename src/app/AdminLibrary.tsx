import { useRef, useState, type FormEvent } from "react";
import { Download, Eye, Film, Image as ImageIcon, Music, Pencil, Plus, Search, Sparkles, Trash2, Upload as UploadIcon } from "lucide-react";
import { Modal, Spinner, Switch, useToast } from "../ui";
import { ApiError, bytes, del, errorText, patch, post, seconds, useApi, type LibraryItem, type LibraryKind } from "../lib";
import { ConfirmDialog, Empty, PlayButton, firstFrame, usePreviewAudio, useStableCallback } from "./pickers";
import { categoriesFor, categoryLabel, CATEGORY_MAX } from "../../shared/library";

// Admin → Library: the shared music, clips and pictures people search and pick from (server/routes/admin-library.ts).
// Items are uploaded, or added from the administrator's own media (an upload, or an AI picture or clip they made for a
// video) with its details: its name, its prompt as the description, the AI mark. Name, description, genre (music) or
// category (clips and pictures), tags and the AI mark are edited afterwards, written by hand or filled in by AI (✨):
// the browser makes small samples of the file and a multimodal model suggests them; nothing is saved until Save or
// Upload. Descriptions, genres, categories and tags are what people search by.

type AdminItem = LibraryItem & { active: boolean; rawTags: string; bytes: number; createdAt: number; fromMedia: boolean; usage: number };
type MediaFile = {
  id: string; name: string; ai: boolean; prompt: string; mime: string; bytes: number; duration: number; width: number; height: number; createdAt: number; url: string;
  added: string | null; problem: string | null;
};
const kinds: LibraryKind[] = ["clip", "image", "music"];
const kindNames: Record<LibraryKind, string> = { clip: "Clip", image: "Picture", music: "Music" };
const kindPlural: Record<LibraryKind, string> = { clip: "Clips", image: "Pictures", music: "Music" };
const kindIcons: Record<LibraryKind, typeof Film> = { clip: Film, image: ImageIcon, music: Music };
const tagIdeas: Record<LibraryKind, string[]> = {
  clip: ["satisfying", "gameplay-style", "parkour", "cooking", "nature", "city", "ocean", "space"],
  image: ["nature", "city", "space", "animals", "food", "history", "abstract", "night"],
  music: ["calm", "upbeat", "inspiring", "dark", "epic", "mysterious", "playful", "ambient"],
};
const accepts: Record<LibraryKind, string> = {
  clip: "video/mp4,video/quicktime,video/webm,.mov", image: "image/jpeg,image/png,image/webp", music: "audio/*,.mp3,.m4a,.wav,.ogg",
};
const MB = 1024 * 1024;
const maxBytes: Record<LibraryKind, number> = { clip: 50 * MB, image: 20 * MB, music: 50 * MB };
const descriptionHint = "What it shows or sounds like, in plain words: people search by it.";
/** An item's file for the administrators, offered or switched off. */
const adminFile = (id: string) => `/api/admin/library/${id}/file`;

export function LibraryTab() {
  const toast = useToast();
  const { data, loading, error, reload, setData } = useApi<{ items: AdminItem[] }>("/admin/library");
  const [kind, setKind] = useState<"all" | LibraryKind>("all");
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [preview, setPreview] = useState<AdminItem | null>(null);
  const [editing, setEditing] = useState<{ item: AdminItem; suggestion?: Suggestion } | null>(null);
  const [deleting, setDeleting] = useState<AdminItem | null>(null);
  const [describing, setDescribing] = useState<string | null>(null);
  const items = data?.items || [];
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = items.filter((i) => (kind === "all" || i.kind === kind) && words.every((w) => `${i.name} ${i.description} ${i.category} ${i.rawTags}`.toLowerCase().includes(w)));
  /** AI suggestions for an item's details, opened in its editor to check and save. */
  const describe = async (item: AdminItem) => {
    setDescribing(item.id);
    try {
      setEditing({ item, suggestion: await suggest(item.kind, item.name, adminFile(item.id)) });
    } catch (e) {
      toast(errorText(e), "bad");
    } finally {
      setDescribing(null);
    }
  };
  const change = (item: AdminItem) => setData((d) => (d ? { items: d.items.map((i) => (i.id === item.id ? item : i)) } : d));
  const setActive = async (item: AdminItem, active: boolean) => {
    change({ ...item, active });
    try {
      await patch(`/admin/library/${item.id}`, { active });
    } catch (e) {
      change(item);
      toast(errorText(e), "bad");
    }
  };
  /** A new item: listed first, then its details opened for checking. */
  const added = (item: AdminItem) => {
    setData((d) => ({ items: [item, ...(d?.items || []).filter((i) => i.id !== item.id)] }));
    setEditing({ item });
  };
  const counts: Record<"all" | LibraryKind, number> = { all: items.length, clip: 0, image: 0, music: 0 };
  for (const i of items) counts[i.kind]++;
  return (
    <div className="stack" style={{ gap: 20 }}>
      <LibraryUpload onUploaded={added} onFromMedia={() => setAdding(true)} />
      <section aria-labelledby="library-list-title">
        <div className="section-head">
          <h2 id="library-list-title">Library items</h2>
          <div className="toolbar">
            <label className="search" style={{ width: 240 }}>
              <Search size={16} aria-hidden="true" />
              <span className="sr-only">Search by name, description, genre, category or tag</span>
              <input className="input" type="search" placeholder="Name, genre, tag…" value={query} onChange={(e) => setQuery(e.target.value)} />
            </label>
            <div className="tag-filter" role="group" aria-label="Kind" style={{ margin: 0 }}>
              {(["all", ...kinds] as const).map((k) => (
                <button key={k} type="button" className="chip button" aria-pressed={kind === k} onClick={() => setKind(k)}>
                  {k === "all" ? "All" : kindPlural[k]} · {counts[k]}
                </button>
              ))}
            </div>
          </div>
        </div>
        {loading ? <Loading /> : error ? (
          <div className="notice bad" role="alert">{error} <button type="button" className="link" onClick={() => void reload()}>Try again</button></div>
        ) : !items.length ? (
          <Empty icon={<Film size={24} />} title="The library is empty">
            Upload clips, pictures and music above, or add your own AI pictures and clips. Music tagged with a mood is picked for series of that mood.
          </Empty>
        ) : !shown.length ? (
          <p className="muted center" style={{ padding: 24 }}>Nothing matches.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <caption className="sr-only">Library items</caption>
              <thead>
                <tr>
                  <th scope="col">Preview</th><th scope="col">Name and description</th><th scope="col">Tags</th><th scope="col">Length</th>
                  <th scope="col">Used by</th><th scope="col">Offered</th><th scope="col"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {shown.map((i) => {
                  const Icon = kindIcons[i.kind];
                  return (
                    <tr key={i.id}>
                      <td>
                        <button type="button" className="adm-thumb" style={{ border: 0, padding: 0, cursor: "pointer" }} onClick={() => setPreview(i)} aria-label={`Preview ${i.name}`}>
                          {i.thumb ? <img src={i.thumb} alt="" loading="lazy" onError={(e) => { e.currentTarget.style.display = "none"; }} /> : <Icon size={20} aria-hidden="true" />}
                        </button>
                      </td>
                      <td style={{ maxWidth: 360 }}>
                        <span className="clip" style={{ fontWeight: 600 }} title={i.name}>{i.name}{i.ai && <span className="chip pick-ai" title="Made with AI">AI</span>}</span>
                        {i.description ? <span className="clip small" title={i.description}>{i.description}</span> : <span className="small muted" style={{ display: "block" }}>No description</span>}
                        <span className="small muted">
                          {kindNames[i.kind]}{i.category ? ` · ${i.category}` : ""}{i.width ? ` · ${i.width}×${i.height}` : ""} · {bytes(i.bytes)}{i.fromMedia ? " · from your media" : ""}
                        </span>
                      </td>
                      <td><span className="clip small" title={i.rawTags}>{i.rawTags || <span className="muted">No tags</span>}</span></td>
                      <td className="small">{i.kind === "image" ? "—" : seconds(i.duration)}</td>
                      <td className="small">{i.usage ? `${i.usage} video${i.usage === 1 ? "" : "s"} or series` : <span className="muted">Not used</span>}</td>
                      <td><Switch checked={i.active} onChange={(v) => void setActive(i, v)} label={`${i.name} is offered`} /></td>
                      <td>
                        <div className="icon-actions">
                          <button type="button" className="btn icon ghost" onClick={() => setPreview(i)} aria-label={`Preview ${i.name}`} title="Preview"><Eye size={16} /></button>
                          <button type="button" className="btn icon ghost" onClick={() => void describe(i)} disabled={describing !== null}
                            aria-label={`Fill in the details of ${i.name} with AI`} title="Fill in with AI">
                            {describing === i.id ? <Spinner label="Describing" /> : <Sparkles size={16} />}
                          </button>
                          <button type="button" className="btn icon ghost" onClick={() => setEditing({ item: i })} aria-label={`Edit ${i.name}`} title="Edit"><Pencil size={16} /></button>
                          <button type="button" className="btn icon ghost danger" onClick={() => setDeleting(i)} aria-label={`Delete ${i.name}`} title="Delete"><Trash2 size={16} /></button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {adding && <FromMediaModal onClose={() => setAdding(false)} onAdded={(item) => { setAdding(false); added(item); toast(`${item.name} is in the library. Check its details.`, "good"); }} />}
      {preview && <PreviewModal item={preview} onClose={() => setPreview(null)} />}
      {editing && <EditItemModal item={editing.item} suggestion={editing.suggestion} onClose={() => setEditing(null)} onSaved={(item) => { change(item); setEditing(null); }} />}
      {deleting && (
        <ConfirmDialog title="Delete this library item?" onClose={() => setDeleting(null)} onConfirm={async () => {
          await del(`/admin/library/${deleting.id}`);
          setData((d) => (d ? { items: d.items.filter((x) => x.id !== deleting.id) } : d));
          toast("Deleted.", "good");
        }}>
          <p>
            <strong>{deleting.name}</strong> disappears from the library. Videos already made keep their file
            {deleting.usage > 0 && `; the ${deleting.usage === 1 ? "video or series that uses it needs" : `${deleting.usage} videos and series that use it need`} another item before they're made again`}.
            To stop offering it only, switch it off instead.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------ adding */

/** PUTs a file as the raw request body, reporting upload progress (fetch can't). */
function sendFile<T = unknown>(path: string, body: Blob, type: string, onProgress?: (share: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("PUT", "/api" + path);
    x.setRequestHeader("Content-Type", type);
    x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
    x.onload = () => {
      let data: any = {};
      try { data = JSON.parse(x.responseText); } catch { data = { error: "Unexpected answer from the server. Please try again." }; }
      if (x.status >= 200 && x.status < 300) resolve(data as T);
      else reject(new ApiError(data.error || "Something went wrong. Please try again.", x.status, data));
    };
    x.onerror = () => reject(new TypeError("We can't reach the server. Check your connection and try again."));
    x.send(body);
  });
}
const extensionTypes: Record<string, string> = {
  mov: "video/quicktime", mp4: "video/mp4", webm: "video/webm", mp3: "audio/mpeg", m4a: "audio/x-m4a", aac: "audio/aac", wav: "audio/wav", ogg: "audio/ogg",
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
};
const mimeOf = (file: File) => file.type || extensionTypes[file.name.split(".").pop()?.toLowerCase() || ""] || "";
const baseName = (name: string) => name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim().slice(0, 120);
const splitTags = (raw: string) => raw.split(",").map((t) => t.trim()).filter(Boolean);
const withTag = (raw: string, tag: string) => (splitTags(raw).some((x) => x.toLowerCase() === tag) ? raw : [...splitTags(raw), tag].join(", "));

function waitFor(el: HTMLMediaElement | HTMLImageElement, event: string, ms: number) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error("The browser couldn't read this file in time.")); }, ms);
    const done = () => { cleanup(); resolve(); };
    const fail = () => { cleanup(); reject(new Error("The browser can't open this file. Try an MP4 (H.264) video, a JPG or PNG picture, or an MP3 track.")); };
    const cleanup = () => { clearTimeout(timer); el.removeEventListener(event, done); el.removeEventListener("error", fail); };
    el.addEventListener(event, done);
    el.addEventListener("error", fail);
  });
}
/** A JPEG of a video frame or a picture, at most `max` pixels on its longer side. */
function thumbnail(source: HTMLVideoElement | HTMLImageElement, width: number, height: number, max = 720) {
  const scale = Math.min(1, max / Math.max(width, height, 1));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  canvas.getContext("2d")?.drawImage(source, 0, 0, canvas.width, canvas.height);
  return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.82));
}
/**
 * Length and size from the browser's own player, plus a thumbnail (JPEG) for clips and pictures. `src` is a chosen
 * file or a file of ours.
 */
async function measure(src: File | string, kind: LibraryKind) {
  const url = typeof src === "string" ? src : URL.createObjectURL(src);
  try {
    if (kind === "image") {
      const img = new Image();
      const loaded = waitFor(img, "load", 20000);
      img.src = url;
      await loaded;
      const width = img.naturalWidth, height = img.naturalHeight;
      if (!width || !height) throw new Error("We couldn't read the size of this picture.");
      return { duration: 0, width, height, poster: await thumbnail(img, width, height).catch(() => null) };
    }
    const el = document.createElement(kind === "clip" ? "video" : "audio");
    el.preload = "metadata";
    el.muted = true;
    if (el instanceof HTMLVideoElement) el.playsInline = true;
    const loaded = waitFor(el, "loadedmetadata", 20000);
    el.src = url;
    await loaded;
    let duration = el.duration;
    if (!Number.isFinite(duration)) {
      // Some recordings (WebM) report no duration until the player seeks to the end.
      const changed = waitFor(el, "durationchange", 10000);
      el.currentTime = 1e7;
      await changed.catch(() => {});
      duration = el.duration;
    }
    if (!Number.isFinite(duration) || duration <= 0) throw new Error("We couldn't read the length of this file.");
    if (!(el instanceof HTMLVideoElement)) return { duration, width: 0, height: 0, poster: null as Blob | null };
    const width = el.videoWidth, height = el.videoHeight;
    let poster: Blob | null = null;
    try {
      const seeked = waitFor(el, "seeked", 15000);
      el.currentTime = Math.min(1, duration / 3);
      await seeked;
      poster = await thumbnail(el, width, height);
    } catch {
      poster = null;
    }
    return { duration, width, height, poster };
  } finally {
    if (typeof src !== "string") URL.revokeObjectURL(url);
  }
}
/** Saves a thumbnail for an item; true when it was saved (an item works without one). */
async function saveThumb(id: string, poster: Blob | null) {
  if (!poster) return false;
  try {
    await sendFile(`/admin/library/${id}/thumb`, poster, "image/jpeg");
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------------------------------------ filled in by AI */

type Suggestion = { name: string; description: string; category: string; tags: string[] };
/** A file's bytes as base64 (without the data: prefix). */
function base64Of(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(new Error("The browser couldn't read this file."));
    reader.readAsDataURL(blob);
  });
}
/** 16-bit mono PCM as a WAV file. */
function wavFile(samples: Float32Array, rate: number) {
  const out = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const text = (at: number, s: string) => [...s].forEach((ch, i) => out.setUint8(at + i, ch.charCodeAt(0)));
  text(0, "RIFF"); out.setUint32(4, 36 + samples.length * 2, true); text(8, "WAVE"); text(12, "fmt ");
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true); out.setUint32(24, rate, true);
  out.setUint32(28, rate * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true); text(36, "data"); out.setUint32(40, samples.length * 2, true);
  samples.forEach((v, i) => out.setInt16(44 + i * 2, Math.max(-1, Math.min(1, v)) * 0x7fff, true));
  return new Blob([out.buffer], { type: "audio/wav" });
}
const LISTEN_RATE = 22050, LISTEN_SECONDS = 60, FRAMES = 6;
/**
 * What the AI sees or hears of a file: the picture or 6 frames spread over a clip (JPEGs of at most 720 pixels), or a
 * minute of a track (from a fifth of the way in for a long one) as a mono 22 kHz WAV (about 2.6 MB): any format and
 * size of file works, and the request stays small.
 */
async function samplesOf(src: File | string, kind: LibraryKind): Promise<{ duration: number; frames: string[]; audio?: string }> {
  const url = typeof src === "string" ? src : URL.createObjectURL(src);
  try {
    if (kind === "music") {
      const data = typeof src === "string"
        ? await fetch(url).then((r) => { if (!r.ok) throw new Error("This track couldn't be loaded."); return r.arrayBuffer(); })
        : await src.arrayBuffer();
      const context = new AudioContext();
      let decoded: AudioBuffer;
      try {
        decoded = await context.decodeAudioData(data);
      } catch {
        throw new Error("The browser can't decode this track. Try an MP3.");
      } finally {
        void context.close();
      }
      const start = decoded.duration > LISTEN_SECONDS + 20 ? Math.min(30, decoded.duration / 5) : 0;
      const length = Math.min(LISTEN_SECONDS, decoded.duration - start);
      // One channel at 22 kHz: the browser mixes and resamples the excerpt.
      const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil(length * LISTEN_RATE)), LISTEN_RATE);
      const source = offline.createBufferSource();
      source.buffer = decoded;
      source.connect(offline.destination);
      source.start(0, start, length);
      const rendered = await offline.startRendering();
      return { duration: decoded.duration, frames: [], audio: await base64Of(wavFile(rendered.getChannelData(0), LISTEN_RATE)) };
    }
    if (kind === "image") {
      const img = new Image();
      const loaded = waitFor(img, "load", 20000);
      img.src = url;
      await loaded;
      const frame = await thumbnail(img, img.naturalWidth, img.naturalHeight, 1024);
      if (!frame) throw new Error("The browser couldn't read this picture.");
      return { duration: 0, frames: [await base64Of(frame)] };
    }
    const video = document.createElement("video");
    video.preload = "auto";
    video.muted = true;
    video.playsInline = true;
    const loaded = waitFor(video, "loadedmetadata", 20000);
    video.src = url;
    await loaded;
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const frames: string[] = [];
    // Without a known length (some WebM recordings), the first frame only.
    for (let i = 0; i < (duration ? FRAMES : 1); i++) {
      const seeked = waitFor(video, "seeked", 15000);
      video.currentTime = duration ? (duration * (i + 0.5)) / FRAMES : 0.1;
      await seeked;
      const frame = await thumbnail(video, video.videoWidth, video.videoHeight);
      if (frame) frames.push(await base64Of(frame));
    }
    if (!frames.length) throw new Error("No frames could be taken from this clip.");
    return { duration, frames };
  } finally {
    if (typeof src !== "string") URL.revokeObjectURL(url);
  }
}
/** The AI's suggested details for a file (a chosen one, or an item's), from samples made here. */
async function suggest(kind: LibraryKind, name: string, src: File | string) {
  const s = await samplesOf(src, kind);
  return (await post<{ suggestion: Suggestion }>("/admin/library/describe", { kind, name: name.slice(0, 200), ...s, duration: Math.min(600, s.duration) })).suggestion;
}
/** A genre or category: one of the suggested ones, or the administrator's own words. */
function CategoryField({ kind, id, value, onChange, disabled }: { kind: LibraryKind; id: string; value: string; onChange: (v: string) => void; disabled?: boolean }) {
  return (
    <>
      <input id={id} className="input" list={`${id}-list`} value={value} onChange={(e) => onChange(e.target.value)} maxLength={CATEGORY_MAX} disabled={disabled}
        placeholder={kind === "music" ? "e.g. Lo-fi" : "e.g. Nature"} autoComplete="off" />
      <datalist id={`${id}-list`}>{categoriesFor(kind).map((c) => <option key={c} value={c} />)}</datalist>
    </>
  );
}

function LibraryUpload({ onUploaded, onFromMedia }: { onUploaded: (item: AdminItem) => void; onFromMedia: () => void }) {
  const toast = useToast();
  const [kind, setKind] = useState<LibraryKind>("clip");
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("");
  const [tags, setTags] = useState("");
  const [ai, setAi] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (stage) return;
    setProblem(null);
    if (!file) return setProblem("Choose a file.");
    const mime = mimeOf(file);
    const wanted = kind === "clip" ? "video/" : kind === "image" ? "image/" : "audio/";
    if (!mime.startsWith(wanted)) return setProblem(kind === "clip" ? "Choose an MP4, MOV or WebM video." : kind === "image" ? "Choose a JPG, PNG or WebP picture." : "Choose an MP3, M4A, OGG or WAV track.");
    if (file.size > maxBytes[kind]) return setProblem(`Library ${kind === "image" ? "pictures" : "files"} can be up to ${maxBytes[kind] / MB} MB.`);
    try {
      setStage("Reading the file…");
      const m = await measure(file, kind);
      if (kind !== "image" && (m.duration < 0.5 || m.duration > 600)) throw new Error("Library clips and tracks must be between half a second and 10 minutes long.");
      if (m.width > 4096 || m.height > 4096) throw new Error(`${kind === "image" ? "Pictures" : "Videos"} can be up to 4096 pixels on each side.`);
      const title = name.trim() || baseName(file.name) || "Untitled";
      const query = new URLSearchParams({
        kind, name: title, description: description.trim(), category: category.trim(), tags: splitTags(tags).join(", "), ai: ai ? "1" : "0",
        duration: m.duration.toFixed(2), width: String(m.width), height: String(m.height),
      });
      setStage("Uploading…");
      setProgress(0);
      const { item } = await sendFile<{ item: AdminItem }>(`/admin/library/file?${query}`, file, mime, setProgress);
      setProgress(null);
      setStage("Saving the thumbnail…");
      const thumbed = await saveThumb(item.id, m.poster);
      if (!thumbed && kind === "clip") toast("Uploaded, but the thumbnail couldn't be saved.", "bad");
      toast(`${title} is in the library.`, "good");
      setFile(null); setName(""); setDescription(""); setCategory(""); setTags(""); setAi(false);
      onUploaded(thumbed ? { ...item, thumb: `/api/library/${item.id}/thumb` } : item);
    } catch (err) {
      setProblem(errorText(err));
    } finally {
      setStage(null);
      setProgress(null);
    }
  };
  /** The chosen file's details suggested by AI, to check before uploading. */
  const fillIn = async () => {
    if (!file || suggesting) return;
    setSuggesting(true);
    setProblem(null);
    try {
      const s = await suggest(kind, name.trim(), file);
      // A name made of the file's name gives way to the AI's; one the administrator wrote stays.
      if (s.name && (!name.trim() || name.trim() === baseName(file.name))) setName(s.name);
      setDescription(s.description);
      setCategory(s.category);
      setTags(s.tags.join(", "));
      toast("Filled in by AI. Check it, then upload.", "good");
    } catch (err) {
      setProblem(errorText(err));
    } finally {
      setSuggesting(false);
    }
  };
  const busy = !!stage || suggesting;
  return (
    <section className="card" aria-labelledby="library-upload-title">
      <div className="card-head">
        <div>
          <h2 id="library-upload-title">Add to the library</h2>
          <p>Upload a clip, picture or track (up to 50 MB; pictures 20 MB), or add AI pictures and clips you made for your own videos. Length, size and a thumbnail are made here in your browser.</p>
        </div>
        <button type="button" className="btn" onClick={onFromMedia}><Sparkles size={16} aria-hidden="true" />Add from my media</button>
      </div>
      <form className="form-grid" onSubmit={submit}>
        <div className="field">
          <label className="label" htmlFor="lib-kind">Kind</label>
          <select id="lib-kind" className="select" value={kind} onChange={(e) => { setKind(e.target.value as LibraryKind); setFile(null); setCategory(""); }} disabled={busy}>
            <option value="clip">Clip (backgrounds and scenes)</option>
            <option value="image">Picture (scenes)</option>
            <option value="music">Music</option>
          </select>
        </div>
        <div className="field">
          <span className="label" id="lib-file-label">File</span>
          <div className="row">
            <button type="button" className="btn" onClick={() => input.current?.click()} disabled={busy} aria-describedby="lib-file-label lib-file-name">
              <UploadIcon size={16} aria-hidden="true" />{file ? "Change file" : "Choose file"}
            </button>
            <span id="lib-file-name" className="small muted" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{file ? `${file.name} · ${bytes(file.size)}` : "No file chosen"}</span>
          </div>
          <input ref={input} type="file" hidden tabIndex={-1} aria-hidden="true" accept={accepts[kind]}
            onChange={(e) => { const f = e.target.files?.[0] || null; e.target.value = ""; setFile(f); if (f && !name.trim()) setName(baseName(f.name)); }} />
        </div>
        <div className="field">
          <label className="label" htmlFor="lib-name">Name</label>
          <input id="lib-name" className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="e.g. Kinetic sand cutting" disabled={busy} />
        </div>
        <div className="field">
          <label className="label" htmlFor="lib-category">{categoryLabel(kind)}</label>
          <CategoryField kind={kind} id="lib-category" value={category} onChange={setCategory} disabled={busy} />
        </div>
        <div className="field full">
          <label className="label" htmlFor="lib-tags">Tags</label>
          <input id="lib-tags" className="input" value={tags} onChange={(e) => setTags(e.target.value)} maxLength={280} placeholder="Comma-separated, e.g. satisfying, calm" disabled={busy} aria-describedby="lib-tags-hint" />
          <div className="row wrap" id="lib-tags-hint" style={{ gap: 6 }}>
            <span className="hint">Add:</span>
            {tagIdeas[kind].map((t) => <button key={t} type="button" className="chip button tag-chip" onClick={() => setTags((v) => withTag(v, t))} disabled={busy}>{t}</button>)}
          </div>
        </div>
        <div className="field full">
          <label className="label" htmlFor="lib-description">Description</label>
          <textarea id="lib-description" className="textarea" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} disabled={busy}
            placeholder={kind === "music" ? "e.g. Soft piano with light strings, slow and hopeful" : "e.g. A slow drone shot over a misty pine forest at sunrise"} aria-describedby="lib-description-hint" />
          <span className="hint" id="lib-description-hint">{descriptionHint}</span>
        </div>
        <div className="field full row" style={{ gap: 10, flexDirection: "row" }}>
          <Switch checked={ai} onChange={setAi} label="Made with AI" disabled={busy} />
          <span className="small">Made with AI <span className="muted">· videos that use it are marked as AI-made when they're posted</span></span>
        </div>
        {problem && <div className="notice bad full" role="alert">{problem}</div>}
        <div className="full row wrap">
          <button type="button" className="btn" disabled={!file || busy} onClick={() => void fillIn()} title={file ? undefined : "Choose a file first"}>
            {suggesting ? <Spinner label="Filling in" /> : <Sparkles size={16} aria-hidden="true" />}{suggesting ? (kind === "music" ? "Listening…" : "Looking…") : "Fill in with AI"}
          </button>
          <button type="submit" className="btn primary" disabled={!file || busy}>{stage ? <Spinner label="Uploading" /> : <UploadIcon size={16} aria-hidden="true" />}Upload</button>
          {stage && <span className="small muted" role="status">{stage}{progress !== null && ` ${Math.round(progress * 100)}%`}</span>}
          {progress !== null && <div className="meter grow" style={{ maxWidth: 260 }} aria-hidden="true"><span style={{ width: `${Math.max(2, progress * 100)}%` }} /></div>}
        </div>
      </form>
    </section>
  );
}

/**
 * The administrator's own uploads and AI pictures and clips; one is added to the library with its details (name,
 * prompt as the description, the AI mark), which are checked right after.
 */
function FromMediaModal({ onClose, onAdded }: { onClose: () => void; onAdded: (item: AdminItem) => void }) {
  const [kind, setKind] = useState<LibraryKind>("image");
  const { data, loading, error, reload } = useApi<{ files: MediaFile[] }>(`/admin/library/media?kind=${kind}`);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const audio = usePreviewAudio();
  const close = useStableCallback(() => { audio.stop(); onClose(); });
  const add = async (f: MediaFile) => {
    setBusy(f.id);
    setProblem(null);
    try {
      const { item } = await post<{ item: AdminItem }>("/admin/library/from-media", { assetId: f.id });
      // Clips and pictures get a small thumbnail, made from the library's copy.
      const poster = kind === "music" ? null : await measure(item.url, kind).then((m) => m.poster).catch(() => null);
      const thumbed = await saveThumb(item.id, poster);
      audio.stop();
      onAdded(thumbed ? { ...item, thumb: `/api/library/${item.id}/thumb` } : item);
    } catch (e) {
      setProblem(errorText(e));
      setBusy(null);
    }
  };
  const files = data?.files || [];
  return (
    <Modal title="Add from my media" onClose={close} wide>
      <div className="stack">
        <p className="small muted" style={{ margin: 0 }}>
          Your uploads and the AI pictures and clips made for your videos. A file is copied into the library with its name, its prompt as the description and the
          AI mark; you can change them right after.
        </p>
        <div className="seg small-seg" role="group" aria-label="Kind">
          {kinds.map((k) => <button key={k} type="button" aria-pressed={kind === k} onClick={() => { setKind(k); setProblem(null); }}>{kindPlural[k]}</button>)}
        </div>
        {problem && <p className="notice bad small" role="alert">{problem}</p>}
        {loading ? <Spinner label="Loading your media" /> : error ? (
          <p className="notice bad small" role="alert">{error} <button type="button" className="link" onClick={() => void reload()}>Try again</button></p>
        ) : !files.length ? (
          <p className="small muted">No {kind === "music" ? "tracks" : kindPlural[kind].toLowerCase()} in your media yet. Upload some on the Media page, or make a video with AI {kind === "clip" ? "clips" : "pictures"}.</p>
        ) : (
          <ul className="pick-rows list-plain" style={{ maxHeight: 420, overflowY: "auto" }}>
            {files.map((f) => (
              <li key={f.id} className="pick-row">
                {kind === "music" ? <PlayButton playing={audio.playing === f.id} onClick={() => audio.toggle(f.id, f.url)} label={f.name} /> : (
                  <span className="adm-thumb" aria-hidden="true">
                    {kind === "image" ? <img src={f.url} alt="" loading="lazy" /> : <video src={firstFrame(f.url)} muted playsInline preload="metadata" style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
                  </span>
                )}
                <span className="grow" style={{ minWidth: 0 }}>
                  <span className="name" style={{ display: "block" }}>{f.name}{f.ai && <span className="chip pick-ai">AI</span>}</span>
                  <span className="small muted">
                    {[kind === "image" ? `${f.width}×${f.height}` : seconds(f.duration), bytes(f.bytes)].join(" · ")}
                  </span>
                  {f.problem && <span className="small" style={{ display: "block", color: "var(--bad, #a3191f)" }}>{f.problem}</span>}
                </span>
                {f.added ? <span className="chip">In the library</span> : (
                  <button type="button" className="btn sm" disabled={!!busy || !!f.problem} onClick={() => void add(f)}>
                    {busy === f.id ? <Spinner label="Adding" /> : <Plus size={14} aria-hidden="true" />}Add
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------------------------------------ items */

function PreviewModal({ item, onClose }: { item: AdminItem; onClose: () => void }) {
  const close = useStableCallback(onClose);
  return (
    <Modal title={item.name} onClose={close} wide>
      <div className="adm-preview stack">
        {!item.active && <div className="notice warn">This item is switched off, so its file isn't served. Switch it on to preview it.</div>}
        {item.kind === "music" ? <audio controls autoPlay={false} src={item.url} />
          : item.kind === "image" ? <img src={item.url} alt={item.description || item.name} />
            : <video controls playsInline src={item.url} poster={item.thumb || undefined} />}
        {item.description && <p style={{ margin: 0 }}>{item.description}</p>}
        <div className="row wrap small muted">
          <span>{kindNames[item.kind]}</span>{item.kind !== "image" && <>·<span>{seconds(item.duration)}</span></>}{item.width > 0 && <>·<span>{item.width} × {item.height}</span></>}
          {item.tags.length > 0 && <>·<span>{item.tags.join(", ")}</span></>}{item.ai && <>·<span>Made with AI</span></>}
          <a className="btn sm" href={item.url} download style={{ marginLeft: "auto" }}><Download size={14} aria-hidden="true" />Download</a>
        </div>
      </div>
    </Modal>
  );
}

/**
 * Name, description, genre or category, tags and the AI mark, as people see and search them; `suggestion` (the ✨
 * button) fills them in, to check before saving.
 */
function EditItemModal({ item, suggestion, onClose, onSaved }: { item: AdminItem; suggestion?: Suggestion; onClose: () => void; onSaved: (item: AdminItem) => void }) {
  const toast = useToast();
  const filled = (s: Suggestion | undefined) => ({
    name: s?.name || item.name, description: s?.description || item.description, category: s?.category || item.category,
    tags: s?.tags.length ? s.tags.join(", ") : item.rawTags,
  });
  const [form, setForm] = useState({ ...filled(suggestion), ai: item.ai });
  const [suggested, setSuggested] = useState(!!suggestion);
  const [suggesting, setSuggesting] = useState(false);
  const [busy, setBusy] = useState(false);
  const close = useStableCallback(onClose);
  const set = (p: Partial<typeof form>) => setForm((f) => ({ ...f, ...p }));
  const fillIn = async () => {
    setSuggesting(true);
    try {
      const s = await suggest(item.kind, form.name, adminFile(item.id));
      set(filled(s));
      setSuggested(true);
    } catch (err) {
      toast(errorText(err), "bad");
    } finally {
      setSuggesting(false);
    }
  };
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) return;
    setBusy(true);
    try {
      const { item: saved } = await patch<{ item: AdminItem }>(`/admin/library/${item.id}`, {
        name: form.name.trim(), description: form.description.trim(), category: form.category.trim(), tags: splitTags(form.tags).join(", "), ai: form.ai,
      });
      toast("Saved.", "good");
      onSaved({ ...saved, usage: item.usage, thumb: saved.thumb ?? item.thumb });
    } catch (err) {
      toast(errorText(err), "bad");
      setBusy(false);
    }
  };
  return (
    <Modal title={`Edit ${kindNames[item.kind].toLowerCase()}`} onClose={close}>
      <form className="stack" onSubmit={save}>
        <div className="row wrap" style={{ gap: 12, alignItems: "flex-start" }}>
          {item.thumb && <img src={item.thumb} alt="" style={{ maxHeight: 160, maxWidth: "100%", objectFit: "contain", borderRadius: 10 }} />}
          <button type="button" className="btn sm" onClick={() => void fillIn()} disabled={suggesting || busy}>
            {suggesting ? <Spinner label="Filling in" /> : <Sparkles size={14} aria-hidden="true" />}{suggesting ? (item.kind === "music" ? "Listening…" : "Looking…") : "Fill in with AI"}
          </button>
        </div>
        {suggested && <p className="notice small" role="status" style={{ margin: 0 }}>Filled in by AI from the {item.kind === "music" ? "track" : item.kind === "clip" ? "clip" : "picture"}. Check it before saving: nothing is saved until you do.</p>}
        <label className="field"><span>Name</span><input className="input" value={form.name} onChange={(e) => set({ name: e.target.value })} maxLength={120} required /></label>
        <div className="field">
          <span><label htmlFor="edit-category">{categoryLabel(item.kind)}</label></span>
          <CategoryField kind={item.kind} id="edit-category" value={form.category} onChange={(category) => set({ category })} />
        </div>
        <label className="field">
          <span>Description</span>
          <textarea className="textarea" rows={3} value={form.description} onChange={(e) => set({ description: e.target.value })} maxLength={500} />
          <span className="hint">{descriptionHint}</span>
        </label>
        <label className="field">
          <span>Tags</span>
          <input className="input" value={form.tags} onChange={(e) => set({ tags: e.target.value })} maxLength={300} />
          <span className="hint">Comma-separated.{item.kind === "music" ? " Music moods: calm, upbeat, inspiring, dark, epic, mysterious, playful, ambient." : ""}</span>
        </label>
        <div className="row wrap" style={{ gap: 6 }}>
          <span className="hint">Add:</span>
          {tagIdeas[item.kind].map((t) => <button key={t} type="button" className="chip button tag-chip" onClick={() => set({ tags: withTag(form.tags, t) })}>{t}</button>)}
        </div>
        <div className="row" style={{ gap: 10 }}>
          <Switch checked={form.ai} onChange={(ai) => set({ ai })} label="Made with AI" />
          <span className="small">Made with AI <span className="muted">· videos that use it are marked as AI-made when they're posted</span></span>
        </div>
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={close}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy || !form.name.trim()}>{busy && <Spinner label="Saving" />}Save</button>
        </div>
      </form>
    </Modal>
  );
}

function Loading() {
  return <div className="stack" aria-busy="true">{Array.from({ length: 4 }, (_, i) => <div key={i} className="skeleton" style={{ height: 64 }} />)}</div>;
}
