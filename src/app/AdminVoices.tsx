import { useState, type FormEvent } from "react";
import { ArrowDown, ArrowUp, Mic, Pencil, Plus, Search, Star, Trash2 } from "lucide-react";
import { Modal, Spinner, Switch, useToast } from "../ui";
import { del, errorText, patch, post, reloadVoices, useApi } from "../lib";
import { ConfirmDialog, Empty, PlayButton, usePreviewAudio, useStableCallback } from "./pickers";
import type { Voice } from "../../shared/voices";

// Admin → Voices: the narration voices people can choose (server/routes/admin-voices.ts). Voices come from the
// ElevenLabs account with ElevenLabs' own details and sample; administrators rename, describe, order, hide them and
// choose the default. A voice no video or series uses can be deleted; a used one can only be hidden.

type AdminVoice = Voice & { providerId: string; active: boolean; sort: number; usage: { series: number; videos: number } };
type AccountVoice = { providerId: string; category: string; name: string; description: string; gender: string; accent: string; age: string; imported: string | null };
const genders: Record<string, string> = { female: "Female", male: "Male", neutral: "Neutral", "": "—" };

export function VoicesTab() {
  const toast = useToast();
  const { data, loading, error, reload, setData } = useApi<{ voices: AdminVoice[] }>("/admin/voices");
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<AdminVoice | null>(null);
  const [deleting, setDeleting] = useState<AdminVoice | null>(null);
  const audio = usePreviewAudio();
  const voices = data?.voices || [];
  const changed = () => { reloadVoices(); void reload(); };
  const update = async (v: AdminVoice, changes: Record<string, unknown>, done = "Saved.") => {
    try {
      await patch(`/admin/voices/${v.id}`, changes);
      changed();
      toast(done, "good");
    } catch (e) {
      toast(errorText(e), "bad");
    }
  };
  // Moving a voice swaps its place with its neighbour's.
  const move = async (index: number, by: -1 | 1) => {
    const a = voices[index], b = voices[index + by];
    if (!a || !b || a.active !== b.active) return;
    const sa = a.sort === b.sort ? a.sort + by : b.sort, sb = a.sort === b.sort ? a.sort : a.sort;
    setData((d) => (d ? { voices: d.voices.map((v, i) => (i === index ? b : i === index + by ? a : v)) } : d));
    try {
      await patch(`/admin/voices/${a.id}`, { sort: sa });
      await patch(`/admin/voices/${b.id}`, { sort: sb });
    } catch (e) {
      toast(errorText(e), "bad");
    }
    changed();
  };
  return (
    <div className="stack" style={{ gap: 20 }}>
      <section aria-labelledby="voices-title">
        <div className="section-head">
          <div>
            <h2 id="voices-title">Voices</h2>
            <p className="muted small" style={{ margin: 0 }}>The voices people choose for narration, in this order. Hidden voices aren't offered, but videos and series that use one keep it.</p>
          </div>
          <button type="button" className="btn primary" onClick={() => setAdding(true)}><Plus size={16} aria-hidden="true" />Add a voice</button>
        </div>
        {loading ? <div className="loading-page"><Spinner label="Loading voices" /></div> : error ? (
          <div className="notice bad" role="alert">{error} <button type="button" className="link" onClick={() => void reload()}>Try again</button></div>
        ) : !voices.length ? (
          <Empty icon={<Mic size={24} />} title="No voices yet" action={<button type="button" className="btn primary" onClick={() => setAdding(true)}>Add a voice</button>}>
            Add voices from your ElevenLabs account. People can only make narrated videos once at least one voice is offered.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <caption className="sr-only">Voices</caption>
              <thead><tr><th scope="col">Sample</th><th scope="col">Voice</th><th scope="col">Details</th><th scope="col">Used by</th><th scope="col">Offered</th><th scope="col">Default</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {voices.map((v, i) => (
                  <tr key={v.id} className={v.active ? undefined : "muted"}>
                    <td>{v.preview ? <PlayButton playing={audio.playing === v.id} onClick={() => audio.toggle(v.id, v.preview!)} label={`a sample of ${v.name}`} /> : <span className="small muted">None</span>}</td>
                    <td>
                      <span className="clip" style={{ fontWeight: 600 }}>{v.name}</span>
                      <span className="small muted">{v.description || "No description"}</span>
                      <span className="small muted" style={{ display: "block" }}>ID {v.id} · ElevenLabs {v.providerId}</span>
                    </td>
                    <td className="small">{[genders[v.gender], v.accent, v.age].filter((x) => x && x !== "—").join(" · ") || "—"}</td>
                    <td className="small">{v.usage.series} series · {v.usage.videos} videos</td>
                    <td><Switch checked={v.active} onChange={(on) => void update(v, { active: on }, on ? `${v.name} is offered.` : `${v.name} is hidden.`)} label={`${v.name} is offered`} disabled={v.default} /></td>
                    <td>
                      {v.default ? <span className="chip green"><Star size={12} aria-hidden="true" />Default</span>
                        : <button type="button" className="btn sm" onClick={() => void update(v, { default: true }, `${v.name} is the default voice.`)}>Make default</button>}
                    </td>
                    <td>
                      <div className="icon-actions">
                        <button type="button" className="btn icon ghost" onClick={() => void move(i, -1)} disabled={i === 0 || voices[i - 1].active !== v.active} aria-label={`Move ${v.name} up`} title="Move up"><ArrowUp size={16} /></button>
                        <button type="button" className="btn icon ghost" onClick={() => void move(i, 1)} disabled={i === voices.length - 1 || voices[i + 1].active !== v.active} aria-label={`Move ${v.name} down`} title="Move down"><ArrowDown size={16} /></button>
                        <button type="button" className="btn icon ghost" onClick={() => setEditing(v)} aria-label={`Edit ${v.name}`} title="Edit"><Pencil size={16} /></button>
                        <button type="button" className="btn icon ghost danger" onClick={() => setDeleting(v)} aria-label={`Delete ${v.name}`} title="Delete" disabled={v.default}><Trash2 size={16} /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {adding && <AddVoiceModal onClose={() => setAdding(false)} onAdded={(v) => { setAdding(false); changed(); toast(`${v.name} was added and is offered now.`, "good"); }} />}
      {editing && <EditVoiceModal voice={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); changed(); }} />}
      {deleting && (
        <ConfirmDialog title="Delete this voice?" onClose={() => setDeleting(null)} onConfirm={async () => {
          await del(`/admin/voices/${deleting.id}`);
          changed();
          toast("Deleted.", "good");
        }}>
          <p><strong>{deleting.name}</strong> leaves the list. Only voices no video or series uses can be deleted; to stop offering a voice, hide it instead.</p>
        </ConfirmDialog>
      )}
    </div>
  );
}

/** Picks a voice of the ElevenLabs account (or takes a voice ID) and imports it with ElevenLabs' details. */
function AddVoiceModal({ onClose, onAdded }: { onClose: () => void; onAdded: (v: Voice) => void }) {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const account = useApi<{ voices: AccountVoice[] }>(`/admin/voices/elevenlabs?search=${encodeURIComponent(query)}`);
  const [providerId, setProviderId] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const close = useStableCallback(onClose);
  const add = async (id: string) => {
    setBusy(id);
    setProblem(null);
    try {
      onAdded((await post<{ voice: Voice }>("/admin/voices", { providerId: id.trim() })).voice);
    } catch (e) {
      setProblem(errorText(e));
      setBusy(null);
    }
  };
  const find = (e: FormEvent) => { e.preventDefault(); setQuery(search.trim()); };
  const list = account.data?.voices || [];
  return (
    <Modal title="Add a voice" onClose={close} wide>
      <div className="stack">
        <p className="small muted" style={{ margin: 0 }}>
          Voices come from your ElevenLabs account. To use one from the ElevenLabs Voice Library, add it to My Voices in ElevenLabs first. It's added
          with ElevenLabs' name, description and sample; you can change them afterwards.
        </p>
        <form className="row" style={{ gap: 8 }} onSubmit={find} role="search">
          <label className="search grow">
            <Search size={16} aria-hidden="true" />
            <span className="sr-only">Search your ElevenLabs voices</span>
            <input className="input" type="search" placeholder="Search your ElevenLabs voices" value={search} onChange={(e) => setSearch(e.target.value)} />
          </label>
          <button type="submit" className="btn">Search</button>
        </form>
        {account.loading ? <Spinner label="Loading your ElevenLabs voices" /> : account.error ? <p className="notice bad small" role="alert">{account.error}</p> : !list.length ? (
          <p className="small muted">No voices found{query ? ` for “${query}”` : ""}.</p>
        ) : (
          <ul className="pick-rows list-plain" style={{ maxHeight: 360, overflowY: "auto" }}>
            {list.map((v) => (
              <li key={v.providerId} className="pick-row">
                <span className="grow">
                  <span className="name" style={{ display: "block" }}>{v.name} <span className="small muted">· {v.category || "voice"}</span></span>
                  <span className="small muted">{[v.description, genders[v.gender] !== "—" ? genders[v.gender] : "", v.accent, v.age].filter(Boolean).join(" · ")}</span>
                </span>
                {v.imported ? <span className="chip">Added as {v.imported}</span> : (
                  <button type="button" className="btn sm" disabled={!!busy} onClick={() => void add(v.providerId)}>{busy === v.providerId && <Spinner label="Adding" />}Add</button>
                )}
              </li>
            ))}
          </ul>
        )}
        <form className="row" style={{ gap: 8, alignItems: "flex-end" }} onSubmit={(e) => { e.preventDefault(); if (providerId.trim()) void add(providerId); }}>
          <label className="field grow"><span className="small">Or paste an ElevenLabs voice ID</span>
            <input className="input" value={providerId} onChange={(e) => setProviderId(e.target.value)} placeholder="e.g. JBFqnCBsd6RMkjVDRZzb" maxLength={60} spellCheck={false} autoComplete="off" />
          </label>
          <button type="submit" className="btn primary" disabled={!!busy || !providerId.trim()}>{busy === providerId && <Spinner label="Adding" />}Add</button>
        </form>
        {problem && <p className="notice bad small" role="alert">{problem}</p>}
      </div>
    </Modal>
  );
}

/** Name, description, gender, accent and age as people see them; the ElevenLabs voice behind it. */
function EditVoiceModal({ voice, onClose, onSaved }: { voice: AdminVoice; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [form, setForm] = useState({ name: voice.name, description: voice.description, gender: voice.gender as string, accent: voice.accent, age: voice.age, providerId: voice.providerId });
  const [busy, setBusy] = useState(false);
  const close = useStableCallback(onClose);
  const set = (p: Partial<typeof form>) => setForm((f) => ({ ...f, ...p }));
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await patch(`/admin/voices/${voice.id}`, { ...form, name: form.name.trim(), providerId: form.providerId.trim() });
      toast("Saved.", "good");
      onSaved();
    } catch (err) {
      toast(errorText(err), "bad");
      setBusy(false);
    }
  };
  return (
    <Modal title={`Edit ${voice.name}`} onClose={close}>
      <form className="stack" onSubmit={save}>
        <label className="field"><span>Name</span><input className="input" value={form.name} onChange={(e) => set({ name: e.target.value })} maxLength={60} required /></label>
        <label className="field">
          <span>Description</span>
          <input className="input" value={form.description} onChange={(e) => set({ description: e.target.value })} maxLength={120} placeholder="e.g. Warm storyteller" />
          <span className="hint">Shown next to the name where people choose a voice.</span>
        </label>
        <div className="form-row">
          <label className="field"><span>Gender</span>
            <select className="select" value={form.gender} onChange={(e) => set({ gender: e.target.value })}>
              {Object.entries(genders).map(([k, n]) => <option key={k} value={k}>{k ? n : "Not set"}</option>)}
            </select>
          </label>
          <label className="field"><span>Accent</span><input className="input" value={form.accent} onChange={(e) => set({ accent: e.target.value })} maxLength={40} placeholder="e.g. British" /></label>
          <label className="field"><span>Age</span><input className="input" value={form.age} onChange={(e) => set({ age: e.target.value })} maxLength={30} placeholder="e.g. Middle-aged" /></label>
        </div>
        <label className="field">
          <span>ElevenLabs voice ID</span>
          <input className="input" value={form.providerId} onChange={(e) => set({ providerId: e.target.value })} maxLength={40} spellCheck={false} autoComplete="off" />
          <span className="hint">Change it only to put another ElevenLabs voice behind this one (for example when ElevenLabs removed it). Its ID, {voice.id}, stays.</span>
        </label>
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={close}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy || !form.name.trim()}>{busy && <Spinner label="Saving" />}Save</button>
        </div>
      </form>
    </Modal>
  );
}
