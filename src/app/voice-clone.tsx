import { useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Mic, Upload } from "lucide-react";
import { Modal, Spinner, useToast } from "../ui";
import { del, errorText, loadOwnVoices, post, uploadFile, useAuth, useOwnVoices } from "../lib";
import { CLONE_CONSENT_TEXT, CLONE_CONSENT_VERSION, CLONE_NAME_MAX, CLONE_SAMPLE, type Voice } from "../../shared/voices";

// Cloning a voice: one recording of clear speech, a name and the owner's statement that the voice is theirs to use
// (server/voice-clones.ts). The recording is uploaded like any file, the voice is made from it, and the upload is
// deleted again: only the voice stays.

const ACCEPT = "audio/mpeg,audio/mp4,audio/x-m4a,audio/aac,audio/wav,audio/x-wav,audio/ogg,.mp3,.m4a,.wav,.ogg,.aac";
const megabytes = CLONE_SAMPLE.maxBytes / 1024 / 1024;

/** "Clone your voice": the form, or why the person can't add one now (their plan, or its room). */
export function CloneVoiceDialog({ onClose, onDone }: { onClose: () => void; onDone?: (voice: Voice) => void }) {
  const { user } = useAuth();
  const own = useOwnVoices();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(() => (user?.name || "").trim().split(/\s+/)[0]?.slice(0, CLONE_NAME_MAX) || "");
  const [file, setFile] = useState<File | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [step, setStep] = useState<null | "upload" | "clone">(null);
  const [progress, setProgress] = useState(0);
  const limit = own?.limit ?? 0, full = !!own && limit > 0 && own.voices.length >= limit;
  const tooBig = !!file && file.size > CLONE_SAMPLE.maxBytes;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!file || tooBig || !agreed || !name.trim() || step) return;
    let uploaded: string | null = null;
    try {
      setStep("upload");
      setProgress(0);
      const asset = await uploadFile(file, setProgress);
      uploaded = asset.id;
      if (asset.status !== "ready") throw new Error(asset.error || "This recording couldn't be read. Try an MP3, M4A or WAV file.");
      setStep("clone");
      const { voice } = await post<{ voice: Voice }>("/voices", { name: name.trim(), assetId: asset.id, consent: true, version: CLONE_CONSENT_VERSION });
      await loadOwnVoices(true);
      toast(`${voice.name} is ready. Choose it for any video or series.`, "good");
      onDone?.(voice);
      onClose();
    } catch (err) {
      toast(errorText(err), "bad");
      setStep(null);
    } finally {
      // The recording was uploaded only to make the voice: it doesn't stay in the person's files.
      if (uploaded) void del(`/media/${uploaded}`).catch(() => {});
    }
  };
  return (
    <Modal title="Clone your voice" onClose={() => { if (!step) onClose(); }} footer={
      !own || !limit || full ? <button type="button" className="btn" onClick={onClose}>Close</button> : (
        <>
          <button type="button" className="btn" onClick={onClose} disabled={!!step}>Cancel</button>
          <button type="submit" form="clone-voice" className="btn primary" disabled={!file || tooBig || !agreed || !name.trim() || !!step}>
            {step ? <Spinner label={step === "upload" ? "Uploading" : "Making the voice"} /> : <Mic size={16} aria-hidden="true" />}
            {step === "upload" ? `Uploading ${Math.round(progress * 100)}%` : step === "clone" ? "Making your voice…" : "Clone this voice"}
          </button>
        </>
      )
    }>
      {!own ? <Spinner label="Loading" /> : !limit ? (
        <p>Cloning your voice is part of the paid plans. <Link className="link" to="/app/billing">Choose a plan</Link> to narrate your videos in your own voice.</p>
      ) : full ? (
        <p>Your plan has room for {limit} cloned voice{limit === 1 ? "" : "s"}. Delete one in <Link className="link" to="/app/settings#voices">Settings</Link> first, or upgrade.</p>
      ) : (
        <form id="clone-voice" className="stack" onSubmit={submit}>
          <p className="small muted" style={{ margin: 0 }}>
            Upload one recording of the voice and every video or series can be narrated in it. Only you can use it, and you can delete it at any time.
          </p>
          <div className="field">
            <span className="small">Recording</span>
            <div className="row wrap" style={{ gap: 10 }}>
              <button type="button" className="btn" disabled={!!step} onClick={() => input.current?.click()}><Upload size={16} aria-hidden="true" />{file ? "Choose another" : "Choose a recording"}</button>
              {file && <span className="small" style={{ minWidth: 0, maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{file.name}</span>}
            </div>
            <input ref={input} type="file" accept={ACCEPT} hidden tabIndex={-1} aria-hidden="true" onChange={(e) => { setFile(e.target.files?.[0] ?? null); e.target.value = ""; }} />
            <p className="hint">
              One to three minutes of one person speaking clearly: no music, no other voices, little background noise.
              At least {CLONE_SAMPLE.minSeconds} seconds, at most {CLONE_SAMPLE.maxSeconds / 60} minutes. MP3, M4A or WAV, up to {megabytes} MB.
            </p>
            {tooBig && <p className="notice bad small" role="alert">This file is over {megabytes} MB. Save it as an MP3 or M4A, or use a shorter recording.</p>}
          </div>
          <label className="field"><span className="small">Name</span>
            <input className="input" value={name} maxLength={CLONE_NAME_MAX} placeholder="My voice" disabled={!!step} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="check">
            <input type="checkbox" checked={agreed} disabled={!!step} onChange={(e) => setAgreed(e.target.checked)} />
            <span>{CLONE_CONSENT_TEXT}</span>
          </label>
        </form>
      )}
    </Modal>
  );
}
