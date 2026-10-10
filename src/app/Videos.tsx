import { useState } from "react";
import { Link } from "react-router-dom";
import { Clapperboard, PenSquare } from "lucide-react";
import { useApi, usePoll, type Video } from "../lib";
import { VideoCard, making } from "./video-ui";

// Every video: made by hand or by a series, with its state; filters for what is being made, waiting or failed.

const views = [
  { id: "all", name: "All" },
  { id: "making", name: "Being made" },
  { id: "review", name: "To review" },
  { id: "ready", name: "Ready" },
  { id: "failed", name: "Failed" },
] as const;
export function VideosPage() {
  const [view, setView] = useState<(typeof views)[number]["id"]>("all");
  const { data, loading, reload } = useApi<{ videos: Video[]; counts: { making: number; review: number; failed: number; total: number } }>(`/videos?view=${view}&limit=100`);
  usePoll(() => { void reload(); }, 8000, !!data?.videos.some(making));
  const counts = data?.counts;
  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Videos</h1><p>{counts ? `${counts.total} video${counts.total === 1 ? "" : "s"}${counts.making ? ` · ${counts.making} being made` : ""}` : "Your videos"}</p></div>
        <Link className="btn primary" to="/app/create"><PenSquare size={18} aria-hidden="true" /> Create video</Link>
      </div>
      <div className="filters" role="group" aria-label="Show" style={{ marginBottom: 20 }}>
        {views.map((v) => {
          const n = v.id === "making" ? counts?.making : v.id === "review" ? counts?.review : v.id === "failed" ? counts?.failed : undefined;
          return <button key={v.id} type="button" className="filter" aria-pressed={view === v.id} onClick={() => setView(v.id)}>{v.name}{!!n && <span className="count">{n}</span>}</button>;
        })}
      </div>
      {loading && !data ? <div className="loading-page" role="status">Loading…</div> : data?.videos.length ? (
        <div className="video-grid">{data.videos.map((v) => <VideoCard key={v.id} video={v} />)}</div>
      ) : (
        <div className="empty card"><Clapperboard size={34} aria-hidden="true" /><p>{view === "all" ? "No videos yet." : "Nothing here."}</p>{view === "all" && <Link className="btn primary" to="/app/create">Make your first video</Link>}</div>
      )}
    </div>
  );
}
