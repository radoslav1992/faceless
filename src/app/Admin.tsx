import { useRef, useState, type FormEvent } from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import { Download, Eye, Film, Mail, Music, Pencil, RefreshCw, Search, Trash2, Upload as UploadIcon } from "lucide-react";
import { Modal, Spinner, Switch, useToast } from "../ui";
import { ApiError, bytes, del, errorText, number, patch, seconds, useApi, useAuth, type LibraryItem } from "../lib";
import { ConfirmDialog, Empty, Tabs, ago, formatDate, tabPanel, useStableCallback } from "./pickers";
import { BillingTab, OperationsTab } from "./AdminOps";
import "./pages.css";

type Kind = LibraryItem["kind"];
type Overview = {
  users: number; newUsers: number; paying: number; granted: number; videos: number; series: number; failedRuns: number; activeRuns: number; published: number; failedPublications: number;
  config: Record<string, boolean>;
};
type AdminItem = LibraryItem & { active: boolean; rawTags: string };
type Message = { id: string; name: string; email: string; topic: string; message: string; created_at: number };
type Tab = "overview" | "operations" | "billing" | "library" | "messages";
const tabIds: Tab[] = ["overview", "operations", "billing", "library", "messages"];
const kindNames: Record<Kind, string> = { clip: "Background clip", music: "Music" };
const topics: Record<string, string> = { question: "Question", billing: "Billing", withdrawal: "Withdrawal (14 days)", partnership: "Partnership", abuse: "Report abuse", other: "Other" };
const flagNames: Record<string, string> = {
  media: "Media pipeline", fal: "fal.ai (AI images & clips)", elevenlabs: "ElevenLabs (voices)", stripe: "Stripe keys",
  billing: "Billing open", tokens: "Token encryption", tiktok: "TikTok", instagram: "Instagram", youtube: "YouTube",
};
const clipTagIdeas = ["satisfying", "gameplay-style", "parkour", "cooking", "nature", "city"];
const musicTagIdeas = ["calm", "upbeat", "inspiring", "dark", "epic", "mysterious", "playful", "ambient"];
const MB = 1024 * 1024;

/** Administration (admins only): health, operations, billing tools, the shared library and contact messages. */
export function AdminPage() {
  const { user } = useAuth();
  if (!user?.admin) return <Navigate to="/app" replace />;
  return <AdminConsole />;
}

function AdminConsole() {
  const [params, setParams] = useSearchParams();
  const requested = params.get("tab") as Tab | null;
  const tab: Tab = requested && tabIds.includes(requested) ? requested : "overview";
  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>Admin</h1>
          <p>Service health and operations, withdrawals and free months, the shared library and contact messages.</p>
        </div>
      </div>
      <div style={{ marginBottom: 20 }}>
        <Tabs label="Admin sections" idBase="admin" value={tab} onChange={(t) => setParams(t === "overview" ? {} : { tab: t }, { replace: true })} items={[
          { id: "overview", label: "Overview" }, { id: "operations", label: "Operations" }, { id: "billing", label: "Billing" },
          { id: "library", label: "Library" }, { id: "messages", label: "Messages" },
        ]} />
      </div>
      <div {...tabPanel("admin", tab)}>
        {tab === "overview" && <OverviewTab />}
        {tab === "operations" && <OperationsTab />}
        {tab === "billing" && <BillingTab />}
        {tab === "library" && <LibraryTab />}
        {tab === "messages" && <MessagesTab />}
      </div>
    </main>
  );
}

/* ------------------------------------------------------------------------------------------------ helpers */

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

function waitFor(el: HTMLMediaElement, event: string, ms: number) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error("The browser couldn't read this file in time.")); }, ms);
    const done = () => { cleanup(); resolve(); };
    const fail = () => { cleanup(); reject(new Error("The browser can't play this file. Try an MP4 (H.264) video or an MP3 track.")); };
    const cleanup = () => { clearTimeout(timer); el.removeEventListener(event, done); el.removeEventListener("error", fail); };
    el.addEventListener(event, done);
    el.addEventListener("error", fail);
  });
}
/** Duration and size from the browser's own player, plus a poster frame (JPEG) for videos. */
async function measure(file: File, video: boolean) {
  const url = URL.createObjectURL(file);
  try {
    const el = document.createElement(video ? "video" : "audio");
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
      const scale = Math.min(1, 720 / Math.max(width, height, 1));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      canvas.getContext("2d")?.drawImage(el, 0, 0, canvas.width, canvas.height);
      poster = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.82));
    } catch {
      poster = null;
    }
    return { duration, width, height, poster };
  } finally {
    URL.revokeObjectURL(url);
  }
}
function Loading() {
  return <div className="stack" aria-busy="true">{Array.from({ length: 4 }, (_, i) => <div key={i} className="skeleton" style={{ height: 64 }} />)}</div>;
}
function LoadError({ error, retry }: { error: string; retry: () => void }) {
  return <div className="notice bad" role="alert">{error} <button type="button" className="link" onClick={retry}>Try again</button></div>;
}
/* ------------------------------------------------------------------------------------------------ overview */

function OverviewTab() {
  const { data, loading, error, reload } = useApi<Overview>("/admin/overview");
  if (loading) return <Loading />;
  if (error || !data) return <LoadError error={error || "Not available."} retry={() => void reload()} />;
  const stats: { label: string; value: number; sub?: string; bad?: boolean }[] = [
    { label: "Users", value: data.users, sub: `+${number(data.newUsers)} in the last 24 h` },
    { label: "Paying", value: data.paying, sub: `Active subscriptions${data.granted ? ` · ${number(data.granted)} free month${data.granted === 1 ? "" : "s"}` : ""}` },
    { label: "Videos made", value: data.videos, sub: "Last 24 h" },
    { label: "Active series", value: data.series, sub: "On autopilot" },
    { label: "Runs in progress", value: data.activeRuns, sub: "Queued or running" },
    { label: "Failed runs", value: data.failedRuns, sub: "Last 24 h", bad: data.failedRuns > 0 },
    { label: "Published", value: data.published, sub: "Last 24 h" },
    { label: "Failed publications", value: data.failedPublications, sub: "Last 24 h", bad: data.failedPublications > 0 },
  ];
  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="row between">
        <h2 style={{ fontSize: 20 }}>Activity</h2>
        <button type="button" className="btn sm" onClick={() => void reload()}><RefreshCw size={14} aria-hidden="true" />Refresh</button>
      </div>
      <div className="grid four">
        {stats.map((s) => (
          <div key={s.label} className={`card stat-card${s.bad ? " bad" : ""}`}>
            <span className="label">{s.label}</span>
            <strong>{number(s.value)}</strong>
            {s.sub && <span className="sub">{s.sub}</span>}
          </div>
        ))}
      </div>
      <section className="card" aria-labelledby="config-title">
        <h2 id="config-title" style={{ marginBottom: 12 }}>Configuration</h2>
        <ul className="list-plain flag-grid">
          {Object.entries(data.config).map(([key, on]) => (
            <li key={key} className={`chip ${on ? "green" : "red"}`}>{on ? "On" : "Off"} · {flagNames[key] || key}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------ library */

function LibraryTab() {
  const toast = useToast();
  const { data, loading, error, reload, setData } = useApi<{ items: AdminItem[] }>("/admin/library");
  const [kind, setKind] = useState<"all" | Kind>("all");
  const [query, setQuery] = useState("");
  const [preview, setPreview] = useState<AdminItem | null>(null);
  const [editing, setEditing] = useState<AdminItem | null>(null);
  const [deleting, setDeleting] = useState<AdminItem | null>(null);
  const items = data?.items || [];
  const q = query.trim().toLowerCase();
  const shown = items.filter((i) => (kind === "all" || i.kind === kind) && (!q || i.name.toLowerCase().includes(q) || i.rawTags.toLowerCase().includes(q)));
  const change = (id: string, c: Partial<AdminItem>) => setData((d) => (d ? { items: d.items.map((i) => (i.id === id ? { ...i, ...c } : i)) } : d));
  const setActive = async (item: AdminItem, active: boolean) => {
    change(item.id, { active });
    try {
      await patch(`/admin/library/${item.id}`, { active });
    } catch (e) {
      change(item.id, { active: item.active });
      toast(errorText(e), "bad");
    }
  };
  const counts = { all: items.length, clip: 0, music: 0 };
  for (const i of items) counts[i.kind]++;
  return (
    <div className="stack" style={{ gap: 20 }}>
      <LibraryUpload onUploaded={() => void reload()} />
      <section aria-labelledby="library-list-title">
        <div className="section-head">
          <h2 id="library-list-title">Library items</h2>
          <div className="toolbar">
            <label className="search" style={{ width: 220 }}>
              <Search size={16} aria-hidden="true" />
              <span className="sr-only">Search by name or tag</span>
              <input className="input" type="search" placeholder="Name or tag" value={query} onChange={(e) => setQuery(e.target.value)} />
            </label>
            <div className="tag-filter" role="group" aria-label="Kind" style={{ margin: 0 }}>
              {(["all", "clip", "music"] as const).map((k) => (
                <button key={k} type="button" className="chip button" aria-pressed={kind === k} onClick={() => setKind(k)}>
                  {k === "all" ? "All" : kindNames[k]} · {counts[k]}
                </button>
              ))}
            </div>
          </div>
        </div>
        {loading ? <Loading /> : error ? <LoadError error={error} retry={() => void reload()} /> : !items.length ? (
          <Empty icon={<Film size={24} />} title="The library is empty">Upload background clips and music above. Music tagged with a mood is picked for series of that mood.</Empty>
        ) : !shown.length ? (
          <p className="muted center" style={{ padding: 24 }}>Nothing matches.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <caption className="sr-only">Library items</caption>
              <thead><tr><th scope="col">Preview</th><th scope="col">Name</th><th scope="col">Tags</th><th scope="col">Length</th><th scope="col">Active</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {shown.map((i) => (
                  <tr key={i.id}>
                    <td>
                      <button type="button" className="adm-thumb" style={{ border: 0, padding: 0, cursor: "pointer" }} onClick={() => setPreview(i)} aria-label={`Preview ${i.name}`}>
                        {i.kind === "music" ? <Music size={20} aria-hidden="true" /> : i.thumb ? <img src={i.thumb} alt="" loading="lazy" onError={(e) => { e.currentTarget.style.display = "none"; }} /> : <Film size={20} aria-hidden="true" />}
                      </button>
                    </td>
                    <td>
                      <span className="clip" style={{ fontWeight: 600 }} title={i.name}>{i.name}</span>
                      <span className="small muted">{kindNames[i.kind]}{i.width ? ` · ${i.width}×${i.height}` : ""}</span>
                    </td>
                    <td><span className="clip small" title={i.rawTags}>{i.rawTags || <span className="muted">No tags</span>}</span></td>
                    <td className="small">{seconds(i.duration)}</td>
                    <td><Switch checked={i.active} onChange={(v) => void setActive(i, v)} label={`${i.name} is active`} /></td>
                    <td>
                      <div className="icon-actions">
                        <button type="button" className="btn icon ghost" onClick={() => setPreview(i)} aria-label={`Preview ${i.name}`} title="Preview"><Eye size={16} /></button>
                        <button type="button" className="btn icon ghost" onClick={() => setEditing(i)} aria-label={`Edit ${i.name}`} title="Edit"><Pencil size={16} /></button>
                        <button type="button" className="btn icon ghost danger" onClick={() => setDeleting(i)} aria-label={`Delete ${i.name}`} title="Delete"><Trash2 size={16} /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {preview && <PreviewModal item={preview} onClose={() => setPreview(null)} />}
      {editing && <EditItemModal item={editing} onClose={() => setEditing(null)} onSaved={(c) => { change(editing.id, c); setEditing(null); }} />}
      {deleting && (
        <ConfirmDialog title="Delete this library item?" onClose={() => setDeleting(null)} onConfirm={async () => {
          await del(`/admin/library/${deleting.id}`);
          setData((d) => (d ? { items: d.items.filter((x) => x.id !== deleting.id) } : d));
          toast("Deleted.", "good");
        }}>
          <p><strong>{deleting.name}</strong> disappears from the library. Posts already rendered with it keep their video; to hide it only, switch it off instead.</p>
        </ConfirmDialog>
      )}
    </div>
  );
}

function LibraryUpload({ onUploaded }: { onUploaded: () => void }) {
  const toast = useToast();
  const [kind, setKind] = useState<Kind>("clip");
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [tags, setTags] = useState("");
  const [stage, setStage] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const video = kind !== "music";
  const addTag = (t: string) => setTags((v) => (splitTags(v).some((x) => x.toLowerCase() === t) ? v : [...splitTags(v), t].join(", ")));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (stage) return;
    setProblem(null);
    if (!file) return setProblem("Choose a file.");
    const mime = mimeOf(file);
    if (video ? !mime.startsWith("video/") : !mime.startsWith("audio/")) return setProblem(video ? "Choose an MP4, MOV or WebM video." : "Choose an MP3, M4A, OGG or WAV track.");
    if (file.size > 50 * MB) return setProblem("Library files can be up to 50 MB.");
    try {
      setStage("Reading the file…");
      const m = await measure(file, video);
      if (m.duration < 0.5 || m.duration > 600) throw new Error("Library files must be between half a second and 10 minutes long.");
      if (m.width > 4096 || m.height > 4096) throw new Error("Videos can be up to 4096 pixels on each side.");
      const allTags = splitTags(tags).join(", ");
      const title = name.trim() || baseName(file.name) || "Untitled";
      const query = new URLSearchParams({ kind, name: title, tags: allTags, duration: m.duration.toFixed(2), width: String(m.width), height: String(m.height) });
      setStage("Uploading…");
      setProgress(0);
      const { id } = await sendFile<{ id: string }>(`/admin/library/file?${query}`, file, mime, setProgress);
      setProgress(null);
      if (m.poster) {
        setStage("Saving the thumbnail…");
        try {
          await sendFile(`/admin/library/${id}/thumb`, m.poster, "image/jpeg");
        } catch (err) {
          toast(`Uploaded, but the thumbnail failed: ${errorText(err)}`, "bad");
        }
      }
      toast(`${title} is in the library.`, "good");
      setFile(null); setName(""); setTags("");
      onUploaded();
    } catch (err) {
      setProblem(errorText(err));
    } finally {
      setStage(null);
      setProgress(null);
    }
  };
  return (
    <section className="card" aria-labelledby="library-upload-title">
      <div className="card-head">
        <div>
          <h2 id="library-upload-title">Add to the library</h2>
          <p>Up to 50 MB. Length and size are measured here in your browser; clips also get a thumbnail.</p>
        </div>
      </div>
      <form className="form-grid" onSubmit={submit}>
        <div className="field">
          <label className="label" htmlFor="lib-kind">Kind</label>
          <select id="lib-kind" className="select" value={kind} onChange={(e) => { setKind(e.target.value as Kind); setFile(null); }} disabled={!!stage}>
            <option value="clip">Background clip (behind stories)</option>
            <option value="music">Music</option>
          </select>
        </div>
        <div className="field">
          <span className="label" id="lib-file-label">File</span>
          <div className="row">
            <button type="button" className="btn" onClick={() => input.current?.click()} disabled={!!stage} aria-describedby="lib-file-label lib-file-name">
              <UploadIcon size={16} aria-hidden="true" />{file ? "Change file" : "Choose file"}
            </button>
            <span id="lib-file-name" className="small muted" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{file ? `${file.name} · ${bytes(file.size)}` : "No file chosen"}</span>
          </div>
          <input ref={input} type="file" hidden tabIndex={-1} aria-hidden="true" accept={video ? "video/mp4,video/quicktime,video/webm,.mov" : "audio/*,.mp3,.m4a,.wav,.ogg"}
            onChange={(e) => { const f = e.target.files?.[0] || null; e.target.value = ""; setFile(f); if (f && !name.trim()) setName(baseName(f.name)); }} />
        </div>
        <div className="field">
          <label className="label" htmlFor="lib-name">Name</label>
          <input id="lib-name" className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="e.g. Kinetic sand cutting" disabled={!!stage} />
        </div>
        <div className="field">
          <label className="label" htmlFor="lib-tags">Tags</label>
          <input id="lib-tags" className="input" value={tags} onChange={(e) => setTags(e.target.value)} maxLength={280} placeholder="Comma-separated, e.g. satisfying, calm" disabled={!!stage} aria-describedby="lib-tags-hint" />
          {(
            <div className="row wrap" id="lib-tags-hint" style={{ gap: 6 }}>
              <span className="hint">Add:</span>
              {(video ? clipTagIdeas : musicTagIdeas).map((t) => <button key={t} type="button" className="chip button tag-chip" onClick={() => addTag(t)} disabled={!!stage}>{t}</button>)}
            </div>
          )}
        </div>
        {problem && <div className="notice bad full" role="alert">{problem}</div>}
        <div className="full row wrap">
          <button type="submit" className="btn primary" disabled={!file || !!stage}>{stage ? <Spinner label="Uploading" /> : <UploadIcon size={16} aria-hidden="true" />}Upload</button>
          {stage && <span className="small muted" role="status">{stage}{progress !== null && ` ${Math.round(progress * 100)}%`}</span>}
          {progress !== null && <div className="meter grow" style={{ maxWidth: 260 }} aria-hidden="true"><span style={{ width: `${Math.max(2, progress * 100)}%` }} /></div>}
        </div>
      </form>
    </section>
  );
}

function PreviewModal({ item, onClose }: { item: AdminItem; onClose: () => void }) {
  const close = useStableCallback(onClose);
  return (
    <Modal title={item.name} onClose={close} wide>
      <div className="adm-preview stack">
        {!item.active && <div className="notice warn">This item is switched off, so its file isn't served. Switch it on to preview it.</div>}
        {item.kind === "music"
          ? <audio controls autoPlay={false} src={item.url} />
          : <video controls playsInline src={item.url} poster={item.thumb || undefined} />}
        <div className="row wrap small muted">
          <span>{kindNames[item.kind]}</span>·<span>{seconds(item.duration)}</span>{item.width > 0 && <>·<span>{item.width} × {item.height}</span></>}
          {item.tags.length > 0 && <>·<span>{item.tags.join(", ")}</span></>}
          <a className="btn sm" href={item.url} download style={{ marginLeft: "auto" }}><Download size={14} aria-hidden="true" />Download</a>
        </div>
      </div>
    </Modal>
  );
}

function EditItemModal({ item, onClose, onSaved }: { item: AdminItem; onClose: () => void; onSaved: (c: Partial<AdminItem>) => void }) {
  const toast = useToast();
  const [name, setName] = useState(item.name);
  const [tags, setTags] = useState(item.rawTags);
  const [busy, setBusy] = useState(false);
  const close = useStableCallback(onClose);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    const raw = tags.split(",").map((t) => t.trim()).filter(Boolean).join(", ");
    try {
      await patch(`/admin/library/${item.id}`, { name: name.trim(), tags: raw });
      toast("Saved.", "good");
      onSaved({ name: name.trim(), rawTags: raw, tags: splitTags(raw) });
    } catch (err) {
      toast(errorText(err), "bad");
      setBusy(false);
    }
  };
  return (
    <Modal title="Edit library item" onClose={close}>
      <form className="stack" onSubmit={save}>
        <label className="field"><span>Name</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required /></label>
        <label className="field">
          <span>Tags</span>
          <input className="input" value={tags} onChange={(e) => setTags(e.target.value)} maxLength={300} />
          <span className="hint">Comma-separated. Music moods: calm, upbeat, inspiring, dark, epic, mysterious, playful, ambient.</span>
        </label>
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={close}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy || !name.trim()}>{busy && <Spinner label="Saving" />}Save</button>
        </div>
      </form>
    </Modal>
  );
}

function MessagesTab() {
  const { data, loading, error, reload } = useApi<{ messages: Message[] }>("/admin/messages");
  if (loading) return <Loading />;
  if (error || !data) return <LoadError error={error || "Not available."} retry={() => void reload()} />;
  if (!data.messages.length) return <Empty icon={<Mail size={24} />} title="No messages">Messages from the contact form show up here.</Empty>;
  return (
    <div className="table-wrap">
      <table className="table">
        <caption className="sr-only">Contact messages, newest first</caption>
        <thead><tr><th scope="col">Received</th><th scope="col">From</th><th scope="col">Topic</th><th scope="col">Message</th></tr></thead>
        <tbody>
          {data.messages.map((m) => (
            <tr key={m.id} style={{ verticalAlign: "top" }}>
              <td className="small" style={{ whiteSpace: "nowrap" }} title={formatDate(m.created_at, true)}>{ago(m.created_at)}</td>
              <td>
                <strong>{m.name}</strong>
                <div className="small"><a href={`mailto:${m.email}?subject=${encodeURIComponent(`Re: ${topics[m.topic] || "Your message"}`)}`} className="link">{m.email}</a></div>
              </td>
              <td><span className={`chip${m.topic === "abuse" ? " red" : m.topic === "billing" || m.topic === "withdrawal" ? " orange" : ""}`}>{topics[m.topic] || m.topic}</span></td>
              <td><MessageText text={m.message} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MessageText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  if (text.length <= 240) return <p className="msg-text">{text}</p>;
  return (
    <div>
      <p className="msg-text">{open ? text : `${text.slice(0, 220).trimEnd()}…`}</p>
      <button type="button" className="link small" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? "Show less" : "Show all"}</button>
    </div>
  );
}
