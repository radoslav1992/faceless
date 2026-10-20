import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AlertTriangle, ArrowRight, Check, Clock, CreditCard, Gift, Undo2 } from "lucide-react";
import { Modal, Spinner, useToast } from "../ui";
import { errorText, newKey, number, post, timeLeft, useApi, useAuth } from "../lib";
import { PlanCards, CreditPacks } from "../public/Pricing";
import { PRICE_NOTE, planById, planIncludes, tariffs, type Interval, type PaidPlanId } from "../../shared/plans";
import { IMMEDIATE_START_TEXT, WITHDRAWAL_DAYS } from "../../shared/withdrawal";
import { PRODUCT } from "../../shared/brand";
import { formatDate, useSignedInUser } from "./pickers";
import { CallOffer } from "./CallOffer";
import "./pages.css";

/** Billing: the plan and its credits, plan changes through Stripe Checkout / Customer Portal, and credit packs. */
export function BillingPage() {
  const user = useSignedInUser();
  const { refresh } = useAuth();
  const toast = useToast();
  const config = useApi<{ billingEnabled: boolean }>("/public/config");
  const [params, setParams] = useSearchParams();
  const [busy, setBusy] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  // A first checkout asks for the express request to start at once (the server refuses checkout without it).
  const [confirming, setConfirming] = useState<{ plan: PaidPlanId; interval: Interval } | null>(null);

  // Back from Stripe: re-read the subscription, then the account (once, even in development's double effects).
  const handled = useRef(false);
  useEffect(() => {
    if (handled.current) return;
    const success = params.get("success") === "1", topup = params.get("topup") === "1", portal = params.get("portal") === "1", cancelled = params.get("cancelled") === "1";
    if (!success && !topup && !portal && !cancelled) return;
    handled.current = true;
    setParams({}, { replace: true });
    if (cancelled) {
      toast("Checkout cancelled. Nothing was charged.");
      return;
    }
    setSyncing(true);
    void (async () => {
      try {
        if (!topup) await post("/billing/sync");
        // Credit packs are added when Stripe confirms the payment, usually within seconds.
        if (topup) await new Promise((r) => setTimeout(r, 2500));
        await refresh();
        toast(success ? "Thank you! Your plan is active." : topup ? "Thank you! Your credits are being added." : "Your billing details are up to date.", "good");
      } catch {
        await refresh();
        toast("We're confirming your payment with the bank. Your plan updates within a minute.", "info");
      } finally {
        setSyncing(false);
      }
    })();
  }, [params, setParams, refresh, toast]);

  const enabled = config.data?.billingEnabled ?? false;
  const plan = planById(user.plan);
  const free = user.plan === "free";
  const go = async (key: string, request: () => Promise<{ url: string }>) => {
    setBusy(key);
    try {
      const { url } = await request();
      window.location.assign(url);
    } catch (e) {
      toast(errorText(e), "bad");
      setBusy(null);
    }
  };
  const portal = (target?: PaidPlanId, interval: Interval = "month") =>
    go(target ? target : "portal", () => post<{ url: string }>("/billing/portal", target ? { plan: target, interval } : {}));
  const choose = (target: string, interval: Interval) => {
    if (!enabled) return toast("Payments open soon.", "info");
    if (!user.verified) return toast("Confirm your email before subscribing.", "bad");
    if (user.hasSubscription) return void portal(target as PaidPlanId, interval);
    setConfirming({ plan: target as PaidPlanId, interval });
  };
  const checkout = (c: { plan: PaidPlanId; interval: Interval }) =>
    go(c.plan, () => post<{ url: string }>("/billing/checkout", { plan: c.plan, interval: c.interval, immediateStart: true }));
  const buy = (pack: string) => go(pack, () => post<{ url: string }>("/billing/topup", { pack, idempotencyKey: newKey() }));
  const granted = !!user.granted && !!user.periodEnd;
  const left = Math.max(0, user.limit - user.used);
  const share = user.limit ? Math.min(1, user.used / user.limit) : 0;
  const subscriber = !free && !user.trialEnded;

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>Billing</h1>
          <p>Your plan, your credits, and more when you need them.</p>
        </div>
        <div className="toolbar">
          {syncing && <span className="chip" role="status"><Spinner label="Updating" />Updating your plan…</span>}
          {user.hasSubscription && (
            <button type="button" className="btn" onClick={() => void portal()} disabled={!!busy}>
              {busy === "portal" ? <Spinner label="Opening" /> : <CreditCard size={16} aria-hidden="true" />}Manage billing
            </button>
          )}
        </div>
      </div>

      {user.paymentIssue && (
        <div className="notice bad row wrap" role="alert" style={{ marginBottom: 16 }}>
          <AlertTriangle size={18} aria-hidden="true" />
          <span className="grow">Your last payment didn't go through. Update your card to keep your plan; we'll retry it automatically.</span>
          {user.hasSubscription && <button type="button" className="btn sm" onClick={() => void portal()} disabled={!!busy}>Update payment method</button>}
        </div>
      )}
      {granted && (
        <div className="notice good row wrap" role="note" style={{ marginBottom: 16 }}>
          <Gift size={18} aria-hidden="true" />
          <span className="grow">
            You have <strong>{plan.name}</strong> free until {formatDate(user.periodEnd!)}, from the {PRODUCT.name} team. No payment is needed. After that you go
            back to {user.hasSubscription ? "your paid plan" : "the free trial"} unless you choose a plan.
          </span>
        </div>
      )}
      {!config.loading && !enabled && (
        <div className="notice warn" role="note" style={{ marginBottom: 16 }}>
          <strong>Payments open soon.</strong> Paid plans aren't available yet; keep using your free trial meanwhile.
        </div>
      )}
      {enabled && !user.verified && (
        <div className="notice warn" role="note" style={{ marginBottom: 16 }}>Confirm your email before subscribing. We sent you a link when you signed up.</div>
      )}

      <section className="card" aria-labelledby="current-plan">
        <div className="card-head">
          <div>
            <span className="small muted">Current plan</span>
            <h2 id="current-plan" style={{ fontSize: 26, marginTop: 2 }}>
              {plan.name}
              {!free && <span className="muted" style={{ fontSize: 16, fontWeight: 500, fontFamily: "var(--font)" }}> · {granted ? "free month" : user.interval === "year" ? `$${plan.yearly}/year` : `$${plan.monthly}/month`}</span>}
            </h2>
            <p>
              {free
                ? user.trialEnded || !user.trialEndsAt
                  ? "Your free trial has ended. Your videos are still here; choose a plan to keep making new ones."
                  : <><Clock size={14} aria-hidden="true" style={{ verticalAlign: -2 }} /> Free trial · {timeLeft(user.trialEndsAt)} (until {formatDate(user.trialEndsAt)})</>
                : user.renewsAt
                  ? `New credits on ${formatDate(user.renewsAt)}. What you don't use rolls over.`
                  : plan.description}
            </p>
          </div>
          {free && user.trialEnded && <span className="chip red">Trial ended</span>}
          {granted && <span className="chip green">Free month</span>}
        </div>
        <div className="usage">
          <div className="stack" style={{ gap: 8 }}>
            <div className="usage-label"><span><strong>Credits</strong></span><span>{number(left)} left</span></div>
            <div className={`meter${share >= 1 ? " bad" : share > 0.85 ? " warn" : ""}`} role="progressbar" aria-label="Credits used" aria-valuemin={0} aria-valuemax={user.limit} aria-valuenow={Math.min(user.used, user.limit)}>
              <span style={{ width: `${Math.max(user.used ? 2 : 0, share * 100)}%` }} />
            </div>
            <span className="small muted">
              {number(user.used)} of {number(user.limit)} used
              {(user.carried > 0 || user.topped > 0) && ` · includes ${[user.carried > 0 && `${number(user.carried)} rolled over`, user.topped > 0 && `${number(user.topped)} from packs`].filter(Boolean).join(" and ")}`}
            </span>
          </div>
          <div className="stack" style={{ gap: 6 }}>
            <div className="usage-label"><span>Series on autopilot</span><span>{plan.series}</span></div>
            <div className="usage-label"><span>Social channels</span><span>{plan.accounts}</span></div>
            <div className="usage-label"><span>Storage</span><span>{plan.storageGb} GB</span></div>
            <div className="usage-label"><span>Watermark</span><span>{free ? "Small watermark" : "None"}</span></div>
          </div>
        </div>
      </section>

      <section className="section" aria-labelledby="plans-title">
        <div className="section-head">
          <div>
            <h2 id="plans-title">{free ? "Choose a plan" : "Change plan"}</h2>
            <p>{PRICE_NOTE} Cancel any time.{user.hasSubscription && " Changes open the secure billing portal to confirm."}</p>
          </div>
        </div>
        <PlanCards current={free ? undefined : user.plan} currentInterval={free ? undefined : user.interval} busy={busy} onChoose={choose} />
      </section>

      <section className="section" aria-label="Credit packs">
        <CreditPacks allowed={enabled && subscriber && user.verified} busy={busy} onBuy={(pack) => void buy(pack)} />
        {!subscriber && <p className="hint" style={{ marginTop: 8 }}>Credit packs are for subscribers: choose a plan first.</p>}
      </section>

      <div className="section"><CallOffer place="billing" /></div>

      {user.hasSubscription && (
        <section className="section card row wrap" aria-labelledby="withdraw-title" style={{ alignItems: "center", gap: 16 }}>
          <Undo2 size={22} aria-hidden="true" style={{ color: "var(--muted)", flex: "none" }} />
          <div className="grow" style={{ minWidth: 220 }}>
            <h2 id="withdraw-title" style={{ fontSize: 18 }}>Changed your mind?</h2>
            <p className="muted small" style={{ marginTop: 4 }}>
              Within {WITHDRAWAL_DAYS} days of subscribing you can withdraw: we end the plan and refund what you paid, less the share of the credits you used.
              {" "}<Link to="/terms#withdrawal" className="link">How it works</Link>
            </p>
          </div>
          <Link to="/contact?topic=withdrawal" className="btn">Ask to withdraw<ArrowRight size={16} aria-hidden="true" /></Link>
        </section>
      )}

      <section className="section grid two" style={{ alignItems: "start" }}>
        <div className="card">
          <h2 style={{ marginBottom: 14, fontSize: 18 }}>Every plan includes</h2>
          <ul className="list-plain includes one">{planIncludes.map((f) => <li key={f}><Check size={16} aria-hidden="true" />{f}</li>)}</ul>
        </div>
        <div className="card">
          <h2 style={{ marginBottom: 14, fontSize: 18 }}>What credits buy</h2>
          <ul className="list-plain stack" style={{ gap: 10 }}>{tariffs.map((t) => <li key={t.name} className="small"><strong>{t.name}.</strong> <span className="muted">{t.text}</span></li>)}</ul>
        </div>
      </section>
      {confirming && (
        <CheckoutConfirm choice={confirming} busy={busy === confirming.plan} onClose={() => { if (!busy) setConfirming(null); }} onConfirm={() => void checkout(confirming)} />
      )}
    </main>
  );
}

/**
 * Before a first checkout: the plan, its price and renewal, and the consumer's express request for the plan to start
 * at once (required; the server records it, repeats it on Stripe's page and confirms it by email).
 */
function CheckoutConfirm({ choice, busy, onClose, onConfirm }: { choice: { plan: PaidPlanId; interval: Interval }; busy: boolean; onClose: () => void; onConfirm: () => void }) {
  const [agreed, setAgreed] = useState(false);
  const p = planById(choice.plan), yearly = choice.interval === "year";
  return (
    <Modal title={`${p.name} · ${yearly ? `$${p.yearly} a year` : `$${p.monthly} a month`}`} onClose={onClose} footer={
      <>
        <button type="button" className="btn" onClick={onClose} disabled={busy}>Back</button>
        <button type="button" className="btn primary" onClick={onConfirm} disabled={!agreed || busy}>{busy && <Spinner label="Opening checkout" />}Continue to payment<ArrowRight size={16} aria-hidden="true" /></button>
      </>
    }>
      <div className="stack">
        <p>
          {p.credits} credits every month{yearly ? ", billed once a year" : ""}. {PRICE_NOTE} The plan renews every {yearly ? "year" : "month"} until you cancel it
          here in Billing. You pay on Stripe's secure page.
        </p>
        <label className="check">
          <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
          <span>{IMMEDIATE_START_TEXT}</span>
        </label>
        <p className="small muted">
          More: <Link to="/terms#withdrawal" className="link" target="_blank" rel="noopener">your right to withdraw</Link> ·{" "}
          <Link to="/terms" className="link" target="_blank" rel="noopener">Terms of Service</Link>
        </p>
      </div>
    </Modal>
  );
}
