import { t as say } from "../../shared/i18n";
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { homeFaq } from "../../shared/faq";
import { ArrowRight, CalendarClock, Captions, Check, Compass, Download, Image as ImageIcon, Mic, PenLine, Plus, Send, Volume2, VolumeX, Wand2, X } from "lucide-react";
import { useAuth } from "../lib";
import { SamplePhone, reel } from "./Phone";
import { PlanCards } from "./Pricing";
// Styles still being tested (administrators only) are not shown here.
import { openCategories as categories, openTemplateIds as templateIds, templates, type CategoryId } from "../../shared/templates";
import { PRODUCT } from "../../shared/brand";
import { SECONDS_PER_CREDIT } from "../../shared/credits";
import { plans } from "../../shared/plans";
import type { StoryStyle } from "../../shared/styles";
import { StyleArt } from "../art";
import { useExamples, type Example } from "../examples";

// The home page: what the product does, its styles, how it compares, what every video includes, how it works, a video
// to try right here, plans and questions. Every word and picture on it is ours; it shows
// real videos made with the styles (Admin → Examples) or drawn samples (and a drawing of the dashboard), never invented
// results, users or reviews.

/** A draft started on the home page, picked up by Create after sign-up. */
export const DEMO_DRAFT = "hss-demo-draft";
const backdrops = [
  { id: "bd-aurora", name: "Aurora" },
  { id: "bd-city", name: "Neon city" },
  { id: "bd-ocean", name: "Ocean" },
  { id: "bd-paper", name: "Notebook" },
];
const colors = [
  { id: "#ffffff", name: "White" },
  { id: "#ffe14d", name: "Yellow" },
  { id: "#b8f53a", name: "Lime" },
  { id: "#7fd8ff", name: "Blue" },
];

/** Try it: a storytime video (a title card, then the story over a background) previewed live, made after sign-up. */
function Demo() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [backdrop, setBackdrop] = useState(backdrops[0].id);
  const [color, setColor] = useState(colors[0].id);
  const [title, setTitle] = useState(() => say("What decision quietly changed your life?"));
  const [story, setStory] = useState(() => say("I almost said no to a free trip with strangers. I went anyway. On the second night, a stranger at the campfire asked what I'd do if money didn't matter. I answered without thinking. A year later, that answer was my job."));
  const caption = useMemo(() => story.split(/\s+/).slice(0, 60).join(" "), [story]);
  const start = () => {
    try { localStorage.setItem(DEMO_DRAFT, JSON.stringify({ template: "storytime", title, script: story, color, at: Date.now() })); } catch { /* storage unavailable */ }
    const next = "/app/create?template=storytime&draft=demo";
    navigate(user ? next : `/register?next=${encodeURIComponent(next)}`);
  };
  return (
    <div className="demo">
      <SamplePhone backdrop={backdrop} title={title} caption={caption} kind="backdrop" color={color} label="Live preview of your storytime video" />
      <div className="demo-fields">
        <div className="field">
          <span>Background</span>
          <div className="backdrops" role="radiogroup" aria-label="Background">
            {backdrops.map((b) => (
              <button key={b.id} type="button" role="radio" aria-checked={backdrop === b.id} className="backdrop-tile" onClick={() => setBackdrop(b.id)}>
                <div className={`backdrop ${b.id}`} style={{ position: "absolute", inset: 0 }} />
                <span>{b.name}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <span>Subtitle colour</span>
          <div className="swatches" role="radiogroup" aria-label="Subtitle colour">
            {colors.map((c) => (
              <button key={c.id} type="button" role="radio" aria-checked={color === c.id} aria-label={c.name} className="swatch" style={{ background: c.id }} onClick={() => setColor(c.id)} />
            ))}
          </div>
        </div>
        <label className="field"><span>Title question</span>
          <input className="input" maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="field"><span>Your story <span className="muted small">(or leave it to the AI later)</span></span>
          <textarea className="textarea" rows={5} maxLength={1500} value={story} onChange={(e) => setStory(e.target.value)} />
        </label>
        <div className="row wrap" style={{ justifyContent: "space-between" }}>
          <p className="muted small">The real video gets a natural AI voice, word-by-word subtitles and a looping background clip.</p>
          <button type="button" className="btn primary big" onClick={start}>Create this video <ArrowRight size={18} aria-hidden="true" /></button>
        </div>
      </div>
    </div>
  );
}

/** The styles with the popular ones in front (what a shortened gallery and the hero show first). */
const popularFirst = [...templateIds].sort((a, b) => Number("popular" in templates[b] && templates[b].popular) - Number("popular" in templates[a] && templates[a].popular));
/**
 * The gallery of faceless styles: filter by category, open one in Create (sign-up first). With `first`, it opens
 * with that many styles, the popular ones in front (half as many on a phone), and a button shows the rest.
 */
export function StyleGallery({ to, first }: { to: (id: string) => string; first?: number }) {
  const examples = useExamples();
  const [category, setCategory] = useState<CategoryId | "all">("all");
  const [all, setAll] = useState(false);
  // A category is short enough to show whole.
  const short = !!first && !all && category === "all" && templateIds.length > first;
  const shown = short ? popularFirst.slice(0, first) : templateIds.filter((id) => category === "all" || templates[id].category === category);
  return (
    <div className="stack" style={{ gap: 22 }}>
      <div className="filters" role="group" aria-label="Filter styles">
        <button type="button" className="filter" aria-pressed={category === "all"} onClick={() => setCategory("all")}>All <span className="count">{templateIds.length}</span></button>
        {categories.map((c) => {
          const n = templateIds.filter((id) => templates[id].category === c.id).length;
          return <button key={c.id} type="button" className="filter" aria-pressed={category === c.id} onClick={() => setCategory(c.id)}>{c.name} <span className="count">{n}</span></button>;
        })}
      </div>
      <div className={`gallery${short ? " short" : ""}`}>
        {shown.map((id) => {
          const t = templates[id];
          return (
            <Link key={id} to={to(id)} className="style-card">
              <div style={{ position: "relative" }}>
                {"popular" in t && t.popular && <span className="badge-popular">POPULAR</span>}
                <SamplePhone style={t.style} kind={t.kind} title={t.kind === "pov" ? `POV: ${t.examples[0]}` : t.kind === "mashup" ? "Toastero Froggarino" : t.examples[0]}
                  caption={t.short} backdrop={t.kind === "backdrop" ? "bd-city" : undefined} example={examples[id]} />
              </div>
              <strong>{t.name}</strong>
              <small>{t.short}</small>
            </Link>
          );
        })}
      </div>
      {short && <div className="center-row"><button type="button" className="btn" onClick={() => setAll(true)}>{`Show all ${templateIds.length} styles`}</button></div>}
      {/* Only where a drawing stands in for a video. */}
      {shown.some((id) => !examples[id]) && <p className="sample-note">Drawn samples. Your videos are written and drawn fresh for your topic.</p>}
    </div>
  );
}

export function Faq({ items }: { items: [string, string][] }) {
  return (
    <div className="faq">
      {items.map(([q, a]) => (
        <details key={q}>
          <summary>{q}<Plus size={20} aria-hidden="true" /></summary>
          <div className="answer"><p>{a}</p></div>
        </details>
      ))}
    </div>
  );
}

/** A drawing of the dashboard: a series' week of videos, made, ready and scheduled. */
const mockTiles: { style: StoryStyle; status: string; tone: "done" | "next" | "wait" }[] = [
  { style: "dark", status: "Made", tone: "done" },
  { style: "anime", status: "Made", tone: "done" },
  { style: "cinematic", status: "Ready", tone: "next" },
  { style: "watercolor", status: "Thu 18:00", tone: "wait" },
  { style: "oil", status: "Fri 18:00", tone: "wait" },
  { style: "clay", status: "Sat 12:00", tone: "wait" },
  { style: "comic", status: "Sun 12:00", tone: "wait" },
  { style: "neon", status: "Mon 18:00", tone: "wait" },
];
function AppMock() {
  return (
    <div className="app-mock" role="img" aria-label={`A drawing of the ${PRODUCT.name} dashboard: a series with this week's videos made, ready and scheduled`}>
      <div className="am-bar" aria-hidden="true"><span /><span /><span /><em>hookstreak.app/app/series</em></div>
      <div className="am-body" aria-hidden="true">
        <div className="am-head">
          <div><strong>Ocean mysteries</strong><small>Daily · TikTok, YouTube, Instagram</small></div>
          <span className="am-chip">Autopilot on</span>
        </div>
        <div className="am-grid">
          {mockTiles.map((t, i) => (
            <div key={i} className="am-tile">
              <StyleArt style={t.style} />
              <span className={`am-status ${t.tone}`}>{t.status}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const included: [typeof Mic, string, string][] = [
  [PenLine, "A script that hooks", "Written for your niche, with a first line made to stop the scroll and an ending worth staying for."],
  [Mic, "Natural AI voices", "Narrators that sound human, or your own recording, timed word by word."],
  [ImageIcon, "A picture for every sentence", "Drawn in one style from start to finish (cinematic, anime, watercolor, comic and more), or your own clips."],
  [Captions, "Subtitles that pop", "Word-by-word captions with the key words in colour, in the style you choose."],
  [Send, "Ready on schedule", "Made ahead of your days and times, ready to approve, then posted to your YouTube channel or downloaded. Posting to TikTok and Instagram Reels is coming soon."],
  [Download, "Yours to keep", "Every video downloads as a 1080 × 1920 MP4, on every plan."],
];

/** The hero's videos: real examples (popular styles first) once there are three, else the drawn samples. */
function heroExamples(examples: Record<string, Example>) {
  const found = popularFirst.filter((id) => examples[id]).slice(0, 5);
  return found.length >= 3 ? found : null;
}
/** The trial's credits, and the 30-second videos they make (two credits each). */
const trial = plans.find((p) => p.id === "free")!.credits;

export function Landing() {
  const { user } = useAuth();
  const examples = useExamples();
  const shown = heroExamples(examples);
  // The hero video that plays with its sound (a tap turns it on, another one off): faceless videos sell on the voice.
  const [sounding, setSounding] = useState<string | null>(null);
  const start = user ? "/app" : "/register";
  const make = (id: string) => (user ? `/app/create?template=${id}` : `/register?next=${encodeURIComponent(`/app/create?template=${id}`)}`);
  return (
    <>
      <section className="hero">
        <div className="pub-wrap">
          <div className="hero-card">
            <p className="hero-pill"><span className="dot" aria-hidden="true" />Made for TikTok, YouTube Shorts and Instagram Reels</p>
            <h1>Grow a faceless channel <span className="glow-text">without lifting a finger</span></h1>
            <p className="lead">{PRODUCT.name} writes, narrates, illustrates and subtitles short videos in your niche, ready on your schedule.</p>
            <div className="center-row">
              <Link className="btn primary big" to={start}>{user ? "Open dashboard" : "Start for free"}</Link>
              <Link className="btn big" to="/tools">Browse video tools</Link>
            </div>
            <p className="hero-note">{`Free trial: ${trial} credits, enough for ${trial / 2} videos · no card needed · cancel any time`}</p>
            {shown ? (
              <div className="reel" aria-label={`Example videos made with ${PRODUCT.name}`}>
                {shown.map((id) => (
                  <SamplePhone key={id} caption="" title={templates[id].name} label={`Example: ${templates[id].name}`} example={examples[id]} autoplay sound={sounding === id}>
                    <button type="button" className="ph-sound" aria-pressed={sounding === id} aria-label={sounding === id ? `Mute ${templates[id].name}` : `Play ${templates[id].name} with sound`}
                      onClick={() => setSounding(sounding === id ? null : id)}>
                      {sounding === id ? <Volume2 size={16} aria-hidden="true" /> : <VolumeX size={16} aria-hidden="true" />}
                    </button>
                  </SamplePhone>
                ))}
              </div>
            ) : (
              <div className="reel" aria-label="Example videos (drawn samples)">
                {reel.map((r) => <SamplePhone key={r.title} {...r} />)}
              </div>
            )}
            {/* Proof: the product's own channels (shared/brand.ts), never invented users or numbers. */}
            {PRODUCT.channels.length > 0 && (
              <p className="hero-proof">
                <span>Our own channels:</span>
                {PRODUCT.channels.map((c) => (
                  <a key={c.url} className="chip" href={c.url} target="_blank" rel="noopener noreferrer">{c.platform} · {`${c.followers} followers`}</a>
                ))}
              </p>
            )}
          </div>
        </div>
      </section>

      <section className="pub-section">
        <div className="pub-wrap">
          <div className="pub-section-head center">
            <span className="kicker">Formats</span>
            <h2 className="title">Made for <span className="glow-text">every niche</span></h2>
            <p className="sub">Each format comes with its own script recipe, voice, art style and music. Pick one and get your first video in minutes.</p>
          </div>
          <StyleGallery to={make} first={12} />
          <p className="price-note">Already filming? Turn podcasts, interviews and streams into vertical shorts. <Link className="text-link" to={user ? "/app/clips" : `/register?next=${encodeURIComponent("/app/clips")}`}>Clip a video <ArrowRight size={15} aria-hidden="true" /></Link></p>
        </div>
      </section>

      <section className="pub-section">
        <div className="pub-wrap">
          <div className="pub-section-head center">
            <span className="kicker">Why {PRODUCT.name}</span>
            <h2 className="title">Why creators switch</h2>
            <p className="sub">Compared with the usual ways of keeping a short-form channel alive.</p>
          </div>
          <div className="compare">
            <div className="compare-card">
              <div className="compare-top"><h3>Hiring video editors</h3><X size={20} aria-label="Slow and costly" /></div>
              <p>Briefs, back-and-forth and a fee for every single video. Hard to keep up a daily pace without a big budget.</p>
            </div>
            <div className="compare-card">
              <div className="compare-top"><h3>Making every video yourself</h3><X size={20} aria-label="Slow" /></div>
              <p>Finding ideas, writing scripts, finding visuals, recording voiceovers, editing, captioning and posting: hours per video.</p>
            </div>
            <div className="compare-card yes">
              <div className="compare-top"><h3>{PRODUCT.name}</h3><Check size={20} aria-label="Fast" /></div>
              <p>Original faceless videos written and made on autopilot for TikTok, YouTube and Instagram, with your review whenever you want it. They post straight to YouTube Shorts; TikTok and Instagram are coming soon.</p>
            </div>
          </div>
        </div>
      </section>

      <section className="pub-section tight">
        <div className="pub-wrap">
          <div className="glow-panel">
            <div className="pub-section-head center">
              <span className="kicker">Everything included</span>
              <h2 className="title">Every part, <span className="glow-text">done for you</span></h2>
              <p className="sub">No editing software, no stock sites, no recording booth.</p>
            </div>
            <div className="included">
              {included.map(([Icon, title, text]) => (
                <div key={title} className="included-item">
                  <span className="pub-icon"><Icon size={20} aria-hidden="true" /></span>
                  <h3>{title}</h3>
                  <p>{text}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="pub-section">
        <div className="pub-wrap system">
          <div>
            <span className="kicker">How it works</span>
            <h2 className="title">Your AI content system for short-form video</h2>
            <p className="sub">Create, edit and schedule videos with AI, all in one place.</p>
            <ul className="system-steps">
              <li><span className="pub-icon"><Compass size={20} aria-hidden="true" /></span><div><h3>Pick a style</h3><p>Start from a proven faceless format, or describe your own topic.</p></div></li>
              <li><span className="pub-icon"><Wand2 size={20} aria-hidden="true" /></span><div><h3>Shape the draft</h3><p>The AI writes the script and draws every scene. Change any word, picture, voice or subtitle before it goes out.</p></div></li>
              <li><span className="pub-icon"><CalendarClock size={20} aria-hidden="true" /></span><div><h3>Stay consistent</h3><p>Set the days and times. Each episode is made ahead of its slot, or waits for your OK, then posts to your YouTube channel. Posting to TikTok and Instagram is coming soon.</p></div></li>
            </ul>
          </div>
          <AppMock />
        </div>
      </section>

      <section className="pub-section tight" id="try">
        <div className="pub-wrap">
          <div className="try-band">
            <div className="pub-section-head center">
              <h2 className="title">Try creating a free video below</h2>
              <p className="sub">Change anything and watch the preview. Create it when you like it.</p>
            </div>
            <Demo />
          </div>
        </div>
      </section>

      <section className="pub-section">
        <div className="pub-wrap">
          <div className="pub-section-head center">
            <span className="kicker">Pricing</span>
            <h2 className="title">Pick your pace</h2>
            <p className="sub">Credits pay for videos: one credit per {SECONDS_PER_CREDIT} seconds. Unused credits roll over.</p>
          </div>
          <PlanCards />
          <p className="price-note"><Link className="text-link" to="/pricing">Full pricing and credit packs <ArrowRight size={15} aria-hidden="true" /></Link></p>
        </div>
      </section>

      <section className="pub-section">
        <div className="pub-wrap">
          <div className="pub-section-head center"><h2 className="title">Frequently asked questions</h2></div>
          <Faq items={homeFaq} />
        </div>
      </section>

      <section className="pub-section tight">
        <div className="pub-wrap">
          <div className="cta-band glowing">
            <div><h2>Ready to start your channel?</h2><p>Pick a style and get your first video in minutes.</p></div>
            <Link className="btn primary big" to={start}>{user ? "Open dashboard" : "Start for free"}</Link>
          </div>
        </div>
      </section>
    </>
  );
}
