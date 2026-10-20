import { useState, type FormEvent } from "react";
import { Check, Copy, HandCoins, Link2, Pencil } from "lucide-react";
import { Spinner, useToast } from "../ui";
import { errorText, patch, post, useApi, useAuth } from "../lib";
import { Empty, formatDate } from "./pickers";
import { AFFILIATE_HOLD_DAYS, AFFILIATE_MIN_PAYOUT, AFFILIATE_MONTHS, AFFILIATE_RATE } from "../../shared/growth";
import { PRODUCT } from "../../shared/brand";
import "./pages.css";

// The affiliate program (server/affiliates.ts): join with a PayPal address, share the link, see what it earned.
// Affiliates see counts and amounts only, never who their customers are.

type Commission = { id: string; kind: "plan" | "pack" | "reversal"; amount: number; commission: number; currency: string; status: "held" | "available" | "paid" | "void"; createdAt: number; availableAt: number };
type Data = {
  affiliate: { code: string; status: "active" | "paused"; payoutEmail: string; clicks: number; createdAt: number } | null;
  signups?: number; customers?: number;
  balances?: { held: number; available: number; paid: number };
  commissions?: Commission[];
  payouts?: { id: string; amount: number; currency: string; createdAt: number }[];
};
const money = (cents: number, currency = "usd") => (cents / 100).toLocaleString("en-US", { style: "currency", currency: currency.toUpperCase() });
const kindNames: Record<Commission["kind"], string> = { plan: "Plan payment", pack: "Credit pack", reversal: "Refund taken back" };
const percent = `${Math.round(AFFILIATE_RATE * 100)}%`;

export function Affiliate() {
  const { data, loading, error, reload } = useApi<Data>("/affiliate");
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Earn {percent} for {AFFILIATE_MONTHS} months</h1>
          <p>Recommend {PRODUCT.name} with your link: you earn {percent} of what each customer you bring pays in their first {AFFILIATE_MONTHS} months.</p>
        </div>
      </div>
      {loading ? <div className="loading-page"><Spinner label="Loading" /></div> : error || !data ? (
        <div className="notice bad" role="alert">{error || "Not available."} <button type="button" className="link" onClick={() => void reload()}>Try again</button></div>
      ) : data.affiliate ? <Dashboard data={data as Required<Data>} reload={reload} /> : <Join onJoined={() => void reload()} />}
    </div>
  );
}

function Join({ onJoined }: { onJoined: () => void }) {
  const { user } = useAuth();
  const toast = useToast();
  const [email, setEmail] = useState(user?.email || "");
  const [accept, setAccept] = useState(false);
  const [busy, setBusy] = useState(false);
  const join = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await post("/affiliate/join", { payoutEmail: email.trim(), acceptTerms: accept });
      toast("You're in. Share your link!", "good");
      onJoined();
    } catch (err) {
      toast(errorText(err), "bad");
      setBusy(false);
    }
  };
  return (
    <div className="grid two" style={{ alignItems: "start" }}>
      <section className="card stack">
        <h2 style={{ fontSize: 20 }}>How it works</h2>
        <ul className="stack small" style={{ margin: 0, paddingLeft: 18 }}>
          <li>Share your link. Whoever signs up through it is your customer (they see your code at sign-up and pay the same).</li>
          <li>You earn {percent} of everything they pay for plans and credit packs, without tax, for {AFFILIATE_MONTHS} months from their first payment.</li>
          <li>Each commission is held {AFFILIATE_HOLD_DAYS} days, for refunds. A refund lowers it, or takes it back from your next payout.</li>
          <li>We pay by PayPal once a month when your available balance is {money(AFFILIATE_MIN_PAYOUT)} or more.</li>
          <li>Be honest: no spam, no ads on our name, no promises of earnings or views, and say it's an affiliate link where the law asks you to.</li>
        </ul>
      </section>
      <form className="card stack" onSubmit={join}>
        <h2 style={{ fontSize: 20 }}>Join</h2>
        <label className="field"><span>PayPal email for payouts</span>
          <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={254} required autoComplete="email" />
        </label>
        <label className="check small">
          <input type="checkbox" checked={accept} onChange={(e) => setAccept(e.target.checked)} required />
          <span>I accept the <a className="text-link" href="/terms#affiliates" target="_blank" rel="noreferrer">affiliate terms</a>.</span>
        </label>
        {!user?.verified && <p className="notice warn small">Confirm your email first: we sent you a link when you signed up.</p>}
        <button type="submit" className="btn primary" disabled={busy || !accept || !email.trim() || !user?.verified}>{busy && <Spinner label="Joining" />}Get my link</button>
      </form>
    </div>
  );
}

function Dashboard({ data, reload }: { data: Required<Data>; reload: () => Promise<void> }) {
  const toast = useToast();
  const a = data.affiliate!;
  const link = `${location.origin}/r/${a.code}`;
  const [editing, setEditing] = useState<null | "code" | "email">(null);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(link); toast("Link copied.", "good"); }
    catch { toast("Couldn't copy. Select the link and copy it yourself.", "bad"); }
  };
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await patch("/affiliate", editing === "code" ? { code: value.trim().toLowerCase() } : { payoutEmail: value.trim() });
      toast(editing === "code" ? "Your link changed. Old links no longer work." : "Saved.", "good");
      setEditing(null);
      await reload();
    } catch (err) {
      toast(errorText(err), "bad");
    } finally {
      setBusy(false);
    }
  };
  const b = data.balances;
  const status = (c: Commission) => c.status === "held" ? `On hold until ${formatDate(c.availableAt)}` : c.status === "available" ? "Available" : c.status === "paid" ? "Paid" : "Cancelled (refunded)";
  return (
    <div className="stack" style={{ gap: 22 }}>
      {a.status === "paused" && <p className="notice warn">Your affiliate account is paused: new customers don't earn commissions. Contact us if you think this is a mistake.</p>}
      <section className="card stack" aria-labelledby="link-title">
        <h2 id="link-title" style={{ fontSize: 18 }}><Link2 size={18} aria-hidden="true" /> Your link</h2>
        <div className="row wrap" style={{ gap: 8 }}>
          <input className="input grow" value={link} readOnly aria-label="Your affiliate link" onFocus={(e) => e.target.select()} />
          <button type="button" className="btn primary" onClick={() => void copy()}><Copy size={16} aria-hidden="true" />Copy</button>
        </div>
        <p className="small muted" style={{ margin: 0 }}>
          It opens the home page; your code <strong>{a.code}</strong> goes into the sign-up form. You can also add <code>?ref={a.code}</code> to any page's address, or
          give people the code to type in.
        </p>
        {editing ? (
          <form className="row wrap" style={{ gap: 8, alignItems: "flex-end" }} onSubmit={save}>
            <label className="field grow"><span className="small">{editing === "code" ? "New code" : "PayPal email for payouts"}</span>
              <input className="input" value={value} onChange={(e) => setValue(e.target.value)} maxLength={editing === "code" ? 24 : 254} type={editing === "email" ? "email" : "text"} required spellCheck={false} />
            </label>
            <button type="button" className="btn" onClick={() => setEditing(null)}>Cancel</button>
            <button type="submit" className="btn primary" disabled={busy || !value.trim()}>{busy && <Spinner label="Saving" />}Save</button>
          </form>
        ) : (
          <div className="row wrap small" style={{ gap: 14 }}>
            <button type="button" className="link" onClick={() => { setValue(a.code); setEditing("code"); }}><Pencil size={13} aria-hidden="true" /> Change code</button>
            <span className="muted">Payouts to {a.payoutEmail}</span>
            <button type="button" className="link" onClick={() => { setValue(a.payoutEmail); setEditing("email"); }}><Pencil size={13} aria-hidden="true" /> Change</button>
          </div>
        )}
      </section>
      <div className="grid three">
        <div className="card stat"><span className="muted small">Visits through your link</span><strong>{a.clicks}</strong><span className="small muted">once a day per visitor</span></div>
        <div className="card stat"><span className="muted small">Sign-ups</span><strong>{data.signups}</strong><span className="small muted">with your code</span></div>
        <div className="card stat"><span className="muted small">Paying customers</span><strong>{data.customers}</strong><span className="small muted">so far</span></div>
      </div>
      <div className="grid three">
        <div className="card stat"><span className="muted small">On hold</span><strong>{money(b.held)}</strong><span className="small muted">{AFFILIATE_HOLD_DAYS} days after each payment</span></div>
        <div className="card stat"><span className="muted small">Available</span><strong>{money(b.available)}</strong><span className="small muted">{b.available >= AFFILIATE_MIN_PAYOUT ? "in the next payout" : `paid from ${money(AFFILIATE_MIN_PAYOUT)}`}</span></div>
        <div className="card stat"><span className="muted small">Paid to you</span><strong>{money(b.paid)}</strong><span className="small muted">{data.payouts.length} payout{data.payouts.length === 1 ? "" : "s"}</span></div>
      </div>
      <section aria-labelledby="commissions-title">
        <h2 id="commissions-title" style={{ fontSize: 18, marginBottom: 10 }}>Commissions</h2>
        {!data.commissions.length ? (
          <Empty icon={<HandCoins size={24} />} title="No commissions yet">When someone you brought pays for a plan or credits, it shows up here.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <caption className="sr-only">Commissions</caption>
              <thead><tr><th scope="col">Date</th><th scope="col">For</th><th scope="col">They paid</th><th scope="col">You earn</th><th scope="col">Status</th></tr></thead>
              <tbody>
                {data.commissions.map((c) => (
                  <tr key={c.id} className={c.status === "void" ? "muted" : undefined}>
                    <td className="small">{formatDate(c.createdAt)}</td>
                    <td className="small">{kindNames[c.kind]}</td>
                    <td className="small">{c.kind === "reversal" ? "—" : money(c.amount, c.currency)}</td>
                    <td><strong>{money(c.commission, c.currency)}</strong></td>
                    <td className="small">{c.status === "paid" && <Check size={13} aria-hidden="true" />} {status(c)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
