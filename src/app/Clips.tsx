import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, CalendarClock, Check, Clapperboard, Film, Link2, Play, Scissors, Sparkles, Trash2, UploadCloud, Youtube } from "lucide-react";
import { del, errorText, newKey, post, useApi, useAuth, usePoll, type Account, type Asset, type Source, type Video } from "../lib";
import { Modal, Spinner, Switch, useToast } from "../ui";
import { ConfirmDialog, CreditBlockNotice, DropZone, FileButton, ACCEPT, UploadList, creditBlock, firstFrame, useRetryKey, useSignedInUser, useUploads } from "./pickers";
import { CaptionStylePicker, EditorSection } from "./CaptionPickers";
import { ClipPreview } from "./ClipPreview";
import { LayoutPicker, scoreLine, scoreTone, useClipSource } from "./clip-editor";
import { PlatformBadge, VideoCard, making } from "./video-ui";
import { specSchema, type HighlightSpec } from "../../shared/formats";
import { creditsLabel, highlightCredits } from "../../shared/credits";
import {
  defaultClipOptions, layoutChoices, MOMENT_COUNTS, momentLengthIds, momentLengths, momentSpec, type ClipOptions, type Moment, type MomentLength,
} from "../../shared/highlights";
import { planById } from "../../shared/plans";
import { comingSoon } from "../../shared/social";
import { SPEECH_MAX_SECONDS } from "../../shared/speech";
import "./clips.css";
import "./create.css";

// Clips: the owner's long videos (podcasts, interviews, streams, webinars) and, for each, the moments the writer found
// and scored, a preview of each as a vertical clip, the clips made of them and posting them on a schedule.

/** "1:02:05" or "2:05" */
export const length = (s: number) => {
  const t = Math.round(s), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = String(t % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
};
/** Where a video stands on its way to clips, in a few words. */
function sourceState(s: Source): { text: string; tone: string; busy?: boolean } {
  if (s.importing) return { text: "Importing", tone: "orange", busy: true };
  if (s.status === "uploading" || s.status === "checking") return { text: "Checking", tone: "orange", busy: true };
  if (s.status === "failed") return { text: "Can't be used", tone: "red" };
  if (s.speech === "pending") return { text: "Listening", tone: "orange", busy: true };
  if (s.wanted) return { text: "Finding clips", tone: "orange", busy: true };
  if (s.moments.length) return { text: `${s.moments.length} moment${s.moments.length === 1 ? "" : "s"}`, tone: "green" };
  if (s.speech === "none") return { text: "No speech heard", tone: "" };
  return { text: "Ready to find clips", tone: "violet" };
}

export function ClipsPage() {
  const user = useSignedInUser();
  const navigate = useNavigate();
  const toast = useToast();
  const { data, error, loading, reload } = useApi<{ sources: Source[] }>("/highlights/sources");
  const uploads = useUploads({
    only: "video",
    concurrency: 1,
    onDone: (asset) => {
      void reload();
      if (asset.status === "failed") toast(`${asset.name}: ${asset.error || "This video can't be used."}`, "bad");
      else navigate(`/app/clips/${asset.id}`);
    },
  });
  const [importing, setImporting] = useState(false);
  const sources = data?.sources || [];
  usePoll(() => { void reload(); }, 5000, sources.some((s) => sourceState(s).busy));
  const imported = (asset: Asset) => {
    setImporting(false);
    navigate(`/app/clips/${asset.id}`);
  };
  const importButton = <button type="button" className="btn" onClick={() => setImporting(true)}><Link2 size={16} aria-hidden="true" />Import</button>;
  const plan = planById(user.plan);
  const limits = plan.id === "free" ? "Videos up to 10 minutes and 500 MB on the free trial; paid plans take videos up to 2 hours (2 GB)." : `Videos up to ${plan.videoMinutes / 60} hours and ${(plan.videoMb / 1000).toFixed(0)} GB.`;
  return (
    <main className="page clips">
      <div className="page-head">
        <div>
          <h1>Clips</h1>
          <p>Turn a podcast, interview, stream or webinar into vertical clips that follow the speaker, with captions.</p>
        </div>
        <div className="toolbar">
          {importButton}
          <FileButton accept={ACCEPT.video} className="btn primary" label="Upload a video" icon={<UploadCloud size={16} aria-hidden="true" />} onFiles={(files) => uploads.add(files.slice(0, 1))} disabled={uploads.busy} />
        </div>
      </div>
      {importing && <ImportDialog onClose={() => setImporting(false)} onImported={imported} />}
      <DropZone onFiles={(files) => uploads.add(files.slice(0, 1))} disabled={uploads.busy} label="Drop a video to find clips in it">
        <div className="stack" style={{ gap: 18 }}>
          {uploads.items.some((u) => u.status !== "ready") && <UploadList items={uploads.items.filter((u) => u.status !== "ready")} onDismiss={uploads.dismiss} />}
          {loading && !data ? <div className="loading-page"><Spinner big label="Loading your videos" /></div> : error && !data ? (
            <div className="empty"><p>{error}</p><button type="button" className="btn" onClick={() => void reload()}>Try again</button></div>
          ) : sources.length ? (
            <div className="source-grid">
              {sources.map((s) => {
                const state = sourceState(s);
                return (
                  <Link key={s.id} to={`/app/clips/${s.id}`} className="source-card">
                    <div className="source-thumb">
                      {s.status === "ready" ? <video src={firstFrame(s.url)} muted preload="metadata" playsInline aria-hidden="true" /> : <Film size={24} aria-hidden="true" />}
                      {s.duration > 0 && <span className="length">{length(s.duration)}</span>}
                    </div>
                    <strong>{s.name}</strong>
                    <span className="row wrap" style={{ gap: 6 }}>
                      <span className={`chip ${state.tone}`}>{state.busy && <Spinner label={state.text} />}{state.text}</span>
                      {s.clips > 0 && <span className="chip"><Scissors size={12} aria-hidden="true" />{s.clips} clip{s.clips === 1 ? "" : "s"}</span>}
                    </span>
                  </Link>
                );
              })}
            </div>
          ) : (
            <div className="card glow empty">
              <Scissors size={34} className="accent-text" aria-hidden="true" />
              <h2 style={{ fontSize: 22 }}>Your first clips are one upload away</h2>
              <ol className="clip-steps">
                <li><strong>Upload</strong> a podcast, interview, stream or webinar, or import it from a link.</li>
                <li><strong>Find clips:</strong> we listen to it and pick the moments that stand on their own, each with a virality score.</li>
                <li><strong>Make and post</strong> them as vertical clips that follow the speaker, with captions, on your schedule.</li>
              </ol>
              <div className="row wrap" style={{ gap: 8, justifyContent: "center" }}>
                <FileButton accept={ACCEPT.video} className="btn primary" label="Upload a video" icon={<UploadCloud size={16} aria-hidden="true" />} onFiles={(files) => uploads.add(files.slice(0, 1))} disabled={uploads.busy} />
                {importButton}
              </div>
            </div>
          )}
          <p className="muted small">{limits} Only upload or import videos you have the rights to, and film people with their consent.</p>
        </div>
      </DropZone>
    </main>
  );
}

type OwnVideo = { id: string; title: string; seconds: number; published: string | null; privacy: string; problem: string | null };
type OwnVideos = { enabled: boolean; reason: "off" | "plan" | "no-channel" | null; channels: { id: string; name: string; videos: OwnVideo[] }[] };
const watchUrl = (id: string) => `https://www.youtube.com/watch?v=${id}`;

/**
 * Imports a video from a link (a video file, or a Dropbox or Google Drive share link) or, when YouTube import is on for
 * the person's plan, one of the latest videos of their own connected YouTube channel.
 */
function ImportDialog({ onClose, onImported }: { onClose: () => void; onImported: (asset: Asset) => void }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const own = useApi<OwnVideos>("/media/youtube");
  const youtube = own.data?.enabled ?? false;
  const start = async (link: string, key: string) => {
    setBusy(key);
    setProblem(null);
    try {
      onImported((await post<{ asset: Asset }>("/media/imports", { url: link })).asset);
    } catch (err) {
      setProblem(errorText(err));
      setBusy(null);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void start(url, "link");
  };
  const videos = own.data?.channels.flatMap((c) => c.videos.map((v) => ({ ...v, channel: c.name }))) || [];
  return (
    <Modal title="Import a video" onClose={onClose} wide={youtube} footer={
      <>
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="submit" form="import-link" className="btn primary" disabled={!!busy || !url.trim()}>
          {busy === "link" ? <Spinner label="Opening the link" /> : <Link2 size={16} aria-hidden="true" />}Import link
        </button>
      </>
    }>
      <div className="stack">
        {youtube && (
          <section className="stack" aria-labelledby="own-youtube" style={{ gap: 8 }}>
            <h3 id="own-youtube" className="row" style={{ gap: 8, fontSize: 15 }}><Youtube size={16} aria-hidden="true" /> From your YouTube channel <span className="chip">Beta</span></h3>
            {own.data?.reason === "no-channel" ? (
              <p className="small muted">Connect your YouTube channel to import its videos. <Link className="text-link" to="/app/channels">Connect a channel</Link></p>
            ) : own.loading && !own.data ? <p className="row small"><Spinner label="Loading your videos" /> Loading your videos…</p> : !videos.length ? (
              <p className="small muted">No videos found on your connected channel yet.</p>
            ) : (
              <ul className="own-videos list-plain">
                {videos.map((v) => (
                  <li key={v.id} className="own-video">
                    <img src={`https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`} alt="" loading="lazy" referrerPolicy="no-referrer" />
                    <div className="own-video-body">
                      <strong>{v.title}</strong>
                      <span className="muted small">{length(v.seconds)}{v.published ? ` · ${new Date(v.published).toLocaleDateString()}` : ""}{own.data!.channels.length > 1 ? ` · ${v.channel}` : ""}</span>
                      {v.problem && <span className="small muted">{v.problem}</span>}
                    </div>
                    <button type="button" className="btn sm" disabled={!!busy || !!v.problem} onClick={() => void start(watchUrl(v.id), v.id)}>
                      {busy === v.id ? <Spinner label="Starting the import" /> : null}Import
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {own.error && <p className="notice bad small" role="alert">{own.error}</p>}
            <p className="muted small">Only videos of your own connected channel. YouTube sometimes refuses downloads; if it does, download the video in YouTube Studio and upload it.</p>
          </section>
        )}
        <form id="import-link" className="stack" onSubmit={submit}>
          <label className="field"><span className="small">{youtube ? "Or paste a link" : "Link to the video"}</span>
            <input className="input" type="url" inputMode="url" autoComplete="off" spellCheck={false} maxLength={2000} required value={url}
              onChange={(e) => setUrl(e.target.value)} placeholder="https://www.dropbox.com/scl/fi/…/episode.mp4" aria-describedby="import-link-hint" />
          </label>
          <p id="import-link-hint" className="muted small">
            {youtube
              ? "A direct link to an MP4, MOV or WebM file, a Dropbox or Google Drive link that anyone with the link can open, or a link to a video on your own connected YouTube channel."
              : own.data?.reason === "plan"
                ? "A direct link to an MP4, MOV or WebM file, or a Dropbox or Google Drive link that anyone with the link can open. Importing from your own YouTube channel is part of the paid plans."
                : "A direct link to an MP4, MOV or WebM file, or a Dropbox or Google Drive link that anyone with the link can open. YouTube links can't be imported: if it's your video, download it in YouTube Studio and upload the file."}
          </p>
          {problem && <p className="notice bad small" role="alert">{problem}</p>}
        </form>
      </div>
    </Modal>
  );
}

type Made = { state: "making" | "made" | "failed"; id?: string; error?: string };
const momentKey = (m: Moment) => `${m.start}-${m.end}`;

export function SourcePage() {
  const { id = "" } = useParams();
  const user = useSignedInUser();
  const { refresh } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const retry = useRetryKey();
  const { data, error, reload, setData } = useApi<{ source: Source; clips: Video[] }>(`/highlights/sources/${id}`);
  const source = data?.source;
  const clips = data?.clips || [];
  const [count, setCount] = useState<number>(5);
  const [lengthId, setLengthId] = useState<MomentLength>("medium");
  const [focusText, setFocusText] = useState("");
  const [busy, setBusy] = useState<"" | "find" | "make">("");
  const [problem, setProblem] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [focus, setFocus] = useState<string | null>(null);
  const [options, setOptions] = useState<ClipOptions>(defaultClipOptions);
  const [made, setMade] = useState<Record<string, Made>>({});
  const [scheduling, setScheduling] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const keys = useRef(new Map<string, string>());
  const seen = useRef<number | null>(null);
  const moments = useMemo(() => source?.moments || [], [source?.moments]);
  // New moments: all chosen, the best one previewed.
  useEffect(() => {
    if (!source || source.momentsAt === seen.current) return;
    seen.current = source.momentsAt;
    setChosen(new Set(moments.map(momentKey)));
    setFocus(moments[0] ? momentKey(moments[0]) : null);
    setMade({});
  }, [source, moments]);
  const waiting = !!source && (source.status === "checking" || source.speech === "pending" || !!source.wanted);
  usePoll(() => { void reload(); }, 4000, waiting || clips.some(making));
  const focused = moments.find((m) => momentKey(m) === focus) || null;
  const preview = useMemo(() => {
    if (!source || !focused) return null;
    const parsed = specSchema.safeParse(momentSpec(source.id, focused, options));
    return parsed.success ? parsed.data as HighlightSpec : null;
  }, [source, focused, options]);
  const clipSource = useClipSource(id, focused?.start ?? 0, focused?.end ?? 1);
  if (error) return <main className="page"><p className="notice bad">{error}</p><Link className="link" to="/app/clips">Back to Clips</Link></main>;
  if (!source) return <div className="loading-page" role="status">Loading…</div>;

  const long = source.duration > SPEECH_MAX_SECONDS && source.speech !== "found";
  const price = long ? source.transcribeCredits : 0;
  const block = price ? creditBlock(user, price) : !user.verified ? creditBlock(user, 0) : null;
  const find = async () => {
    setBusy("find"); setProblem(null);
    try {
      const body = { count, length: lengthId, focus: focusText.trim(), credits: price };
      const r = await post<{ source: Source }>(`/highlights/sources/${source.id}/find`, { ...body, idempotencyKey: retry.key({ id: source.id, ...body }) });
      retry.settle();
      setData((d) => (d ? { ...d, source: r.source } : d));
      if (price) void refresh();
    } catch (e) {
      retry.settle(e);
      setProblem(errorText(e));
    } finally {
      setBusy("");
    }
  };
  const picked = moments.filter((m) => chosen.has(momentKey(m)) && made[momentKey(m)]?.state !== "made");
  const cost = picked.reduce((n, m) => n + highlightCredits(m.end - m.start), 0);
  const makeBlock = picked.length ? creditBlock(user, cost) : null;
  const make = async () => {
    setBusy("make"); setProblem(null);
    let ok = 0;
    for (const m of picked) {
      const k = momentKey(m), key = keys.current.get(k) || newKey();
      keys.current.set(k, key);
      setMade((all) => ({ ...all, [k]: { state: "making" } }));
      try {
        const spec = specSchema.parse(momentSpec(source.id, m, options));
        const r = await post<{ id: string }>("/videos", { spec, idempotencyKey: key });
        setMade((all) => ({ ...all, [k]: { state: "made", id: r.id } }));
        ok++;
      } catch (e) {
        // A network failure may have made it: the same key is used again, so a retry cannot make it twice.
        if (!(e instanceof TypeError)) keys.current.delete(k);
        setMade((all) => ({ ...all, [k]: { state: "failed", error: errorText(e) } }));
      }
    }
    setBusy("");
    void refresh();
    void reload();
    if (ok) toast(ok === 1 ? "Your clip is being made." : `${ok} clips are being made.`, "good");
  };
  const toggle = (k: string) => setChosen((c) => { const next = new Set(c); if (next.has(k)) next.delete(k); else next.add(k); return next; });
  const set = (change: Partial<ClipOptions>) => setOptions((o) => ({ ...o, ...change }));
  const ready = clips.filter((c) => c.renderStatus === "ready");
  return (
    <main className="page clips">
      <div className="page-head">
        <div style={{ minWidth: 0 }}>
          <Link className="link" to="/app/clips"><ArrowLeft size={15} aria-hidden="true" /> Clips</Link>
          <h1 style={{ marginTop: 8, overflowWrap: "anywhere" }}>{source.name}</h1>
          <p>{length(source.duration)}{source.speechLanguage ? ` · speech in ${source.speechLanguage.toUpperCase()}` : ""}{clips.length ? ` · ${clips.length} clip${clips.length === 1 ? "" : "s"} made` : ""}</p>
        </div>
        <div className="toolbar">
          {ready.length > 0 && <button type="button" className="btn" onClick={() => setScheduling(true)}><CalendarClock size={16} aria-hidden="true" /> Schedule clips</button>}
          <button type="button" className="btn ghost danger" onClick={() => setConfirm(true)} aria-label="Delete this video"><Trash2 size={16} aria-hidden="true" /></button>
        </div>
      </div>

      <div className="clips-layout">
        <div className="stack" style={{ gap: 18 }}>
          {source.status !== "ready" ? (
            <section className="card stack">
              {source.status === "failed" ? <p className="notice bad">{source.error}</p>
                : source.importing ? <p className="row"><Spinner label="Importing" /> Downloading the video from its link. Long videos take a few minutes.</p>
                : <p className="row"><Spinner label="Checking" /> Checking the video. Long videos take a few minutes.</p>}
            </section>
          ) : (
            <section className="card stack" aria-labelledby="find-title">
              <h2 id="find-title" className="row" style={{ gap: 8 }}><Sparkles size={18} aria-hidden="true" /> {moments.length ? "Find clips again" : "Find clips"}</h2>
              {source.hasAudio === false ? <p className="small">This video has no sound. Clips are cut from what people say.</p>
                : source.speech === "none" ? <p className="small">We didn't hear anyone speak in this video, so it has no moments to cut.</p> : (
                <>
                  <div className="find-grid">
                    <div className="field"><span className="small" id="find-count">How many</span>
                      <div className="seg small-seg" role="group" aria-labelledby="find-count">
                        {MOMENT_COUNTS.map((n) => <button key={n} type="button" aria-pressed={count === n} onClick={() => setCount(n)}>{n}</button>)}
                      </div>
                    </div>
                    <div className="field"><span className="small" id="find-length">How long</span>
                      <div className="seg small-seg" role="group" aria-labelledby="find-length">
                        {momentLengthIds.map((l) => <button key={l} type="button" aria-pressed={lengthId === l} onClick={() => setLengthId(l)} title={momentLengths[l].about}>{momentLengths[l].name}</button>)}
                      </div>
                    </div>
                  </div>
                  <label className="field"><span className="small">About <span className="muted">(optional: a topic, a guest, a question)</span></span>
                    <input className="input" maxLength={200} value={focusText} onChange={(e) => setFocusText(e.target.value)} placeholder="e.g. how they found their first customers" />
                  </label>
                  <CreditBlockNotice block={block} />
                  {waiting ? (
                    <p className="row small" role="status"><Spinner label="Working" />{source.speech === "pending" ? `Listening to the video${source.duration > 600 ? ". It takes about a minute for every ten minutes of it" : ""}; the clips are found right after.` : "Finding the best moments…"}</p>
                  ) : (
                    <div className="row wrap" style={{ gap: 12 }}>
                      <button type="button" className="btn primary" disabled={!!busy || !!block} onClick={find}>
                        {busy === "find" ? <Spinner label="Finding clips" /> : <Sparkles size={16} aria-hidden="true" />}
                        {price ? `Find clips · ${creditsLabel(price)}` : "Find clips · free"}
                      </button>
                      <span className="muted small">{price ? `Transcribing a long video costs 1 credit per started 30 minutes; refunded if it fails.` : "Up to 20 searches a day."}</span>
                    </div>
                  )}
                  {source.momentsError && !waiting && <p className="notice bad small" role="alert">{source.momentsError}</p>}
                </>
              )}
              {problem && <p className="notice bad small" role="alert">{problem}</p>}
            </section>
          )}

          {moments.length > 0 && (
            <section className="stack" aria-labelledby="moments-title" style={{ gap: 10 }}>
              <h2 id="moments-title" style={{ fontSize: 20 }}>Moments <span className="muted small">best first</span></h2>
              <p className="muted small">
                The virality score (10–99) is our AI's estimate of how well a moment works as a short on its own: its hook, payoff, how well it
                stands alone and its energy, plus the laughter or applause heard in it. It is not a promise of views.
              </p>
              <ol className="moments list-plain">
                {moments.map((m) => {
                  const k = momentKey(m), state = made[k];
                  return (
                    <li key={k} className={`moment${focus === k ? " on" : ""}`}>
                      <span className={`score-badge ${scoreTone(m.score)}`} title={`Virality score · ${scoreLine(m.scores, m.reactions)}`} aria-label={`Virality score ${m.score} of 99`}>{m.score}</span>
                      <div className="moment-body">
                        <strong>{m.title}</strong>
                        <span className="muted small">{length(m.start)} – {length(m.end)} · {Math.round(m.end - m.start)} s · {scoreLine(m.scores, m.reactions)}</span>
                        {m.why && <p className="small">{m.why}</p>}
                        <p className="moment-text small">“{m.text}”</p>
                        <div className="row wrap" style={{ gap: 6 }}>
                          <button type="button" className="btn sm" aria-pressed={focus === k} onClick={() => setFocus(k)}><Play size={14} aria-hidden="true" />Preview</button>
                          <label className="check small" style={{ alignItems: "center" }}>
                            <input type="checkbox" checked={chosen.has(k)} disabled={state?.state === "made"} onChange={() => toggle(k)} /> Make this clip
                          </label>
                          {state?.state === "making" && <span className="small row"><Spinner label="Starting" /> Starting…</span>}
                          {state?.state === "made" && state.id && <Link className="chip green" to={`/app/videos/${state.id}`}><Check size={13} aria-hidden="true" />Being made</Link>}
                        </div>
                        {state?.state === "failed" && <p className="notice bad small" role="alert">{state.error}</p>}
                      </div>
                    </li>
                  );
                })}
              </ol>
            </section>
          )}

          {moments.length > 0 && (
            <section className="card stack" aria-labelledby="make-title">
              <h2 id="make-title" className="row" style={{ gap: 8 }}><Clapperboard size={18} aria-hidden="true" /> Make the clips</h2>
              <EditorSection title="Layout" hint="You can change it, and place the picture, for each clip afterwards.">
                <LayoutPicker value={options.layout} onChange={(layout) => set({ layout })} />
              </EditorSection>
              <Option title="Captions" about="What's said, word by word." checked={options.captions} onChange={(captions) => set({ captions })} />
              {options.captions && <CaptionStylePicker value={options.style} onChange={(style) => set({ style })} />}
              <Option title="Hook title" about="The moment's title on screen for the first seconds." checked={options.title} onChange={(title) => set({ title })} />
              <Option title="Remove pauses" about="Long silences are cut out, picture and sound alike." checked={options.cuts} onChange={(cuts) => set({ cuts })} />
              {options.cuts && <Option title="Filler words too" about="Um, uh and erm go as well." checked={options.fillers} onChange={(fillers) => set({ fillers })} />}
              <CreditBlockNotice block={makeBlock} />
              <div className="row wrap between" style={{ gap: 12 }}>
                <span className="cost">{picked.length} clip{picked.length === 1 ? "" : "s"} · {creditsLabel(cost)}</span>
                <button type="button" className="btn primary" disabled={!!busy || !picked.length || !!makeBlock} onClick={make}>
                  {busy === "make" ? <Spinner label="Starting" /> : <Scissors size={16} aria-hidden="true" />}Make {picked.length === 1 ? "the clip" : `${picked.length} clips`}
                </button>
              </div>
              <p className="muted small">1 credit per started minute of each clip. Editing a clip afterwards is free.</p>
            </section>
          )}

          {clips.length > 0 && (
            <section className="stack" aria-labelledby="made-title">
              <h2 id="made-title" style={{ fontSize: 20 }}>Clips made from this video</h2>
              <div className="video-grid">{clips.map((v) => <VideoCard key={v.id} video={v} />)}</div>
            </section>
          )}
        </div>

        <aside className="clips-preview" aria-label="Clip preview">
          {preview && clipSource.source && focused ? (
            <>
              <ClipPreview spec={preview} source={clipSource.source} label={`Preview of “${focused.title}”`} />
              <p className="muted small">{focused.title} · {layoutChoices[options.layout].name}{options.layout === "follow" || options.layout === "speakers" ? " · the people are found when it's made" : ""}</p>
            </>
          ) : (
            <div className="phone-frame placeholder"><p>{moments.length ? "Loading the preview…" : <>Your clip's preview<br /><span className="muted">appears here</span></>}</p></div>
          )}
        </aside>
      </div>
      {scheduling && <ScheduleClips clips={ready} onClose={() => setScheduling(false)} onDone={() => { setScheduling(false); void reload(); }} />}
      {confirm && (
        <ConfirmDialog title="Delete this video?" onClose={() => setConfirm(false)} onConfirm={async () => { await del(`/media/${source.id}`); navigate("/app/clips"); }}>
          <p>The long video and the moments found in it are deleted. Clips already made stay in Videos, but can't be edited.</p>
        </ConfirmDialog>
      )}
    </main>
  );
}

function Option({ title, about, checked, onChange }: { title: string; about: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="row between clips-option">
      <span><strong className="small">{title}</strong><br /><span className="muted small">{about}</span></span>
      <Switch checked={checked} onChange={onChange} label={title} />
    </div>
  );
}

/** "2026-10-12T18:00" in the viewer's zone, for datetime-local inputs. */
const local = (at: number) => { const d = new Date(at * 1000); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
const spacings = [{ hours: 24, label: "One a day" }, { hours: 12, label: "Two a day" }, { hours: 168, label: "One a week" }] as const;
/** Posts made clips one after another: the first at a chosen time, then one per spacing, on the chosen channels. */
function ScheduleClips({ clips, onClose, onDone }: { clips: Video[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const accounts = useApi<{ accounts: Account[]; platforms?: { id: string; soon?: boolean }[] }>("/accounts");
  const allSoon = !!accounts.data?.platforms?.length && accounts.data.platforms.every((p) => p.soon);
  const unposted = clips.filter((c) => !(c.publications || []).some((p) => p.status !== "failed" && p.status !== "canceled"));
  const [chosen, setChosen] = useState<string[]>([]);
  const [videos, setVideos] = useState<string[]>(() => unposted.map((c) => c.id));
  const [first, setFirst] = useState(() => { const d = new Date(Date.now() + 86400000); d.setHours(18, 0, 0, 0); return local(Math.floor(d.getTime() / 1000)); });
  const [hours, setHours] = useState<number>(24);
  const [busy, setBusy] = useState(false);
  const usable = (accounts.data?.accounts || []).filter((a) => a.status === "active");
  const order = clips.filter((c) => videos.includes(c.id));
  const start = Math.floor(new Date(first).getTime() / 1000);
  const send = async () => {
    setBusy(true);
    let ok = 0;
    for (const [i, v] of order.entries()) {
      try {
        await post(`/videos/${v.id}/publish`, { accountIds: chosen, at: start + i * hours * 3600 });
        ok++;
      } catch (e) {
        toast(`${v.title || "A clip"}: ${errorText(e)}`, "bad");
      }
    }
    setBusy(false);
    if (ok) { toast(`${ok} clip${ok === 1 ? "" : "s"} scheduled.`, "good"); onDone(); }
  };
  return (
    <Modal title="Schedule clips" onClose={onClose} wide footer={
      <>
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn primary" disabled={busy || !chosen.length || !order.length || !(start > Date.now() / 1000 + 60)} onClick={send}>
          {busy ? <Spinner label="Scheduling" /> : <CalendarClock size={16} aria-hidden="true" />}Schedule {order.length} clip{order.length === 1 ? "" : "s"}
        </button>
      </>
    }>
      <div className="stack">
        {accounts.loading && !accounts.data ? <Spinner label="Loading channels" /> : !usable.length ? allSoon ? (
          <p className="muted small">{comingSoon("TikTok, YouTube and Instagram")}</p>
        ) : (
          <p className="muted small">Connect TikTok, YouTube or Instagram first. <Link className="text-link" to="/app/channels">Connect a channel</Link></p>
        ) : (
          <div className="stack" style={{ gap: 6 }}>
            <span className="label">Post to</span>
            {usable.map((a) => (
              <label key={a.id} className="check">
                <input type="checkbox" checked={chosen.includes(a.id)} onChange={(e) => setChosen(e.target.checked ? [...chosen, a.id] : chosen.filter((x) => x !== a.id))} />
                <PlatformBadge platform={a.platform} /> {a.name}{a.handle ? ` (@${a.handle})` : ""}
              </label>
            ))}
          </div>
        )}
        <div className="find-grid">
          <label className="field"><span className="small">First post</span>
            <input type="datetime-local" className="input" value={first} onChange={(e) => setFirst(e.target.value)} />
          </label>
          <div className="field"><span className="small" id="spacing">Then</span>
            <div className="seg small-seg" role="group" aria-labelledby="spacing">
              {spacings.map((s) => <button key={s.hours} type="button" aria-pressed={hours === s.hours} onClick={() => setHours(s.hours)}>{s.label}</button>)}
            </div>
          </div>
        </div>
        <div className="stack" style={{ gap: 6 }}>
          <span className="label">Clips, in this order</span>
          {clips.map((c) => {
            const i = order.findIndex((o) => o.id === c.id);
            return (
              <label key={c.id} className="check">
                <input type="checkbox" checked={videos.includes(c.id)} onChange={(e) => setVideos(e.target.checked ? [...videos, c.id] : videos.filter((x) => x !== c.id))} />
                <span className="grow">{c.title || c.hook || "Clip"}</span>
                <span className="muted small">{i >= 0 && start ? new Date((start + i * hours * 3600) * 1000).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : ""}</span>
              </label>
            );
          })}
        </div>
        {clips.length > unposted.length && <p className="muted small">Clips already scheduled or posted are left out unless you tick them.</p>}
      </div>
    </Modal>
  );
}
