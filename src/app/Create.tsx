import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeft, Repeat, Search, Wand2 } from "lucide-react";
import { errorText, newKey, post, useAuth } from "../lib";
import { useToast } from "../ui";
import { StyleArt } from "../art";
import { StoryStylePicker } from "./StoryStyles";
import { VideoEditor } from "./EditVideo";
import { creditBlock, CreditBlockNotice } from "./pickers";
import { categories, isTemplate, templateIds, templates, type CategoryId, type TemplateId } from "../../shared/templates";
import { languages, musicMoods } from "../../shared/series";
import { specCredits, type StorySpec } from "../../shared/formats";
import { storyStyles, type StoryStyle } from "../../shared/story";
import { voices } from "../../shared/voices";
import { creditsLabel, videoCredits } from "../../shared/credits";
import "./create.css";

// Create: pick a faceless style, say what the video is about, get a free draft (the script and what every picture
// shows), shape it in the editor, then make it — the only step that spends credits.

const DEMO_DRAFT = "hss-demo-draft";
const lengths = [30, 45, 60, 90];

function Gallery({ onPick }: { onPick: (id: TemplateId) => void }) {
  const [category, setCategory] = useState<CategoryId | "all">("all");
  const [query, setQuery] = useState("");
  const shown = templateIds.filter((id) => (category === "all" || templates[id].category === category) &&
    (!query.trim() || `${templates[id].name} ${templates[id].short}`.toLowerCase().includes(query.trim().toLowerCase())));
  return (
    <div className="stack" style={{ gap: 18 }}>
      <label className="search-field"><Search size={18} aria-hidden="true" /><input className="input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search styles: scary, history, POV…" aria-label="Search styles" /></label>
      <div className="filters" role="group" aria-label="Categories">
        <button type="button" className="filter" aria-pressed={category === "all"} onClick={() => setCategory("all")}>All</button>
        {categories.map((c) => <button key={c.id} type="button" className="filter" aria-pressed={category === c.id} onClick={() => setCategory(c.id)}>{c.name}</button>)}
      </div>
      <div className="template-grid">
        {shown.map((id) => {
          const t = templates[id];
          return (
            <button key={id} type="button" className="template-card" onClick={() => onPick(id)}>
              <span className="art">{"popular" in t && t.popular && <span className="chip solid pop">Popular</span>}<StyleArt style={t.style} /></span>
              <strong>{t.name}</strong>
              <small>{t.short}</small>
            </button>
          );
        })}
        {!shown.length && <p className="muted">No style matches “{query}”.</p>}
      </div>
    </div>
  );
}

type Form = {
  prompt: string; script: string; title: string; animal: string; object: string; seconds: number;
  language: string; voiceId: string; style: StoryStyle; music: string; subject: string;
};
const formFor = (id: TemplateId, prompt = ""): Form => {
  const t = templates[id];
  return { prompt, script: "", title: "", animal: "", object: "", seconds: t.seconds, language: "en", voiceId: t.voice, style: t.style, music: t.music, subject: "" };
};

export function Create() {
  const { user, refresh } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const param = params.get("template") || "";
  const template = isTemplate(param) ? param : null;
  const [form, setForm] = useState<Form>(() => formFor(template || "facts", params.get("prompt") || ""));
  const [spec, setSpec] = useState<StorySpec | null>(null);
  const [writing, setWriting] = useState(false);
  const [making, setMaking] = useState(false);
  const [key] = useState(newKey);
  // A new style starts from its own choices; a draft from the home page's demo fills in the storytime story.
  useEffect(() => {
    if (!template) return;
    const next = formFor(template, params.get("prompt") || "");
    if (params.get("draft") === "demo") {
      try {
        const d = JSON.parse(localStorage.getItem(DEMO_DRAFT) || "null");
        if (d?.template === template) Object.assign(next, { title: String(d.title || ""), script: String(d.script || "") });
      } catch { /* nothing stored */ }
    }
    setForm(next);
    setSpec(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the style changes
  }, [template]);
  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));
  const left = user ? Math.max(0, user.limit - user.used) : null;
  const t = template ? templates[template] : null;
  const ready = !!t && (t.kind === "script" ? form.script.trim().length >= 20 : t.kind === "mashup" ? true : t.kind === "backdrop" ? true : form.prompt.trim().length >= 2 || template === "random");
  const write = async () => {
    if (!template || !t) return;
    setWriting(true);
    try {
      const { spec: draft } = await post<{ spec: StorySpec }>("/story/draft", {
        template, prompt: form.prompt, script: form.script, title: form.title, mashup: { animal: form.animal, object: form.object },
        seconds: form.seconds, language: form.language, voiceId: form.voiceId, style: form.style, music: form.music, subject: form.subject,
      });
      setSpec(draft);
      window.scrollTo({ top: 0 });
    } catch (e) {
      toast(errorText(e), "bad");
    } finally {
      setWriting(false);
    }
  };
  const cost = useMemo(() => (spec ? specCredits(spec, true) : videoCredits(form.seconds)), [spec, form.seconds]);
  const block = user ? creditBlock(user, cost) : null;
  const make = async () => {
    if (!spec) return;
    setMaking(true);
    try {
      const r = await post<{ id: string }>("/videos", { spec, idempotencyKey: key });
      try { localStorage.removeItem(DEMO_DRAFT); } catch { /* storage unavailable */ }
      await refresh();
      navigate(`/app/videos/${r.id}`);
    } catch (e) {
      toast(errorText(e), "bad");
      setMaking(false);
    }
  };

  if (!template || !t) {
    return (
      <div className="page">
        <div className="page-head"><div><h1>Choose a faceless style</h1><p>Story videos, POV clips, facts, brainrot, storytime or your own script.</p></div></div>
        <Gallery onPick={(id) => setParams({ template: id })} />
      </div>
    );
  }
  if (spec) {
    return (
      <div className="page create">
        <div className="page-head">
          <div>
            <button type="button" className="link" onClick={() => setSpec(null)}><ArrowLeft size={15} aria-hidden="true" /> Back to the brief</button>
            <h1 style={{ marginTop: 8 }}>{spec.title || t.name}</h1>
            <p>Edit anything below. Nothing is made or charged until you press Make video.</p>
          </div>
          <div className="toolbar">
            <button type="button" className="btn" disabled={writing} onClick={write}>{writing ? <span className="spinner" aria-hidden="true" /> : <Wand2 size={16} aria-hidden="true" />} Write again</button>
            <button type="button" className="btn primary" disabled={making || !!block} onClick={make}>{making ? <span className="spinner" aria-hidden="true" /> : null} Make video · {creditsLabel(cost)}</button>
          </div>
        </div>
        <CreditBlockNotice block={block} />
        <VideoEditor spec={spec} onChange={setSpec} initial creditsLeft={left} />
        <div className="row" style={{ justifyContent: "flex-end", marginTop: 20 }}>
          <button type="button" className="btn primary big" disabled={making || !!block} onClick={make}>{making ? <span className="spinner" aria-hidden="true" /> : null} Make video · {creditsLabel(cost)}</button>
        </div>
      </div>
    );
  }
  return (
    <div className="page create">
      <div className="page-head">
        <div>
          <button type="button" className="link" onClick={() => setParams({})}><ArrowLeft size={15} aria-hidden="true" /> All styles</button>
          <h1 style={{ marginTop: 8 }}>{t.name}</h1>
          <p>{t.short}. You'll see the script before anything is made.</p>
        </div>
        {t.kind !== "script" && <Link className="btn" to={`/app/series/new?template=${template}`}><Repeat size={16} aria-hidden="true" /> Make it a series</Link>}
      </div>
      <div className="brief-grid">
        <div className="card stack">
          {t.kind === "script" && (
            <label className="field"><span>Your script</span>
              <textarea className="textarea" rows={9} maxLength={2400} value={form.script} placeholder={t.examples[0]} onChange={(e) => set({ script: e.target.value })} />
              <span className="hint">{form.script.length.toLocaleString("en-US")} / 2,400 characters · every sentence or two becomes a scene.</span>
            </label>
          )}
          {t.kind === "mashup" && (
            <div className="form-row">
              <label className="field"><span>Animal</span><input className="input" maxLength={60} value={form.animal} placeholder="Shark" onChange={(e) => set({ animal: e.target.value })} /></label>
              <label className="field"><span>Object</span><input className="input" maxLength={60} value={form.object} placeholder="Sneaker" onChange={(e) => set({ object: e.target.value })} /></label>
            </div>
          )}
          {t.kind === "backdrop" && (
            <>
              <label className="field"><span>Title question <span className="muted small">(optional)</span></span>
                <input className="input" maxLength={140} value={form.title} placeholder={t.examples[0]} onChange={(e) => set({ title: e.target.value })} />
              </label>
              <label className="field"><span>Your story <span className="muted small">(optional: leave empty and the AI writes it)</span></span>
                <textarea className="textarea" rows={6} maxLength={2400} value={form.script} onChange={(e) => set({ script: e.target.value })} />
              </label>
            </>
          )}
          {(t.kind === "story" || t.kind === "pov") && (
            <label className="field"><span>{t.kind === "pov" ? "Scenario" : template === "custom" ? "What's the video about?" : "Topic or idea"}</span>
              <textarea className="textarea" rows={3} maxLength={600} value={form.prompt} placeholder={t.examples[0]} onChange={(e) => set({ prompt: e.target.value })} />
              <span className="row wrap" style={{ gap: 6 }}>{t.examples.map((x) => <button key={x} type="button" className="chip button" onClick={() => set({ prompt: x })}>{x}</button>)}</span>
            </label>
          )}
          {t.kind !== "script" && t.kind !== "backdrop" && (
            <label className="field"><span>Length</span>
              <div className="seg" role="group" aria-label="Length">
                {lengths.map((n) => <button key={n} type="button" aria-pressed={form.seconds === n} onClick={() => set({ seconds: n })}>{n < 60 ? `${n} s` : n === 60 ? "1 min" : "1½ min"}</button>)}
              </div>
              <span className="hint">{creditsLabel(videoCredits(form.seconds))} to make (1 per 30 seconds).</span>
            </label>
          )}
          <div className="form-row">
            <label className="field"><span>Narration language</span>
              <select className="select" value={form.language} onChange={(e) => set({ language: e.target.value })}>{languages.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</select>
            </label>
            <label className="field"><span>Voice</span>
              <select className="select" value={form.voiceId} onChange={(e) => set({ voiceId: e.target.value })}>{voices.map((v) => <option key={v.id} value={v.id}>{v.name} — {v.tone}</option>)}</select>
            </label>
          </div>
          <label className="field"><span>Music</span>
            <select className="select" value={form.music} onChange={(e) => set({ music: e.target.value })}>
              {musicMoods.map((m) => <option key={m} value={m}>{m === "auto" ? "Pick one that fits" : m === "none" ? "No music" : m[0].toUpperCase() + m.slice(1)}</option>)}
            </select>
          </label>
          {t.kind !== "backdrop" && (
            <label className="field"><span>Main character <span className="muted small">(optional)</span></span>
              <input className="input" maxLength={300} value={form.subject} placeholder="A curious orange fox with a blue scarf" onChange={(e) => set({ subject: e.target.value })} />
              <span className="hint">Drawn the same way in every picture.</span>
            </label>
          )}
        </div>
        <div className="card stack">
          {t.kind === "backdrop" ? (
            <p className="muted small">Storytime videos play your story over a looping background clip from the library, with bold subtitles. You can swap the clip in the editor.</p>
          ) : (
            <>
              <span className="label">Art style · {storyStyles[form.style].name}</span>
              <StoryStylePicker value={form.style} onChange={(style) => set({ style })} />
            </>
          )}
          <button type="button" className="btn primary big block" disabled={!ready || writing} onClick={write} style={{ marginTop: 8 }}>
            {writing ? <><span className="spinner" aria-hidden="true" /> Writing your draft…</> : <><Wand2 size={18} aria-hidden="true" /> Write the draft (free)</>}
          </button>
          {!ready && <p className="hint center">{t.kind === "script" ? "Paste at least a sentence or two." : "Give it a topic first."}</p>}
          <CreditBlockNotice block={block} />
        </div>
      </div>
    </div>
  );
}
