import { t as say } from "../../shared/i18n";
import { SITE } from "../../shared/site";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeft, ImagePlus, Repeat, Search, Wand2, X } from "lucide-react";
import { errorText, fileUrl, newKey, post, useAuth } from "../lib";
import { Switch, useToast } from "../ui";
import { StyleArt } from "../art";
import { ExampleVideo, useExamples } from "../examples";
import { StoryStylePicker } from "./StoryStyles";
import { VideoEditor } from "./EditVideo";
import { creditBlock, CreditBlockNotice, MediaPicker, MusicChoice, UploadButton, useOfferedVoice, VoiceSelect } from "./pickers";
import { categories, isTemplate, isTest, templateIds, templates, type CategoryId, type TemplateId } from "../../shared/templates";
import { adCredits, adLengths, PRODUCT_PHOTOS_MAX } from "../../shared/ad";
import { languages, type MusicMood } from "../../shared/series";
import { specCredits, type StorySpec } from "../../shared/formats";
import { STORY_MAX_CHARS, storyStyles, type StoryStyle } from "../../shared/story";
import { CLIP_CREDITS, CLIP_SECONDS, clipModelNames, creditsLabel, SECONDS_PER_CREDIT, videoCredits, type ClipModel, type ClipQuality } from "../../shared/credits";
import "./create.css";

// Create: pick a faceless style, say what the video is about, get a free draft (the script and what every picture
// shows), shape it in the editor, then make it — the only step that spends credits.

const DEMO_DRAFT = "hss-demo-draft";
const lengths = [30, 45, 60, 90];

function Gallery({ onPick, admin }: { onPick: (id: TemplateId) => void; admin: boolean }) {
  const examples = useExamples();
  const [category, setCategory] = useState<CategoryId | "all">("all");
  const [query, setQuery] = useState("");
  // A style still being tested is an administrator's to see; a category shows when it has a style to show.
  const offered = templateIds.filter((id) => admin || !isTest(id));
  const shown = offered.filter((id) => (category === "all" || templates[id].category === category) &&
    (!query.trim() || `${templates[id].name} ${templates[id].short}`.toLowerCase().includes(query.trim().toLowerCase())));
  return (
    <div className="stack" style={{ gap: 18 }}>
      <label className="search-field"><Search size={18} aria-hidden="true" /><input className="input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search styles: scary, history, POV…" aria-label="Search styles" /></label>
      <div className="filters" role="group" aria-label="Categories">
        <button type="button" className="filter" aria-pressed={category === "all"} onClick={() => setCategory("all")}>All</button>
        {categories.filter((c) => offered.some((id) => templates[id].category === c.id)).map((c) => <button key={c.id} type="button" className="filter" aria-pressed={category === c.id} onClick={() => setCategory(c.id)}>{c.name}</button>)}
      </div>
      <div className="template-grid">
        {shown.map((id) => {
          const t = templates[id];
          return (
            <button key={id} type="button" className="template-card" onClick={() => onPick(id)}>
              <span className="art">
                {"popular" in t && t.popular && <span className="chip solid pop">Popular</span>}
                {isTest(id) && <span className="chip solid pop">Admin test</span>}
                {examples[id] ? <ExampleVideo example={examples[id]} /> : <StyleArt style={t.style} />}
              </span>
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
  language: string; voiceId: string; style: StoryStyle; music: MusicMood; musicTrackId: string | null; subject: string;
  /** Sound effects from the library: a whoosh on scene changes and sounds the writer picks (changed in the editor). */
  sounds: boolean;
  /** Cinematic (shared/film.ts): every scene an AI clip of this quality and, for an administrator, model. */
  film: boolean; filmQuality: ClipQuality; filmModel: ClipModel | "";
  /** A product ad (shared/ad.ts): the photos of the product (the owner's uploads) and what it is called. */
  photos: string[]; productName: string;
};
/** Text that reads like a whole story rather than a topic: long, or several lines. */
const storyLike = (text: string) => text.trim().length >= 280 || text.trim().split(/\n\s*\n|\n/).filter(Boolean).length >= 4;
/** A mashup's animal and object from "A shark + a sneaker" (how the tool page and its ideas pass them). */
export function mashupParts(prompt: string): { animal: string; object: string } {
  const [animal = "", object = ""] = prompt.split("+").map((part) => part.trim().replace(/^(an?|the)\s+/i, "").slice(0, 60));
  return prompt.includes("+") ? { animal, object } : { animal: "", object: "" };
}
const formFor = (id: TemplateId, prompt = ""): Form => {
  const t = templates[id];
  const mashup = t.kind === "mashup" ? mashupParts(prompt) : { animal: "", object: "" };
  return { prompt, script: "", title: "", ...mashup, seconds: t.seconds, language: SITE.narration, voiceId: t.voice, style: t.style, music: t.music, musicTrackId: null, subject: "", sounds: true, film: false, filmQuality: "regular", filmModel: "", photos: [], productName: "" };
};

export function Create() {
  const { user, refresh } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const param = params.get("template") || "";
  // A style still being tested opens for administrators only.
  const template = isTemplate(param) && (!isTest(param) || !!user?.admin) ? param : null;
  const [picking, setPicking] = useState(false);
  const [form, setForm] = useState<Form>(() => formFor(template || "facts", params.get("prompt") || ""));
  const [spec, setSpec] = useState<StorySpec | null>(null);
  const [writing, setWriting] = useState(false);
  const [making, setMaking] = useState(false);
  const [key] = useState(newKey);
  // A story pasted as a topic, taken to Text to video with the choices made so far (see the hint under the topic).
  const carry = useRef<Partial<Form> | null>(null);
  // A new style starts from its own choices; a draft from the home page's demo fills in the storytime story.
  useEffect(() => {
    if (!template) return;
    const next = formFor(template, params.get("prompt") || "");
    if (carry.current) Object.assign(next, carry.current);
    carry.current = null;
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
  // A template's voice that is no longer offered gives way to the default voice.
  useOfferedVoice(form.voiceId, (voiceId) => set({ voiceId }));
  const left = user ? Math.max(0, user.limit - user.used) : null;
  const t = template ? templates[template] : null;
  // Any video can be cinematic, except a story over one background clip (it has no scenes to film).
  const ad = t?.kind === "ad";
  const canFilm = !!t && t.kind !== "backdrop" && !ad;
  const addPhoto = (id: string) => setForm((f) => (f.photos.includes(id) || f.photos.length >= PRODUCT_PHOTOS_MAX ? f : { ...f, photos: [...f.photos, id] }));
  const cinematic = canFilm && form.film;
  const ready = !!t && (ad ? form.photos.length > 0 && form.prompt.trim().length >= 2 : t.kind === "script" ? form.script.trim().length >= 20 : t.kind === "mashup" ? true : t.kind === "backdrop" ? true : form.prompt.trim().length >= 2 || template === "random");
  const write = async () => {
    if (!template || !t) return;
    setWriting(true);
    try {
      const { spec: draft } = await post<{ spec: StorySpec }>("/story/draft", {
        template, prompt: form.prompt, script: form.script, title: form.title, mashup: { animal: form.animal, object: form.object },
        seconds: form.seconds, language: form.language, voiceId: form.voiceId, style: form.style, music: form.music, subject: form.subject, sounds: form.sounds,
        ...(form.musicTrackId && { musicTrackId: form.musicTrackId }),
        ...(cinematic && { film: { quality: form.filmQuality, ...(form.filmModel && { model: form.filmModel }) } }),
        ...(ad && { product: { assets: form.photos, name: form.productName } }),
      });
      setSpec(draft);
      window.scrollTo({ top: 0 });
    } catch (e) {
      toast(errorText(e), "bad");
    } finally {
      setWriting(false);
    }
  };
  const cost = useMemo(() => (spec ? specCredits(spec, true) : ad ? adCredits(form.seconds) : videoCredits(form.seconds)), [spec, form.seconds, ad]);
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
        <Gallery onPick={(id) => setParams({ template: id })} admin={!!user?.admin} />
      </div>
    );
  }
  if (spec) {
    return (
      <div className="page create">
        <div className="page-head">
          <div>
            <button type="button" className="link" onClick={() => setSpec(null)}><ArrowLeft size={15} aria-hidden="true" /> Back to the brief</button>
            <h1 style={{ marginTop: 8 }}>{spec.title || t.name}{spec.film && <span className="chip" style={{ marginLeft: 10, verticalAlign: 6 }}>{spec.product ? "Product ad" : "Cinematic"}</span>}</h1>
            <p>Edit anything below. Nothing is made or charged until you press Make video.{spec.product ? " Every scene is a shot filmed from your photos: the price counts each one." : spec.film ? " Every scene is an AI clip: the price counts each one." : ""}</p>
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
        {t.kind !== "script" && !ad && <Link className="btn" to={`/app/series/new?template=${template}`}><Repeat size={16} aria-hidden="true" /> Make it a series</Link>}
      </div>
      <div className="brief-grid">
        <div className="card stack">
          {t.kind === "script" && (
            <label className="field"><span>Your script</span>
              <textarea className="textarea" rows={9} maxLength={2400} value={form.script} placeholder={t.examples[0]} onChange={(e) => set({ script: e.target.value })} />
              <span className="hint">{form.script.length.toLocaleString(SITE.locale)} / 2,400 characters · every sentence or two becomes a scene.</span>
            </label>
          )}
          {ad && (
            <>
              <div className="field"><span>Photos of the product</span>
                <div className="product-photos">
                  {form.photos.map((id, n) => (
                    <span key={id} className="product-photo">
                      <img src={fileUrl(id)} alt={`The product, view ${n + 1}`} />
                      <button type="button" className="icon-btn" aria-label={`Remove photo ${n + 1}`} onClick={() => set({ photos: form.photos.filter((x) => x !== id) })}><X size={14} aria-hidden="true" /></button>
                    </span>
                  ))}
                  {form.photos.length < PRODUCT_PHOTOS_MAX && (
                    <span className="row wrap" style={{ gap: 8 }}>
                      <UploadButton type="image" multiple label="Upload photos" onUploaded={(a) => addPhoto(a.id)} />
                      <button type="button" className="btn" onClick={() => setPicking(true)}><ImagePlus size={16} aria-hidden="true" /> Choose from your files</button>
                    </span>
                  )}
                </div>
                <span className="hint">{`1 to ${PRODUCT_PHOTOS_MAX} photos (JPG, PNG or WebP). The first one is the main view; add other sides and close-ups, on a plain background if you can. The ad shows the product as it is in them.`}</span>
              </div>
              <label className="field"><span>Product name <span className="muted small">(optional)</span></span>
                <input className="input" maxLength={80} value={form.productName} placeholder="Aqua Steel bottle" onChange={(e) => set({ productName: e.target.value })} />
              </label>
              <label className="field"><span>What is it, and what should the ad say?</span>
                <textarea className="textarea" rows={4} maxLength={STORY_MAX_CHARS} value={form.prompt} placeholder={t.examples[0]} onChange={(e) => set({ prompt: e.target.value })} />
                <span className="hint">What it is, who it is for and what makes it good. The ad says only what you write here: no invented prices or claims.</span>
              </label>
            </>
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
              <textarea className="textarea" rows={storyLike(form.prompt) ? 8 : 3} maxLength={STORY_MAX_CHARS} value={form.prompt} placeholder={t.examples[0]} onChange={(e) => set({ prompt: e.target.value })} />
              {t.kind === "story" && storyLike(form.prompt) ? (
                <span className="hint">
                  This reads like a whole story: it will be retold in this style at the length you choose. Want your exact words, scene by
                  scene?{" "}
                  <button type="button" className="link" onClick={() => {
                    carry.current = { script: form.prompt, style: form.style, voiceId: form.voiceId, music: form.music, musicTrackId: form.musicTrackId, language: form.language, subject: form.subject };
                    setParams({ template: "script" });
                  }}>Use Text to video</button>
                </span>
              ) : (
                <span className="row wrap" style={{ gap: 6 }}>{t.examples.map((x) => <button key={x} type="button" className="chip button" onClick={() => set({ prompt: say(x) })}>{x}</button>)}</span>
              )}
            </label>
          )}
          {t.kind !== "script" && t.kind !== "backdrop" && (
            <label className="field"><span>Length</span>
              <div className="seg" role="group" aria-label="Length">
                {(ad ? adLengths : lengths).map((n) => <button key={n} type="button" aria-pressed={form.seconds === n} onClick={() => set({ seconds: n })}>{n < 60 ? `${n} s` : n === 60 ? "1 min" : "1½ min"}</button>)}
              </div>
              {ad ? <span className="hint">{`About ${creditsLabel(adCredits(form.seconds))}: the video, and a filmed shot for every ${CLIP_SECONDS} seconds of it. The draft shows the exact price before anything is charged.`}</span>
                : <span className="hint">{creditsLabel(videoCredits(form.seconds))} to make (1 per {SECONDS_PER_CREDIT} seconds).</span>}
            </label>
          )}
          <div className="form-row">
            <label className="field"><span>Narration language</span>
              <select className="select" value={form.language} onChange={(e) => set({ language: e.target.value })}>{languages.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</select>
            </label>
            <div className="field"><span>Voice</span>
              <VoiceSelect value={form.voiceId} onChange={(voiceId) => set({ voiceId })} />
            </div>
          </div>
          <MusicChoice label="Music" mood={form.music} trackId={form.musicTrackId} onChange={({ mood, trackId }) => set({ music: mood, musicTrackId: trackId })}
            moodName={(m) => (m === "auto" ? "Pick one that fits" : m === "none" ? "No music" : m[0].toUpperCase() + m.slice(1))} />
          {!ad && <div className="field">
            <span className="row" style={{ gap: 10 }}>
              <Switch checked={form.sounds} onChange={(sounds) => set({ sounds })} label="Sound effects" />
              <span>Sound effects</span>
            </span>
            <span className="hint">A whoosh on scene changes and sounds for scenes you'd hear (fire, waves, a crowd). Add, change or remove them in the editor.</span>
          </div>}
          {canFilm && (
            <div className="field">
              <span className="row" style={{ gap: 10 }}>
                <Switch checked={form.film} onChange={(film) => set({ film })} label="Cinematic" />
                <span>Cinematic</span>
              </span>
              <span className="hint">
                Made like an AI short film: every scene is an AI clip with its own camera move, scenes change on hard cuts, and the whole video gets a film look (grade and grain). Each clip costs credits on top of the video; the draft shows the total before anything is charged.
              </span>
              {form.film && (
                <div className="form-row" style={{ marginTop: 8 }}>
                  <label className="field"><span className="small">Clip quality</span>
                    <select className="select" value={form.filmQuality} onChange={(e) => set({ filmQuality: e.target.value as ClipQuality })}>
                      <option value="regular">Regular · 720p</option>
                      <option value="high">High · 1080p</option>
                    </select>
                    <span className="hint">{CLIP_CREDITS[form.filmQuality]} credit{CLIP_CREDITS[form.filmQuality] === 1 ? "" : "s"} per {CLIP_SECONDS} seconds of clip.</span>
                  </label>
                  {(user?.clipModels?.length ?? 0) > 1 && (
                    <label className="field"><span className="small">Clip model</span>
                      <select className="select" value={form.filmModel} onChange={(e) => set({ filmModel: e.target.value as ClipModel | "" })}>
                        <option value="">Everyone's model</option>
                        {user!.clipModels!.map((m) => <option key={m} value={m}>{clipModelNames[m]}</option>)}
                      </select>
                      <span className="hint">Only some models make sound with their clips.</span>
                    </label>
                  )}
                </div>
              )}
            </div>
          )}
          {t.kind !== "backdrop" && !ad && (
            <label className="field"><span>Main character <span className="muted small">(optional)</span></span>
              <input className="input" maxLength={300} value={form.subject} placeholder="A curious orange fox with a blue scarf" onChange={(e) => set({ subject: e.target.value })} />
              <span className="hint">Drawn the same way in every picture.</span>
            </label>
          )}
        </div>
        <div className="card stack">
          {ad ? (
            <p className="muted small">Each shot is drawn with your photos, so it shows your product in the shot's setting, then filmed for a few seconds with its own sound. A voiceover in the voice you chose, subtitles and music go over the shots. You can change every line and shot in the draft.</p>
          ) : t.kind === "backdrop" ? (
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
          {!ready && <p className="hint center">{ad ? (form.photos.length ? "Say what the product is first." : "Add a photo of the product first.") : t.kind === "script" ? "Paste at least a sentence or two." : "Give it a topic first."}</p>}
          <CreditBlockNotice block={block} />
        </div>
      </div>
      {picking && <MediaPicker type="image" title="Choose a photo of the product" onPick={(a) => { addPhoto(a.id); setPicking(false); }} onClose={() => setPicking(false)} />}
    </div>
  );
}
