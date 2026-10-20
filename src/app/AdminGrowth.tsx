import { useState } from "react";
import { HandCoins, PhoneCall } from "lucide-react";
import { Modal, Spinner, Switch, useToast } from "../ui";
import { errorText, patch, post, useApi } from "../lib";
import { ConfirmDialog, Empty, formatDate, useStableCallback } from "./pickers";
import { AFFILIATE_HOLD_DAYS, AFFILIATE_MONTHS, AFFILIATE_RATE, CALL_MINUTES } from "../../shared/growth";

// Admin → Growth: the affiliates (balances, their commissions, recording a payout sent by PayPal) and the calls for
// credits (mark a call done with its notes, which adds the credits, or missed). server/affiliates.ts, server/calls.ts.

type AdminAffiliate = {
  id: string; email: string; name: string; code: string; status: "active" | "paused"; payoutEmail: string; clicks: number; signups: number; customers: number;
  held: number; available: number; paid: number; createdAt: number;
};
type AdminCommission = { id: string; kind: string; amount: number; commission: number; currency: string; status: string; createdAt: number; availableAt: number; customer: string };
type Call = { userId: string; email: string; name: string; plan: string; status: "requested" | "done" | "missed"; credits: number; notes: string; requestedAt: number; doneAt: number | null };
const money = (cents: number, currency = "usd") => (cents / 100).toLocaleString("en-US", { style: "currency", currency: currency.toUpperCase() });

export function GrowthTab() {
  return (
    <div className="stack" style={{ gap: 28 }}>
      <AffiliatesSection />
      <CallsSection />
    </div>
  );
}

function AffiliatesSection() {
  const toast = useToast();
  const { data, loading, error, reload } = useApi<{ affiliates: AdminAffiliate[]; minPayout: number }>("/admin/affiliates");
  const [open, setOpen] = useState<AdminAffiliate | null>(null);
  const [paying, setPaying] = useState<AdminAffiliate | null>(null);
  const setStatus = async (a: AdminAffiliate, active: boolean) => {
    try {
      await patch(`/admin/affiliates/${a.id}`, { status: active ? "active" : "paused" });
      toast(active ? `${a.code} earns again.` : `${a.code} is paused: new payments earn nothing.`, "good");
      void reload();
    } catch (e) {
      toast(errorText(e), "bad");
    }
  };
  const list = data?.affiliates || [];
  return (
    <section aria-labelledby="affiliates-title">
      <div className="section-head">
        <div>
          <h2 id="affiliates-title">Affiliates</h2>
          <p className="muted small" style={{ margin: 0 }}>
            They earn {Math.round(AFFILIATE_RATE * 100)}% of their customers' payments for {AFFILIATE_MONTHS} months, held {AFFILIATE_HOLD_DAYS} days. Pay the available balances by PayPal once a month (from {money(data?.minPayout ?? 5000)}), then record each payout here.
          </p>
        </div>
      </div>
      {loading ? <Spinner label="Loading affiliates" /> : error ? <p className="notice bad" role="alert">{error}</p> : !list.length ? (
        <Empty icon={<HandCoins size={24} />} title="No affiliates yet">Customers join from “Earn 30%” in the app.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <caption className="sr-only">Affiliates</caption>
            <thead><tr><th scope="col">Affiliate</th><th scope="col">Visits · sign-ups · customers</th><th scope="col">On hold</th><th scope="col">Available</th><th scope="col">Paid</th><th scope="col">Earning</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {list.map((a) => (
                <tr key={a.id}>
                  <td>
                    <span className="clip" style={{ fontWeight: 600 }}>{a.code}</span>
                    <span className="small muted" style={{ display: "block" }}>{a.email} · pays to {a.payoutEmail}</span>
                  </td>
                  <td className="small">{a.clicks} · {a.signups} · {a.customers}</td>
                  <td className="small">{money(a.held)}</td>
                  <td><strong className={a.available >= (data?.minPayout ?? 5000) ? "accent-text" : undefined}>{money(a.available)}</strong></td>
                  <td className="small">{money(a.paid)}</td>
                  <td><Switch checked={a.status === "active"} onChange={(on) => void setStatus(a, on)} label={`${a.code} earns commissions`} /></td>
                  <td>
                    <div className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
                      <button type="button" className="btn sm" onClick={() => setOpen(a)}>Commissions</button>
                      <button type="button" className="btn sm primary" disabled={a.available <= 0} onClick={() => setPaying(a)}>Record payout</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && <CommissionsModal affiliate={open} onClose={() => setOpen(null)} />}
      {paying && <PayoutDialog affiliate={paying} onClose={() => setPaying(null)} onPaid={() => { setPaying(null); void reload(); }} />}
    </section>
  );
}

function CommissionsModal({ affiliate, onClose }: { affiliate: AdminAffiliate; onClose: () => void }) {
  const { data, loading } = useApi<{ commissions: AdminCommission[]; payouts: { id: string; amount: number; currency: string; paidTo: string; reference: string; createdAt: number }[] }>(`/admin/affiliates/${affiliate.id}`);
  const close = useStableCallback(onClose);
  return (
    <Modal title={`Commissions of ${affiliate.code}`} onClose={close} wide>
      {loading || !data ? <Spinner label="Loading" /> : (
        <div className="stack">
          {!data.commissions.length ? <p className="small muted">No commissions yet.</p> : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th scope="col">Date</th><th scope="col">Customer</th><th scope="col">For</th><th scope="col">Paid</th><th scope="col">Commission</th><th scope="col">Status</th></tr></thead>
                <tbody>
                  {data.commissions.map((c) => (
                    <tr key={c.id} className={c.status === "void" ? "muted" : undefined}>
                      <td className="small">{formatDate(c.createdAt)}</td>
                      <td className="small">{c.customer}</td>
                      <td className="small">{c.kind === "plan" ? "Plan" : c.kind === "pack" ? "Credit pack" : "Refund taken back"}</td>
                      <td className="small">{c.kind === "reversal" ? "—" : money(c.amount, c.currency)}</td>
                      <td>{money(c.commission, c.currency)}</td>
                      <td className="small">{c.status === "held" ? `held until ${formatDate(c.availableAt)}` : c.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {data.payouts.length > 0 && (
            <>
              <h3 style={{ fontSize: 15, margin: "8px 0 0" }}>Payouts</h3>
              <ul className="list-plain small">
                {data.payouts.map((p) => <li key={p.id}>{formatDate(p.createdAt)} · {money(p.amount, p.currency)} to {p.paidTo}{p.reference ? ` · ${p.reference}` : ""}</li>)}
              </ul>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}

function PayoutDialog({ affiliate, onClose, onPaid }: { affiliate: AdminAffiliate; onClose: () => void; onPaid: () => void }) {
  const toast = useToast();
  const [reference, setReference] = useState("");
  return (
    <ConfirmDialog title={`Record a payout to ${affiliate.code}`} confirmLabel={`Record ${money(affiliate.available)}`} danger={false} onClose={onClose}
      onConfirm={async () => {
        await post(`/admin/affiliates/${affiliate.id}/payouts`, { expected: affiliate.available, reference: reference.trim() });
        toast(`Recorded ${money(affiliate.available)} paid to ${affiliate.payoutEmail}.`, "good");
        onPaid();
      }}>
      <p>
        First send <strong>{money(affiliate.available)}</strong> to <strong>{affiliate.payoutEmail}</strong> by PayPal. Recording it marks every available commission
        as paid.
      </p>
      <label className="field"><span className="small">PayPal transaction ID (optional)</span>
        <input className="input" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={200} />
      </label>
    </ConfirmDialog>
  );
}

function CallsSection() {
  const toast = useToast();
  const { data, loading, error, reload } = useApi<{ calls: Call[]; enabled: boolean; credits: number }>("/admin/calls");
  const [closing, setClosing] = useState<{ call: Call; outcome: "done" | "missed" | "notes" } | null>(null);
  const list = data?.calls || [];
  return (
    <section aria-labelledby="calls-title">
      <div className="section-head">
        <div>
          <h2 id="calls-title">Calls for credits</h2>
          <p className="muted small" style={{ margin: 0 }}>
            Customers book a {CALL_MINUTES}-minute call on your scheduling page. After it, mark it done with your notes: that adds {data?.credits ?? 30} credits once per account and emails them.
          </p>
        </div>
      </div>
      {data && !data.enabled && <p className="notice warn small">Not offered: set the <code>CALL_BOOKING_URL</code> variable of the Worker to your scheduling page (Cal.com, Calendly…).</p>}
      {loading ? <Spinner label="Loading calls" /> : error ? <p className="notice bad" role="alert">{error}</p> : !list.length ? (
        <Empty icon={<PhoneCall size={24} />} title="No calls yet">Booked calls appear here, newest first.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <caption className="sr-only">Calls</caption>
            <thead><tr><th scope="col">Customer</th><th scope="col">Plan</th><th scope="col">Booked</th><th scope="col">Status</th><th scope="col">Notes</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {list.map((c) => (
                <tr key={c.userId}>
                  <td><span className="clip" style={{ fontWeight: 600 }}>{c.name}</span><span className="small muted" style={{ display: "block" }}>{c.email}</span></td>
                  <td className="small">{c.plan}</td>
                  <td className="small">{formatDate(c.requestedAt, true)}</td>
                  <td className="small">{c.status === "done" ? `Done · ${c.credits} credits` : c.status === "missed" ? "Missed" : "Booked"}</td>
                  <td className="small" style={{ maxWidth: 280 }}><span className="clip">{c.notes || "—"}</span></td>
                  <td>
                    <div className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
                      {c.status !== "done" && <button type="button" className="btn sm primary" onClick={() => setClosing({ call: c, outcome: "done" })}>Done</button>}
                      {c.status === "requested" && <button type="button" className="btn sm" onClick={() => setClosing({ call: c, outcome: "missed" })}>Missed</button>}
                      {c.status === "done" && <button type="button" className="btn sm" onClick={() => setClosing({ call: c, outcome: "notes" })}>Notes</button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {closing && <CallModal call={closing.call} outcome={closing.outcome} credits={data?.credits ?? 30} onClose={() => setClosing(null)}
        onSaved={(message) => { setClosing(null); toast(message, "good"); void reload(); }} />}
    </section>
  );
}

function CallModal({ call, outcome, credits, onClose, onSaved }: { call: Call; outcome: "done" | "missed" | "notes"; credits: number; onClose: () => void; onSaved: (message: string) => void }) {
  const toast = useToast();
  const [notes, setNotes] = useState(call.notes);
  const [busy, setBusy] = useState(false);
  const close = useStableCallback(() => { if (!busy) onClose(); });
  const save = async () => {
    setBusy(true);
    try {
      if (outcome === "notes") await patch(`/admin/calls/${call.userId}`, { notes });
      else {
        const r = await post<{ emailed?: boolean }>(`/admin/calls/${call.userId}/${outcome}`, { notes });
        if (outcome === "done" && r.emailed === false) toast("Credits added, but the email couldn't be sent.", "bad");
      }
      onSaved(outcome === "done" ? `${credits} credits added to ${call.email}.` : outcome === "missed" ? "Marked missed: they can book again." : "Notes saved.");
    } catch (e) {
      toast(errorText(e), "bad");
      setBusy(false);
    }
  };
  return (
    <Modal title={outcome === "done" ? `Call with ${call.name}: done` : outcome === "missed" ? `Call with ${call.name}: missed` : `Notes: ${call.name}`} onClose={close}>
      <div className="stack">
        {outcome === "done" && <p className="small" style={{ margin: 0 }}>Adds <strong>{credits} credits</strong> to {call.email} (once per account) and emails them.</p>}
        <label className="field"><span className="small">Notes</span>
          <textarea className="textarea" rows={7} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={4000}
            placeholder="What they make, what got in their way, what they'd pay for, what to build next" />
        </label>
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={close} disabled={busy}>Cancel</button>
          <button type="button" className="btn primary" onClick={() => void save()} disabled={busy}>{busy && <Spinner label="Saving" />}{outcome === "done" ? `Done · add ${credits} credits` : outcome === "missed" ? "Mark missed" : "Save notes"}</button>
        </div>
      </div>
    </Modal>
  );
}
