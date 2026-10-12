import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeft, ArrowRight, Check, Plus, X } from "lucide-react";
import { errorText, post, useApi, useAuth, useVoices, type Account, type LibraryItem, type Series } from "../lib";
import { Switch, useToast } from "../ui";
import { StyleArt } from "../art";
import { StoryStylePicker } from "./StoryStyles";
import { CaptionStylePicker } from "./CaptionPickers";
import { PlatformBadge } from "./video-ui";
import { connectPlatform, useConnectOutcome } from "./Channels";
import { useOfferedVoice, VoiceSelect } from "./pickers";
import { isTemplate, seriesTemplates, templates, type TemplateId } from "../../shared/templates";
import { defaultSeriesSettings, episodeCredits, episodeLengths, languages, lengthName, musicMoods, type SeriesSettings } from "../../shared/series";
import { videosPerMonth } from "../../shared/schedule";
import { storyStyles } from "../../shared/story";
import { platforms, type PlatformId } from "../../shared/social";
import { planById } from "../../shared/plans";
import { creditsLabel } from "../../shared/credits";
import "./create.css";

// A new series: its style, what it says and how it looks, where and when it posts, then a review. The settings form is
// also the series page's Settings tab.

const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const zones = (() => { try { return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? []; } catch { return []; } })();

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return <div className="card stack"><div><h3>{title}</h3>{hint && <p className="muted small" style={{ marginTop: 4 }}>{hint}</p>}</div>{children}</div>;
}

/** What a series says and how it looks (`part` "content"), where and when it posts ("posting"), or both. */
export function SeriesSettingsForm({ template, settings, onChange, part = "all" }: {
  template: TemplateId; settings: SeriesSettings; onChange: (s: SeriesSettings) => void; part?: "content" | "posting" | "all";
}) {
  const t = templates[template];
  const set = (patch: Partial<SeriesSettings>) => onChange({ ...settings, ...patch });
  const accounts = useApi<{ accounts: Account[] }>(part === "content" ? null : "/accounts");
  const music = useApi<{ items: LibraryItem[] }>(part === "posting" ? null : "/library?kind=music");
  const clips = useApi<{ items: LibraryItem[] }>(part === "posting" || t.kind !== "backdrop" ? null : "/library?kind=clip");
  const [time, setTime] = useState("12:00");
  const { pathname } = useLocation();
  const toast = useToast();
  // Back on this page after the network's consent screen (the wizard keeps its answers meanwhile).
  const connect = (platform: PlatformId) => connectPlatform(platform, pathname).catch((e) => toast(errorText(e), "bad"));
  const content = (
    <>
      <Section title={template === "custom" ? "What is the series about?" : "Topic and direction"} hint={template === "custom" ? "Describe the videos: the subject, the audience, the tone." : "Optional: narrow the topic or give the writer extra direction."}>
        <textarea className="textarea" rows={3} maxLength={600} value={settings.prompt} placeholder={t.examples.join(" · ")} onChange={(e) => set({ prompt: e.target.value })} />
      </Section>
      <Section title="Voice and language">
        <div className="form-row">
          <label className="field"><span className="small">Narration language</span>
            <select className="select" value={settings.language} onChange={(e) => set({ language: e.target.value as SeriesSettings["language"] })}>{languages.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</select>
          </label>
          <label className="field"><span className="small">Voice</span>
            <VoiceSelect value={settings.voiceId} onChange={(voiceId) => set({ voiceId })} />
          </label>
        </div>
        <div className="field"><span className="small">Length of each video</span>
          <div className="seg" role="group" aria-label="Length">
            {episodeLengths.map((n) => <button key={n} type="button" aria-pressed={settings.seconds === n} onClick={() => set({ seconds: n })}>{lengthName(n)}</button>)}
          </div>
        </div>
      </Section>
      {t.kind === "backdrop" ? (
        <Section title="Background clip" hint="A clip from the library loops behind every episode. Leave it on “Any” for a different one each time.">
          <select className="select" value={settings.backdropId || ""} onChange={(e) => set({ backdropId: e.target.value || null })}>
            <option value="">Any background clip</option>
            {(clips.data?.items || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Section>
      ) : (
        <Section title={`Art style · ${storyStyles[settings.style].name}`} hint="Every picture of every episode in one style.">
          <StoryStylePicker value={settings.style} onChange={(style) => set({ style })} />
          <label className="field"><span className="small">Main character <span className="muted">(optional, drawn the same in every picture)</span></span>
            <input className="input" maxLength={300} value={settings.subject} placeholder="A small robot with a round blue head and one antenna" onChange={(e) => set({ subject: e.target.value })} />
          </label>
          <label className="field"><span className="small">Animated scenes per episode</span>
            <select className="select" value={settings.animate} onChange={(e) => set({ animate: Number(e.target.value) })}>
              {[0, 1, 2, 3].map((n) => <option key={n} value={n}>{n ? `First ${n} scene${n > 1 ? "s" : ""} (+${n} credit${n > 1 ? "s" : ""})` : "None (pictures move slowly)"}</option>)}
            </select>
          </label>
        </Section>
      )}
      <Section title="Music and subtitles">
        <div className="form-row">
          <label className="field"><span className="small">Music</span>
            <select className="select" value={settings.music.trackId ? `track:${settings.music.trackId}` : settings.music.mood}
              onChange={(e) => set({ music: e.target.value.startsWith("track:") ? { ...settings.music, trackId: e.target.value.slice(6) } : { ...settings.music, trackId: null, mood: e.target.value as SeriesSettings["music"]["mood"] } })}>
              {musicMoods.map((m) => <option key={m} value={m}>{m === "auto" ? "A track that fits each episode" : m === "none" ? "No music" : `${m[0].toUpperCase()}${m.slice(1)} tracks`}</option>)}
              {(music.data?.items || []).map((i) => <option key={i.id} value={`track:${i.id}`}>Always: {i.name}</option>)}
            </select>
          </label>
          <label className="field"><span className="small">Music volume: {Math.round(settings.music.volume * 100)}%</span>
            <input type="range" min={0} max={1} step={0.05} value={settings.music.volume} onChange={(e) => set({ music: { ...settings.music, volume: Number(e.target.value) } })} />
          </label>
        </div>
        <div className="row between"><span className="small">Subtitles</span><Switch checked={settings.captions.enabled} onChange={(enabled) => set({ captions: { ...settings.captions, enabled } })} label="Subtitles" /></div>
        {settings.captions.enabled && <CaptionStylePicker label="Subtitle style" value={settings.captions.style} onChange={(style) => set({ captions: { ...settings.captions, style } })} />}
      </Section>
    </>
  );
  const usable = (accounts.data?.accounts || []).filter((a) => a.status === "active");
  const perMonth = videosPerMonth(settings.schedule);
  const posting = (
    <>
      <Section title="Where it posts" hint="Every episode posts to the channels you pick. Pick none to only make the videos (download them, or get them by e-mail).">
        {usable.length ? usable.map((a) => (
          <label key={a.id} className="account-row check" style={{ alignItems: "center" }}>
            <input type="checkbox" checked={settings.accounts.includes(a.id)} onChange={(e) => set({ accounts: e.target.checked ? [...settings.accounts, a.id] : settings.accounts.filter((x) => x !== a.id) })} />
            <PlatformBadge platform={a.platform} /><span className="grow">{a.name}{a.handle ? ` (@${a.handle})` : ""}</span>
          </label>
        )) : <p className="muted small">No channels connected yet.</p>}
        <div className="row wrap" style={{ gap: 8 }}>
          {(Object.keys(platforms) as (keyof typeof platforms)[]).map((p) => (
            <button key={p} type="button" className="btn sm" onClick={() => void connect(p)}><Plus size={14} aria-hidden="true" /> {platforms[p].name}</button>
          ))}
          <Link className="small text-link" to="/app/channels">Manage channels</Link>
        </div>
        <div className="row between"><span className="small">Post privately (only you see them; TikTok and YouTube)</span><Switch checked={settings.private} onChange={(v) => set({ private: v })} label="Post privately" /></div>
        <div className="row between"><span className="small">Review each episode before it posts</span><Switch checked={settings.review} onChange={(v) => set({ review: v })} label="Review first" /></div>
        <div className="row between"><span className="small">E-mail me when an episode is ready</span><Switch checked={settings.notify} onChange={(v) => set({ notify: v })} label="E-mail notices" /></div>
      </Section>
      <Section title="When it posts" hint={`${perMonth} videos a month · ${creditsLabel(perMonth * episodeCredits(settings))} a month at ${creditsLabel(episodeCredits(settings))} each.`}>
        <div className="field"><span className="small">Days</span>
          <div className="days" role="group" aria-label="Days">
            {dayNames.map((d, i) => (
              <button key={d} type="button" aria-pressed={settings.schedule.days.includes(i)}
                onClick={() => { const days = settings.schedule.days.includes(i) ? settings.schedule.days.filter((x) => x !== i) : [...settings.schedule.days, i].sort(); if (days.length) set({ schedule: { ...settings.schedule, days } }); }}>{d}</button>
            ))}
          </div>
        </div>
        <div className="field"><span className="small">Times</span>
          <div className="row wrap" style={{ gap: 6 }}>
            {settings.schedule.times.map((x) => (
              <span key={x} className="chip">{x}{settings.schedule.times.length > 1 && <button type="button" className="btn icon ghost sm" aria-label={`Remove ${x}`} onClick={() => set({ schedule: { ...settings.schedule, times: settings.schedule.times.filter((y) => y !== x) } })}><X size={12} /></button>}</span>
            ))}
            {settings.schedule.times.length < 6 && (
              <span className="row" style={{ gap: 6 }}>
                <input type="time" className="input" style={{ width: 130, padding: "6px 10px" }} value={time} onChange={(e) => setTime(e.target.value)} aria-label="Add a time" />
                <button type="button" className="btn sm" onClick={() => { if (/^\d\d:\d\d$/.test(time) && !settings.schedule.times.includes(time)) set({ schedule: { ...settings.schedule, times: [...settings.schedule.times, time].sort() } }); }}>Add</button>
              </span>
            )}
          </div>
        </div>
        <label className="field"><span className="small">Time zone</span>
          <select className="select" value={settings.schedule.timezone} onChange={(e) => set({ schedule: { ...settings.schedule, timezone: e.target.value } })}>
            {(zones.length ? zones : [settings.schedule.timezone]).map((z) => <option key={z} value={z}>{z}</option>)}
          </select>
        </label>
      </Section>
    </>
  );
  return <div className="stack" style={{ gap: 16 }}>{part !== "posting" && content}{part !== "content" && posting}</div>;
}

const stepNames = ["Style", "Content", "Posting", "Review"];
/** The wizard's answers while the browser is away connecting a channel. */
const DRAFT = "hss-series-draft";
type Draft = { template: TemplateId; step: number; settings: SeriesSettings; name: string };
function savedDraft(returning: boolean): Draft | null {
  if (!returning) return null;
  try {
    const d = JSON.parse(sessionStorage.getItem(DRAFT) || "null") as Draft | null;
    return d && isTemplate(d.template) && d.settings ? d : null;
  } catch { return null; }
}

export function SeriesWizard() {
  const { user } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [draft] = useState(() => savedDraft(params.has("connected") || params.has("error")));
  useConnectOutcome();
  const initial = params.get("template");
  const [template, setTemplate] = useState<TemplateId | null>(draft?.template ?? (initial && isTemplate(initial) && seriesTemplates.includes(initial) ? initial : null));
  const [step, setStep] = useState(draft?.step ?? (template ? 1 : 0));
  const [settings, setSettings] = useState<SeriesSettings>(() => {
    if (draft) return draft.settings;
    const s = defaultSeriesSettings(template || "facts");
    try { s.schedule.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { /* default */ }
    return s;
  });
  const [name, setName] = useState(draft?.name ?? (template ? templates[template].name : ""));
  const { byId } = useVoices();
  const voiceName = (id: string) => byId(id)?.name ?? id;
  // A template's voice that is no longer offered gives way to the default voice.
  useOfferedVoice(settings.voiceId, (voiceId) => setSettings((s) => ({ ...s, voiceId })), !!template);
  useEffect(() => {
    try {
      if (template) sessionStorage.setItem(DRAFT, JSON.stringify({ template, step, settings, name } satisfies Draft));
    } catch { /* storage unavailable: the wizard starts over after connecting */ }
  }, [template, step, settings, name]);
  const [busy, setBusy] = useState(false);
  const pick = (id: TemplateId) => {
    const s = defaultSeriesSettings(id);
    setSettings({ ...s, schedule: settings.schedule, accounts: settings.accounts });
    setTemplate(id);
    setName(templates[id].name);
    setStep(1);
  };
  const plan = planById(user?.plan);
  const perMonth = useMemo(() => videosPerMonth(settings.schedule) * episodeCredits(settings), [settings]);
  const create = async () => {
    if (!template) return;
    setBusy(true);
    try {
      const r = await post<{ series: Series; started: boolean }>("/series", { name: name.trim() || templates[template].name, template, settings, first: true });
      try { sessionStorage.removeItem(DRAFT); } catch { /* storage unavailable */ }
      toast(r.started ? "Series created. The first episode is being written now." : "Series created.", "good");
      navigate(`/app/series/${r.series.id}`);
    } catch (e) {
      toast(errorText(e), "bad");
      setBusy(false);
    }
  };
  return (
    <div className="page create">
      <div className="page-head">
        <div>
          <Link className="link" to="/app/series"><ArrowLeft size={15} aria-hidden="true" /> Series</Link>
          <h1 style={{ marginTop: 8 }}>New series</h1>
          <p>A new video for every slot of your schedule, written and made ahead of time.</p>
        </div>
      </div>
      <div className="steps-bar" aria-label="Steps">
        {stepNames.map((n, i) => <span key={n} aria-current={i === step ? "step" : undefined} className={i < step ? "done" : ""}>{i + 1}. {n}</span>)}
      </div>
      {step === 0 && (
        <div className="template-grid">
          {seriesTemplates.map((id) => (
            <button key={id} type="button" className="template-card" onClick={() => pick(id)}>
              <span className="art">{"popular" in templates[id] && (templates[id] as { popular?: boolean }).popular && <span className="chip solid pop">Popular</span>}<StyleArt style={templates[id].style} /></span>
              <strong>{templates[id].name}</strong><small>{templates[id].short}</small>
            </button>
          ))}
        </div>
      )}
      {step === 1 && template && <SeriesSettingsForm template={template} settings={settings} onChange={setSettings} part="content" />}
      {step === 2 && template && <SeriesSettingsForm template={template} settings={settings} onChange={setSettings} part="posting" />}
      {step === 3 && template && (
        <div className="stack" style={{ gap: 16, maxWidth: 720 }}>
          <label className="field"><span>Series name</span><input className="input" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} /></label>
          <div className="card stack">
            <h3>Summary</h3>
            <ul className="stack" style={{ margin: 0, paddingLeft: 18, gap: 6 }}>
              <li>{templates[template].name}{settings.prompt ? `: ${settings.prompt}` : ""}</li>
              <li>{lengthName(settings.seconds)} videos in {languages.find((l) => l[0] === settings.language)?.[1]}, narrated by {voiceName(settings.voiceId)}{templates[template].kind !== "backdrop" ? `, ${storyStyles[settings.style].name.toLowerCase()} pictures` : ""}</li>
              <li>{videosPerMonth(settings.schedule)} videos a month at {settings.schedule.times.join(", ")} ({settings.schedule.timezone})</li>
              <li>{settings.accounts.length ? `Posts to ${settings.accounts.length} channel${settings.accounts.length > 1 ? "s" : ""}${settings.private ? ", privately" : ""}${settings.review ? " after your review" : ""}` : "Not posted: videos are only made"}</li>
              <li>{creditsLabel(episodeCredits(settings))} per video · about {creditsLabel(perMonth)} a month</li>
            </ul>
            {user && perMonth > plan.credits && <p className="notice warn">This schedule needs about {creditsLabel(perMonth)} a month; your plan has {creditsLabel(plan.credits)}. Episodes are skipped when credits run out. <Link className="link" to="/app/billing">See plans</Link></p>}
            <p className="muted small">The first episode is written right away for the first slot, so you can see it before anything posts.</p>
          </div>
        </div>
      )}
      <div className="row between" style={{ marginTop: 24 }}>
        {step > 0 ? <button type="button" className="btn" onClick={() => setStep(step - 1)}><ArrowLeft size={16} aria-hidden="true" /> Back</button> : <span />}
        {step > 0 && step < 3 && <button type="button" className="btn primary" disabled={template === "custom" && step === 1 && settings.prompt.trim().length < 3} onClick={() => setStep(step + 1)}>Continue <ArrowRight size={16} aria-hidden="true" /></button>}
        {step === 3 && <button type="button" className="btn primary big" disabled={busy} onClick={create}>{busy ? <span className="spinner" aria-hidden="true" /> : <Check size={18} aria-hidden="true" />} Create series</button>}
      </div>
    </div>
  );
}
