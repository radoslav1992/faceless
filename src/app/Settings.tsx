import { useEffect, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { AlertTriangle, Check, Copy, KeyRound, Plug, Plus, Trash2, UserRound } from "lucide-react";
import { Spinner, useToast } from "../ui";
import { del, errorText, patch, post, relative, useApi, useAuth } from "../lib";
import { WITHDRAWAL_DAYS } from "../../shared/withdrawal";
import { ConfirmDialog, useSignedInUser, useStableCallback } from "./pickers";
import "./pages.css";

/** Settings: the account (name, password, deletion) and API keys for the REST API and MCP. */
export function SettingsPage() {
  const { hash } = useLocation();
  // The MCP page links to #api-keys: bring that section into view.
  useEffect(() => {
    if (hash === "#api-keys") document.getElementById("api-keys")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [hash]);
  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p>Your account, and keys for connecting AI assistants and your own tools.</p>
        </div>
      </div>
      <div className="settings">
        <AccountSection />
        <PasswordSection />
        <ApiKeysSection />
        <DangerSection />
      </div>
    </main>
  );
}

function AccountSection() {
  const user = useSignedInUser();
  const { refresh } = useAuth();
  const toast = useToast();
  const [name, setName] = useState(user.name);
  const [busy, setBusy] = useState(false);
  const changed = name.trim() !== user.name && !!name.trim();
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!changed) return;
    setBusy(true);
    try {
      await patch("/settings/profile", { name: name.trim() });
      await refresh();
      toast("Your name is saved.", "good");
    } catch (err) {
      toast(errorText(err), "bad");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card" aria-labelledby="account-title">
      <div className="card-head"><div><h2 id="account-title"><UserRound size={18} aria-hidden="true" style={{ verticalAlign: -2, marginRight: 6 }} />Account</h2><p>How we address you.</p></div></div>
      <form className="form-grid" onSubmit={save}>
        <label className="field">
          <span>Name</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoComplete="name" required />
        </label>
        <div className="field">
          <label className="label" htmlFor="account-email">Email {user.verified ? <span className="chip green"><Check size={12} aria-hidden="true" />Confirmed</span> : <span className="chip orange">Not confirmed</span>}</label>
          <input id="account-email" className="input" value={user.email} readOnly aria-describedby="account-email-hint" style={{ background: "var(--surface-2)" }} />
          <span id="account-email-hint" className="hint">To change your email, contact us from the <Link to="/contact" className="link">contact page</Link>.</span>
        </div>
        <div className="full row">
          <button type="submit" className="btn primary" disabled={!changed || busy}>{busy && <Spinner label="Saving" />}Save name</button>
        </div>
      </form>
    </section>
  );
}

function PasswordSection() {
  const user = useSignedInUser();
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setProblem(null);
    if (!current) return setProblem("Enter your current password.");
    if (password.length < 10) return setProblem("Use at least 10 characters for your new password.");
    if (password !== confirm) return setProblem("The new passwords don't match.");
    if (password === current) return setProblem("Choose a password different from your current one.");
    setBusy(true);
    try {
      await post("/settings/password", { current, password });
      setCurrent(""); setPassword(""); setConfirm("");
      toast("Password changed. Other devices were signed out.", "good");
    } catch (err) {
      setProblem(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card" aria-labelledby="password-title">
      <div className="card-head"><div><h2 id="password-title"><KeyRound size={18} aria-hidden="true" style={{ verticalAlign: -2, marginRight: 6 }} />Password</h2><p>Changing it signs you out everywhere else.</p></div></div>
      <form className="form-grid" onSubmit={submit} noValidate>
        {/* Lets password managers attach the change to the right account. */}
        <input type="text" name="username" autoComplete="username" value={user.email} readOnly hidden />
        <label className="field full">
          <span>Current password</span>
          <input className="input" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" maxLength={128} />
        </label>
        <label className="field">
          <span>New password</span>
          <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={10} maxLength={128} aria-describedby="new-password-hint" />
          <span id="new-password-hint" className="hint">At least 10 characters.</span>
        </label>
        <label className="field">
          <span>Repeat new password</span>
          <input className="input" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" maxLength={128} />
        </label>
        {problem && <div className="notice bad full" role="alert">{problem}</div>}
        <div className="full row">
          <button type="submit" className="btn primary" disabled={busy || !current || !password || !confirm}>{busy && <Spinner label="Saving" />}Change password</button>
        </div>
      </form>
    </section>
  );
}

type ApiKey = { id: string; name: string; prefix: string; lastUsedAt: number | null; createdAt: number };

/** Personal API keys: shown once when made, then only their first characters. */
function ApiKeysSection() {
  const user = useSignedInUser();
  const toast = useToast();
  const { data, reload } = useApi<{ keys: ApiKey[] }>("/keys");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<ApiKey | null>(null);
  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const r = await post<{ secret: string }>("/keys", { name: name.trim() });
      setSecret(r.secret);
      setName("");
      await reload();
    } catch (err) {
      toast(errorText(err), "bad");
    } finally {
      setBusy(false);
    }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(secret || ""); toast("Copied.", "good"); }
    catch { toast("Couldn't copy. Select the key and copy it yourself.", "bad"); }
  };
  return (
    <section className="card" id="api-keys" aria-labelledby="keys-title">
      <div className="card-head">
        <div>
          <h2 id="keys-title"><Plug size={18} aria-hidden="true" style={{ verticalAlign: -2, marginRight: 6 }} />API keys</h2>
          <p>Let an AI assistant (over MCP) or your own scripts make videos for you. A key can do what you can, with your credits. <Link to="/mcp" className="link">How to connect</Link></p>
        </div>
      </div>
      {secret && (
        <div className="notice good stack" role="status" style={{ marginBottom: 14 }}>
          <strong>Copy your new key now. It won't be shown again.</strong>
          <div className="field-row">
            <input className="input grow" value={secret} readOnly onFocus={(e) => e.target.select()} aria-label="New API key" style={{ fontFamily: "ui-monospace, monospace" }} />
            <button type="button" className="btn" onClick={() => void copy()}><Copy size={16} aria-hidden="true" />Copy</button>
          </div>
          <button type="button" className="btn sm ghost" style={{ justifySelf: "start" }} onClick={() => setSecret(null)}>Done</button>
        </div>
      )}
      {data?.keys.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th scope="col">Name</th><th scope="col">Key</th><th scope="col">Last used</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {data.keys.map((k) => (
                <tr key={k.id}>
                  <td>{k.name}</td>
                  <td><code>{k.prefix}…</code></td>
                  <td className="muted">{k.lastUsedAt ? relative(k.lastUsedAt) : "Never"}</td>
                  <td style={{ textAlign: "right" }}><button type="button" className="btn icon ghost danger" onClick={() => setDeleting(k)} aria-label={`Delete ${k.name}`} title="Delete"><Trash2 size={16} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className="muted small">No API keys yet.</p>}
      <form className="field-row" onSubmit={create} style={{ marginTop: 16 }}>
        <label className="grow">
          <span className="sr-only">Key name</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="What it's for, e.g. Claude" disabled={!user.verified} />
        </label>
        <button type="submit" className="btn primary" disabled={!name.trim() || busy || !user.verified}>{busy ? <Spinner label="Creating" /> : <Plus size={16} aria-hidden="true" />}Create key</button>
      </form>
      {!user.verified && <p className="hint" style={{ marginTop: 8 }}>Confirm your email to create API keys.</p>}
      {deleting && (
        <ConfirmDialog title={`Delete ${deleting.name}?`} confirmLabel="Delete key" onClose={() => setDeleting(null)}
          onConfirm={async () => { await del(`/keys/${deleting.id}`); await reload(); toast("Key deleted. Anything using it stops working.", "good"); }}>
          <p>Assistants and scripts using this key lose access straight away.</p>
        </ConfirmDialog>
      )}
    </section>
  );
}

function DangerSection() {
  const user = useSignedInUser();
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const close = useStableCallback(() => { setOpen(false); setPassword(""); });
  const remove = async () => {
    if (!password) throw new Error("Enter your password to confirm.");
    await del("/settings/account", { password });
    toast("Your account was deleted. We're sorry to see you go.", "good");
    // Leave the signed-in pages first, so they don't redirect to the sign-in page once the account is gone.
    navigate("/", { replace: true });
    await refresh();
  };
  return (
    <section className="card danger-card" aria-labelledby="danger-title">
      <div className="card-head">
        <div>
          <h2 id="danger-title"><AlertTriangle size={18} aria-hidden="true" style={{ verticalAlign: -2, marginRight: 6, color: "var(--red)" }} />Danger zone</h2>
          <p>Delete your account with every series, video and file. A paid plan is cancelled at once, without a refund of the rest of the period.</p>
        </div>
        <button type="button" className="btn danger" onClick={() => setOpen(true)}><Trash2 size={16} aria-hidden="true" />Delete account</button>
      </div>
      {open && (
        <ConfirmDialog title="Delete your account?" confirmLabel="Delete my account" disabled={!password} onClose={close} onConfirm={remove}>
          <p>Everything is deleted for good: series, videos, files, connected channels and API keys. Videos already posted stay on the networks. Any paid plan is cancelled now.</p>
          {user.hasSubscription && (
            <p className="notice warn">
              Subscribed in the last {WITHDRAWAL_DAYS} days and want a refund? <Link to="/contact?topic=withdrawal" className="link">Ask to withdraw</Link> before
              you delete your account: deleting cancels the plan without a refund.
            </p>
          )}
          <label className="field">
            <span>Your password</span>
            <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          </label>
        </ConfirmDialog>
      )}
    </section>
  );
}
