import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { CalendarClock, ChevronLeft, ChevronRight, Film, Repeat } from "lucide-react";
import { fileUrl, useApi, usePoll, type Publication, type Series } from "../lib";
import { Spinner } from "../ui";
import { PlatformBadge } from "./video-ui";
import { slots } from "../../shared/schedule";

// Schedule: two weeks at a time, day by day — what was posted, what is scheduled, and the slots of active series
// whose episode is not made yet.

type Row = Publication & { videoId: string; title: string | null; hook: string | null; seriesId: string | null; coverAsset: string | null; renderStatus: string };
type Item =
  | { kind: "post"; at: number; row: Row }
  | { kind: "slot"; at: number; series: Series };
const DAY = 86400, SPAN = 14;
const startOfDay = (at: number) => { const d = new Date(at * 1000); d.setHours(0, 0, 0, 0); return Math.floor(d.getTime() / 1000); };
const dayKey = (at: number) => new Date(at * 1000).toDateString();
const dayName = (at: number) => {
  const today = startOfDay(Date.now() / 1000), day = startOfDay(at);
  const label = new Date(at * 1000).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
  return day === today ? `Today · ${label}` : day === today + DAY ? `Tomorrow · ${label}` : label;
};
const time = (at: number) => new Date(at * 1000).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
const statusText: Record<Publication["status"], string> = { scheduled: "Scheduled", publishing: "Posting", published: "Posted", failed: "Failed", canceled: "Canceled" };
const statusChip: Record<Publication["status"], string> = { scheduled: "violet", publishing: "orange", published: "green", failed: "red", canceled: "" };

export function SchedulePage() {
  const [from, setFrom] = useState(() => startOfDay(Date.now() / 1000) - DAY);
  const to = from + SPAN * DAY;
  const { data, loading, reload } = useApi<{ publications: Row[] }>(`/publications?from=${from}&to=${to}`);
  const series = useApi<{ series: Series[] }>("/series");
  usePoll(() => { void reload(); }, 30000);
  const days = useMemo(() => {
    const items: Item[] = (data?.publications || []).map((row) => ({ kind: "post", at: row.scheduledAt, row }));
    // A series slot shows until its episode is scheduled (then the post stands for it).
    const taken = new Set((data?.publications || []).filter((p) => p.seriesId).map((p) => `${p.seriesId}:${p.scheduledAt}`));
    const t = Date.now() / 1000;
    for (const s of series.data?.series || []) {
      if (s.status !== "active") continue;
      for (const at of slots(s.settings.schedule, Math.max(from, t), SPAN + 1)) {
        if (at < to && !taken.has(`${s.id}:${at}`)) items.push({ kind: "slot", at, series: s });
      }
    }
    items.sort((a, b) => a.at - b.at);
    const grouped = new Map<string, Item[]>();
    for (const item of items) grouped.set(dayKey(item.at), [...(grouped.get(dayKey(item.at)) || []), item]);
    return [...grouped.values()];
  }, [data, series.data, from, to]);
  const range = `${new Date(from * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" })} – ${new Date((to - 1) * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
  return (
    <main className="page">
      <div className="page-head">
        <div><h1>Schedule</h1><p>What posts when, across your series and channels.</p></div>
        <div className="toolbar">
          <button type="button" className="btn icon" onClick={() => setFrom(from - SPAN * DAY)} aria-label="Earlier"><ChevronLeft size={18} /></button>
          <span className="small" style={{ minWidth: 120, textAlign: "center" }} aria-live="polite">{range}</span>
          <button type="button" className="btn icon" onClick={() => setFrom(from + SPAN * DAY)} aria-label="Later"><ChevronRight size={18} /></button>
          <button type="button" className="btn sm ghost" onClick={() => setFrom(startOfDay(Date.now() / 1000) - DAY)}>Today</button>
        </div>
      </div>
      {loading && !data ? <div className="loading-page"><Spinner big label="Loading the schedule" /></div> : days.length ? (
        <div className="stack" style={{ gap: 22 }}>
          {days.map((items) => (
            <section key={dayKey(items[0].at)} className="stack" style={{ gap: 8 }} aria-label={dayName(items[0].at)}>
              <h2 style={{ fontSize: 16 }}>{dayName(items[0].at)}</h2>
              <div className="slot-list">
                {items.map((item) => item.kind === "post" ? (
                  <Link key={item.row.id} to={`/app/videos/${item.row.videoId}`} className="slot schedule-item">
                    <div className="slot-cover">{item.row.coverAsset ? <img src={fileUrl(item.row.coverAsset)} alt="" loading="lazy" /> : <Film size={18} aria-hidden="true" />}</div>
                    <div style={{ minWidth: 0 }}>
                      <strong>{item.row.title || item.row.hook || "Untitled video"}</strong>
                      <small className="row" style={{ gap: 6 }}><PlatformBadge platform={item.row.platform} /> {time(item.at)} · {item.row.accountName}{item.row.private ? " · private" : ""}</small>
                      {item.row.status === "failed" && item.row.error && <small className="error">{item.row.error}</small>}
                    </div>
                    <span className={`chip ${statusChip[item.row.status]}`}>{item.row.status === "scheduled" && item.row.renderStatus !== "ready" ? "Being made" : item.row.status === "published" && item.row.draft ? "Sent to drafts" : statusText[item.row.status]}</span>
                  </Link>
                ) : (
                  <Link key={`${item.series.id}-${item.at}`} to={`/app/series/${item.series.id}`} className="slot schedule-item planned">
                    <div className="slot-cover"><CalendarClock size={18} aria-hidden="true" /></div>
                    <div style={{ minWidth: 0 }}>
                      <strong>{item.series.name}</strong>
                      <small>{time(item.at)} · next episode, made a few hours before</small>
                    </div>
                    <span className="chip"><Repeat size={12} aria-hidden="true" /> Planned</span>
                  </Link>
                ))}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div className="card glow empty">
          <CalendarClock size={34} className="accent-text" aria-hidden="true" />
          <h2 style={{ fontSize: 22 }}>Nothing scheduled in these two weeks</h2>
          <p>Start a series to post on a schedule, or post any video from its page.</p>
          <Link className="btn primary" to="/app/series/new">Start a series</Link>
        </div>
      )}
    </main>
  );
}
