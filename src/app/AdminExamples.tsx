import { useState } from "react";
import { Link } from "react-router-dom";
import { Film, Trash2 } from "lucide-react";
import { Spinner, useToast } from "../ui";
import { del, errorText, put, useApi } from "../lib";
import { StyleArt } from "../art";
import { ExampleVideo, reloadExamples, type Example } from "../examples";
import { Empty } from "./pickers";
import { kindInfo, templateIds, templates, type TemplateId, type VideoKind } from "../../shared/templates";

// Admin → Examples (server/examples.ts): one of the administrator's finished videos for each faceless style, played on
// the style's card in Create, on the home page and on its tool page. A style without one shows its drawing.

type AdminExample = Example & { template: string; sourceVideoId: string | null; createdAt: number };
type OwnVideo = { id: string; kind: string; title: string; duration: number; createdAt: number; url: string; cover: string | null };

const kindName = (kind: string) => (kind in kindInfo ? kindInfo[kind as VideoKind].name : kind === "highlight" ? "Clip" : kind);

export function ExamplesTab() {
  const toast = useToast();
  const { data, loading, error, reload } = useApi<{ examples: AdminExample[]; videos: OwnVideo[] }>("/admin/examples");
  const [busy, setBusy] = useState<string | null>(null);
  if (loading) return <Spinner />;
  if (error || !data) return <p className="error">{error}</p>;
  const byTemplate = new Map(data.examples.map((e) => [e.template, e]));
  const change = async (id: TemplateId, videoId: string | null) => {
    setBusy(id);
    try {
      if (videoId) await put(`/admin/examples/${id}`, { videoId });
      else await del(`/admin/examples/${id}`);
      reloadExamples();
      await reload();
      toast(videoId ? `${templates[id].name} has a new example.` : `${templates[id].name} shows its drawing again.`, "good");
    } catch (e) {
      toast(errorText(e), "bad");
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="stack" style={{ gap: 18 }}>
      <p className="muted" style={{ margin: 0 }}>
        Choose one of your finished videos for each style. Its card in Create, on the home page and on its tool page plays it; the home page shows real
        examples once three styles have one. To make one, <Link className="text-link" to="/app/create">create a video</Link> in that style.
      </p>
      {!data.videos.length && <Empty icon={<Film />} title="No finished videos yet">Make a video in a style, then choose it here as that style's example.</Empty>}
      <div className="example-grid">
        {templateIds.map((id) => {
          const t = templates[id], example = byTemplate.get(id);
          // Videos of the style's own type first.
          const videos = [...data.videos].sort((a, b) => Number(b.kind === t.kind) - Number(a.kind === t.kind));
          return (
            <div key={id} className="example-card">
              {example ? (
                <a className="art" href={example.video} target="_blank" rel="noreferrer" aria-label={`Open the example of ${t.name}`}>
                  <ExampleVideo example={example} />
                </a>
              ) : (
                <div className="art"><StyleArt style={t.style} /><span className="chip">Drawing</span></div>
              )}
              <strong>{t.name}</strong>
              <small className="muted">{kindInfo[t.kind].name}</small>
              <label className="field">
                <span className="sr-only">Example for {t.name}</span>
                <select className="select" value="" disabled={busy !== null || !videos.length} onChange={(e) => e.target.value && change(id, e.target.value)}>
                  <option value="">{example ? "Replace with…" : "Choose a video…"}</option>
                  {videos.map((v) => (
                    <option key={v.id} value={v.id}>{v.title.slice(0, 60)} · {kindName(v.kind)} · {Math.round(v.duration)} s{v.id === example?.sourceVideoId ? " (current)" : ""}</option>
                  ))}
                </select>
              </label>
              {busy === id ? <span className="row muted small"><Spinner /> Copying…</span> : example && (
                <button type="button" className="btn sm ghost danger" disabled={busy !== null} onClick={() => change(id, null)}><Trash2 size={14} aria-hidden="true" /> Remove</button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
