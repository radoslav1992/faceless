import { useState } from "react";
import { Link } from "react-router-dom";
import { Check } from "lucide-react";
import { useAuth } from "../lib";
import { Faq } from "./Landing";
import { BEST_SAVING, creditPacks, paidPlans, planById, plans, PRICE_NOTE, tariffs, TRIAL_DAYS, type Interval } from "../../shared/plans";

// Pricing: the plans (monthly or yearly), credit packs, what credits buy and the questions people ask about them.

const money = (n: number) => (Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`);
/** The paid plans as cards with a monthly / yearly switch; `onChoose` (in the app) replaces the sign-up links. */
export function PlanCards({ current, currentInterval, onChoose, busy }: {
  current?: string; currentInterval?: Interval; onChoose?: (plan: string, interval: Interval) => void; busy?: string | null;
}) {
  const { user } = useAuth();
  const [interval, setInterval] = useState<Interval>(currentInterval || "month");
  return (
    <div className="stack" style={{ gap: 28, alignItems: "center" }}>
      <div className="billing-toggle" role="group" aria-label="Billing period">
        <button type="button" aria-pressed={interval === "month"} onClick={() => setInterval("month")}>Monthly</button>
        <button type="button" aria-pressed={interval === "year"} onClick={() => setInterval("year")}>Annual <span className="save">Save {BEST_SAVING}%</span></button>
      </div>
      <div className="plans" style={{ width: "100%" }}>
        {paidPlans.map((id) => {
          const p = planById(id);
          const monthly = interval === "year" ? p.yearly / 12 : p.monthly;
          const mine = current === id && (!currentInterval || currentInterval === interval);
          return (
            <div key={id} className={`plan${p.popular ? " popular" : ""}`}>
              {p.popular && <span className="ribbon">Most popular</span>}
              <h3>{p.name}</h3>
              <div className="price"><strong>{money(Math.round(monthly * 100) / 100)}</strong><span>/ mo</span></div>
              <p className="per">{p.credits} credits / mo{interval === "year" ? ` · ${money(p.yearly)} billed yearly` : ""}</p>
              <ul>{p.features.map((f) => <li key={f}><Check size={16} aria-hidden="true" />{f}</li>)}</ul>
              {onChoose ? (
                <button type="button" className={`btn block${p.popular ? " primary" : ""}`} disabled={mine || busy === id} onClick={() => onChoose(id, interval)}>
                  {busy === id ? <span className="spinner" aria-hidden="true" /> : null}{mine ? "Your plan" : `Get ${p.name}`}
                </button>
              ) : (
                <Link className={`btn block${p.popular ? " primary" : ""}`} to={user ? "/app/billing" : "/register"}>Get {p.name}</Link>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Credit packs for subscribers. */
export function CreditPacks({ onBuy, busy, allowed }: { onBuy?: (pack: string) => void; busy?: string | null; allowed?: boolean }) {
  return (
    <div className="packs">
      <div>
        <h3 style={{ fontSize: 20 }}>Need more credits?</h3>
        <p className="muted small" style={{ marginTop: 4 }}>Subscribers can add credits at any time without changing their plan. They roll over like the plan's own.</p>
      </div>
      {creditPacks.map((p) => (
        <div key={p.id} className="pack">
          <div><strong>{p.credits} credits</strong><small>{money(Math.round((p.price / p.credits) * 100) / 100)} per credit</small></div>
          <div className="row">
            <span className="amount">{money(p.price)}</span>
            {onBuy && <button type="button" className="btn sm primary" disabled={!allowed || busy === p.id} onClick={() => onBuy(p.id)}>{busy === p.id ? <span className="spinner" aria-hidden="true" /> : "Buy"}</button>}
          </div>
        </div>
      ))}
      {!onBuy && <Link className="btn block" to="/register">Choose a plan</Link>}
    </div>
  );
}

const pricingFaq: [string, string][] = [
  ["What is a credit?", "Credits pay for making videos. A new video costs 1 credit per started 30 seconds of narration — so a one-minute video is 2 credits — with the script, the voice and every picture included."],
  ["Do unused credits roll over?", "Yes. Whatever you don't use carries into the next month while your plan runs, up to three months' worth of your plan's credits plus any packs you bought."],
  ["Can I mix video types on one plan?", "Yes. Every plan includes every video type, art style, voice and language. Credits work the same for all of them."],
  ["What happens if I run out of credits?", "Nothing breaks. Series skip their next episodes until credits are back (we e-mail you), and you can add a credit pack or upgrade at any time."],
  ["What do edits cost?", "Changing words on screen, subtitles, music, transitions or timing is free. Only new AI work costs credits: new narration for changed words (1 credit per 30 seconds), new pictures (1 credit per 5) and animated scenes (1 credit per 5 seconds)."],
  [`What does the free trial include?`, `${planById("free").credits} credits to try every video type, one series and one social account, for ${TRIAL_DAYS} days. No card needed. Trial videos carry a small watermark.`],
];

export function Pricing() {
  const { user } = useAuth();
  return (
    <>
      <div className="pub-wrap">
        <div className="pub-head center">
          <span className="kicker">Pricing</span>
          <h1 className="title" style={{ marginTop: 12 }}>Choose how often you post</h1>
          <p className="lead">Plans differ only in how many videos they make. Every video type, voice and art style is included.</p>
        </div>
        <PlanCards />
        <CreditPacks />
        <p className="price-note">{PRICE_NOTE} Free trial: {plans[0].features.slice(0, 2).join(", ").toLowerCase()}.</p>
      </div>
      <section className="pub-section tight">
        <div className="pub-wrap">
          <div className="pub-section-head center"><h2 className="title">What credits buy</h2></div>
          <div className="tariffs">{tariffs.map((t) => <div key={t.name} className="tariff"><strong>{t.name}</strong><p>{t.text}</p></div>)}</div>
        </div>
      </section>
      <section className="pub-section tight">
        <div className="pub-wrap">
          <div className="pub-section-head center"><h2 className="title">Questions about pricing</h2></div>
          <Faq items={pricingFaq} />
        </div>
      </section>
      <section className="pub-section tight">
        <div className="pub-wrap">
          <div className="cta-band glowing">
            <div><h2>Ready to start creating?</h2><p>Pick a plan, or try it free and make your first video in minutes.</p></div>
            <Link className="btn primary big" to={user ? "/app/billing" : "/register"}>{user ? "Choose a plan" : "Start for free"}</Link>
          </div>
        </div>
      </section>
    </>
  );
}
