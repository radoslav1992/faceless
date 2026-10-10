import { useEffect, useState } from "react";
import { useApi, type LibraryItem } from "../lib";
import { LibraryPicker } from "./pickers";
import { StoryEditor } from "./StoryEditor";
import { useUploadTiming } from "./story-model";
import type { StorySpec } from "../../shared/formats";
import "./create.css";

// The editor of a draft or a made video: the timeline editor (StoryEditor) with its music and background clip from the
// shared library, and the post's text (title, description, hashtags).

export function VideoEditor({ spec, onChange, initial, renderedSeconds, creditsLeft }: {
  spec: StorySpec; onChange: (spec: StorySpec) => void; initial: boolean; renderedSeconds?: number; creditsLeft: number | null;
}) {
  const music = useApi<{ items: LibraryItem[] }>("/library?kind=music");
  const clips = useApi<{ items: LibraryItem[] }>(spec.backdrop ? "/library?kind=clip" : null);
  const [picker, setPicker] = useState<null | "music" | "clip">(null);
  const upload = useUploadTiming(spec.narration.kind === "upload" ? spec.narration.assetId : undefined, spec.narration.kind === "upload" ? spec.narration.script : "");
  const track = spec.music?.trackId ? music.data?.items.find((i) => i.id === spec.music!.trackId) : null;
  const clip = spec.backdrop?.libraryId ? clips.data?.items.find((i) => i.id === spec.backdrop!.libraryId) : null;
  const [tags, setTags] = useState(spec.hashtags.join(" "));
  useEffect(() => setTags(spec.hashtags.join(" ")), [spec.hashtags]);
  return (
    <div className="stack" style={{ gap: 18 }}>
      <StoryEditor spec={spec} onChange={onChange} initial={initial} upload={upload.timing} renderedSeconds={renderedSeconds} creditsLeft={creditsLeft}
        music={track?.name ?? (spec.music ? "Your track" : null)} onMusic={() => setPicker("music")}
        backdrop={clip ? { name: clip.name, url: clip.url, duration: clip.duration } : null} onBackdrop={() => setPicker("clip")} />
      {!spec.music && (
        <div className="row wrap" style={{ gap: 10 }}>
          <span className="small muted">No background music.</span>
          <button type="button" className="btn sm" onClick={() => setPicker("music")}>Add music</button>
        </div>
      )}
      <div className="card flat stack">
        <h3>Post text</h3>
        <label className="field"><span className="small">Title <span className="muted">(YouTube title and the video's name)</span></span>
          <input className="input" maxLength={100} value={spec.title} onChange={(e) => onChange({ ...spec, title: e.target.value })} />
        </label>
        <label className="field"><span className="small">Description</span>
          <textarea className="textarea" rows={3} maxLength={2200} value={spec.caption} onChange={(e) => onChange({ ...spec, caption: e.target.value })} />
        </label>
        <label className="field"><span className="small">Hashtags <span className="muted">(separated by spaces)</span></span>
          <input className="input" value={tags} onChange={(e) => setTags(e.target.value)}
            onBlur={() => onChange({ ...spec, hashtags: tags.split(/[\s,]+/).map((t) => t.replace(/[^\p{L}\p{N}_#]/gu, "")).filter((t) => /^#?[\p{L}\p{N}_]{1,60}$/u.test(t)).map((t) => (t.startsWith("#") ? t : `#${t}`)).slice(0, 15) })} />
        </label>
      </div>
      {picker === "music" && <LibraryPicker kind="music" onClose={() => setPicker(null)}
        onPick={(i) => { onChange({ ...spec, music: { trackId: i.id, volume: spec.music?.volume ?? 0.25 } }); setPicker(null); }} />}
      {picker === "clip" && <LibraryPicker kind="clip" title="Choose a background clip" onClose={() => setPicker(null)}
        onPick={(i) => { onChange({ ...spec, backdrop: { libraryId: i.id } }); void clips.reload(); setPicker(null); }} />}
    </div>
  );
}
