import { useState } from "react";
import { AudioLines, Plus, Trash2 } from "lucide-react";
import { useApi, type LibraryItem } from "../lib";
import { Switch } from "../ui";
import { EditorSection } from "./CaptionPickers";
import { LibraryPicker, PlayButton, itemLength, usePreviewAudio } from "./pickers";
import { SOUND_VOLUME, TRANSITION_CATEGORY } from "../../shared/sounds";
import type { StorySpec } from "../../shared/formats";
import type { StoryScene } from "../../shared/story";

// Sound effects in the editor (shared/sounds.ts): switched on or off for the whole video, at one volume, with the
// whoosh played on every scene change and each scene's own sound, added, changed or removed scene by scene. Changing
// them only renders the video again (free).

/** The library's sound effects by ID: their names, lengths and files. */
export function useSoundLibrary() {
  const { data } = useApi<{ items: LibraryItem[] }>("/library?kind=sfx");
  return new Map((data?.items || []).map((i) => [i.id, i]));
}
/** The spec with sound effects on (switched on with the default volume when it had none). */
const soundsOn = (spec: StorySpec): NonNullable<StorySpec["sounds"]> => ({ volume: SOUND_VOLUME, ...spec.sounds, enabled: true });

/** One sound effect: play it, change it, remove it. */
function SoundRow({ id, library, label, onChange, onRemove }: {
  id: string; library: Map<string, LibraryItem>; label: string; onChange: () => void; onRemove: () => void;
}) {
  const audio = usePreviewAudio();
  const item = library.get(id);
  return (
    <div className="music-track">
      <PlayButton playing={audio.playing === id} onClick={() => audio.toggle(id, `/api/library/${id}/file`)} label={item?.name || label} />
      <span className="grow" style={{ minWidth: 0 }}>
        <span className="small name">{item?.name || "Library sound"}</span>
        {item && <span className="small muted">{[item.category, itemLength(item)].filter(Boolean).join(" · ")}</span>}
      </span>
      <button type="button" className="btn sm" onClick={() => { audio.stop(); onChange(); }}>Change</button>
      <button type="button" className="btn sm icon ghost" onClick={() => { audio.stop(); onRemove(); }} aria-label={`Remove ${item?.name || label}`} title="Remove">
        <Trash2 size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

/** The video's sound effects: on or off, their volume, the whoosh of scene changes and how many scenes have a sound. */
export function SoundSection({ spec, onChange, library }: { spec: StorySpec; onChange: (spec: StorySpec) => void; library: Map<string, LibraryItem> }) {
  const [picking, setPicking] = useState(false);
  const on = !!spec.sounds?.enabled;
  const sounds = soundsOn(spec);
  const withSound = spec.scenes.filter((s) => s.soundId).length;
  return (
    <EditorSection title="Sound effects"
      hint="A whoosh on every scene change and sounds for the scenes that have one, under the voice. You hear them in the made video; changing them is free."
      action={<Switch checked={on} onChange={(enabled) => onChange({ ...spec, sounds: { ...sounds, enabled } })} label="Play sound effects" />}>
      {on && (
        <div className="stack" style={{ gap: 10 }}>
          <div className="field">
            <span className="small">Scene changes</span>
            {sounds.transitionId ? (
              <SoundRow id={sounds.transitionId} library={library} label="the whoosh" onChange={() => setPicking(true)}
                onRemove={() => onChange({ ...spec, sounds: { ...sounds, transitionId: undefined } })} />
            ) : (
              <div className="row wrap" style={{ gap: 8 }}>
                <span className="small muted">No whoosh.</span>
                <button type="button" className="btn sm" onClick={() => setPicking(true)}><Plus size={14} aria-hidden="true" /> Add a whoosh</button>
              </div>
            )}
            {spec.backdrop && <span className="hint">Not played over a background clip: the picture doesn't change between scenes.</span>}
          </div>
          <p className="small muted" style={{ margin: 0 }}>
            {withSound ? `${withSound} scene${withSound === 1 ? " has its" : "s have their"} own sound.` : "No scene has its own sound."} Choose a scene above to add, change or remove its sound.
          </p>
          <label className="field story-volume"><span className="small">Volume: {Math.round(sounds.volume * 100)}%</span>
            <input type="range" min={0} max={1} step={0.05} value={sounds.volume} onChange={(e) => onChange({ ...spec, sounds: { ...sounds, volume: Number(e.target.value) } })} />
          </label>
        </div>
      )}
      {picking && <LibraryPicker kind="sfx" title="Choose the whoosh for scene changes" query={TRANSITION_CATEGORY} onClose={() => setPicking(false)}
        onPick={(i) => { onChange({ ...spec, sounds: { ...sounds, transitionId: i.id } }); setPicking(false); }} />}
    </EditorSection>
  );
}

/**
 * The selected scene's sound effect, played when it starts: added (which switches the video's sound effects on),
 * changed or removed.
 */
export function SceneSound({ spec, index, scene, library, onScene, onSpec }: {
  spec: StorySpec; index: number; scene: StoryScene; library: Map<string, LibraryItem>;
  onScene: (patch: Partial<StoryScene>) => void; onSpec: (spec: StorySpec) => void;
}) {
  const [picking, setPicking] = useState(false);
  const on = !!spec.sounds?.enabled;
  const pick = (item: LibraryItem) => {
    setPicking(false);
    onSpec({ ...spec, sounds: soundsOn(spec), scenes: spec.scenes.map((s, i) => (i === index ? { ...s, soundId: item.id } : s)) });
  };
  return (
    <div className="field">
      <span className="small">Sound effect</span>
      {scene.soundId ? (
        <SoundRow id={scene.soundId} library={library} label={`the sound of scene ${index + 1}`} onChange={() => setPicking(true)} onRemove={() => onScene({ soundId: undefined })} />
      ) : (
        <div className="row wrap" style={{ gap: 8 }}>
          <button type="button" className="btn sm" onClick={() => setPicking(true)}><AudioLines size={14} aria-hidden="true" /> Add a sound</button>
        </div>
      )}
      <span className="hint">
        {scene.soundId && !on ? "Sound effects are off for this video: switch them on below to hear it." : "Plays when the scene starts (fire, waves, a crowd, a door…)."}
      </span>
      {picking && <LibraryPicker kind="sfx" title={`Choose a sound for scene ${index + 1}`} onClose={() => setPicking(false)} onPick={pick} />}
    </div>
  );
}
