import { useState } from "react";
import { Check, UserRound } from "lucide-react";
import { Modal } from "../ui";
import { useAvatars } from "../lib";
import { EditorSection } from "./CaptionPickers";
import { useStableCallback } from "./pickers";
import { presenterCurrent, presenterShown, spokenSeconds, type StorySpec } from "../../shared/formats";
import { presenterLayoutInfo, presenterLayouts, presenterQualities, presenterQualityInfo, type Avatar, type Presenter } from "../../shared/presenter";
import { PRESENTER_CREDITS, PRESENTER_SECONDS, creditsLabel, presenterCredits } from "../../shared/credits";

// The on-screen presenter of a narrated video (shared/presenter.ts): an AI avatar from Admin → Presenters speaking the AI
// voice, on the hook and every other scene or on all of them, in regular or high quality. Shown only while avatars are
// offered (or the video already has one).

const genderNames = { female: "Female", male: "Male" } as const;

/** An avatar's picture, or its initial when it has none. */
export function AvatarFace({ avatar, className = "" }: { avatar: Pick<Avatar, "name" | "preview"> | undefined; className?: string }) {
  return avatar?.preview
    ? <img className={`avatar-face ${className}`} src={avatar.preview} alt="" loading="lazy" />
    : <span className={`avatar-face blank ${className}`} aria-hidden="true">{avatar?.name?.[0]?.toUpperCase() || <UserRound size={18} />}</span>;
}

export function PresenterSection({ spec, onChange }: { spec: StorySpec; onChange: (spec: StorySpec) => void }) {
  const { avatars, loading, byId } = useAvatars();
  const [picking, setPicking] = useState(false);
  const p = spec.presenter;
  if (!p && (loading || !avatars.length)) return null;
  const avatar = p ? byId(p.avatarId) : undefined;
  const set = (patch: Partial<Presenter>) => onChange({ ...spec, presenter: { ...p!, ...patch } });
  const blocked = spec.narration.kind !== "voice" ? "A presenter speaks the AI voice: it can't be used with your own recording."
    : spec.backdrop ? "A presenter is shown instead of the scene pictures, so it can't be used with a background clip." : "";
  const seconds = spokenSeconds(spec);
  // A quality the avatar isn't offered in (or no longer) is shown, but can't be chosen again.
  const offered = avatar?.qualities ?? (p ? [p.quality] : []);
  return (
    <EditorSection title="On-screen presenter"
      hint={p ? "An AI presenter speaks the voice on camera, lip-synced to it. Pictures and timing stay editable for free."
        : `An AI presenter speaks the voice on camera: ${creditsLabel(PRESENTER_CREDITS.regular)} per ${PRESENTER_SECONDS} seconds, or ${creditsLabel(PRESENTER_CREDITS.high)} in high quality. Optional.`}
      action={p
        ? <button type="button" className="btn sm ghost" onClick={() => onChange({ ...spec, presenter: null })}>Remove</button>
        : <button type="button" className="btn sm" disabled={!!blocked} onClick={() => setPicking(true)}><UserRound size={14} aria-hidden="true" /> Add presenter</button>}>
      {!p && blocked && <p className="muted small">{blocked}</p>}
      {p && (
        <div className="stack" style={{ gap: 12 }}>
          <div className="presenter-current">
            <AvatarFace avatar={avatar} />
            <span className="grow" style={{ minWidth: 0 }}>
              <span className="name">{avatar?.name ?? (loading ? "Loading…" : "Presenter")}</span>
              <span className="small muted">{avatar ? "AI presenter" : loading ? "" : "No longer offered: this video keeps it"}</span>
            </span>
            <button type="button" className="btn sm" disabled={loading || !avatars.length} onClick={() => setPicking(true)}>Change</button>
          </div>
          <div className="field"><span className="small">On camera</span>
            <div className="seg small-seg" role="group" aria-label="When the presenter is on camera">
              {presenterLayouts.map((l) => (
                <button key={l} type="button" aria-pressed={p.layout === l} onClick={() => set({ layout: l })}>{presenterLayoutInfo[l].name}</button>
              ))}
            </div>
            <span className="hint">{presenterLayoutInfo[p.layout].note}.{p.layout === "mix" ? " Scenes with your own or library media keep it." : " No pictures are made."}</span>
          </div>
          <div className="field"><span className="small">Presenter quality</span>
            <div className="seg small-seg" role="group" aria-label="Presenter quality">
              {presenterQualities.map((q) => (
                <button key={q} type="button" aria-pressed={p.quality === q} disabled={!offered.includes(q) && p.quality !== q} onClick={() => set({ quality: q })}>
                  {presenterQualityInfo[q].name} · {creditsLabel(PRESENTER_CREDITS[q])} per {PRESENTER_SECONDS} s
                </button>
              ))}
            </div>
            <span className="hint">
              {presenterQualityInfo[p.quality].note}.{" "}
              {presenterCurrent(spec) ? "Already made for these words: free." : `About ${creditsLabel(presenterCredits(seconds, p.quality))} for this voice (${Math.round(seconds)} s); new words make it again.`}
            </span>
          </div>
          {blocked && <p className="notice bad small">{blocked} Remove one of them.</p>}
          {!blocked && !presenterShown(spec) && <p className="notice warn small">No scene shows the presenter: with Presenter + pictures it speaks the first scene and every other one that has an AI picture or clip.</p>}
        </div>
      )}
      {picking && <AvatarPicker value={p?.avatarId ?? ""} onClose={() => setPicking(false)} onPick={(a) => {
        setPicking(false);
        onChange({ ...spec, presenter: { avatarId: a.id, layout: p?.layout ?? "mix", quality: a.qualities.includes(p?.quality ?? "regular") ? p?.quality ?? "regular" : a.qualities[0] } });
      }} />}
    </EditorSection>
  );
}

/** Every avatar offered, by gender. */
export function AvatarPicker({ value, onPick, onClose }: { value: string; onPick: (a: Avatar) => void; onClose: () => void }) {
  const { avatars, loading } = useAvatars();
  const [chosen, setChosen] = useState(value);
  const [gender, setGender] = useState<Avatar["gender"]>("");
  const close = useStableCallback(onClose);
  const genders = (["female", "male"] as const).filter((g) => avatars.some((a) => a.gender === g));
  const shown = avatars.filter((a) => !gender || a.gender === gender);
  const selected = avatars.find((a) => a.id === chosen);
  return (
    <Modal title="Choose a presenter" onClose={close} wide footer={
      <>
        <button type="button" className="btn" onClick={close}>Cancel</button>
        <button type="button" className="btn primary" disabled={!selected} onClick={() => selected && onPick(selected)}>
          <Check size={16} aria-hidden="true" />{selected ? `Use ${selected.name}` : "Use this presenter"}
        </button>
      </>
    }>
      <p className="small muted" style={{ margin: "0 0 12px" }}>
        AI presenters, made with HeyGen: they speak your video's voice, lip-synced to it. The video is marked as made with AI.
      </p>
      {genders.length > 1 && (
        <div className="tag-filter">
          <span className="filter-group" role="group" aria-label="Presenter">
            <button type="button" className="chip button" aria-pressed={!gender} onClick={() => setGender("")}>All</button>
            {genders.map((g) => <button key={g} type="button" className="chip button" aria-pressed={gender === g} onClick={() => setGender(gender === g ? "" : g)}>{genderNames[g]}</button>)}
          </span>
        </div>
      )}
      {loading ? <div className="pick-grid">{Array.from({ length: 8 }, (_, i) => <div key={i} className="skeleton pick-item tall" />)}</div> : (
        <div className="pick-grid avatar-grid">
          {shown.map((a) => (
            <button key={a.id} type="button" className="pick-item tall" aria-pressed={a.id === chosen} onClick={() => setChosen(a.id)} onDoubleClick={() => onPick(a)}
              aria-label={`${a.name}${a.gender ? `, ${genderNames[a.gender]}` : ""}${a.qualities.includes("high") ? ", high quality available" : ""}`}>
              <AvatarFace avatar={a} />
              {a.id === chosen && <span className="pick-check"><Check size={15} aria-hidden="true" /></span>}
              {a.qualities.includes("high") && <span className="pick-badges"><span className="chip solid small">HQ</span></span>}
              <span className="pick-name">{a.name}</span>
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
}
