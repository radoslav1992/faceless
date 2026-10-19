import { useEffect, useState, type FormEvent } from "react";
import { ArrowDown, ArrowUp, Check, Link2, Pencil, Plus, RefreshCw, Search, Trash2, UserRound } from "lucide-react";
import { Modal, Spinner, Switch, useToast } from "../ui";
import { api, del, errorText, patch, post, reloadAvatars, useApi } from "../lib";
import { ConfirmDialog, Empty, useStableCallback } from "./pickers";
import { AvatarFace } from "./presenter-ui";
import { presenterQualityInfo, type Avatar, type PresenterQuality } from "../../shared/presenter";

// Admin → Presenters (server/avatars.ts): the AI presenters people can put on camera. They come from HeyGen: its stock
// avatars (offered after confirming the HeyGen plan allows it) or the account's own avatars, linked by ID (made in
// HeyGen from a consenting person). Each is offered in the qualities its HeyGen engines allow; a used one can only
// be hidden, never deleted.

type AdminAvatar = Avatar & { lookId: string; engines: string[]; stock: boolean; active: boolean; sort: number; usage: number; createdAt: number };
type StockLook = { id: string; name: string; gender: Avatar["gender"]; tags: string[]; qualities: PresenterQuality[]; added: string | null; image: string | null; page: string | null };
const genders: Record<string, string> = { female: "Female", male: "Male", "": "—" };
const qualityChips = (qualities: PresenterQuality[]) => qualities.map((q) => <span key={q} className={`chip${q === "high" ? " green" : ""}`}>{presenterQualityInfo[q].name}</span>);

export function AvatarsTab() {
  const toast = useToast();
  const { data, loading, error, reload, setData } = useApi<{ avatars: AdminAvatar[]; enabled: boolean }>("/admin/avatars");
  const [adding, setAdding] = useState<null | "stock" | "link">(null);
  const [editing, setEditing] = useState<AdminAvatar | null>(null);
  const [deleting, setDeleting] = useState<AdminAvatar | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  const avatars = data?.avatars || [];
  const changed = () => { reloadAvatars(); void reload(); };
  const update = async (a: AdminAvatar, changes: Record<string, unknown>, done = "Saved.") => {
    try {
      await patch(`/admin/avatars/${a.id}`, changes);
      changed();
      toast(done, "good");
    } catch (e) {
      toast(errorText(e), "bad");
    }
  };
  const check = async (a: AdminAvatar) => {
    setChecking(a.id);
    try {
      const { avatar } = await post<{ avatar: AdminAvatar }>(`/admin/avatars/${a.id}/check`, {});
      changed();
      toast(avatar.qualities.length ? `${a.name}: ${avatar.qualities.map((q) => presenterQualityInfo[q].name.toLowerCase()).join(" and ")} quality.` : `HeyGen can't animate ${a.name} with Avatar IV or V any more.`, avatar.qualities.length ? "good" : "bad");
    } catch (e) {
      toast(errorText(e), "bad");
    } finally {
      setChecking(null);
    }
  };
  // Moving an avatar swaps its place with its neighbour's.
  const move = async (index: number, by: -1 | 1) => {
    const a = avatars[index], b = avatars[index + by];
    if (!a || !b || a.active !== b.active || !data) return;
    const sa = a.sort === b.sort ? a.sort + by : b.sort, sb = a.sort;
    setData({ ...data, avatars: avatars.map((v, i) => (i === index ? b : i === index + by ? a : v)) });
    try {
      await patch(`/admin/avatars/${a.id}`, { sort: sa });
      await patch(`/admin/avatars/${b.id}`, { sort: sb });
    } catch (e) {
      toast(errorText(e), "bad");
    }
    changed();
  };
  return (
    <div className="stack" style={{ gap: 20 }}>
      <section aria-labelledby="avatars-title">
        <div className="section-head">
          <div>
            <h2 id="avatars-title">Presenters</h2>
            <p className="muted small" style={{ margin: 0 }}>
              The AI presenters people can put on camera in their videos, in this order. They speak the video's ElevenLabs voice, animated by HeyGen. Hidden presenters
              aren't offered, but videos that have one keep it.
            </p>
          </div>
          <div className="row wrap" style={{ gap: 8 }}>
            <button type="button" className="btn" disabled={!data?.enabled} onClick={() => setAdding("link")}><Link2 size={16} aria-hidden="true" />Link my own avatar</button>
            <button type="button" className="btn primary" disabled={!data?.enabled} onClick={() => setAdding("stock")}><Plus size={16} aria-hidden="true" />Add from HeyGen</button>
          </div>
        </div>
        {data && !data.enabled && (
          <p className="notice warn small">Presenters aren't offered: set the <code>HEYGEN_API_KEY</code> secret of the Worker (Cloudflare → Workers → Settings → Variables and secrets) to your HeyGen API key, then add avatars here.</p>
        )}
        {loading ? <div className="loading-page"><Spinner label="Loading presenters" /></div> : error ? (
          <div className="notice bad" role="alert">{error} <button type="button" className="link" onClick={() => void reload()}>Try again</button></div>
        ) : !avatars.length ? (
          <Empty icon={<UserRound size={24} />} title="No presenters yet" action={data?.enabled ? <button type="button" className="btn primary" onClick={() => setAdding("stock")}>Add from HeyGen</button> : undefined}>
            Add HeyGen's stock avatars, or link avatars of your HeyGen account. People see the presenter option once at least one is offered.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <caption className="sr-only">Presenters</caption>
              <thead><tr><th scope="col">Presenter</th><th scope="col">Qualities</th><th scope="col">Used by</th><th scope="col">Offered</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {avatars.map((a, i) => (
                  <tr key={a.id} className={a.active ? undefined : "muted"}>
                    <td>
                      <div className="row" style={{ gap: 10, flexWrap: "nowrap" }}>
                        <AvatarFace avatar={a} className="sm" />
                        <span style={{ minWidth: 0 }}>
                          <span className="clip" style={{ fontWeight: 600 }}>{a.name}</span>
                          <span className="small muted" style={{ display: "block" }}>{[genders[a.gender] !== "—" ? genders[a.gender] : "", a.stock ? "HeyGen stock" : "Own avatar"].filter(Boolean).join(" · ")}</span>
                          <span className="small muted" style={{ display: "block" }}>HeyGen {a.lookId}</span>
                        </span>
                      </div>
                    </td>
                    <td><span className="row wrap" style={{ gap: 4 }}>{a.qualities.length ? qualityChips(a.qualities) : <span className="small ops-bad">None</span>}</span></td>
                    <td className="small">{a.usage} video{a.usage === 1 ? "" : "s"}</td>
                    <td><Switch checked={a.active} onChange={(on) => void update(a, { active: on }, on ? `${a.name} is offered.` : `${a.name} is hidden.`)} label={`${a.name} is offered`} /></td>
                    <td>
                      <div className="icon-actions">
                        <button type="button" className="btn icon ghost" onClick={() => void move(i, -1)} disabled={i === 0 || avatars[i - 1].active !== a.active} aria-label={`Move ${a.name} up`} title="Move up"><ArrowUp size={16} /></button>
                        <button type="button" className="btn icon ghost" onClick={() => void move(i, 1)} disabled={i === avatars.length - 1 || avatars[i + 1].active !== a.active} aria-label={`Move ${a.name} down`} title="Move down"><ArrowDown size={16} /></button>
                        <button type="button" className="btn icon ghost" onClick={() => void check(a)} disabled={!data?.enabled || checking === a.id} aria-label={`Check ${a.name}'s qualities with HeyGen`} title="Check with HeyGen">
                          {checking === a.id ? <Spinner label="Checking" /> : <RefreshCw size={16} />}
                        </button>
                        <button type="button" className="btn icon ghost" onClick={() => setEditing(a)} aria-label={`Edit ${a.name}`} title="Edit"><Pencil size={16} /></button>
                        <button type="button" className="btn icon ghost danger" onClick={() => setDeleting(a)} aria-label={`Delete ${a.name}`} title="Delete"><Trash2 size={16} /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {adding === "stock" && <StockModal onClose={() => setAdding(null)} onAdded={(a) => { changed(); toast(`${a.name} was added and is offered now.`, "good"); }} />}
      {adding === "link" && <LinkModal onClose={() => setAdding(null)} onAdded={(a) => { setAdding(null); changed(); toast(`${a.name} was added and is offered now.`, "good"); }} />}
      {editing && <EditAvatarModal avatar={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); changed(); }} />}
      {deleting && (
        <ConfirmDialog title="Delete this presenter?" onClose={() => setDeleting(null)} onConfirm={async () => {
          await del(`/admin/avatars/${deleting.id}`);
          changed();
          toast("Deleted.", "good");
        }}>
          <p><strong>{deleting.name}</strong> leaves the list (the avatar stays in HeyGen). Only presenters no video uses can be deleted; to stop offering one, hide it instead.</p>
        </ConfirmDialog>
      )}
    </div>
  );
}

const rightsText = "My HeyGen plan lets me offer this avatar to the people who use this site, as an AI presenter of their videos.";
/** HeyGen's stock avatars, a page of 50 at a time: pick one, confirm the plan allows offering it, add it. */
function StockModal({ onClose, onAdded }: { onClose: () => void; onAdded: (a: AdminAvatar) => void }) {
  const [looks, setLooks] = useState<StockLook[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [gender, setGender] = useState<Avatar["gender"]>("");
  const [highOnly, setHighOnly] = useState(false);
  const [chosen, setChosen] = useState<StockLook | null>(null);
  const [rights, setRights] = useState(false);
  const [busy, setBusy] = useState(false);
  const close = useStableCallback(onClose);
  const load = async (page: string | null) => {
    setLoading(true);
    setProblem(null);
    try {
      const r = await api<{ looks: Omit<StockLook, "page">[]; nextPage: string | null }>(`/admin/avatars/stock${page ? `?page=${encodeURIComponent(page)}` : ""}`);
      setLooks((l) => [...l, ...r.looks.filter((x) => !l.some((y) => y.id === x.id)).map((x) => ({ ...x, page }))]);
      setNext(r.nextPage);
    } catch (e) {
      setProblem(errorText(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(null); }, []);
  const add = async () => {
    if (!chosen) return;
    setBusy(true);
    setProblem(null);
    try {
      const { avatar } = await post<{ avatar: AdminAvatar }>("/admin/avatars/stock", { lookId: chosen.id, page: chosen.page, rightsConfirmed: rights });
      setLooks((l) => l.map((x) => (x.id === chosen.id ? { ...x, added: avatar.id } : x)));
      setChosen(null);
      setRights(false);
      onAdded(avatar);
    } catch (e) {
      setProblem(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const q = query.trim().toLowerCase();
  const shown = looks.filter((l) => (!gender || l.gender === gender) && (!highOnly || l.qualities.includes("high")) && (!q || `${l.name} ${l.tags.join(" ")}`.toLowerCase().includes(q)));
  return (
    <Modal title="Add a presenter from HeyGen" onClose={close} wide footer={
      <div className="stock-foot">
        {chosen && <label className="check small"><input type="checkbox" checked={rights} onChange={(e) => setRights(e.target.checked)} /> {rightsText}</label>}
        <span className="grow" />
        <button type="button" className="btn" onClick={close}>Done</button>
        <button type="button" className="btn primary" disabled={!chosen || !rights || busy} onClick={() => void add()}>
          {busy ? <Spinner label="Adding" /> : <Check size={16} aria-hidden="true" />}{chosen ? `Add ${chosen.name}` : "Add"}
        </button>
      </div>
    }>
      <div className="stack">
        <p className="small muted" style={{ margin: 0 }}>
          HeyGen's stock avatars. Check what your HeyGen plan allows before you offer one: people's videos show it speaking their words. Its preview picture is copied here;
          “HQ” avatars can also be offered in high quality (Avatar V).
        </p>
        <div className="pick-toolbar">
          <label className="search">
            <Search size={16} aria-hidden="true" />
            <span className="sr-only">Search the avatars loaded</span>
            <input className="input" type="search" placeholder="Search by name or tag" value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
          <span className="filter-group" role="group" aria-label="Gender">
            <button type="button" className="chip button" aria-pressed={!gender} onClick={() => setGender("")}>All</button>
            <button type="button" className="chip button" aria-pressed={gender === "female"} onClick={() => setGender(gender === "female" ? "" : "female")}>Female</button>
            <button type="button" className="chip button" aria-pressed={gender === "male"} onClick={() => setGender(gender === "male" ? "" : "male")}>Male</button>
          </span>
          <button type="button" className="chip button" aria-pressed={highOnly} onClick={() => setHighOnly(!highOnly)}>HQ only</button>
        </div>
        {problem && <p className="notice bad small" role="alert">{problem}</p>}
        {!shown.length && !loading ? <p className="small muted">No avatars{q || gender || highOnly ? " match these filters among the ones loaded" : ""}.</p> : (
          <div className="pick-grid avatar-grid" style={{ maxHeight: 440, overflowY: "auto" }}>
            {shown.map((l) => (
              <button key={l.id} type="button" className="pick-item tall" aria-pressed={chosen?.id === l.id} disabled={!!l.added || !l.qualities.length}
                onClick={() => { setChosen(l); setRights(false); }} aria-label={`${l.name}${l.added ? ", already added" : !l.qualities.length ? ", can't be animated with Avatar IV or V" : ""}`}>
                {l.image ? <img className="avatar-face" src={l.image} alt="" loading="lazy" /> : <span className="avatar-face blank" aria-hidden="true">{l.name[0]}</span>}
                {chosen?.id === l.id && <span className="pick-check"><Check size={15} aria-hidden="true" /></span>}
                <span className="pick-badges">
                  {l.added && <span className="chip solid small">Added</span>}
                  {l.qualities.includes("high") && <span className="chip solid small">HQ</span>}
                </span>
                <span className="pick-name">{l.name}</span>
              </button>
            ))}
          </div>
        )}
        <div className="row" style={{ justifyContent: "center" }}>
          {loading ? <Spinner label="Loading HeyGen's avatars" /> : next && <button type="button" className="btn sm" onClick={() => void load(next)}>Load more</button>}
        </div>
      </div>
    </Modal>
  );
}

/** One of the HeyGen account's own avatars (or any avatar ID), with the confirmation that it may be offered. */
function LinkModal({ onClose, onAdded }: { onClose: () => void; onAdded: (a: AdminAvatar) => void }) {
  const [lookId, setLookId] = useState("");
  const [rights, setRights] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const close = useStableCallback(() => { if (!busy) onClose(); });
  const add = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      onAdded((await post<{ avatar: AdminAvatar }>("/admin/avatars/link", { lookId: lookId.trim(), rightsConfirmed: rights })).avatar);
    } catch (err) {
      setProblem(errorText(err));
      setBusy(false);
    }
  };
  return (
    <Modal title="Link my own avatar" onClose={close}>
      <form className="stack" onSubmit={add}>
        <p className="small muted" style={{ margin: 0 }}>
          An avatar of your HeyGen account (Avatars → the avatar → its look ID). Only offer avatars of people who agreed to be offered as a presenter here — never a
          likeness of someone who didn't.
        </p>
        <label className="field"><span>HeyGen avatar (look) ID</span>
          <input className="input" value={lookId} onChange={(e) => setLookId(e.target.value)} maxLength={160} spellCheck={false} autoComplete="off" required />
        </label>
        <label className="check small"><input type="checkbox" checked={rights} onChange={(e) => setRights(e.target.checked)} /> The person in this avatar agreed to it being offered here, and my HeyGen plan allows it.</label>
        {problem && <p className="notice bad small" role="alert">{problem}</p>}
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={close} disabled={busy}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy || !lookId.trim() || !rights}>{busy && <Spinner label="Adding" />}Add</button>
        </div>
      </form>
    </Modal>
  );
}

/** The name and gender people see; the HeyGen avatar behind it stays. */
function EditAvatarModal({ avatar, onClose, onSaved }: { avatar: AdminAvatar; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [name, setName] = useState(avatar.name);
  const [gender, setGender] = useState<string>(avatar.gender);
  const [busy, setBusy] = useState(false);
  const close = useStableCallback(onClose);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await patch(`/admin/avatars/${avatar.id}`, { name: name.trim(), gender });
      toast("Saved.", "good");
      onSaved();
    } catch (err) {
      toast(errorText(err), "bad");
      setBusy(false);
    }
  };
  return (
    <Modal title={`Edit ${avatar.name}`} onClose={close}>
      <form className="stack" onSubmit={save}>
        <label className="field"><span>Name</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required /></label>
        <label className="field"><span>Gender</span>
          <select className="select" value={gender} onChange={(e) => setGender(e.target.value)}>
            {Object.entries(genders).map(([k, n]) => <option key={k} value={k}>{k ? n : "Not set"}</option>)}
          </select>
          <span className="hint">People can filter presenters by it.</span>
        </label>
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={close}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy || !name.trim()}>{busy && <Spinner label="Saving" />}Save</button>
        </div>
      </form>
    </Modal>
  );
}
