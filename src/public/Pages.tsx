import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowRight, BookOpen, Bot, Building2, CalendarClock, Clapperboard, Eye, FileText, Ghost, Globe2, KeyRound, Layers, MessageSquare, Plus, ShieldCheck, Sparkles, Users, Wand2 } from "lucide-react";
import { useAuth } from "../lib";
import { StyleArt } from "../art";
import { SamplePhone } from "./Phone";
import { useExamples } from "../examples";
import { Faq, StyleGallery, homeFaq } from "./Landing";
import { NotFound } from "./NotFound";
import { categories, templates, tools, toolBySlug, type TemplateId } from "../../shared/templates";
import { storyStyleIds, storyStyles } from "../../shared/story";
import { languages } from "../../shared/series";
import { PRODUCT } from "../../shared/brand";

// The public pages beside the home page: video tools (one generator page each), art styles, FAQ, about, business and
// the MCP / API page. All copy is our own.

const icons: Record<string, typeof Ghost> = { ghost: Ghost, "book-open": BookOpen, eye: Eye, sparkles: Sparkles, "file-text": FileText, "message-square": MessageSquare };
/** Where a "Try this" goes: Create with the template (after sign-up when signed out), with the prompt kept. */
function useStart() {
  const { user } = useAuth();
  const navigate = useNavigate();
  return (template: TemplateId, prompt = "") => {
    const next = `/app/create?template=${template}${prompt ? `&prompt=${encodeURIComponent(prompt.slice(0, 400))}` : ""}`;
    navigate(user ? next : `/register?next=${encodeURIComponent(next)}`);
  };
}

const toolFilters = [
  { id: "all", name: "All tools", match: () => true },
  { id: "text", name: "From text", match: (id: TemplateId) => templates[id].kind === "script" },
  { id: "story", name: "Story videos", match: (id: TemplateId) => templates[id].kind === "story" || templates[id].kind === "backdrop" },
  { id: "trending", name: "Trending videos", match: (id: TemplateId) => templates[id].kind === "mashup" },
  { id: "pov", name: "POV videos", match: (id: TemplateId) => templates[id].kind === "pov" },
] as const;
export function Tools() {
  const [filter, setFilter] = useState<(typeof toolFilters)[number]["id"]>("all");
  const shown = tools.filter((t) => toolFilters.find((f) => f.id === filter)!.match(t.id));
  return (
    <>
      <div className="pub-wrap">
        <div className="pub-head center">
          <h1 className="title">AI <span className="glow-text">video tools</span> for faceless creators</h1>
          <p className="lead">Turn a script, a story idea or a wild prompt into a narrated vertical video for TikTok, YouTube Shorts and Instagram Reels. Pick a tool to start.</p>
        </div>
        <div className="filters" role="group" aria-label="Filter tools" style={{ justifyContent: "center", marginBottom: 36 }}>
          {toolFilters.map((f) => {
            const n = tools.filter((t) => f.match(t.id)).length;
            return <button key={f.id} type="button" className="filter" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>{f.name} <span className="count">{n}</span></button>;
          })}
        </div>
        <div className="row between" style={{ marginBottom: 16 }}><h2 style={{ fontSize: 26 }}>Explore video generators</h2><span className="muted small">{shown.length} tools</span></div>
        <div className="tools">
          {shown.map((t) => {
            const Icon = icons[t.icon] || Sparkles;
            return (
              <Link key={t.slug} to={`/tools/${t.slug}`} className="tool-card">
                <span className="pub-icon"><Icon size={22} aria-hidden="true" /></span>
                <h3>{t.title.replace(/^AI /, "AI ")}</h3>
                <p>{t.description}</p>
                <span className="text-link">Try this tool <ArrowRight size={16} aria-hidden="true" /></span>
              </Link>
            );
          })}
        </div>
        <div className="cta-band" style={{ marginTop: 40 }}>
          <div><h2>More faceless styles</h2><p>Scary stories, history, fun facts, bedtime stories and more — each with its own look and voice.</p></div>
          <Link className="btn primary big" to="/styles">Browse all video styles <ArrowRight size={18} aria-hidden="true" /></Link>
        </div>
      </div>
      <section className="pub-section">
        <div className="pub-wrap faq-split">
          <h2 className="title" style={{ marginTop: 0 }}>Questions about the video tools</h2>
          <Faq items={[
            ["What can I make with these tools?", "Narrated vertical videos: stories with a picture for every sentence, POV clips with an on-screen line, absurd mashup characters, storytime over a background clip, or your own script illustrated scene by scene."],
            ["How do I turn text into a video?", "Open Text to video, paste your script and choose a voice and an art style. Every sentence or two becomes a scene with its own picture; subtitles follow the voice word by word."],
            ["Are the videos made for TikTok, Shorts and Reels?", "Yes: 1080 × 1920 vertical MP4s up to three minutes, which fit all three. Download them to upload; posting straight to your accounts is coming soon."],
            ["Do I need to film myself or record a voiceover?", "No. Every video is faceless and narrated by a natural AI voice in one of 26 languages. You can use your own recording if you prefer."],
            ["Does choosing a tool make a video right away?", "No. A tool opens with your idea filled in; you see the draft script and choose the voice and look before anything is made or charged."],
            ["Can I schedule videos for my channels?", "Yes. Turn a tool into a series that makes new episodes on its own schedule. Posting them straight to your channels is coming soon; until then, download each one."],
          ]} />
        </div>
      </section>
    </>
  );
}

export function ToolPage() {
  const { slug = "" } = useParams();
  const tool = toolBySlug(slug);
  const start = useStart();
  const [prompt, setPrompt] = useState("");
  const [animal, setAnimal] = useState("");
  const [object, setObject] = useState("");
  const examples = useExamples();
  if (!tool) return <NotFound />;
  const t = templates[tool.id];
  const Icon = icons[tool.icon] || Sparkles;
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    start(tool.id, t.kind === "mashup" ? [animal, object].filter(Boolean).join(" + ") : prompt);
  };
  return (
    <>
      <div className="pub-wrap tool-hero">
        <div>
          <span className="pub-icon"><Icon size={22} aria-hidden="true" /></span>
          <h1 className="title" style={{ marginTop: 18 }}>{tool.title}</h1>
          <p className="lead">{tool.description}</p>
          <form className="tool-form" onSubmit={submit}>
            {t.kind === "mashup" ? (
              <div className="form-grid">
                <label className="field"><span>Animal</span><input className="input" maxLength={60} value={animal} placeholder="Shark" onChange={(e) => setAnimal(e.target.value)} /></label>
                <label className="field"><span>Object</span><input className="input" maxLength={60} value={object} placeholder="Sneaker" onChange={(e) => setObject(e.target.value)} /></label>
              </div>
            ) : (
              <label className="field"><span>{t.kind === "script" ? "Your script" : t.kind === "backdrop" ? "Title question" : t.kind === "pov" ? "Scenario" : "Story idea"}</span>
                {t.kind === "script"
                  ? <textarea className="textarea" rows={5} maxLength={2400} value={prompt} placeholder={t.examples[0]} onChange={(e) => setPrompt(e.target.value)} />
                  : <input className="input" maxLength={300} value={prompt} placeholder={t.examples[0]} onChange={(e) => setPrompt(e.target.value)} />}
              </label>
            )}
            <div className="row wrap" style={{ justifyContent: "space-between" }}>
              <span className="muted small">Free to draft · 1 credit per 30 seconds when you make it</span>
              <button className="btn primary" type="submit">Create video <ArrowRight size={16} aria-hidden="true" /></button>
            </div>
          </form>
          {t.kind !== "script" && t.kind !== "mashup" && (
            <div className="row wrap" style={{ marginTop: 14 }}>
              <span className="muted small">Ideas:</span>
              {t.examples.map((x) => <button key={x} type="button" className="chip button" onClick={() => setPrompt(x)}>{x}</button>)}
            </div>
          )}
        </div>
        <SamplePhone style={t.style} kind={t.kind} backdrop={t.kind === "backdrop" ? "bd-aurora" : undefined}
          title={t.kind === "pov" ? `POV: ${t.examples[0]}` : t.kind === "mashup" ? "Sneakorino Sharkalino" : t.examples[0]} caption={t.short}
          example={examples[tool.id]} autoplay />
      </div>
      <section className="pub-section tight">
        <div className="pub-wrap">
          <div className="feature-list">
            <div className="feature"><Wand2 size={22} className="accent-text" aria-hidden="true" /><h3>Written for you</h3><p>{t.brief}</p></div>
            <div className="feature"><Layers size={22} className="accent-text" aria-hidden="true" /><h3>A picture per sentence</h3><p>Every scene gets its own AI picture in {storyStyles[t.style].name.toLowerCase()} style by default — or pick any of {storyStyleIds.length} art styles.</p></div>
            <div className="feature"><Clapperboard size={22} className="accent-text" aria-hidden="true" /><h3>Ready to post</h3><p>Natural narration, word-by-word subtitles, smooth transitions and music, rendered as a 1080 × 1920 MP4.</p></div>
            <div className="feature"><CalendarClock size={22} className="accent-text" aria-hidden="true" /><h3>Or on autopilot</h3><p>Turn it into a series: a new episode for every slot of your schedule, for TikTok, YouTube and Instagram (auto-posting coming soon).</p></div>
          </div>
        </div>
      </section>
    </>
  );
}

export function Styles() {
  const { user } = useAuth();
  return (
    <div className="pub-wrap">
      <div className="pub-head center">
        <h1 className="title">Faceless <span className="glow-text">video styles</span></h1>
        <p className="lead">Every style is a ready-made recipe: what the script is about, how it's told, and the voice, art and music that suit it.</p>
      </div>
      <StyleGallery to={(id) => (user ? `/app/create?template=${id}` : `/register?next=${encodeURIComponent(`/app/create?template=${id}`)}`)} />
      <section className="pub-section tight" id="art">
        <div className="pub-section-head"><h2 className="title">{storyStyleIds.length} art styles</h2><p className="sub">One style for every picture of a video, so it looks drawn by one hand.</p></div>
        <div className="art-grid">
          {storyStyleIds.map((s) => <div key={s} className="art-card"><StyleArt style={s} /><strong>{storyStyles[s].name}</strong><small>{storyStyles[s].short}</small></div>)}
        </div>
      </section>
      <p className="muted small center">{categories.length} categories · {Object.keys(templates).length} styles · {languages.length} narration languages</p>
    </div>
  );
}

export function FaqPage() {
  return (
    <div className="pub-wrap">
      <div className="pub-head center"><h1 className="title">Frequently asked questions</h1><p className="lead">How {PRODUCT.name} makes your videos on your schedule.</p></div>
      <Faq items={[
        ...homeFaq,
        ["Which languages can the narration use?", `${languages.length} languages, from English, Spanish and Portuguese to German, Polish, Turkish, Greek and Ukrainian. Subtitles follow the narration.`],
        ["Who owns the videos?", "You do. You can use everything you make commercially, on any channel. The scripts and pictures are generated new for each video."],
        ["Are the videos marked as AI-generated?", "Yes, where the networks ask for it: the files carry AI metadata, and TikTok and YouTube get their AI-content labels when we post for you."],
        ["How long does a video take?", "Usually a few minutes: the script, the voice, a picture for every scene, then the render. Series episodes are made hours ahead of their slot."],
        ["Can I cancel any time?", "Yes, in Billing. Your plan runs to the end of the period you paid for, and your videos stay downloadable."],
      ]} />
      <div className="cta-band" style={{ marginTop: 40 }}>
        <div><h2>Still have a question?</h2><p>We read every message.</p></div>
        <Link className="btn primary" to="/contact">Contact us</Link>
      </div>
    </div>
  );
}

export function About() {
  return (
    <div className="pub-wrap narrow">
      <div className="pub-head"><span className="kicker">About</span><h1 className="title" style={{ marginTop: 12 }}>Video channels without the grind</h1>
        <p className="lead">{PRODUCT.name} exists for people with ideas and no time to film, edit and post every day.</p></div>
      <div className="stack" style={{ gap: 18, fontSize: 17, color: "#c9d0ca" }}>
        <p>Short-form video rewards consistency: a new post every day, for months. That is hard to keep up when every video means writing a script, finding pictures, recording a voice, editing, captioning and posting by hand.</p>
        <p>{PRODUCT.name} does that work for you. Choose a faceless style and a topic once; for every slot in your schedule it writes an original script, narrates it with a natural AI voice, draws a new picture for every sentence in one art style, adds subtitles, transitions and music, and has the finished video ready on time (posting it straight to your channels is coming soon). You can step in at any point: edit the draft, ask to review before anything posts, or just download.</p>
        <p>We care about doing this responsibly: every script is written new, videos are labelled as AI-made where the networks ask, we never invent reviews or results, and your connected accounts are only ever used to post what you made.</p>
      </div>
      <div className="feature-list" style={{ marginTop: 36 }}>
        <div className="feature"><ShieldCheck size={22} className="accent-text" aria-hidden="true" /><h3>Your account, your content</h3><p>Tokens are encrypted, nothing posts without your schedule or your click, and everything you make is yours to use.</p></div>
        <div className="feature"><Globe2 size={22} className="accent-text" aria-hidden="true" /><h3>Many languages</h3><p>Narration and subtitles in {languages.length} languages, for channels anywhere.</p></div>
        <div className="feature"><MessageSquare size={22} className="accent-text" aria-hidden="true" /><h3>Real people</h3><p>Questions, ideas or problems? <Link className="text-link" to="/contact">Write to us</Link>.</p></div>
      </div>
    </div>
  );
}

export function Business() {
  return (
    <>
      <div className="pub-wrap">
        <div className="pub-head center"><span className="kicker">For business</span><h1 className="title" style={{ marginTop: 12 }}>Short-form video at the pace of a team, without the team</h1>
          <p className="lead">Agencies, media brands and businesses run many channels on {PRODUCT.name}: each series with its own topic, voice, look and schedule.</p>
          <div className="center-row" style={{ marginTop: 26 }}><Link className="btn primary big" to="/pricing">See Studio plan</Link><Link className="btn big" to="/contact?topic=partnership">Talk to us</Link></div>
        </div>
      </div>
      <section className="pub-section tight">
        <div className="pub-wrap feature-list">
          <div className="feature"><Users size={22} className="accent-text" aria-hidden="true" /><h3>Many channels</h3><p>Run dozens of series side by side and post to as many TikTok, YouTube and Instagram accounts as you need once posting opens (coming soon).</p></div>
          <div className="feature"><Eye size={22} className="accent-text" aria-hidden="true" /><h3>Review before posting</h3><p>Turn on review for any series: episodes wait for approval, with an e-mail when each is ready.</p></div>
          <div className="feature"><Clapperboard size={22} className="accent-text" aria-hidden="true" /><h3>Clips from your shows</h3><p>Turn podcasts, webinars and streams of up to two hours into captioned vertical clips that cut to whoever is talking, each moment with a virality score.</p></div>
          <div className="feature"><Bot size={22} className="accent-text" aria-hidden="true" /><h3>API and MCP</h3><p>Make videos from your own tools, scripts or AI assistant with an API key. <Link className="text-link" to="/mcp">How it works</Link></p></div>
          <div className="feature"><Building2 size={22} className="accent-text" aria-hidden="true" /><h3>Invoices and tax</h3><p>Pay by card with proper invoices; business tax IDs are collected at checkout where tax applies.</p></div>
        </div>
      </section>
    </>
  );
}

export function Mcp() {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const config = JSON.stringify({ mcpServers: { [PRODUCT.slug]: { type: "http", url: `${origin}/mcp`, headers: { Authorization: "Bearer hss_your_api_key" } } } }, null, 2);
  return (
    <div className="pub-wrap">
      <div className="pub-head center"><span className="kicker">MCP Connection</span><h1 className="title" style={{ marginTop: 12 }}>Make videos from your AI assistant</h1>
        <p className="lead">Connect {PRODUCT.name} to any assistant that speaks the Model Context Protocol. Ask for a video in plain words; it is written, made and returned with a download link.</p></div>
      <div className="grid two" style={{ alignItems: "start" }}>
        <div className="glass stack">
          <h2 style={{ fontSize: 22 }}>1. Create an API key</h2>
          <p className="muted">In the app, open Settings → API keys and create a key. It starts with <code>hss_</code> and is shown once.</p>
          <h2 style={{ fontSize: 22, marginTop: 10 }}>2. Add the server</h2>
          <p className="muted">Add a remote (Streamable HTTP) MCP server with this address and your key as a bearer token:</p>
          <pre className="code">{config}</pre>
          <h2 style={{ fontSize: 22, marginTop: 10 }}>3. Ask</h2>
          <p className="muted">"Make a 45-second scary story about a lighthouse in the dark fantasy style, then give me the link."</p>
        </div>
        <div className="glass stack">
          <h2 style={{ fontSize: 22 }}>Tools the assistant gets</h2>
          <ul className="stack" style={{ paddingLeft: 18, color: "#c9d0ca", gap: 8 }}>
            <li><code>list_video_types</code> — styles, art styles, voices and languages</li>
            <li><code>create_video</code> — writes and makes a video (uses credits)</li>
            <li><code>get_video</code> — status and a download link when ready</li>
            <li><code>list_videos</code>, <code>list_series</code>, <code>set_series_status</code></li>
            <li><code>list_long_videos</code>, <code>import_video</code>, <code>find_clips</code>, <code>get_long_video</code> — your videos (uploaded, or imported from a link) and the moments found in them</li>
            <li><code>make_clip</code> — makes a vertical clip of a moment (uses credits)</li>
            <li><code>get_account</code> — plan and credits left</li>
          </ul>
          <p className="muted small">The assistant acts as you, with your credits and limits. Delete the key in Settings to cut it off at once.</p>
        </div>
      </div>
      <section className="pub-section tight" id="api">
        <div className="pub-section-head"><span className="kicker">API access</span><h2 className="title">Prefer plain HTTP?</h2><p className="sub">The same key works with the REST API.</p></div>
        <pre className="code">{`curl -X POST ${origin}/api/v1/videos \\
  -H "Authorization: Bearer hss_your_api_key" \\
  -H "Content-Type: application/json" \\
  -d '{"type":"facts","prompt":"Animals that never sleep","seconds":45,"style":"doodle"}'

curl ${origin}/api/v1/videos/VIDEO_ID -H "Authorization: Bearer hss_your_api_key"
# → { "video": { "status": "ready", "download": "https://…" } }`}</pre>
        <div className="feature-list" style={{ marginTop: 18 }}>
          <div className="feature"><KeyRound size={20} className="accent-text" aria-hidden="true" /><h3>GET /api/v1/me</h3><p>Plan and credits left.</p></div>
          <div className="feature"><Layers size={20} className="accent-text" aria-hidden="true" /><h3>GET /api/v1/types</h3><p>Video types, art styles, voices, languages.</p></div>
          <div className="feature"><Plus size={20} className="accent-text" aria-hidden="true" /><h3>POST /api/v1/videos</h3><p>Write and make a video.</p></div>
          <div className="feature"><Clapperboard size={20} className="accent-text" aria-hidden="true" /><h3>GET /api/v1/videos/:id</h3><p>Status and download link.</p></div>
          <div className="feature"><Layers size={20} className="accent-text" aria-hidden="true" /><h3>GET /api/v1/sources</h3><p>Your uploaded videos and the moments found in them, with their virality scores.</p></div>
          <div className="feature"><Plus size={20} className="accent-text" aria-hidden="true" /><h3>POST /api/v1/sources</h3><p>Import a video from a link to the file, or a Dropbox or Google Drive share link.</p></div>
          <div className="feature"><Plus size={20} className="accent-text" aria-hidden="true" /><h3>POST /api/v1/sources/:id/find</h3><p>Find clips in one of them.</p></div>
          <div className="feature"><Plus size={20} className="accent-text" aria-hidden="true" /><h3>POST /api/v1/clips</h3><p>Make a clip of a moment.</p></div>
        </div>
      </section>
    </div>
  );
}
