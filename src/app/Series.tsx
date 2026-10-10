import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, CalendarClock, Film, Pause, Play, Plus, Repeat, Settings2, Sparkles, Trash2 } from "lucide-react";
import { del, errorText, fileUrl, patch, post, useApi, useAuth, usePoll, when, type Account, type Series, type Video } from "../lib";
import { useToast } from "../ui";
import { StyleArt } from "../art";
import { ConfirmDialog } from "./pickers";
import { SeriesSettingsForm } from "./SeriesWizard";
import { useConnectOutcome } from "./Channels";
import { PlatformBadge, PublicationLine, StatusChip, making, phaseText } from "./video-ui";
import { templates } from "../../shared/templates";
import { languageName, lengthName, type SeriesSettings } from "../../shared/series";
import { videosPerMonth } from "../../shared/schedule";
import { storyStyles } from "../../shared/story";
import { creditsLabel } from "../../shared/credits";

// Series: faceless channels on autopilot. The list, and one series' coming slots, its episodes and its settings.

export function SeriesList() {
  const { data, loading } = useApi<{ series: Series[] }>("/series");
  const accounts = useApi<{ accounts: Account[] }>("/accounts");
  const byId = new Map((accounts.data?.accounts || []).map((a) => [a.id, a]));
  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Series</h1><p>Each series makes and posts a new video for every slot of its schedule.</p></div>
        <Link className="btn primary" to="/app/series/new"><Plus size={18} aria-hidden="true" /> New series</Link>
      </div>
      {loading && !data ? <div className="loading-page" role="status">Loading…</div> : data?.series.length ? (
        <div className="series-grid">
          {data.series.map((s) => {
            const t = templates[s.template];
            return (
              <Link key={s.id} to={`/app/series/${s.id}`} className="series-card">
                <div className="series-art">{s.coverAssetId ? <img src={fileUrl(s.coverAssetId)} alt="" /> : <StyleArt style={s.settings.style} />}</div>
                <div className="stack" style={{ gap: 6, minWidth: 0 }}>
                  <div className="row between"><strong className="truncate" style={{ maxWidth: "none" }}>{s.name}</strong><span className={s.status === "active" ? "chip green" : "chip"}>{s.status === "active" ? "Active" : "Paused"}</span></div>
                  <span className="small muted">{t?.name} · {storyStyles[s.settings.style].name} · {lengthName(s.settings.seconds)}</span>
                  <span className="small muted">{videosPerMonth(s.settings.schedule)} videos a month · up to {creditsLabel(s.credits)} each</span>
                  <div className="row" style={{ gap: 4 }}>
                    {s.settings.accounts.map((id) => byId.get(id)).filter(Boolean).map((a) => <PlatformBadge key={a!.id} platform={a!.platform} />)}
                    {!s.settings.accounts.length && <span className="small muted">No channels: videos are only made</span>}
                  </div>
                  {s.status === "active" && s.nextSlot && <span className="small"><CalendarClock size={13} aria-hidden="true" /> Next: {when(s.nextSlot)}</span>}
                  {s.blocked && <span className="small error">{s.blocked}</span>}
                  {!!s.review && <span className="chip orange">{s.review} to review</span>}
                </div>
              </Link>
            );
          })}
        </div>
      ) : (
        <div className="card glow empty">
          <Repeat size={34} className="accent-text" aria-hidden="true" />
          <h2 style={{ fontSize: 22 }}>Put a channel on autopilot</h2>
          <p>Choose a style, a voice and a schedule once. Every slot gets a new, original video, posted for you.</p>
          <Link className="btn primary" to="/app/series/new"><Sparkles size={16} aria-hidden="true" /> Start a series</Link>
        </div>
      )}
    </div>
  );
}

export function SeriesPage() {
  const { id = "" } = useParams();
  const { refresh } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const { data, error, reload, setData } = useApi<{ series: Series; videos: Video[]; upcoming: { at: number; made: boolean }[] }>(`/series/${id}`);
  const [tab, setTab] = useState<"episodes" | "settings">("episodes");
  const [settings, setSettings] = useState<SeriesSettings | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  useConnectOutcome();
  usePoll(() => { void reload(); }, 8000, !!data?.videos.some(making));
  if (error) return <div className="page"><p className="notice bad">{error}</p></div>;
  if (!data) return <div className="loading-page" role="status">Loading…</div>;
  const s = data.series, t = templates[s.template];
  const run = async (key: string, work: () => Promise<unknown>, done?: string) => {
    setBusy(key);
    try { await work(); if (done) toast(done, "good"); await reload(); await refresh(); }
    catch (e) { toast(errorText(e), "bad"); }
    finally { setBusy(null); }
  };
  const bySlot = new Map(data.videos.filter((v) => v.slotAt).map((v) => [v.slotAt!, v]));
  const past = data.videos.filter((v) => !v.slotAt || v.slotAt <= Date.now() / 1000 || !data.upcoming.some((u) => u.at === v.slotAt));
  const editing = settings ?? s.settings;
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <Link className="link" to="/app/series"><ArrowLeft size={15} aria-hidden="true" /> Series</Link>
          <h1 style={{ marginTop: 8 }}>{s.name}</h1>
          <p>{t?.name} · {languageName(s.settings.language)} · {storyStyles[s.settings.style].name} · {lengthName(s.settings.seconds)} · up to {creditsLabel(s.credits)} per video</p>
        </div>
        <div className="toolbar">
          <button type="button" className="btn" disabled={busy === "make"} onClick={() => run("make", () => post(`/series/${s.id}/episodes`, {}), "Writing a new episode…")}>
            {busy === "make" ? <span className="spinner" aria-hidden="true" /> : <Film size={16} aria-hidden="true" />} Make one now
          </button>
          {s.status === "active"
            ? <button type="button" className="btn" onClick={() => run("pause", () => patch(`/series/${s.id}`, { status: "paused" }), "Paused. Nothing more posts until you resume.")}><Pause size={16} aria-hidden="true" /> Pause</button>
            : <button type="button" className="btn primary" onClick={() => run("resume", () => patch(`/series/${s.id}`, { status: "active" }), "Resumed.")}><Play size={16} aria-hidden="true" /> Resume</button>}
        </div>
      </div>
      {s.blocked && <p className="notice warn" style={{ marginBottom: 16 }}>{s.blocked} <Link className="link" to="/app/billing">Billing</Link></p>}
      <div className="tabs" role="tablist" style={{ marginBottom: 20 }}>
        <button role="tab" aria-selected={tab === "episodes"} onClick={() => setTab("episodes")}><Film size={15} aria-hidden="true" /> Episodes</button>
        <button role="tab" aria-selected={tab === "settings"} onClick={() => { setTab("settings"); setSettings(s.settings); setName(s.name); }}><Settings2 size={15} aria-hidden="true" /> Settings</button>
      </div>
      {tab === "episodes" ? (
        <div className="grid two" style={{ alignItems: "start" }}>
          <section className="stack">
            <h2 style={{ fontSize: 18 }}>Coming up</h2>
            {s.status !== "active" ? <p className="muted small">Paused: no slots are made or posted.</p> : !data.upcoming.length ? <p className="muted small">No posting times in the next two weeks. Check the schedule in Settings.</p> : (
              <div className="slot-list">
                {data.upcoming.slice(0, 14).map((u) => {
                  const v = bySlot.get(u.at);
                  return (
                    <div key={u.at} className="slot">
                      <div className="slot-cover">{v?.coverAssetId && !making(v) ? <img src={fileUrl(v.coverAssetId)} alt="" /> : v && making(v) ? <span className="spinner" aria-hidden="true" /> : <CalendarClock size={18} aria-hidden="true" />}</div>
                      <div style={{ minWidth: 0 }}>
                        <strong>{v ? v.title || v.hook || "Episode" : "Not made yet"}</strong>
                        <small>{when(u.at)}{v && making(v) ? ` · ${phaseText(v)}…` : !v ? " · made a few hours before" : ""}</small>
                      </div>
                      {v ? <Link className="btn sm" to={`/app/videos/${v.id}`}>Open</Link>
                        : <button type="button" className="btn sm" disabled={busy === `slot-${u.at}`} onClick={() => run(`slot-${u.at}`, () => post(`/series/${s.id}/episodes`, { slot: u.at }), "Writing this episode now…")}>Make now</button>}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
          <section className="stack">
            <h2 style={{ fontSize: 18 }}>Episodes</h2>
            {past.length ? past.map((v) => (
              <div key={v.id} className="slot" style={{ gridTemplateColumns: "56px minmax(0,1fr) auto" }}>
                <div className="slot-cover">{v.coverAssetId && !making(v) ? <img src={fileUrl(v.coverAssetId)} alt="" /> : <Film size={18} aria-hidden="true" />}</div>
                <div style={{ minWidth: 0 }} className="stack">
                  <Link to={`/app/videos/${v.id}`} style={{ textDecoration: "none" }}><strong>{v.title || v.hook || "Episode"}</strong></Link>
                  <div className="row wrap" style={{ gap: 6 }}><StatusChip video={v} /><small>{v.slotAt ? when(v.slotAt) : `extra · ${when(v.createdAt)}`}</small></div>
                  {(v.publications || []).map((p) => <PublicationLine key={p.id} p={p} />)}
                </div>
                <Link className="btn sm" to={`/app/videos/${v.id}`}>Open</Link>
              </div>
            )) : <p className="muted small">No episodes yet. The first one is made a few hours before the first slot — or press Make one now.</p>}
          </section>
        </div>
      ) : (
        <div className="stack" style={{ gap: 20, maxWidth: 860 }}>
          <label className="field"><span>Name</span><input className="input" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} /></label>
          <SeriesSettingsForm template={s.template} settings={editing} onChange={setSettings} />
          <div className="row between wrap">
            <button type="button" className="btn ghost danger" onClick={() => setConfirm(true)}><Trash2 size={16} aria-hidden="true" /> Delete series</button>
            <button type="button" className="btn primary" disabled={busy === "save"} onClick={() => run("save", async () => {
              const r = await patch<{ series: Series }>(`/series/${s.id}`, { name, settings: editing });
              setData({ ...data, series: r.series });
            }, "Saved. New episodes use these settings.")}>{busy === "save" ? <span className="spinner" aria-hidden="true" /> : null} Save settings</button>
          </div>
        </div>
      )}
      {confirm && (
        <ConfirmDialog title="Delete this series?" onClose={() => setConfirm(false)} onConfirm={async () => { await del(`/series/${s.id}`); navigate("/app/series"); }}>
          <p>No more episodes are made, and posts still scheduled are canceled. Its videos stay in Videos.</p>
        </ConfirmDialog>
      )}
    </div>
  );
}
