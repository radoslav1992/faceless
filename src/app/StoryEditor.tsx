import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Film, Image as ImageIcon, Library, Merge, RefreshCw, Scissors, Sparkles, Star, Trash2, Type, Wand2 } from "lucide-react";
import { api, fileUrl, useAvatars, useVoices, type Asset, type LibraryItem } from "../lib";
import { Switch } from "../ui";
import { CaptionStylePicker, EditorSection } from "./CaptionPickers";
import { LibraryPicker, MediaPicker, PlayButton, useOfferedVoice, usePreviewAudio, VoiceSelect } from "./pickers";
import { StoryPreview, type ScenePicture } from "./StoryPreview";
import { StoryTimeline } from "./StoryTimeline";
import { StoryStylePicker } from "./StoryStyles";
import { PresenterSection } from "./presenter-ui";
import {
  clockText, mergeScenes, moveEdge, segmentsOf, splitScene, toggleKey, useStoryClock, useStoryPlayer, type UploadTiming,
} from "./story-model";
import { narrationCurrent, pendingMedia, presenterCurrent, presenterNeeded, showsPresenter, specCredits, spokenSeconds, type StorySpec } from "../../shared/formats";
import { presenterLayoutInfo, presenterQualityInfo } from "../../shared/presenter";
import {
  clipFor, normWord, storyLengths, storyScript, storyStyles, storyTransitions, textWords, transitionInfo, STORY_MAX_CHARS, STORY_MAX_SCENES, STORY_MAX_SECONDS,
  type SceneSource, type StoryScene, type StoryStyle, type StoryTransition,
} from "../../shared/story";
import { styledCaptions } from "../../shared/captions";
import { overlayItems } from "../../shared/overlay";
import { FRAME } from "../../shared/render";
import {
  CLIP_CREDITS, CLIP_SECONDS, PICTURES_PER_CREDIT, clipCredits, clipQualities, creditsLabel, pictureCredits, presenterCredits, speechSeconds, videoCredits, voiceCredits, type ClipQuality,
} from "../../shared/credits";
import { headlineFor } from "../../shared/headline";
import "./story.css";

// The video editor: the preview and the selected scene, the timeline of the whole voice, the on-screen title, the
// presenter, the subtitles, the background clip, the music, and the plan with its exact price. Nothing is paid until
// the video is made: then its run makes what is still missing (the voice, AI pictures, AI clips, the presenter),
// refunded if it fails.

type Known = { url: string; kind: "image" | "video"; duration: number; name: string };
/** What the editor knows of a library clip or picture. */
const libraryKnown = (i: LibraryItem): Known => ({ url: i.url, kind: i.kind === "image" ? "image" : "video", duration: i.duration, name: i.name });
const sourceNames: Record<SceneSource, string> = { image: "AI picture", clip: "AI clip", own: "My media", library: "Library" };
const clipQualityNames: Record<ClipQuality, string> = { regular: "Regular", high: "High" };
const sourceIcons: Record<SceneSource, typeof ImageIcon> = { image: ImageIcon, clip: Film, own: Sparkles, library: Library };
const transitionName = (t: StoryTransition) => (t === "auto" ? "Auto (varied)" : t === "cut" ? "Cut" : transitionInfo[t].name);

/** The editor's state of a narrated video: its clock, its pictures and what the preview plays. */
function useStoryMedia(spec: StorySpec) {
  const [known, setKnown] = useState<Record<string, Known>>({});
  const asked = useRef(new Set<string>());
  const remember = useCallback((id: string, k: Known) => setKnown((m) => ({ ...m, [id]: k })), []);
  // Own files and library clips and pictures in the scenes: what they are and where to show them.
  useEffect(() => {
    for (const s of spec.scenes) {
      if (s.source !== "own" || !s.assetId || asked.current.has(s.assetId)) continue;
      asked.current.add(s.assetId);
      const id = s.assetId;
      void api<{ asset: Asset }>(`/media/${id}`).then(({ asset }) => remember(id, { url: asset.url, kind: asset.mime.startsWith("video/") ? "video" : "image", duration: asset.duration, name: asset.name })).catch(() => {});
    }
    const items = [...new Set(spec.scenes.map((s) => (s.source === "library" ? s.libraryId : undefined)).filter((id): id is string => !!id && !asked.current.has(id)))];
    if (items.length) {
      items.forEach((id) => asked.current.add(id));
      void api<{ items: LibraryItem[] }>(`/library?ids=${items.join(",")}`).then(({ items }) => items.forEach((i) => remember(i.id, libraryKnown(i)))).catch(() => {});
    }
  }, [spec.scenes, remember]);
  const picture = useCallback((s: StoryScene, seconds: number): ScenePicture => {
    // An AI clip starts from its picture: shown until the clip's frames are there.
    if (s.source === "clip" && s.clipId) return { url: fileUrl(s.clipId), kind: "video", ...(s.imageId && { poster: fileUrl(s.imageId) }) };
    if ((s.source === "image" || s.source === "clip") && s.imageId) return { url: fileUrl(s.imageId), kind: "image" };
    if (s.source === "own" && s.assetId && known[s.assetId]) return { url: known[s.assetId].url, kind: known[s.assetId].kind, loop: known[s.assetId].duration < seconds - 1 };
    if (s.source === "library" && s.libraryId && known[s.libraryId]) {
      const k = known[s.libraryId];
      return k.kind === "image" ? { url: k.url, kind: "image" } : { url: k.url, kind: "video", loop: k.duration < seconds - 1 };
    }
    return { pending: s.source === "own" || s.source === "library" ? `Choose ${s.source === "own" ? "your picture or video" : "a library clip or picture"}` : s.description, label: sourceNames[s.source] };
  }, [known]);
  return { known, remember, picture };
}

export function StoryEditor({ spec, onChange, initial, upload, renderedSeconds, creditsLeft, music, onMusic, backdrop, onBackdrop }: {
  spec: StorySpec; onChange: (spec: StorySpec) => void;
  /** A new video (priced by its length) rather than an edit of a made one (priced by what it makes again). */
  initial: boolean;
  /** The words of an owner's recording. */
  upload: UploadTiming | null;
  /** The made video's length (the voice's), when it was rendered. */
  renderedSeconds?: number;
  creditsLeft: number | null;
  /** The name of the music track, if any; `onMusic` opens the music picker. */
  music: string | null; onMusic: () => void;
  /** The background clip (a library clip), if any: its name and where it plays; `onBackdrop` opens the clip picker. */
  backdrop: { name: string; url: string; duration: number } | null; onBackdrop: () => void;
}) {
  const clock = useStoryClock(spec, upload, renderedSeconds);
  const segments = useMemo(() => segmentsOf(spec, clock.timing), [spec, clock.timing]);
  const player = useStoryPlayer(clock.duration);
  const media = useStoryMedia(spec);
  const [selected, setSelected] = useState(0);
  const [picker, setPicker] = useState<null | "image" | "video" | "library">(null);
  const audio = usePreviewAudio();
  const scene = spec.scenes[Math.min(selected, spec.scenes.length - 1)];
  const timed = clock.timing.scenes;
  const { byId: avatarById } = useAvatars();
  const avatar = spec.presenter ? avatarById(spec.presenter.avatarId) : undefined;
  // The presenter's scenes play its video at the voice's time (made for these words), else show the avatar.
  const presenterPicture = useMemo((): ScenePicture | null => {
    if (!spec.presenter) return null;
    if (presenterCurrent(spec)) return { url: fileUrl(spec.presented!.assetId), kind: "video", synced: true };
    return avatar?.preview ? { url: avatar.preview, kind: "image" } : { pending: `${avatar?.name ?? "The presenter"} speaks this scene`, label: "Presenter" };
  }, [spec, avatar]);
  const pictures = useMemo(() => spec.scenes.map((s, i): ScenePicture => (spec.backdrop && backdrop
    ? { url: backdrop.url, kind: "video" as const, loop: true }
    : presenterPicture && showsPresenter(spec, i) ? presenterPicture : media.picture(s, timed[i].end - timed[i].start))), [spec, backdrop, media, timed, presenterPicture]);
  // An AI clip's still is the picture it was made from; the presenter's is the avatar.
  const thumbs = useMemo(() => spec.scenes.map((s, i) => (showsPresenter(spec, i) ? avatar?.preview ?? null
    : s.imageId && (s.source === "image" || s.source === "clip") ? fileUrl(s.imageId) : "url" in pictures[i] && pictures[i].kind === "image" ? (pictures[i] as { url: string }).url : null)), [spec, pictures, avatar]);
  const audioUrl = spec.narration.kind === "upload" ? fileUrl(spec.narration.assetId) : narrationCurrent(spec) ? fileUrl(spec.generated!.voiceAssetId) : null;
  const realWords = clock.source !== "recording" || clock.said.length > 0;
  const captions = useMemo(() => (spec.captions.enabled && realWords && clock.timing.words.length ? styledCaptions(clock.timing.words, spec.captions.style) : null),
    [spec.captions, realWords, clock.timing.words]);
  const headline = useMemo(() => {
    if (!spec.headline?.text.trim()) return null;
    const until = spec.headline.seconds > 0 ? Math.min(clock.duration, spec.headline.seconds) : clock.duration;
    return { items: overlayItems(spec.headline.text, spec.headline.look, FRAME.width, FRAME.height, { start: 0, end: until }), until };
  }, [spec.headline, clock.duration]);
  const setScenes = (scenes: StoryScene[]) => onChange({ ...spec, scenes });
  const setScene = (patch: Partial<StoryScene>) => setScenes(spec.scenes.map((s, i) => (i === selected ? { ...s, ...patch } as StoryScene : s)));
  // A picture's source is chosen scene by scene; this turns every AI picture into an AI clip at once, each as long as
  // its scene needs (5 or 10 s), made from its picture.
  const pictureScenes = spec.backdrop ? [] : spec.scenes.flatMap((s, i) => (s.source === "image" ? [{ i, seconds: clipFor(timed[i].end - timed[i].start) }] : []));
  const allClips = {
    count: pictureScenes.length,
    credits: (quality: ClipQuality) => clipCredits(pictureScenes.map((p) => ({ seconds: p.seconds, quality }))),
    apply: (quality: ClipQuality) => setScenes(spec.scenes.map((s, i) => {
      const p = pictureScenes.find((x) => x.i === i);
      return p ? { ...s, source: "clip", clipSeconds: p.seconds, clipQuality: quality } as StoryScene : s;
    })),
  };
  const { byId } = useVoices();
  const voiceName = spec.narration.kind === "voice" ? byId((spec.narration as { voiceId: string }).voiceId)?.name || "AI voice" : "Your recording";
  const voiceLabel = spec.narration.kind === "upload" ? `Your recording · ${clockText(clock.duration)}` : `AI voice · ${voiceName}${clock.source === "estimate" ? " · made with the video" : ""}`;
  const long = clock.duration > STORY_MAX_SECONDS;
  return (
    <div className="story-editor">
      <div className="preview-grid story-grid">
        <div className="preview-phone">
          <StoryPreview segments={segments} scenes={timed} pictures={pictures} captions={captions} headline={headline} player={player} audioUrl={audioUrl}
            label={`Preview of the narrated video, ${spec.scenes.length} scenes, ${clockText(clock.duration)}`} />
          <p className="muted small story-note">{clock.source === "estimate"
            ? "Until the voice is made, the preview times the words from the script."
            : clock.source === "recording" && !clock.said.length ? "No word timings yet: scenes are spread over the recording and no subtitles are shown." : "The preview plays the voice with the scenes, transitions and subtitles in sync."}</p>
        </div>
        <SceneInspector spec={spec} index={selected} scene={scene} seconds={timed[selected] ? timed[selected].end - timed[selected].start : 0}
          known={media.known} onChange={setScene} pick={setPicker} initial={initial} allClips={allClips} presenter={avatar?.name ?? "The presenter"}
          onSplit={(at) => setScenes(splitScene(spec.scenes, selected, at))}
          onMerge={() => setScenes(mergeScenes(spec.scenes, selected))}
          onDelete={() => { setScenes(spec.scenes.filter((_, i) => i !== selected)); setSelected(Math.max(0, selected - 1)); }} />
      </div>
      <StoryTimeline timing={clock.timing} segments={segments} duration={clock.duration} pictures={pictures} thumbs={thumbs} selected={selected} player={player}
        estimated={clock.source === "estimate"} voiceLabel={voiceLabel} music={music} onMusic={onMusic}
        onSelect={setSelected} onMoveEdge={(k, first) => setScenes(moveEdge(spec.scenes, k, first))} />
      {long && <p className="notice bad">This voice is {clockText(clock.duration)} long: a video can be up to 3 minutes. Shorten the script or the recording.</p>}
      <EditorSection title="On-screen title" hint="A line at the top: a POV line or a creature's name all along, or a title card for the first seconds."
        action={<button type="button" className="btn sm" onClick={() => onChange({ ...spec, headline: spec.headline ? null : headlineFor(spec.kind, spec.title || storyScript(spec.scenes).split(/(?<=[.!?])\s/)[0] || "Title") })}>
          <Type size={14} aria-hidden="true" /> {spec.headline ? "Remove" : "Add title"}
        </button>}>
        {spec.headline && (
          <div className="row wrap" style={{ gap: 10, alignItems: "end" }}>
            <label className="field grow"><span className="small">Text</span>
              <input className="input" maxLength={140} value={spec.headline.text} onChange={(e) => onChange({ ...spec, headline: { ...spec.headline!, text: e.target.value } })} />
            </label>
            <label className="field"><span className="small">Shown</span>
              <select className="select" value={spec.headline.seconds} onChange={(e) => onChange({ ...spec, headline: { ...spec.headline!, seconds: Number(e.target.value) } })}>
                {[0, 2, 3, 4, 5, 8].map((n) => <option key={n} value={n}>{n ? `First ${n} s` : "Whole video"}</option>)}
              </select>
            </label>
            <label className="field"><span className="small">Look</span>
              <select className="select" value={spec.headline.look.background ? "card" : spec.headline.look.color === "#ffe14d" ? "loud" : "plain"}
                onChange={(e) => onChange({ ...spec, headline: { ...spec.headline!, look: headlineFor(e.target.value === "card" ? "story" : e.target.value === "loud" ? "mashup" : "pov", "x")!.look } })}>
                <option value="card">White card</option><option value="plain">White outline</option><option value="loud">Big yellow</option>
              </select>
            </label>
          </div>
        )}
      </EditorSection>
      <PresenterSection spec={spec} onChange={onChange} />
      <EditorSection title="Background clip" hint="One clip loops behind the whole video instead of a picture per scene (storytime). No AI pictures are made."
        action={spec.backdrop
          ? <button type="button" className="btn sm ghost" onClick={() => onChange({ ...spec, backdrop: null })}>Use pictures</button>
          : <button type="button" className="btn sm" onClick={onBackdrop}><Film size={14} aria-hidden="true" /> Choose clip</button>}>
        {spec.backdrop && <div className="row wrap" style={{ gap: 8 }}><span className="small">{backdrop?.name || "Library clip"}</span><button type="button" className="btn sm" onClick={onBackdrop}>Swap</button></div>}
      </EditorSection>
      <EditorSection title="Subtitles" hint="Word by word over the whole voice. Key word: Title Case, one key word per line in lime."
        action={<Switch checked={spec.captions.enabled} onChange={(enabled) => onChange({ ...spec, captions: { ...spec.captions, enabled } })} label="Show subtitles" />}>
        {spec.captions.enabled && <CaptionStylePicker label="Subtitle style" value={spec.captions.style} onChange={(style) => onChange({ ...spec, captions: { ...spec.captions, style } })} />}
      </EditorSection>
      {spec.music && (
        <EditorSection title="Music" hint="Plays under the whole voice, lowered so every word stays clear."
          action={<button type="button" className="btn sm ghost" onClick={() => onChange({ ...spec, music: null })}>Remove</button>}>
          <div className="music-track">
            <PlayButton playing={audio.playing === "music"} onClick={() => audio.toggle("music", `/api/library/${spec.music!.trackId}/file`)} label={music || "the music"} />
            <span className="grow small name">{music}</span>
            <button type="button" className="btn sm" onClick={() => { audio.stop(); onMusic(); }}>Swap</button>
          </div>
          <label className="field story-volume"><span className="small">Volume: {Math.round(spec.music.volume * 100)}%</span>
            <input type="range" min={0} max={1} step={0.05} value={spec.music.volume} onChange={(e) => onChange({ ...spec, music: { ...spec.music!, volume: Number(e.target.value) } })} />
          </label>
        </EditorSection>
      )}
      <StoryPlan spec={spec} creditsLeft={creditsLeft} music={music} initial={initial} recordingSeconds={spec.narration.kind === "upload" ? clock.duration : undefined} />
      {picker === "library" && <LibraryPicker kind="scene" onClose={() => setPicker(null)}
        onPick={(i) => { media.remember(i.id, libraryKnown(i)); setScene({ source: "library", libraryId: i.id, assetId: undefined }); setPicker(null); }} />}
      {(picker === "image" || picker === "video") && <MediaPicker type={picker} allowUpload onClose={() => setPicker(null)}
        onPick={(a) => { media.remember(a.id, { url: a.url, kind: a.mime.startsWith("video/") ? "video" : "image", duration: a.duration, name: a.name }); setScene({ source: "own", assetId: a.id, libraryId: undefined }); setPicker(null); }} />}
    </div>
  );
}

/** The selected scene: its words (key words, split), its picture (source, description, price) and its way in. */
function SceneInspector({ spec, index, scene, seconds, known, onChange, pick, onSplit, onMerge, onDelete, initial, allClips, presenter }: {
  spec: StorySpec; index: number; scene: StoryScene; seconds: number; known: Record<string, Known>; initial: boolean;
  /** The presenter's name (shown on its scenes). */
  presenter: string;
  /** The scenes still showing an AI picture, what turning them all into AI clips costs, and doing it. */
  allClips: { count: number; credits: (quality: ClipQuality) => number; apply: (quality: ClipQuality) => void };
  onChange: (patch: Partial<StoryScene>) => void; pick: (p: "image" | "video" | "library") => void;
  onSplit: (at: number) => void; onMerge: () => void; onDelete: () => void;
}) {
  const [word, setWord] = useState<number | null>(null);
  useEffect(() => setWord(null), [index]);
  const w = textWords(scene.text), voice = spec.narration.kind === "voice";
  const isKey = (text: string) => scene.keys.some((k) => normWord(k) === normWord(text));
  // What choosing a source costs: an AI picture is part of a new video (1 credit per 5 when redone), a clip by length.
  const price = (source: SceneSource) => source === "clip" ? (scene.clipId ? 0 : clipCredits([{ seconds: scene.clipSeconds, quality: scene.clipQuality }])) : source === "image" && !scene.imageId && !initial ? `1 per ${PICTURES_PER_CREDIT}` : 0;
  // The other scenes become clips of the quality this one has (regular when it is still a picture).
  const quality: ClipQuality = scene.source === "clip" ? scene.clipQuality : "regular";
  const made = (scene.source === "image" && scene.imageId) || (scene.source === "clip" && scene.clipId);
  const own = scene.assetId ? known[scene.assetId] : undefined, lib = scene.libraryId ? known[scene.libraryId] : undefined;
  return (
    <div className="inspector stack story-inspector" aria-label={`Scene ${index + 1}`}>
      <div className="row between">
        <strong className="small">Scene {index + 1} of {spec.scenes.length}</strong>
        <span className="chip">{seconds.toFixed(1)} s</span>
      </div>
      {voice ? (
        <label className="field"><span className="small">Words (spoken)</span>
          <textarea className="textarea" rows={3} maxLength={600} value={scene.text} onChange={(e) => onChange({ text: e.target.value.replace(/\s+/g, " ") })} />
          {narrationCurrent(spec) && <span className="hint">The voice is recorded: new words record it again (see the price below).</span>}
        </label>
      ) : <span className="small strong-label">Words (from your recording)</span>}
      <div className="word-chips" role="group" aria-label="Words of this scene: choose one to mark it or split before it">
        {w.map((text, i) => (
          <button key={i} type="button" className={`word-chip${isKey(text) ? " key" : ""}`} aria-pressed={word === i} onClick={() => setWord(word === i ? null : i)}>{text}</button>
        ))}
      </div>
      <div className="row wrap" style={{ gap: 6 }}>
        <button type="button" className="btn sm" disabled={word === null} onClick={() => word !== null && onChange({ keys: toggleKey(scene, w[word]).keys })}>
          <Star size={14} aria-hidden="true" /> {word !== null && isKey(w[word]) ? "Not a key word" : "Key word"}
        </button>
        <button type="button" className="btn sm" disabled={!word || spec.scenes.length >= STORY_MAX_SCENES} onClick={() => word && onSplit(word)}><Scissors size={14} aria-hidden="true" /> Split here</button>
        <button type="button" className="btn sm" disabled={index >= spec.scenes.length - 1} onClick={onMerge}><Merge size={14} aria-hidden="true" /> Merge with next</button>
        {voice && <button type="button" className="btn sm ghost danger" disabled={spec.scenes.length <= 1} onClick={onDelete}><Trash2 size={14} aria-hidden="true" /> Delete</button>}
      </div>
      <hr />
      <span className="small strong-label">Picture of scene {index + 1}</span>
      {showsPresenter(spec, index) && (
        <p className="notice small presenter-note">
          {presenter} speaks this scene on camera.{spec.presenter!.layout === "mix" ? " Choose My media or Library to show a picture of yours instead." : ""}
        </p>
      )}
      {!(showsPresenter(spec, index) && spec.presenter!.layout === "full") && <>
      <div className="seg small-seg story-sources" role="group" aria-label="Where the picture comes from">
        {(["image", "clip", "own", "library"] as const).map((s) => {
          const Icon = sourceIcons[s], cost = price(s);
          return (
            <button key={s} type="button" aria-pressed={scene.source === s}
              onClick={() => onChange(s === "own" || s === "library" ? { source: s } : { source: s, clipSeconds: s === "clip" ? clipFor(seconds) : scene.clipSeconds })}>
              <Icon size={14} aria-hidden="true" /> {sourceNames[s]} <small>{typeof cost === "string" ? `${cost} credits` : cost ? creditsLabel(cost) : scene.source === s && (s === "image" || s === "clip") && (scene.imageId || scene.clipId) ? "made" : s === "image" && initial ? "included" : "free"}</small>
            </button>
          );
        })}
      </div>
      {(scene.source === "image" || scene.source === "clip") && allClips.count > (scene.source === "image" ? 1 : 0) && (
        <button type="button" className="btn sm wrap" onClick={() => allClips.apply(quality)}>
          <Film size={14} aria-hidden="true" /> {scene.source === "clip" ? `Same for the other ${allClips.count} picture scene${allClips.count === 1 ? "" : "s"}` : `AI clips for all ${allClips.count} picture scenes`}{quality === "high" ? ", high quality" : ""} · {creditsLabel(allClips.credits(quality))}
        </button>
      )}
      {(scene.source === "image" || scene.source === "clip") && (
        <>
          <label className="field"><span className="small">What the picture shows</span>
            <textarea className="textarea" rows={3} maxLength={300} value={scene.description} placeholder="A doodle of a curious octopus with three hearts"
              onChange={(e) => onChange({ description: e.target.value })} />
          </label>
          {scene.source === "clip" && (<>
            <div className="field"><span className="small">Clip quality</span>
              <div className="seg small-seg" role="group" aria-label="Clip quality">
                {clipQualities.map((q) => (
                  <button key={q} type="button" aria-pressed={scene.clipQuality === q} disabled={!!scene.clipId} onClick={() => onChange({ clipQuality: q })}>
                    {clipQualityNames[q]} · {creditsLabel(CLIP_CREDITS[q])} per {CLIP_SECONDS} s
                  </button>
                ))}
              </div>
              <span className="hint">{scene.clipQuality === "high" ? "1080p, finer motion and detail." : "720p, smooth motion; the video is still 1080p."}</span>
            </div>
            <div className="field"><span className="small">Clip length (made from the picture)</span>
              <div className="seg small-seg" role="group" aria-label="Clip length">
                {([5, 10] as const).map((n) => <button key={n} type="button" aria-pressed={scene.clipSeconds === n} disabled={!!scene.clipId} onClick={() => onChange({ clipSeconds: n })}>{n} s · {creditsLabel(clipCredits([{ seconds: n, quality: scene.clipQuality }]))}</button>)}
              </div>
              {seconds > scene.clipSeconds + 0.3 && <span className="hint">The scene lasts {seconds.toFixed(1)} s: the clip holds its last frame after {scene.clipSeconds} s.</span>}
            </div>
          </>)}
          {made
            ? <button type="button" className="btn sm" onClick={() => onChange({ imageId: undefined, clipId: undefined })}><RefreshCw size={14} aria-hidden="true" /> New picture · 1 credit per {PICTURES_PER_CREDIT}</button>
            : <p className="muted small">Made when you make the video, in the {storyStyles[spec.style].name.toLowerCase()} style{spec.subject ? ", with your main character" : ""}.</p>}
        </>
      )}
      {scene.source === "own" && (
        <div className="row wrap" style={{ gap: 6 }}>
          {own && <span className="small truncate" title={own.name}>{own.name}</span>}
          <button type="button" className="btn sm" onClick={() => pick("image")}><ImageIcon size={14} aria-hidden="true" /> {own?.kind === "image" ? "Change picture" : "Choose picture"}</button>
          <button type="button" className="btn sm" onClick={() => pick("video")}><Film size={14} aria-hidden="true" /> {own?.kind === "video" ? "Change video" : "Choose video"}</button>
        </div>
      )}
      {scene.source === "library" && (
        <div className="row wrap" style={{ gap: 6 }}>
          {lib && <span className="small truncate" title={lib.name}>{lib.name}</span>}
          <button type="button" className="btn sm" onClick={() => pick("library")}><Library size={14} aria-hidden="true" /> {lib ? (lib.kind === "image" ? "Change picture" : "Change clip") : "Choose clip or picture"}</button>
        </div>
      )}
      </>}
      <hr />
      <label className="field"><span className="small">Transition in</span>
        <select className="select" value={scene.transition} disabled={index === 0} onChange={(e) => onChange({ transition: e.target.value as StoryTransition })}>
          {storyTransitions.map((t) => <option key={t} value={t}>{transitionName(t)}</option>)}
        </select>
        {index === 0 && <span className="hint">The first scene starts the video.</span>}
      </label>
    </div>
  );
}

/** What making the video costs, line by line, from the same rules the server charges by (shared/formats.ts). */
export function storyPrice(spec: StorySpec, initial: boolean, recordingSeconds?: number) {
  const script = storyScript(spec.scenes);
  const pending = pendingMedia(spec);
  const pictures = pending.filter((m) => m.kind === "image").length;
  const clips = pending.filter((m) => m.kind === "clip").map((m) => ({ seconds: m.seconds ?? CLIP_SECONDS, quality: m.quality ?? "regular" }));
  const seconds = recordingSeconds ?? speechSeconds(script);
  const voiceAgain = spec.narration.kind === "voice" && !narrationCurrent(spec);
  return {
    script, pictures, clips, seconds,
    presenter: spec.presenter && presenterNeeded(spec) ? presenterCredits(spokenSeconds(spec), spec.presenter.quality) : 0,
    video: initial ? videoCredits(seconds) : 0,
    voice: !initial && voiceAgain ? voiceCredits(script) : 0,
    redo: initial ? 0 : pictureCredits(pictures),
    clipCredits: clipCredits(clips),
    total: specCredits(spec, initial, recordingSeconds),
  };
}
function StoryPlan({ spec, creditsLeft, music, initial, recordingSeconds }: { spec: StorySpec; creditsLeft: number | null; music: string | null; initial: boolean; recordingSeconds?: number }) {
  const p = storyPrice(spec, initial, recordingSeconds);
  const missing = spec.backdrop ? -1 : spec.scenes.findIndex((s) => (s.source === "image" || s.source === "clip") && !s.imageId && s.description.trim().length < 3);
  const unchosen = spec.backdrop ? -1 : spec.scenes.findIndex((s) => (s.source === "own" && !s.assetId) || (s.source === "library" && !s.libraryId));
  const { byId } = useVoices();
  const { byId: avatarById } = useAvatars();
  const voiceName = spec.narration.kind === "voice" ? byId((spec.narration as { voiceId: string }).voiceId)?.name ?? "" : "";
  const presenter: [string, string, number | null][] = spec.presenter ? [[
    `On-screen presenter${avatarById(spec.presenter.avatarId) ? ` · ${avatarById(spec.presenter.avatarId)!.name}` : ""}`,
    p.presenter ? `${presenterQualityInfo[spec.presenter.quality].name} quality, ${presenterLayoutInfo[spec.presenter.layout].name.toLowerCase()}` : "unchanged",
    p.presenter,
  ]] : [];
  const rows: [string, string, number | null][] = initial
    ? [
      [`New video · about ${clockText(p.seconds)}`, `${spec.narration.kind === "voice" ? `AI voice ${voiceName}` : "your recording"}, ${spec.backdrop ? "a background clip" : `${p.pictures} AI pictures in ${storyStyles[spec.style].name}`}`, p.video],
      ["Animated scenes", p.clips.length ? p.clips.map((c) => `${c.seconds} s${c.quality === "high" ? " HQ" : ""}`).join(", ") : "none", p.clipCredits],
      ...presenter,
      ["Subtitles, transitions" + (music ? ", music" : ""), "rendering", 0],
    ]
    : [
      [`New narration${voiceName ? ` · ${voiceName}` : ""}`, p.voice ? `${p.script.length.toLocaleString("en-US")} characters` : "unchanged", p.voice],
      [`New pictures · ${storyStyles[spec.style].name}`, p.pictures ? `${p.pictures} to make` : "none", p.redo],
      ["Animated scenes", p.clips.length ? p.clips.map((c) => `${c.seconds} s${c.quality === "high" ? " HQ" : ""}`).join(", ") : "none", p.clipCredits],
      ...presenter,
      ["Subtitles, transitions, timing" + (music ? ", music" : ""), "rendering", 0],
    ];
  return (
    <EditorSection title="Plan and price" hint={initial ? "A new video costs 1 credit per started 30 seconds, everything included. If it fails, the credits come back." : "Only new AI work costs credits; text, subtitles, timing and music changes are free."}>
      <table className="story-plan">
        <tbody>
          {rows.map(([what, detail, credits]) => (
            <tr key={what}><th scope="row">{what}<span>{detail}</span></th><td>{credits ? creditsLabel(credits) : "Free"}</td></tr>
          ))}
        </tbody>
        <tfoot><tr><th scope="row">Total{creditsLeft !== null && <span>{creditsLabel(creditsLeft)} left</span>}</th><td>{creditsLabel(p.total)}</td></tr></tfoot>
      </table>
      {spec.narration.kind === "voice" && p.script.length > STORY_MAX_CHARS && <p className="notice bad">The script is {p.script.length.toLocaleString("en-US")} characters: up to {STORY_MAX_CHARS.toLocaleString("en-US")} fit in one video.</p>}
      {missing >= 0 && <p className="notice warn">Describe the picture of scene {missing + 1}.</p>}
      {unchosen >= 0 && <p className="notice warn">Choose the media of scene {unchosen + 1}.</p>}
      {creditsLeft !== null && p.total > creditsLeft && <p className="notice warn">This needs {creditsLabel(p.total)} and {creditsLabel(creditsLeft)} are left. Upgrade or add a credit pack.</p>}
    </EditorSection>
  );
}

/** Before the timeline: where the voice comes from, how long, which voice, the picture style and the main character. */
export type StoryInput = { mode: "voice" | "upload"; voiceId: string; seconds: number; style: StoryStyle; subject: string; script: string };
export const defaultStoryInput: StoryInput = { mode: "voice", voiceId: "george", seconds: 45, style: "doodle", subject: "", script: "" };
export function StoryInputs({ input, onInput, recording, timing, aligning, alignError, onPickRecording, onAlign, fixed = false }: {
  input: StoryInput; onInput: (input: StoryInput) => void;
  /** Editing a made video: its voiceover stays (an AI voice can change voice); no new script or recording. */
  fixed?: boolean;
  recording: { name: string; duration?: number } | null;
  timing: UploadTiming | null; aligning: boolean; alignError: string;
  onPickRecording: (type: "audio" | "video") => void; onAlign: () => void;
}) {
  const set = (patch: Partial<StoryInput>) => onInput({ ...input, ...patch });
  // A new video starts with an offered voice; a made one keeps its own.
  useOfferedVoice(input.voiceId, (voiceId) => set({ voiceId }), !fixed && input.mode === "voice");
  const words = timing?.words.length ?? 0;
  return (
    <>
      {fixed ? (
        <div className="card flat stack">
          <span className="label">Voiceover</span>
          {input.mode === "voice" ? (
            <div className="field"><span className="small">Voice <span className="muted">(a new voice is recorded again)</span></span>
              <VoiceSelect value={input.voiceId} onChange={(voiceId) => set({ voiceId })} />
            </div>
          ) : <span className="small story-file">{recording?.name || "Your recording"}{recording?.duration ? ` · ${clockText(recording.duration)}` : ""}</span>}
        </div>
      ) : <div className="card flat stack">
        <span className="label">Voiceover</span>
        <div className="seg" role="group" aria-label="Voiceover">
          <button type="button" aria-pressed={input.mode === "voice"} onClick={() => set({ mode: "voice" })}><Wand2 size={15} aria-hidden="true" /> AI voice</button>
          <button type="button" aria-pressed={input.mode === "upload"} onClick={() => set({ mode: "upload" })}><Film size={15} aria-hidden="true" /> My recording</button>
        </div>
        {input.mode === "voice" ? (
          <div className="story-voice-fields">
            <div className="field"><span className="small">Voice</span>
              <VoiceSelect value={input.voiceId} onChange={(voiceId) => set({ voiceId })} />
            </div>
            <label className="field"><span className="small">Length</span>
              <select className="select" value={input.seconds} onChange={(e) => set({ seconds: Number(e.target.value) })}>
                {storyLengths.map(([s, name]) => <option key={s} value={s}>{name}</option>)}
              </select>
            </label>
          </div>
        ) : (
          <div className="stack" style={{ gap: 8 }}>
            <div className="row between">
              {recording ? <span className="small truncate" title={recording.name}>{recording.name}{recording.duration ? ` · ${clockText(recording.duration)}` : ""}</span> : <span className="small muted">Audio or video, up to 3 minutes</span>}
              <div className="row" style={{ gap: 6 }}>
                <button type="button" className="btn sm" onClick={() => onPickRecording("audio")}>Audio</button>
                <button type="button" className="btn sm" onClick={() => onPickRecording("video")}>Video</button>
              </div>
            </div>
            {recording && (
              <p className="small muted" aria-live="polite">
                {timing?.source === "script" ? `${words} words timed to your script.`
                  : words ? `${words} words found in the recording.`
                    : timing?.speech === "pending" ? "Listening for the words…" : timing ? "No words found yet: paste the script below to time it." : "Reading the recording…"}
              </p>
            )}
            <label className="field"><span className="small">Exact script <span className="muted">(optional, for exact timing)</span></span>
              <textarea className="textarea" rows={3} maxLength={STORY_MAX_CHARS * 2} value={input.script} placeholder="Paste exactly what is said" onChange={(e) => set({ script: e.target.value })} />
            </label>
            <button type="button" className="btn sm" disabled={!recording || !input.script.trim() || aligning} onClick={onAlign}>
              {aligning ? <span className="spinner" aria-hidden="true" /> : <Scissors size={14} aria-hidden="true" />} Match to the script (free)
            </button>
            {alignError && <p className="notice bad small">{alignError}</p>}
          </div>
        )}
      </div>}
      <div className="card flat stack">
        <span className="label">Picture style</span>
        <StoryStylePicker value={input.style} onChange={(style) => set({ style })} />
        <p className="muted small">{storyStyles[input.style].short}: used for every scene, so the video looks drawn by one hand.</p>
      </div>
      <label className="card flat field"><span>Main character <span className="muted small">(optional)</span></span>
        <input className="input" maxLength={300} value={input.subject} placeholder="A curious orange octopus with big round eyes" onChange={(e) => set({ subject: e.target.value })} />
        <span className="hint">Described the same way in every picture. Leave empty and the writer suggests one when it fits.</span>
      </label>
    </>
  );
}
