import { Link } from "react-router-dom";
import { AlertTriangle, CheckCircle2, Clock, Eye, Film } from "lucide-react";
import { fileUrl, number, seconds, when, type Publication, type Video } from "../lib";
import { platforms, type PlatformId } from "../../shared/social";

// Small pieces every list of videos shares: where a video is in its making, its card, its posts.

const phases: Record<string, string> = {
  images: "Drawing the pictures", clip: "Animating a scene", voice: "Recording the voice", presenter: "Filming the presenter", tracking: "Finding the speaker", rendering: "Rendering the video", saving: "Saving",
};
/** What a video being made is doing right now. */
export const phaseText = (v: Pick<Video, "phase" | "renderStatus">) => (v.renderStatus === "queued" ? "Waiting to start" : phases[v.phase || ""] || "Getting started");
export const making = (v: Pick<Video, "renderStatus">) => v.renderStatus === "queued" || v.renderStatus === "running";

/** The video's state in one chip: making, failed, waiting for review, scheduled, posted or ready. */
export function StatusChip({ video }: { video: Video }) {
  if (making(video)) return <span className="chip orange"><Clock size={12} aria-hidden="true" /> Making</span>;
  if (video.renderStatus === "failed") return <span className="chip red"><AlertTriangle size={12} aria-hidden="true" /> Failed</span>;
  if (video.status === "pending") return <span className="chip orange"><Eye size={12} aria-hidden="true" /> Review</span>;
  if (video.status === "rejected") return <span className="chip">Rejected</span>;
  const pubs = video.publications || [];
  if (pubs.some((p) => p.status === "published")) return <span className="chip green"><CheckCircle2 size={12} aria-hidden="true" /> Posted</span>;
  if (pubs.some((p) => p.status === "scheduled" || p.status === "publishing")) return <span className="chip violet"><Clock size={12} aria-hidden="true" /> Scheduled</span>;
  if (pubs.some((p) => p.status === "failed")) return <span className="chip red">Post failed</span>;
  return <span className="chip green">Ready</span>;
}
export function PlatformBadge({ platform }: { platform: PlatformId }) {
  return <span className="platform-dot" style={{ background: platforms[platform].color }} title={platforms[platform].name} aria-label={platforms[platform].name}>{platforms[platform].name[0]}</span>;
}
/** One line per post of a video: where, when, how it went. */
export function PublicationLine({ p }: { p: Publication }) {
  const label = p.status === "published" ? "Posted" : p.status === "scheduled" ? "Posts" : p.status === "publishing" ? "Posting now" : p.status === "failed" ? "Failed" : "Canceled";
  return (
    <div className="row small" style={{ gap: 8 }}>
      <PlatformBadge platform={p.platform} />
      <span className="grow truncate" style={{ maxWidth: "none" }}>{p.accountName}{p.private ? " · private" : ""}</span>
      <span className={p.status === "failed" ? "error" : "muted"}>{label} {p.status !== "failed" && when(p.scheduledAt)}</span>
      {p.url && <a className="text-link" href={p.url} target="_blank" rel="noreferrer">Open</a>}
      {p.views !== null && <span className="muted">{number(p.views)} views</span>}
    </div>
  );
}

export function VideoCard({ video, sub }: { video: Video; sub?: string }) {
  return (
    <Link to={`/app/videos/${video.id}`} className="video-card">
      <div className="cover">
        {video.coverAssetId && !making(video) ? <img src={fileUrl(video.coverAssetId)} alt="" loading="lazy" /> : (
          <div className="making">{making(video) ? <div><span className="spinner" aria-hidden="true" /><div>{phaseText(video)}…</div></div> : video.renderStatus === "failed" ? <div><AlertTriangle size={22} aria-hidden="true" /><div>Couldn't be made</div></div> : <Film size={26} aria-hidden="true" />}</div>
        )}
        <StatusChip video={video} />
        {video.duration > 0 && <span className="length">{seconds(video.duration)}</span>}
      </div>
      <strong>{video.title || video.hook || "Untitled video"}</strong>
      <small>{sub ?? (video.seriesName ? `${video.seriesName}${video.slotAt ? ` · ${when(video.slotAt)}` : ""}` : when(video.createdAt))}</small>
    </Link>
  );
}
