import { Link } from "react-router-dom";
import { ArrowRight, PenSquare, Repeat, Scissors, Sparkles } from "lucide-react";
import { useApi, useAuth, usePoll, number, when, type Series, type Video } from "../lib";
import { VideoCard, making } from "./video-ui";
import { StyleArt } from "../art";
import { ExampleVideo, useExamples } from "../examples";
import { templates } from "../../shared/templates";

// Home: what needs the owner (videos to review), what posts next, the latest videos and the series at a glance.

type Scheduled = { id: string; videoId: string; title: string; hook: string; platform: string; accountName: string; scheduledAt: number; status: string };
export function Home() {
  const { user } = useAuth();
  const examples = useExamples();
  const videos = useApi<{ videos: Video[]; counts: { making: number; review: number; failed: number; total: number } }>("/videos?limit=12");
  const series = useApi<{ series: Series[] }>("/series");
  const upcoming = useApi<{ publications: Scheduled[] }>(`/publications?from=${Math.floor(Date.now() / 1000)}`);
  usePoll(() => { void videos.reload(); }, 8000, !!videos.data?.videos.some(making));
  const list = videos.data?.videos || [];
  const review = list.filter((v) => v.status === "pending" && v.renderStatus === "ready");
  const next = (upcoming.data?.publications || []).filter((p) => p.status === "scheduled").slice(0, 5);
  const active = (series.data?.series || []).filter((s) => s.status === "active");
  const first = user?.name.split(" ")[0] || "there";
  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Hi, {first}</h1><p>{active.length ? `${active.length} series on autopilot.` : "Make a video, clip a long one, or put a channel on autopilot."}</p></div>
        <div className="toolbar">
          <Link className="btn" to="/app/clips"><Scissors size={18} aria-hidden="true" /> Clip a video</Link>
          <Link className="btn" to="/app/series/new"><Repeat size={18} aria-hidden="true" /> New series</Link>
          <Link className="btn primary" to="/app/create"><PenSquare size={18} aria-hidden="true" /> Create video</Link>
        </div>
      </div>

      {!list.length && !videos.loading && !(series.data?.series.length) && (
        <div className="card glow stack" style={{ gap: 16, marginBottom: 22 }}>
          <div className="row" style={{ gap: 14 }}><Sparkles className="accent-text" aria-hidden="true" /><h2 style={{ fontSize: 22 }}>Let's make your first video</h2></div>
          <p className="muted">Pick a faceless style below. You'll see the script before anything is made, and you can turn it into a series later. Have a podcast or stream? <Link className="text-link" to="/app/clips">Turn it into clips</Link>.</p>
          <div className="choice-grid">
            {(["scary", "facts", "dayinlife", "mashup", "motivation", "storytime"] as const).map((id) => (
              <Link key={id} to={`/app/create?template=${id}`} className="choice" style={{ textDecoration: "none" }}>
                <div className="choice-art">{examples[id] ? <ExampleVideo example={examples[id]} /> : <StyleArt style={templates[id].style} />}</div>
                <strong>{templates[id].name}</strong><small>{templates[id].short}</small>
              </Link>
            ))}
          </div>
        </div>
      )}

      <div className="grid three" style={{ marginBottom: 22 }}>
        <div className="card stat"><span className="muted small">Credits left</span><strong>{user ? number(Math.max(0, user.limit - user.used)) : "–"}</strong><Link className="small text-link" to="/app/billing">{user?.plan === "free" ? "Upgrade" : "Add credits"}</Link></div>
        <div className="card stat"><span className="muted small">Being made</span><strong>{videos.data?.counts.making ?? "–"}</strong><span className="small muted">{videos.data?.counts.failed ? `${videos.data.counts.failed} failed` : "videos in progress"}</span></div>
        <div className="card stat"><span className="muted small">Waiting for review</span><strong>{videos.data?.counts.review ?? "–"}</strong><span className="small muted">approve to post</span></div>
      </div>

      {review.length > 0 && (
        <section className="stack" style={{ marginBottom: 28 }}>
          <div className="row between"><h2 style={{ fontSize: 20 }}>Needs your review</h2></div>
          <div className="video-grid">{review.map((v) => <VideoCard key={v.id} video={v} />)}</div>
        </section>
      )}

      <div className="grid two" style={{ alignItems: "start", marginBottom: 28 }}>
        <section className="card stack">
          <div className="row between"><h2 style={{ fontSize: 18 }}>Up next</h2><Link className="small text-link" to="/app/schedule">Schedule <ArrowRight size={14} aria-hidden="true" /></Link></div>
          {next.length ? next.map((p) => (
            <Link key={p.id} to={`/app/videos/${p.videoId}`} className="row between small" style={{ textDecoration: "none", padding: "6px 0", borderBottom: "1px solid var(--line)" }}>
              <span className="grow truncate" style={{ maxWidth: "none" }}>{p.title || p.hook}</span>
              <span className="muted">{p.accountName} · {when(p.scheduledAt)}</span>
            </Link>
          )) : <p className="muted small">Nothing scheduled. Series schedule their episodes on their own; any video can be posted from its page.</p>}
        </section>
        <section className="card stack">
          <div className="row between"><h2 style={{ fontSize: 18 }}>Series</h2><Link className="small text-link" to="/app/series">All series <ArrowRight size={14} aria-hidden="true" /></Link></div>
          {(series.data?.series || []).slice(0, 5).map((s) => (
            <Link key={s.id} to={`/app/series/${s.id}`} className="row between small" style={{ textDecoration: "none", padding: "6px 0", borderBottom: "1px solid var(--line)" }}>
              <span className="grow truncate" style={{ maxWidth: "none" }}><strong>{s.name}</strong> <span className="muted">· {templates[s.template]?.name}</span></span>
              <span className={s.status === "active" ? "chip green" : "chip"}>{s.status === "active" ? (s.nextSlot ? `next ${when(s.nextSlot)}` : "active") : "paused"}</span>
            </Link>
          ))}
          {!series.data?.series.length && <p className="muted small">No series yet. <Link className="text-link" to="/app/series/new">Start one</Link> and new episodes are made and posted on their own.</p>}
        </section>
      </div>

      {list.length > 0 && (
        <section className="stack">
          <div className="row between"><h2 style={{ fontSize: 20 }}>Latest videos</h2><Link className="small text-link" to="/app/videos">All videos <ArrowRight size={14} aria-hidden="true" /></Link></div>
          <div className="video-grid">{list.slice(0, 8).map((v) => <VideoCard key={v.id} video={v} />)}</div>
        </section>
      )}
    </div>
  );
}
