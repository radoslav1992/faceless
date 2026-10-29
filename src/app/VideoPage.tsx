import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Check, Copy, Download, RotateCcw, Send, Trash2, X } from "lucide-react";
import { del, errorText, fileUrl, newKey, post, put, useApi, useAuth, usePoll, when, type Account, type Publication, type Video } from "../lib";
import { useToast } from "../ui";
import { ConfirmDialog } from "./pickers";
import { VideoEditor } from "./EditVideo";
import { HighlightEditor } from "./clip-editor";
import { MadeForKids, PlatformBadge, PublicationLine, StatusChip, making, phaseText } from "./video-ui";
import { specCredits, visualPart, type HighlightSpec, type Spec, type StorySpec } from "../../shared/formats";
import { creditsLabel } from "../../shared/credits";
import { comingSoon, platforms, postCaption } from "../../shared/social";
import "./create.css";

// One video: watch it, approve or reject it (series episodes in review), post it now or later, download it, and edit
// it — an edit that changes the picture or sound makes it again (only new AI work costs credits; a clip of a long
// video only when it moves to other footage).

/** "2026-10-12T18:00" in the viewer's zone, for datetime-local inputs. */
const local = (at: number) => { const d = new Date(at * 1000); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };

/** A TikTok draft waits in the person's TikTok inbox, without its caption (TikTok's Upload API can't carry it). */
function DraftNote({ video }: { video: Video }) {
  const toast = useToast();
  const caption = postCaption((video.caption || "").trim(), video.hashtags || [], "tiktok").text;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(caption);
      toast("Caption copied. Paste it in TikTok.", "good");
    } catch {
      toast("Couldn't copy the caption. Try again.", "bad");
    }
  };
  return (
    <p className="small muted">
      It's waiting in your TikTok inbox: open TikTok's notification, paste the caption, choose who can see it and post. If it has an AI voice or AI
      pictures, turn on TikTok's “AI-generated content” label.{" "}
      {caption && <button type="button" className="link" onClick={() => void copy()}><Copy size={13} aria-hidden="true" /> Copy caption</button>}
    </p>
  );
}

function PostPanel({ video, onDone }: { video: Video; onDone: () => void }) {
  const toast = useToast();
  const accounts = useApi<{ accounts: Account[]; platforms?: { id: string; soon?: boolean; drafts?: boolean }[] }>("/accounts");
  const [chosen, setChosen] = useState<string[]>([]);
  const [later, setLater] = useState(false);
  const [at, setAt] = useState(() => local(Math.floor(Date.now() / 1000) + 3600));
  const [privately, setPrivately] = useState(false);
  const [kids, setKids] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const usable = (accounts.data?.accounts || []).filter((a) => a.status === "active");
  const tiktokDrafts = !!accounts.data?.platforms?.find((p) => p.id === "tiktok")?.drafts;
  const allSoon = !!accounts.data?.platforms?.length && accounts.data.platforms.every((p) => p.soon);
  const toDrafts = tiktokDrafts && usable.some((a) => a.platform === "tiktok" && chosen.includes(a.id));
  const toYouTube = usable.some((a) => a.platform === "youtube" && chosen.includes(a.id));
  const pubs = (video.publications || []).filter((p) => p.status !== "canceled");
  const send = async () => {
    setBusy(true);
    try {
      await post(`/videos/${video.id}/publish`, {
        accountIds: chosen, private: privately, ...(toYouTube && { madeForKids: kids }), ...(later && { at: Math.floor(new Date(at).getTime() / 1000) }),
      });
      toast(later ? "Scheduled." : "Posting in a minute.", "good");
      setChosen([]);
      onDone();
    } catch (e) {
      toast(errorText(e), "bad");
    } finally {
      setBusy(false);
    }
  };
  const act = async (p: Publication, action: "cancel" | "retry") => {
    try {
      if (action === "cancel") await del(`/publications/${p.id}`);
      else await post(`/publications/${p.id}/retry`);
      onDone();
    } catch (e) { toast(errorText(e), "bad"); }
  };
  return (
    <div className="card stack">
      <h3>Posts</h3>
      {pubs.length ? pubs.map((p) => (
        <div key={p.id} className="stack" style={{ gap: 4 }}>
          <PublicationLine p={p} />
          {p.error && <p className="small error">{p.error}</p>}
          {p.draft && p.status === "published" && !p.url ? <DraftNote video={video} /> : null}
          <div className="row" style={{ gap: 6 }}>
            {p.status === "scheduled" && <button type="button" className="btn sm ghost" onClick={() => act(p, "cancel")}><X size={14} aria-hidden="true" /> Cancel</button>}
            {p.status === "failed" && <button type="button" className="btn sm" onClick={() => act(p, "retry")}><RotateCcw size={14} aria-hidden="true" /> Try again</button>}
          </div>
        </div>
      )) : <p className="muted small">Not posted anywhere yet.</p>}
      <hr style={{ border: 0, borderTop: "1px solid var(--line)", width: "100%" }} />
      {video.renderStatus !== "ready" ? <p className="muted small">You can post it once it's made.</p> : !usable.length ? allSoon ? (
        <p className="muted small">{comingSoon("TikTok, YouTube and Instagram")}</p>
      ) : (
        <p className="muted small">Connect TikTok, YouTube or Instagram to post from here. <Link className="text-link" to="/app/channels">Connect a channel</Link></p>
      ) : (
        <>
          <span className="label">Post to</span>
          <div className="stack" style={{ gap: 6 }}>
            {usable.map((a) => (
              <label key={a.id} className="check">
                <input type="checkbox" checked={chosen.includes(a.id)} onChange={(e) => setChosen(e.target.checked ? [...chosen, a.id] : chosen.filter((x) => x !== a.id))} />
                <PlatformBadge platform={a.platform} /> {a.name}{a.handle ? ` (@${a.handle})` : ""}
              </label>
            ))}
          </div>
          <div className="seg small-seg" role="group" aria-label="When">
            <button type="button" aria-pressed={!later} onClick={() => setLater(false)}>Now</button>
            <button type="button" aria-pressed={later} onClick={() => setLater(true)}>Later</button>
          </div>
          {later && <input type="datetime-local" className="input" value={at} onChange={(e) => setAt(e.target.value)} aria-label="Post at" />}
          {toDrafts && <p className="small muted">TikTok: it goes to your TikTok inbox as a draft, and you post it in the TikTok app.</p>}
          <label className="check"><input type="checkbox" checked={privately} onChange={(e) => setPrivately(e.target.checked)} /> Post privately (only you can see it; not on Instagram{tiktokDrafts ? " or TikTok drafts" : ""})</label>
          {toYouTube && <MadeForKids value={kids} onChange={setKids} />}
          <button type="button" className="btn primary" disabled={busy || !chosen.length || (toYouTube && kids === null)} onClick={send}>{busy ? <span className="spinner" aria-hidden="true" /> : <Send size={16} aria-hidden="true" />} {later ? "Schedule" : "Post"}</button>
        </>
      )}
    </div>
  );
}

export function VideoPage() {
  const { id = "" } = useParams();
  const { user, refresh } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const { data, error, reload, setData } = useApi<{ video: Video }>(`/videos/${id}`);
  const video = data?.video;
  const [spec, setSpec] = useState<Spec | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [key, setKey] = useState(newKey);
  usePoll(() => { void reload(); }, 5000, !!video && making(video));
  // The editor starts from the stored spec, and again whenever a run changed it (a new revision).
  useEffect(() => { if (video?.spec) setSpec(video.spec); }, [video?.revision, video?.renderStatus]); // eslint-disable-line react-hooks/exhaustive-deps
  const changed = !!spec && !!video?.spec && JSON.stringify(spec) !== JSON.stringify(video.spec);
  const rerender = !!spec && !!video?.spec && visualPart(spec) !== visualPart(video.spec);
  // A video never made (its first run failed and was refunded) costs what a new one does, as the server charges.
  const cost = useMemo(() => (spec && video?.spec && rerender
    ? !video.videoAssetId ? specCredits(spec, true) : specCredits(spec, false, undefined, video.spec)
    : 0), [spec, rerender, video?.spec, video?.videoAssetId]);
  const retryCost = video?.spec ? (!video.videoAssetId ? specCredits(video.spec, true) : specCredits(video.spec, false, undefined, video.spec)) : 0;
  const clip = spec?.format === "highlight";
  if (error) return <div className="page"><p className="notice bad">{error}</p></div>;
  if (!video || !spec) return <div className="loading-page" role="status">Loading…</div>;
  const save = async () => {
    setSaving(true);
    try {
      const r = await put<{ video: Video; rendering: boolean }>(`/videos/${video.id}`, { spec, idempotencyKey: key });
      setKey(newKey());
      setData({ video: r.video });
      toast(r.rendering ? "Saved. The video is being made again." : "Saved.", "good");
      await refresh();
    } catch (e) {
      toast(errorText(e), "bad");
    } finally {
      setSaving(false);
    }
  };
  const review = async (decision: "approve" | "reject") => {
    try {
      const r = await post<{ scheduled: number }>(`/videos/${video.id}/review`, { decision });
      toast(decision === "approve" ? (r.scheduled ? "Approved and scheduled." : "Approved.") : "Rejected.", "good");
      await reload();
    } catch (e) { toast(errorText(e), "bad"); }
  };
  const retry = async () => {
    try {
      await post(`/videos/${video.id}/render`, { idempotencyKey: newKey() });
      await reload();
      await refresh();
    } catch (e) { toast(errorText(e), "bad"); }
  };
  return (
    <div className="page create">
      <div className="page-head">
        <div>
          {video.spec?.format === "highlight"
            ? <Link className="link" to={`/app/clips/${video.spec.source.assetId}`}><ArrowLeft size={15} aria-hidden="true" /> Clips</Link>
            : <Link className="link" to={video.seriesId ? `/app/series/${video.seriesId}` : "/app/videos"}><ArrowLeft size={15} aria-hidden="true" /> {video.seriesName || "Videos"}</Link>}
          <h1 style={{ marginTop: 8 }}>{video.title || video.hook || "Untitled video"}</h1>
          <p className="row wrap" style={{ gap: 8 }}><StatusChip video={video} />{video.slotAt && <span className="small muted">for the slot of {when(video.slotAt)}</span>}</p>
        </div>
        <div className="toolbar">
          {video.status === "pending" && video.renderStatus === "ready" && (
            <>
              <button type="button" className="btn" onClick={() => review("reject")}><X size={16} aria-hidden="true" /> Reject</button>
              <button type="button" className="btn primary" onClick={() => review("approve")}><Check size={16} aria-hidden="true" /> Approve</button>
            </>
          )}
          {video.videoAssetId && video.renderStatus === "ready" && <a className="btn" href={`${fileUrl(video.videoAssetId)}?download=1`}><Download size={16} aria-hidden="true" /> Download</a>}
          <button type="button" className="btn ghost danger" onClick={() => setConfirm(true)} aria-label="Delete video"><Trash2 size={16} aria-hidden="true" /></button>
        </div>
      </div>

      <div className="video-top">
        <div className="phone-frame">
          {video.renderStatus === "ready" && video.videoAssetId
            ? <video src={fileUrl(video.videoAssetId)} poster={fileUrl(video.coverAssetId)} controls playsInline />
            : <div className="making-big">
              {making(video) ? <><span className="spinner big" aria-hidden="true" /><strong>{phaseText(video)}…</strong><span className="small muted">Usually a few minutes. You can leave this page.</span></>
                : <><strong>This video couldn't be made</strong><span className="small muted">{video.renderError}</span><button type="button" className="btn primary" onClick={retry}><RotateCcw size={16} aria-hidden="true" /> Try again{retryCost ? ` · ${creditsLabel(retryCost)}` : " · free"}</button></>}
            </div>}
        </div>
        <PostPanel video={video} onDone={() => void reload()} />
      </div>

      <section className="stack" style={{ marginTop: 32 }}>
        <div className="row between wrap">
          <div><h2 style={{ fontSize: 22 }}>Edit</h2><p className="muted small">{making(video) ? "You can edit once it's made." : clip ? "Trim the moment, change the layout, captions, title or music." : "Change the words, pictures, voice, title, subtitles, music or sound effects."}</p></div>
          <div className="toolbar">
            {changed && <button type="button" className="btn ghost" onClick={() => setSpec(video.spec!)}>Undo changes</button>}
            <button type="button" className="btn primary" disabled={!changed || saving || making(video)} onClick={save}>
              {saving ? <span className="spinner" aria-hidden="true" /> : null}{rerender ? `Save and make again${cost ? ` · ${creditsLabel(cost)}` : " · free"}` : "Save"}
            </button>
          </div>
        </div>
        {!making(video) && (spec.format === "highlight"
          ? <HighlightEditor spec={spec} onChange={(next: HighlightSpec) => setSpec(next)} />
          : <VideoEditor spec={spec} onChange={(next: StorySpec) => setSpec(next)} initial={false} renderedSeconds={video.duration || undefined} creditsLeft={user ? Math.max(0, user.limit - user.used) : null} />)}
      </section>
      {confirm && (
        <ConfirmDialog title="Delete this video?" onClose={() => setConfirm(false)} onConfirm={async () => { await del(`/videos/${video.id}`); navigate("/app/videos"); }}>
          <p>The video and its files are deleted. Posts already published stay on {Object.values(platforms).map((p) => p.name).join(", ")}; scheduled ones are canceled.</p>
        </ConfirmDialog>
      )}
    </div>
  );
}
