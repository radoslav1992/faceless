import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowRight, CalendarClock, Check, Columns2, Compass, Plus, ScanFace, Scissors, Sparkles, Wand2, X } from "lucide-react";
import { useAuth } from "../lib";
import { SamplePhone, reel } from "./Phone";
import { PlanCards } from "./Pricing";
import { categories, templateIds, templates, type CategoryId } from "../../shared/templates";
import { PRODUCT } from "../../shared/brand";

// The home page: what the product does, a video to try right here, the faceless styles, how it compares, plans and
// questions. Every word and picture on it is ours; it shows drawn samples, never invented results, users or reviews.

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
  const [title, setTitle] = useState("What decision quietly changed your life?");
  const [story, setStory] = useState("I almost said no to a free trip with strangers. I went anyway. On the second night, a stranger at the campfire asked what I'd do if money didn't matter. I answered without thinking. A year later, that answer was my job.");
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

/** The gallery of faceless styles: filter by category, open one in Create (sign-up first). */
export function StyleGallery({ to }: { to: (id: string) => string }) {
  const [category, setCategory] = useState<CategoryId | "all">("all");
  const shown = templateIds.filter((id) => category === "all" || templates[id].category === category);
  return (
    <div className="stack" style={{ gap: 22 }}>
      <div className="filters" role="group" aria-label="Filter styles">
        <button type="button" className="filter" aria-pressed={category === "all"} onClick={() => setCategory("all")}>All <span className="count">{templateIds.length}</span></button>
        {categories.map((c) => {
          const n = templateIds.filter((id) => templates[id].category === c.id).length;
          return <button key={c.id} type="button" className="filter" aria-pressed={category === c.id} onClick={() => setCategory(c.id)}>{c.name} <span className="count">{n}</span></button>;
        })}
      </div>
      <div className="gallery">
        {shown.map((id) => {
          const t = templates[id];
          return (
            <Link key={id} to={to(id)} className="style-card">
              <div style={{ position: "relative" }}>
                {"popular" in t && t.popular && <span className="badge-popular">POPULAR</span>}
                <SamplePhone style={t.style} kind={t.kind} title={t.kind === "pov" ? `POV: ${t.examples[0]}` : t.kind === "mashup" ? "Toastero Froggarino" : t.examples[0]}
                  caption={t.short} backdrop={t.kind === "backdrop" ? "bd-city" : undefined} />
              </div>
              <strong>{t.name}</strong>
              <small>{t.short}</small>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

export const homeFaq: [string, string][] = [
  ["Do I have to make the videos myself?", `No. Pick a style and a topic once and ${PRODUCT.name} writes the script, records the voice, draws a picture for every sentence, adds subtitles and music, and renders the video. You can also make single videos whenever you like.`],
  ["Can I edit a video before it's posted?", "Yes. Every video opens in the editor: change the words, redo a picture, swap the voice, music or subtitle style, or move scenes on the timeline. Edits to text and timing are free."],
  ["What if I don't want videos posted publicly?", "Post them privately (TikTok and YouTube) to check them first, let videos wait for your approval, or don't connect an account at all and just download them."],
  ["Can I choose when my videos are published?", "Yes. Each series has its own days, times and time zone. Every episode is made several hours ahead and posts at its slot."],
  ["Can I see upcoming videos before they post?", "Yes. The series page lists the coming slots and the episodes already made for them, with their status. You get an e-mail when each one is ready."],
  ["Can I post to several social accounts?", "Yes. A series can post to TikTok, YouTube Shorts and Instagram Reels at the same time, and different series can post to different accounts."],
  ["Can I download my videos?", "Always. Every video downloads as a 1080 × 1920 MP4, on every plan, including the free trial."],
  ["Can I turn my podcast or stream into clips?", "Yes. Upload the video (up to 10 minutes on the free trial, up to 2 hours on paid plans) and we find the moments that stand on their own, give each a virality score, and make the ones you choose into vertical clips that cut to whoever is talking, with captions. A clip costs 1 credit per started minute."],
];
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

export function Landing() {
  const { user } = useAuth();
  const start = user ? "/app" : "/register";
  return (
    <>
      <section className="hero">
        <div className="pub-wrap">
          <span className="kicker">Faceless channels on autopilot</span>
          <h1 style={{ marginTop: 16 }}>Grow a faceless channel <span className="glow-text">without lifting a finger</span></h1>
          <p className="lead">{PRODUCT.name} writes, narrates, illustrates and subtitles short videos in your niche, then posts them to TikTok, YouTube Shorts and Instagram Reels on your schedule.</p>
          <div className="center-row">
            <Link className="btn primary big" to={start}>{user ? "Open dashboard" : "Start for free"}</Link>
            <Link className="btn big" to="/tools">Browse video tools</Link>
          </div>
          <p className="hero-note">Free trial · no card needed · cancel any time</p>
        </div>
        <div className="reel" aria-label="Example videos (drawn samples)">
          {reel.map((r) => <SamplePhone key={r.title} {...r} />)}
        </div>
      </section>

      <section className="pub-section">
        <div className="pub-wrap">
          <div className="pub-section-head center">
            <span className="kicker">How it works</span>
            <h2 className="title">Your content system for short-form video</h2>
            <p className="sub">Set it up once. New videos keep coming, and you stay in control of every one.</p>
          </div>
          <div className="steps">
            <div className="step"><Compass size={30} aria-hidden="true" /><h3>Pick a style</h3><p>Start from a proven faceless format — scary stories, history, POV, facts, brainrot — or describe your own topic.</p></div>
            <div className="step"><Wand2 size={30} aria-hidden="true" /><h3>Shape the draft</h3><p>The AI writes the script and draws every scene. Change any word, picture, voice or subtitle before it goes out.</p></div>
            <div className="step"><CalendarClock size={30} aria-hidden="true" /><h3>Stay consistent</h3><p>Set the days and times. Each episode is made ahead and posted on schedule — or waits for your OK.</p></div>
          </div>
        </div>
      </section>

      <section className="pub-section tight" id="try">
        <div className="pub-wrap">
          <div className="pub-section-head center">
            <span className="kicker">Try it</span>
            <h2 className="title">Make a free video right here</h2>
            <p className="sub">Change anything below and watch the preview. Create it when you like it.</p>
          </div>
          <Demo />
        </div>
      </section>

      <section className="pub-section">
        <div className="pub-wrap">
          <div className="pub-section-head">
            <span className="kicker">Faceless styles</span>
            <h2 className="title">Start from a format that works</h2>
            <p className="sub">Every style comes with its own script recipe, voice, art style and music. Make one video, or turn it into a series.</p>
          </div>
          <StyleGallery to={(id) => (user ? `/app/create?template=${id}` : `/register?next=${encodeURIComponent(`/app/create?template=${id}`)}`)} />
        </div>
      </section>

      <section className="pub-section">
        <div className="pub-wrap">
          <div className="pub-section-head">
            <span className="kicker">Clips</span>
            <h2 className="title">Already filming? Turn long videos into shorts</h2>
            <p className="sub">Upload a podcast, interview, stream or webinar. We listen to it, pick the moments that work on their own and make them vertical.</p>
          </div>
          <div className="feature-list">
            <div className="feature"><Sparkles size={22} className="accent-text" aria-hidden="true" /><h3>A virality score for every moment</h3><p>Each moment is scored on its hook, payoff, clarity and energy, and on the laughs and applause it gets, with a reason it works. An estimate, never a promise of views. Ask for a topic if you like.</p></div>
            <div className="feature"><ScanFace size={22} className="accent-text" aria-hidden="true" /><h3>Framed on the speaker</h3><p>The vertical crop cuts to whoever is talking: we hear who speaks and watch whose lips move. Or stack two speakers, put your camera over your screen, or place the crop yourself.</p></div>
            <div className="feature"><Columns2 size={22} className="accent-text" aria-hidden="true" /><h3>Captions and cuts</h3><p>Word-by-word captions in twenty-one styles, a hook title, and long pauses and filler words cut out.</p></div>
            <div className="feature"><Scissors size={22} className="accent-text" aria-hidden="true" /><h3>Edit, schedule, post</h3><p>Trim any clip on its words, then post the batch on your channels one a day, or whenever you choose.</p></div>
          </div>
          <p className="price-note"><Link className="text-link" to={user ? "/app/clips" : `/register?next=${encodeURIComponent("/app/clips")}`}>Clip a video <ArrowRight size={15} aria-hidden="true" /></Link></p>
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
            <div className="compare-row"><div><h3>Hiring video editors</h3><p>Briefs, back-and-forth and a fee for every single video. Hard to keep up a daily pace without a big budget.</p></div><span className="mark"><X size={22} aria-label="Slow and costly" /></span></div>
            <div className="compare-row"><div><h3>Making every video yourself</h3><p>Finding ideas, writing scripts, finding visuals, recording voiceovers, editing, captioning and posting — hours per video.</p></div><span className="mark"><X size={22} aria-label="Slow" /></span></div>
            <div className="compare-row yes"><div><h3>{PRODUCT.name}</h3><p>Original faceless videos written, made and posted on autopilot to TikTok, YouTube and Instagram, with your review whenever you want it.</p></div><span className="mark"><Check size={22} aria-label="Fast" /></span></div>
          </div>
        </div>
      </section>

      <section className="pub-section">
        <div className="pub-wrap">
          <div className="pub-section-head center">
            <span className="kicker">Pricing</span>
            <h2 className="title">Pick your pace</h2>
            <p className="sub">Credits pay for videos: one credit per 30 seconds. Unused credits roll over.</p>
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
