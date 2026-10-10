import Stripe from "stripe";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { creditPacks, intervals, packById, paidPlans, planById, plans, ROLLOVER_MONTHS, TRIAL_DAYS, type Interval, type PaidPlanId, type PlanId } from "../shared/plans";
import { IMMEDIATE_START_TEXT, IMMEDIATE_START_VERSION, WITHDRAWAL_DAYS } from "../shared/withdrawal";
import type { App, Env, DbUser } from "./types";
import { now, ready, uid, DAY, GB } from "./types";
import { hmac, origin, rate, sendMail, sha } from "./security";
import { writeState } from "./ops-state";
import { PRODUCT } from "../shared/brand";

export const billing = new Hono<App>();
export function stripe(env: Env) {
  if (!env.STRIPE_SECRET_KEY) throw new HTTPException(503, { message: "Payments are not set up yet." });
  return new Stripe(env.STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient(), maxNetworkRetries: 2 });
}
/** A renewing subscription keeps its last paid period this long while Stripe collects the new invoice. */
export const RENEWAL_GRACE = 3 * DAY;
/** Subscriptions an administrator granted (testers, partners): no Stripe behind them, see plan-grants.ts. */
export const GRANT_PREFIX = "grant_";

/**
 * Identifies a free allowance across account deletion without keeping the address: an HMAC of the mailbox keyed with
 * TRIAL_HASH_SECRET (a plain hash of a known address could be recomputed), or a plain hash when no secret is set.
 */
export async function trialKey(e: Env, email: string) {
  const box = "trial:" + mailbox(email);
  return e.TRIAL_HASH_SECRET ? hmac(e.TRIAL_HASH_SECRET, box) : sha(box);
}
/** Keeps the mailbox's trial row current (called on sign-in). */
export async function touchTrial(e: Env, email: string) {
  await e.DB.prepare("UPDATE trial_history SET updated_at=? WHERE email_hash=?").bind(now(), await trialKey(e, email)).run();
}
/** One mailbox, however it is written: "+tags" are ignored, and Gmail also ignores dots in the name. */
export function mailbox(email: string) {
  const [name, domain = ""] = email.trim().toLowerCase().split(/@(?=[^@]*$)/);
  const gmail = domain === "gmail.com" || domain === "googlemail.com";
  const base = name.replace(/\+.*$/, "");
  return `${gmail ? base.replace(/\./g, "") : base}@${gmail ? "gmail.com" : domain}`;
}
/** The configured Stripe price of a plan, billed monthly or yearly. */
function priceIds(e: Env, interval: Interval = "month"): Record<PaidPlanId, string | undefined> {
  return interval === "year"
    ? { starter: e.STRIPE_PRICE_STARTER_YEARLY, daily: e.STRIPE_PRICE_DAILY_YEARLY, double: e.STRIPE_PRICE_DOUBLE_YEARLY, studio: e.STRIPE_PRICE_STUDIO_YEARLY }
    : { starter: e.STRIPE_PRICE_STARTER, daily: e.STRIPE_PRICE_DAILY, double: e.STRIPE_PRICE_DOUBLE, studio: e.STRIPE_PRICE_STUDIO };
}
const DAY_MS = 86400000;
/**
 * The month of a paid period `t` falls in: monthly periods are one month (0); a yearly period is cut into calendar
 * months from its start, so its credits come month by month like a monthly plan's.
 */
export function periodMonth(start: number, end: number, t: number) {
  if (end - start <= 40 * DAY) return { index: 0, start, end };
  const from = new Date(start * 1000);
  const at = (n: number) => {
    const d = new Date(from.getTime());
    d.setUTCMonth(from.getUTCMonth() + n);
    // A start on the 31st falls back to the month's last day, as Stripe does.
    if (d.getUTCDate() !== from.getUTCDate()) d.setTime(d.getTime() - d.getUTCDate() * DAY_MS);
    return Math.floor(d.getTime() / 1000);
  };
  let index = 0;
  while (index < 12 && at(index + 1) <= t) index++;
  return { index, start: at(index), end: Math.min(end, at(index + 1)) };
}

export type Allowance = Awaited<ReturnType<typeof allowance>>;
/**
 * The account's plan and the usage window it spends credits from (`used`/`limit`). Each paid month has its own window
 * (user:subscription:period_start, and :n for the n-th month of a yearly period), which starts with the plan's credits
 * plus those rolled over; the free allowance is one lasting window (user:trial), once per mailbox. An administrator's
 * grant is a subscription row of its own (GRANT_PREFIX), so it gets a fresh window and ends by itself.
 */
export async function allowance(e: Env, u: DbUser) {
  // An incomplete subscription (a checkout that was abandoned or not paid yet) gives no access; ended grants never
  // count. A running grant wins over a paid subscription unless the customer pays for a higher plan.
  const rows = (await e.DB.prepare(
    "SELECT s.*,st.status AS stripe_status FROM subscriptions s LEFT JOIN stripe_status st ON st.subscription_id=s.id WHERE s.user_id=?1 AND s.status IN ('active','trialing','past_due','unpaid') AND NOT (substr(s.id,1,6)=?2 AND s.period_end<=?3) ORDER BY s.status='active' DESC, s.period_end DESC LIMIT 10",
  ).bind(u.id, GRANT_PREFIX, now()).all<any>()).results;
  const rank = (plan: string) => plans.findIndex((p) => p.id === plan);
  const grant = rows.find((r) => String(r.id).startsWith(GRANT_PREFIX));
  const paid = rows.find((r) => !String(r.id).startsWith(GRANT_PREFIX));
  const paidActive = paid?.status === "active" && paid.period_end + (paid.cancel_at_period_end ? 0 : RENEWAL_GRACE) > now();
  const sub = grant && !(paidActive && rank(paid.plan) > rank(grant.plan)) ? grant : paid || null;
  const granted = !!sub && sub === grant;
  // A renewing subscription keeps its last paid period until Stripe confirms the new invoice.
  const active = !!sub && sub.status === "active" && sub.period_end + (sub.cancel_at_period_end ? 0 : RENEWAL_GRACE) > now();
  const plan = planById(active ? sub.plan : "free");
  const month = active ? periodMonth(sub.period_start, sub.period_end, now()) : null;
  const window = active ? `${u.id}:${sub.id}:${sub.period_start}${month!.index ? `:${month!.index}` : ""}` : `${u.id}:trial`;
  // Same plan: the window keeps its quota. A downgrade inside a month uses the new plan's credits; an upgrade adds only
  // the unused share of the difference, so upgrading on the last day does not unlock a whole month. A grant's window
  // is always new, with the whole plan.
  const left = active && !granted && month!.end > month!.start
    ? Math.min(1, Math.max(0, (month!.end - now()) / (month!.end - month!.start))) : 1;
  const trial = await trialKey(e, u.email);
  const known = !!(await e.DB.prepare("SELECT 1 FROM usage_windows WHERE id=?").bind(window).first());
  // Unused credits roll over into a new paid month: from the month before (within 45 days, so a lapsed plan does not
  // bring back old credits), at most ROLLOVER_MONTHS of the plan's credits plus the credit packs bought then.
  // Only paid months take part: a free month (grant) starts with its full plan and leaves nothing behind.
  let carried = 0;
  if (active && !granted && !known) {
    const previous = await e.DB.prepare(
      "SELECT quota,used,topped FROM usage_windows WHERE user_id=? AND id<>? AND plan<>'free' AND instr(id,?)=0 AND created_at>? ORDER BY created_at DESC LIMIT 1",
    ).bind(u.id, window, `:${GRANT_PREFIX}`, now() - 45 * DAY).first<{ quota: number; used: number; topped: number }>();
    if (previous) carried = Math.max(0, Math.min(previous.quota - previous.used, plan.credits * ROLLOVER_MONTHS + previous.topped));
  }
  // The plan's own share of an existing window (its quota less what was carried in and bought).
  const base = "(usage_windows.quota-usage_windows.carried-usage_windows.topped)";
  await e.DB.batch([
    e.DB.prepare(
      `INSERT INTO usage_windows(id,user_id,plan,quota,carried,used,created_at) VALUES (?1,?2,?3,?4+?5,?5,
        CASE WHEN ?3='free' THEN COALESCE((SELECT used FROM trial_history WHERE email_hash=?6),0) ELSE 0 END,?8)
       ON CONFLICT(id) DO UPDATE SET plan=excluded.plan,quota=CASE
         WHEN usage_windows.plan=excluded.plan THEN usage_windows.quota
         WHEN ?4>${base} THEN usage_windows.quota+CAST((?4-${base})*?7 AS INTEGER)
         ELSE ?4+usage_windows.carried+usage_windows.topped END`,
    ).bind(window, u.id, plan.id, plan.credits, carried, trial, left, now()),
    // Storage follows the plan; files over a lower limit stay, new ones wait until there is room.
    e.DB.prepare("INSERT INTO media_limits(user_id,max_bytes) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET max_bytes=excluded.max_bytes")
      .bind(u.id, plan.storageGb * GB),
  ]);
  // The free allowance is once per mailbox: another account of the same address starts with it used up.
  if (!active && !known)
    await e.DB.prepare(
      "INSERT INTO trial_history(email_hash,used,updated_at) VALUES (?,?,?) ON CONFLICT(email_hash) DO UPDATE SET used=MAX(trial_history.used,excluded.used),updated_at=excluded.updated_at",
    ).bind(trial, plan.credits, now()).run();
  const usage = await e.DB.prepare("SELECT used,quota,carried,topped FROM usage_windows WHERE id=?")
    .bind(window).first<{ used: number; quota: number; carried: number; topped: number }>();
  const trialEndsAt = plan.id === "free" ? u.created_at + TRIAL_DAYS * DAY : null;
  return {
    plan: plan.id as PlanId,
    /** Free plan: new videos can be made until then. */
    trialEndsAt,
    trialEnded: trialEndsAt !== null && trialEndsAt <= now(),
    used: usage?.used || 0,
    limit: usage?.quota ?? plan.credits,
    /** Of the limit: credits rolled over from the month before, and credit packs bought this month. */
    carried: usage?.carried || 0,
    topped: usage?.topped || 0,
    window,
    /** When this month's credits renew (the end of the paid month), and when the paid period ends. */
    renewsAt: active ? month!.end : null,
    periodEnd: active ? (sub.period_end as number) : null,
    interval: (active && !granted && sub.period_end - sub.period_start > 40 * DAY ? "year" : "month") as Interval,
    /** A Stripe subscription (only those can be managed in the Customer Portal); a grant is not one. */
    hasSubscription: !!paid,
    /** The plan is an administrator's grant (until periodEnd), not a paid subscription. */
    granted: granted && active,
    /** Stripe reports the latest payment as failed (it retries the card meanwhile), or the period ended unpaid. */
    paymentIssue: !!paid && !granted && (["past_due", "unpaid"].includes(paid.stripe_status ?? paid.status) ||
      (paid.status === "active" && !paid.cancel_at_period_end && paid.period_end + RENEWAL_GRACE < now())),
  };
}

billing.post("/checkout", async (c) => {
  const u = c.get("user");
  if (!u.verified) throw new HTTPException(403, { message: "Confirm your email before subscribing." });
  if (c.env.BILLING_ENABLED !== "true" || !ready(c.env)) throw new HTTPException(503, { message: "Subscriptions are not open yet." });
  await rate(c, "checkout", 8, 3600, u.id);
  const parsed = z.object({ plan: z.enum(paidPlans), interval: z.enum(intervals).default("month"), immediateStart: z.boolean().optional() }).safeParse(await c.req.json());
  const interval = parsed.success ? parsed.data.interval : "month";
  // The choice is kept as "plan:interval" (checkout intents and consents).
  const requested = parsed.success ? `${parsed.data.plan}:${interval}` : null;
  let id = parsed.success ? priceIds(c.env, interval)[parsed.data.plan] : undefined;
  if (!requested || !id) throw new HTTPException(400, { message: "This plan is not available." });
  // The plan starts within the withdrawal period only at the consumer's express request (CRD Art. 14(3)).
  if (parsed.data?.immediateStart !== true)
    throw new HTTPException(400, { message: "Confirm that you want your plan to start straight after payment." });
  const s = stripe(c.env);
  let customer = u.stripe_customer;
  if (!customer) {
    const created = await s.customers.create({ email: u.email, name: u.name, metadata: { user_id: u.id } }, { idempotencyKey: "customer-" + u.id });
    customer = created.id;
    await c.env.DB.prepare("UPDATE users SET stripe_customer=? WHERE id=?").bind(customer, u.id).run();
  }
  const existing = await s.subscriptions.list({ customer, status: "all", limit: 100 });
  if (existing.data.some((x) => !["canceled", "incomplete_expired", "incomplete"].includes(x.status)))
    return c.json({ url: await portalUrl(c.env, c.req.raw, customer, parsed.data!.plan, interval) });
  // An unfinished earlier checkout is closed first so its invoice cannot still be paid next to a new one.
  for (const x of existing.data) if (x.status === "incomplete") await s.subscriptions.cancel(x.id);
  await c.env.DB.prepare(
    "INSERT INTO checkout_intents(user_id,plan,intent_id,expires_at) VALUES (?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET plan=excluded.plan,intent_id=excluded.intent_id,expires_at=excluded.expires_at WHERE checkout_intents.expires_at<?",
  ).bind(u.id, requested, uid(), now() + 1860, now()).run();
  const intent = await c.env.DB.prepare("SELECT * FROM checkout_intents WHERE user_id=?").bind(u.id).first<any>();
  if (intent.plan !== requested) {
    // Close the checkout for the earlier choice so only one subscription can ever be started.
    const open = await s.checkout.sessions.list({ customer, status: "open", limit: 100 });
    for (const session of open.data) await s.checkout.sessions.expire(session.id);
    intent.plan = requested;
    intent.intent_id = uid();
    await c.env.DB.prepare("UPDATE checkout_intents SET plan=?,intent_id=? WHERE user_id=?").bind(intent.plan, intent.intent_id, u.id).run();
  }
  const [plan, every] = String(intent.plan).split(":") as [PaidPlanId, Interval];
  id = priceIds(c.env, every)[plan];
  if (!id) throw new HTTPException(503, { message: "This plan is temporarily unavailable." });
  const p = await s.prices.retrieve(id);
  const chosen = planById(plan);
  if (!p.active || p.currency !== "usd" || p.unit_amount !== (every === "year" ? chosen.yearly : chosen.monthly) * 100 || p.recurring?.interval !== every || p.recurring.interval_count !== 1)
    throw new HTTPException(503, { message: "This plan is being updated. Please try again later." });
  const tax = c.env.STRIPE_AUTOMATIC_TAX === "true";
  const session = await s.checkout.sessions.create(
    {
      mode: "subscription",
      customer,
      expires_at: intent.expires_at,
      line_items: [{ price: id, quantity: 1 }],
      allow_promotion_codes: true,
      ...(tax && { automatic_tax: { enabled: true }, tax_id_collection: { enabled: true }, billing_address_collection: "required" as const, customer_update: { address: "auto" as const, name: "auto" as const } }),
      client_reference_id: u.id,
      // The request given on our page, repeated where the customer pays.
      custom_text: { submit: { message: IMMEDIATE_START_TEXT } },
      metadata: { user_id: u.id, immediate_start: IMMEDIATE_START_VERSION },
      subscription_data: { metadata: { user_id: u.id, immediate_start: IMMEDIATE_START_VERSION } },
      success_url: origin(c.env, c.req.raw) + "/app/billing?success=1",
      cancel_url: origin(c.env, c.req.raw) + "/app/billing?cancelled=1",
    },
    { idempotencyKey: `checkout-v2-${intent.intent_id}-${id}` },
  );
  // The consent for this checkout; it is confirmed by email once the payment completes.
  await c.env.DB.prepare("INSERT OR IGNORE INTO checkout_consents(session_id,user_id,plan,version,created_at) VALUES (?,?,?,?,?)")
    .bind(session.id, u.id, intent.plan, IMMEDIATE_START_VERSION, now()).run();
  return c.json({ url: session.url });
});
/**
 * A credit pack: a one-time payment, for active subscribers (their credits roll over like the plan's). Credits are
 * added when Stripe reports the payment (webhook, creditTopup), never on the redirect back.
 */
billing.post("/topup", async (c) => {
  const u = c.get("user");
  if (!u.verified) throw new HTTPException(403, { message: "Confirm your email before buying credits." });
  if (c.env.BILLING_ENABLED !== "true" || !ready(c.env)) throw new HTTPException(503, { message: "Payments are not open yet." });
  await rate(c, "topup", 10, 3600, u.id);
  const { pack: packId, idempotencyKey } = z.object({ pack: z.enum(creditPacks.map((p) => p.id) as [string, ...string[]]), idempotencyKey: z.uuid() }).parse(await c.req.json());
  const pack = packById(packId)!;
  const a = await allowance(c.env, u);
  if (a.plan === "free" || a.trialEnded === true) throw new HTTPException(402, { message: "Credit packs are for subscribers. Choose a plan first." });
  const s = stripe(c.env);
  let customer = u.stripe_customer;
  if (!customer) {
    const created = await s.customers.create({ email: u.email, name: u.name, metadata: { user_id: u.id } }, { idempotencyKey: "customer-" + u.id });
    customer = created.id;
    await c.env.DB.prepare("UPDATE users SET stripe_customer=? WHERE id=?").bind(customer, u.id).run();
  }
  const metadata = { user_id: u.id, kind: "topup", pack: pack.id, credits: String(pack.credits) };
  const session = await s.checkout.sessions.create(
    {
      mode: "payment",
      customer,
      line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: pack.price * 100, product_data: { name: `${pack.credits} credits — ${PRODUCT.name}` } } }],
      ...(c.env.STRIPE_AUTOMATIC_TAX === "true" && { automatic_tax: { enabled: true }, billing_address_collection: "required" as const, customer_update: { address: "auto" as const, name: "auto" as const } }),
      client_reference_id: u.id,
      custom_text: { submit: { message: "Credits are added to your account as soon as the payment goes through, and roll over while your plan runs." } },
      metadata,
      payment_intent_data: { metadata },
      success_url: origin(c.env, c.req.raw) + "/app/billing?topup=1",
      cancel_url: origin(c.env, c.req.raw) + "/app/billing?cancelled=1",
    },
    { idempotencyKey: `topup-${u.id}-${idempotencyKey}` },
  );
  return c.json({ url: session.url });
});
/** Adds a paid credit pack to the buyer's current month, once per Checkout session. */
export async function creditTopup(e: Env, session: Stripe.Checkout.Session) {
  const meta = session.metadata || {};
  const pack = packById(String(meta.pack || ""));
  if (meta.kind !== "topup" || !pack || session.payment_status !== "paid" || Number(meta.credits) !== pack.credits) return;
  const user = await e.DB.prepare("SELECT * FROM users WHERE id=?").bind(String(meta.user_id || "")).first<DbUser>();
  if (!user) {
    console.error("Credit pack paid by an account that no longer exists; review for refund", { session: session.id });
    return;
  }
  const a = await allowance(e, user);
  const intent = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id ?? null;
  await e.DB.batch([
    e.DB.prepare("INSERT OR IGNORE INTO credit_topups(session_id,user_id,pack,credits,amount,currency,payment_intent,created_at) VALUES (?,?,?,?,?,?,?,?)")
      .bind(session.id, user.id, pack.id, pack.credits, session.amount_total ?? pack.price * 100, session.currency || "usd", intent, now()),
    e.DB.prepare("UPDATE usage_windows SET quota=quota+?1,topped=topped+?1 WHERE id=?2 AND EXISTS(SELECT 1 FROM credit_topups WHERE session_id=?3 AND window_id IS NULL)")
      .bind(pack.credits, a.window, session.id),
    e.DB.prepare("UPDATE credit_topups SET window_id=? WHERE session_id=? AND window_id IS NULL").bind(a.window, session.id),
  ]);
}
/** A refunded credit pack: its credits that are still unused are taken back. */
async function refundTopup(e: Env, paymentIntent: string) {
  const t = await e.DB.prepare("SELECT * FROM credit_topups WHERE payment_intent=? AND refunded=0").bind(paymentIntent).first<any>();
  if (!t) return false;
  await e.DB.batch([
    e.DB.prepare("UPDATE usage_windows SET quota=MAX(used,quota-?1),topped=MAX(0,topped-?1) WHERE id=?2").bind(t.credits, t.window_id),
    e.DB.prepare("UPDATE credit_topups SET refunded=1 WHERE session_id=?").bind(t.session_id),
  ]);
  console.log("Credit pack refunded", { session: t.session_id });
  return true;
}
/** Re-reads the customer's subscriptions from Stripe (on return from Checkout or the portal). */
billing.post("/sync", async (c) => {
  const u = c.get("user");
  if (!u.stripe_customer) return c.json({ ok: true });
  await rate(c, "billing-sync", 30, 3600, u.id);
  await syncCustomer(c.env, u.id, u.stripe_customer);
  return c.json({ ok: true });
});
async function syncCustomer(e: Env, userId: string, customer: string) {
  const fetchedAt = now();
  const list = await stripe(e).subscriptions.list({ customer, status: "all", limit: 10, expand: ["data.latest_invoice"] });
  const statements: D1PreparedStatement[] = [];
  for (const sub of list.data) statements.push(...(await subscriptionStatements(e, sub, userId, fetchedAt)));
  if (statements.length) await e.DB.batch(statements);
  return statements.length > 0;
}
/**
 * Nightly backstop for missed webhooks: customers whose plan looks doubtful are re-read from Stripe. Grants have no
 * Stripe subscription behind them and are never part of it. The outcome is kept for the operations summary.
 */
export async function reconcileStripe(e: Env) {
  if (e.BILLING_ENABLED !== "true" || !e.STRIPE_SECRET_KEY) return;
  // The least recently checked first: customers who stay doubtful for long (e.g. unpaid) cannot take every slot.
  const users = (await e.DB.prepare(
    `SELECT u.id,u.stripe_customer FROM users u LEFT JOIN stripe_reconciled r ON r.user_id=u.id WHERE u.stripe_customer IS NOT NULL AND (
      EXISTS(SELECT 1 FROM subscriptions s WHERE s.user_id=u.id AND substr(s.id,1,6)<>?2 AND ((s.status='active' AND s.period_end<?1) OR s.status IN ('past_due','incomplete','trialing','unpaid')))
      OR (EXISTS(SELECT 1 FROM checkout_intents c WHERE c.user_id=u.id AND c.expires_at>?1-2*86400) AND NOT EXISTS(SELECT 1 FROM subscriptions s WHERE s.user_id=u.id AND substr(s.id,1,6)<>?2 AND s.status='active'))
    ) ORDER BY COALESCE(r.checked_at,0) LIMIT 50`,
  ).bind(now(), GRANT_PREFIX).all<{ id: string; stripe_customer: string }>()).results;
  let changed = 0, failed = 0;
  for (const u of users) {
    try { if (await syncCustomer(e, u.id, u.stripe_customer)) changed++; }
    catch (error) { failed++; console.error("Stripe reconciliation failed", { userId: u.id, error: (error as Error)?.name }); }
    // Also after a failure: a customer Stripe keeps rejecting is not retried ahead of everyone else.
    await e.DB.prepare("INSERT INTO stripe_reconciled(user_id,checked_at) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET checked_at=excluded.checked_at")
      .bind(u.id, now()).run();
  }
  await writeState(e, "stripe", { at: now(), checked: users.length, updated: changed, failed });
  if (users.length) console.log("Stripe reconciliation", { checked: users.length, updated: changed, failed });
}
/** A Customer Portal link; with a plan it opens on the confirmation of that plan change. */
async function portalUrl(e: Env, request: Request, customer: string, plan?: PaidPlanId | null, interval: Interval = "month") {
  const s = stripe(e), back = origin(e, request) + "/app/billing?portal=1";
  const price = plan ? priceIds(e, interval)[plan] : undefined;
  if (price) {
    try {
      const sub = (await s.subscriptions.list({ customer, status: "active", limit: 1 })).data[0];
      const item = sub?.items.data[0];
      if (sub && item && sub.items.data.length === 1 && item.price.id !== price)
        return (await s.billingPortal.sessions.create({
          customer, return_url: back,
          flow_data: {
            type: "subscription_update_confirm",
            subscription_update_confirm: { subscription: sub.id, items: [{ id: item.id, price, quantity: 1 }] },
            after_completion: { type: "redirect", redirect: { return_url: back } },
          },
        })).url;
    } catch {
      console.error("Plan change flow unavailable; opening the Customer Portal", { plan });
    }
  }
  return (await s.billingPortal.sessions.create({ customer, return_url: back })).url;
}
billing.post("/portal", async (c) => {
  const u = c.get("user");
  if (!u.stripe_customer) throw new HTTPException(400, { message: "You don't have a paid subscription yet." });
  await rate(c, "billing-portal", 20, 3600, u.id);
  const body = await c.req.json().catch(() => ({}));
  const plan = z.object({ plan: z.enum(paidPlans), interval: z.enum(intervals).default("month") }).safeParse(body);
  return c.json({ url: await portalUrl(c.env, c.req.raw, u.stripe_customer, plan.success ? plan.data.plan : null, plan.success ? plan.data.interval : "month") });
});
/** The plan of a Stripe price: a configured STRIPE_PRICE_*, or its lookup key / metadata.plan. */
function planOf(e: Env, price: Stripe.Price | undefined): PlanId | undefined {
  if (!price) return undefined;
  const configured = [...Object.entries(priceIds(e, "month")), ...Object.entries(priceIds(e, "year"))].find(([, v]) => v === price.id)?.[0];
  const named = [price.lookup_key, price.metadata?.plan].find((p) => (paidPlans as readonly string[]).includes(p || ""));
  return (configured || named || undefined) as PlanId | undefined;
}
/** Stores Stripe's current state of a subscription; an older reading (`fetchedAt`) never overwrites a newer one. */
async function subscriptionStatements(e: Env, sub: Stripe.Subscription, userId: string, fetchedAt: number) {
  const item = sub.items.data[0];
  const plan = planOf(e, item?.price);
  const status = e.DB.prepare(
    "INSERT INTO stripe_status(subscription_id,user_id,status,fetched_at) VALUES (?,?,?,?) ON CONFLICT(subscription_id) DO UPDATE SET status=excluded.status,fetched_at=excluded.fetched_at WHERE excluded.fetched_at>=stripe_status.fetched_at",
  ).bind(sub.id, userId, sub.status, fetchedAt);
  if (!plan) {
    console.error("Subscription price is not a configured plan", { subscription: sub.id, price: item?.price.id });
    return item ? [e.DB.prepare(
      "UPDATE subscriptions SET status=?,period_start=?,period_end=?,cancel_at_period_end=?,event_created=? WHERE id=? AND ?>=event_created",
    ).bind(sub.status, item.current_period_start, item.current_period_end, sub.cancel_at_period_end ? 1 : 0, fetchedAt, sub.id, fetchedAt), status] : [status];
  }
  const invoice = sub.latest_invoice as Stripe.Invoice | null;
  const unpaid = sub.status === "active" && (!invoice || typeof invoice !== "object" || invoice.status !== "paid");
  // A renewal or plan-change invoice is open for a moment: keep the stored, paid state until it is paid.
  const pending = (unpaid || sub.status === "past_due") && typeof invoice === "object" &&
    ["subscription_cycle", "subscription_update"].includes(invoice?.billing_reason || "") &&
    !!(await e.DB.prepare("SELECT id FROM subscriptions WHERE id=? AND status='active'").bind(sub.id).first());
  if (pending) return [status];
  return [e.DB.prepare(
    "INSERT INTO subscriptions(id,user_id,plan,status,period_start,period_end,cancel_at_period_end,event_created) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET plan=excluded.plan,status=excluded.status,period_start=excluded.period_start,period_end=excluded.period_end,cancel_at_period_end=excluded.cancel_at_period_end,event_created=excluded.event_created WHERE excluded.event_created>=subscriptions.event_created",
  ).bind(sub.id, userId, plan, unpaid ? "past_due" : sub.status, item.current_period_start, item.current_period_end, sub.cancel_at_period_end ? 1 : 0, fetchedAt), status];
}
/**
 * A full refund, a chargeback, a withdrawal or the deletion of the account ends the paid plan at once: subscriptions
 * are cancelled in Stripe (no further charges) and the videos and credits left in paid periods stop. A grant is not
 * touched (its window ID has no Stripe subscription). Safe to repeat.
 */
export async function endPaidAccess(e: Env, customer: string, reason: "refund" | "dispute" | "withdrawal" | "deletion") {
  const s = stripe(e), fetchedAt = now();
  const user = await e.DB.prepare("SELECT id FROM users WHERE stripe_customer=?").bind(customer).first<{ id: string }>();
  const list = await s.subscriptions.list({ customer, status: "all", limit: 10 });
  const statements: D1PreparedStatement[] = [];
  let cancelled = 0;
  for (const sub of list.data) {
    const ended = ["canceled", "incomplete_expired"].includes(sub.status);
    const current = ended ? sub : await s.subscriptions.cancel(sub.id);
    if (!ended) cancelled++;
    if (user) statements.push(...(await subscriptionStatements(e, current, user.id, fetchedAt)));
  }
  if (user)
    statements.push(e.DB.prepare("UPDATE usage_windows SET quota=used WHERE user_id=? AND id LIKE ?").bind(user.id, `${user.id}:sub_%`));
  if (statements.length) await e.DB.batch(statements);
  console.error("Paid access ended", { userId: user?.id ?? null, reason, cancelled });
}
/**
 * Confirms the contract on a durable medium (CRD Art. 8(7)): the plan and price, the request for immediate start
 * given at checkout, and how to withdraw. Sent once per completed checkout; retried by maintenance.
 */
export async function confirmContract(e: Env, sessionId: string) {
  const row = await e.DB.prepare(
    "SELECT c.plan,c.created_at,u.email FROM checkout_consents c JOIN users u ON u.id=c.user_id WHERE c.session_id=? AND c.completed_at IS NOT NULL AND c.confirmed_at IS NULL",
  ).bind(sessionId).first<{ plan: string; created_at: number; email: string }>();
  if (!row) return;
  const [planId, every] = row.plan.split(":");
  const plan = plans.find((p) => p.id === planId);
  const price = plan ? (every === "year" ? `$${plan.yearly} a year` : `$${plan.monthly} a month`) : "";
  const site = (e.SITE_URL || "").replace(/\/$/, "");
  const when = new Date(row.created_at * 1000).toUTCString();
  const contact = e.CONTACT_EMAIL ? `by email to ${e.CONTACT_EMAIL} or ` : "";
  await sendMail(e, row.email, `Your ${plan?.name ?? planId} plan — ${PRODUCT.name}`, [
    "Hi,",
    "",
    `This confirms your subscription to the ${plan?.name ?? planId} plan${price ? ` at ${price}, plus any tax shown at checkout` : ""}. ` +
      `It renews every ${every === "year" ? "year" : "month"} until you cancel it in Billing.`,
    "",
    `When you ordered (${when}) you asked:`,
    `"${IMMEDIATE_START_TEXT}"`,
    "",
    `Right of withdrawal: you can withdraw from this contract within ${WITHDRAWAL_DAYS} days of subscribing without giving a reason. ` +
      `Tell us ${contact}through ${site}/contact?topic=withdrawal. You can use the model withdrawal form at ${site}/terms#withdrawal-form. ` +
      `We refund within 14 days of your message what you paid, less the share of the plan you used.`,
    "",
    `Terms of Service: ${site}/terms`,
    [e.COMPANY_NAME, e.COMPANY_ADDRESS].filter(Boolean).join(", "),
  ].join("\n"));
  await e.DB.prepare("UPDATE checkout_consents SET confirmed_at=? WHERE session_id=?").bind(now(), sessionId).run();
}
/** Hourly: confirmations whose email failed when the payment completed (up to a week back). */
export async function confirmPendingContracts(e: Env) {
  if (e.BILLING_ENABLED !== "true") return;
  const rows = (await e.DB.prepare(
    "SELECT session_id FROM checkout_consents WHERE confirmed_at IS NULL AND completed_at>? ORDER BY completed_at LIMIT 20",
  ).bind(now() - 7 * DAY).all<{ session_id: string }>()).results;
  for (const r of rows) {
    try { await confirmContract(e, r.session_id); }
    catch (error) { console.error("Contract confirmation failed", { session: r.session_id, error: (error as Error)?.name }); }
  }
}
const customerId = (c: string | { id: string }) => (typeof c === "string" ? c : c.id);
export async function webhook(request: Request, e: Env) {
  if (!e.STRIPE_WEBHOOK_SECRET) throw new HTTPException(503, { message: "Payments are not set up." });
  const s = stripe(e);
  let event: Stripe.Event;
  try {
    event = await s.webhooks.constructEventAsync(
      await request.text(), request.headers.get("stripe-signature") || "", e.STRIPE_WEBHOOK_SECRET, 300, Stripe.createSubtleCryptoProvider(),
    );
  } catch {
    throw new HTTPException(400, { message: "Invalid signature." });
  }
  if (await e.DB.prepare("SELECT id FROM billing_events WHERE id=?").bind(event.id).first()) return { received: true };
  let subscriptionId: string | undefined;
  const object = event.data.object as any;
  if (event.type.startsWith("customer.subscription.")) subscriptionId = object.id;
  else if (event.type === "checkout.session.completed" && object.mode === "subscription")
    subscriptionId = typeof object.subscription === "string" ? object.subscription : object.subscription?.id;
  // Credit packs: paid at once (cards) or later (async methods).
  if (["checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(event.type) && object.mode === "payment")
    await creditTopup(e, object as Stripe.Checkout.Session);
  else if (["invoice.paid", "invoice.payment_failed"].includes(event.type))
    subscriptionId = object.parent?.subscription_details?.subscription || object.subscription;
  const statements: D1PreparedStatement[] = [];
  // A refunded credit pack takes back its unused credits; a refunded subscription payment ends the plan.
  if (event.type === "charge.refunded" && object.refunded === true && object.customer) {
    const intent = typeof object.payment_intent === "string" ? object.payment_intent : object.payment_intent?.id;
    if (!(intent && !object.invoice && await refundTopup(e, intent))) await endPaidAccess(e, customerId(object.customer), "refund");
  }
  if (event.type === "charge.dispute.created" && object.charge) {
    const charge = await s.charges.retrieve(customerId(object.charge));
    if (charge.customer) await endPaidAccess(e, customerId(charge.customer), "dispute");
  }
  const completedSession = event.type === "checkout.session.completed" && object.mode === "subscription" && typeof object.id === "string" ? (object.id as string) : null;
  if (completedSession)
    statements.push(e.DB.prepare("UPDATE checkout_consents SET completed_at=? WHERE session_id=? AND completed_at IS NULL").bind(now(), completedSession));
  if (subscriptionId) {
    // Current state from Stripe: never grant access based on a redirect, a stale payload or an invoice alone.
    const fetchedAt = now();
    const sub = await s.subscriptions.retrieve(subscriptionId, { expand: ["latest_invoice"] });
    const customer = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
    const user = await e.DB.prepare("SELECT id FROM users WHERE stripe_customer=?").bind(customer).first<{ id: string }>();
    if (!user && sub.metadata?.user_id && !["canceled", "incomplete_expired"].includes(sub.status) &&
      !(await e.DB.prepare("SELECT id FROM users WHERE id=?").bind(sub.metadata.user_id).first())) {
      // Started by an account that no longer exists: nobody can use or cancel it.
      await s.subscriptions.cancel(sub.id);
      console.error("Cancelled subscription of a deleted account; review for refund", { subscription: sub.id });
    }
    if (user) statements.push(...(await subscriptionStatements(e, sub, user.id, fetchedAt)));
  }
  statements.push(e.DB.prepare("INSERT OR IGNORE INTO billing_events(id,created_at) VALUES (?,?)").bind(event.id, now()));
  await e.DB.batch(statements);
  // After the batch, so a failed email never makes Stripe resend the event; maintenance retries it.
  if (completedSession) {
    try { await confirmContract(e, completedSession); }
    catch (error) { console.error("Contract confirmation failed", { session: completedSession, error: (error as Error)?.name }); }
  }
  return { received: true };
}
export { plans };
