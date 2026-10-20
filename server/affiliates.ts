import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type Stripe from "stripe";
import type { App, Env } from "./types";
import { now, uid, DAY } from "./types";
import { clientIp, hit, rate } from "./security";
import { mailbox, stripe } from "./billing";
import {
  AFFILIATE_HOLD_DAYS, AFFILIATE_MIN_PAYOUT, AFFILIATE_MONTHS, AFFILIATE_TERMS_VERSION, REFERRAL_CODE, RESERVED_CODES, commissionOn,
} from "../shared/growth";

// The affiliate program (shared/growth.ts, migrations/0009_growth.sql). An affiliate shares hookstreak.app/r/<code>;
// it opens the home page with ?ref=<code>, which the site keeps in the page's memory (never a cookie) and puts in the
// sign-up form, where the visitor sees it and can remove it. Whoever signs up with a code is referred by that
// affiliate; every payment of theirs in the first 12 months (plans and credit packs, without tax) earns the affiliate
// a commission from the Stripe webhook, held 30 days, then paid out by an administrator. Refunds and chargebacks lower
// or void it, or take it back from the next payout once paid. Affiliates never see who their customers are.

type AffiliateRow = { user_id: string; code: string; status: "active" | "paused"; payout_email: string; terms_version: string; clicks: number; created_at: number; updated_at: number };
type CommissionRow = {
  id: string; affiliate_id: string; customer_id: string | null; kind: "plan" | "pack" | "reversal"; reverses: string | null; payment_intent: string | null;
  amount: number; commission: number; currency: string; status: "pending" | "paid" | "void"; payout_id: string | null; available_at: number; created_at: number;
};

/** The affiliate a new account was referred by: an active one, never the person signing up (any spelling of their mailbox). */
export async function referrerFor(env: Env, code: unknown, email: string) {
  if (typeof code !== "string" || !REFERRAL_CODE.test(code.trim().toLowerCase())) return null;
  const a = await env.DB.prepare("SELECT a.user_id,u.email FROM affiliates a JOIN users u ON u.id=a.user_id WHERE a.code=? AND a.status='active'")
    .bind(code.trim().toLowerCase()).first<{ user_id: string; email: string }>();
  return a && mailbox(a.email) !== mailbox(email) ? a.user_id : null;
}

/** /r/<code>: counts the visit (once a day per visitor) and opens the home page with the code. No cookie is set. */
export const referralLinks = new Hono<App>();
referralLinks.get("/r/:code", async (c) => {
  const code = c.req.param("code").toLowerCase();
  if (!REFERRAL_CODE.test(code)) return c.redirect("/", 302);
  const a = await c.env.DB.prepare("SELECT user_id FROM affiliates WHERE code=? AND status='active'").bind(code).first<{ user_id: string }>();
  if (a && (await hit(c.env, `ref-click:${code}`, DAY, clientIp(c))) === 1)
    await c.env.DB.prepare("UPDATE affiliates SET clicks=clicks+1 WHERE user_id=?").bind(a.user_id).run();
  return c.redirect(a ? `/?ref=${encodeURIComponent(code)}` : "/", 302);
});

// Commissions from Stripe (called by the billing webhook) -----------------------------------------------------------

/** The affiliate who earns on this customer's payment now, if any: active, and within 12 months of their first payment. */
async function earningAffiliate(env: Env, customerUserId: string) {
  const row = await env.DB.prepare(
    "SELECT u.referred_by AS affiliate,(SELECT MIN(created_at) FROM commissions WHERE customer_id=u.id AND kind<>'reversal') AS first FROM users u JOIN affiliates a ON a.user_id=u.referred_by AND a.status='active' WHERE u.id=?",
  ).bind(customerUserId).first<{ affiliate: string; first: number | null }>();
  if (!row) return null;
  if (row.first && now() - row.first > AFFILIATE_MONTHS * 30.5 * DAY) return null;
  return row.affiliate;
}
async function addCommission(env: Env, c: { id: string; affiliate: string; customer: string; kind: "plan" | "pack"; intent: string | null; amount: number; currency: string }) {
  const commission = commissionOn(c.amount);
  if (commission <= 0) return;
  const t = now();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO commissions(id,affiliate_id,customer_id,kind,payment_intent,amount,commission,currency,status,available_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,'pending',?,?,?)",
  ).bind(c.id, c.affiliate, c.customer, c.kind, c.intent, c.amount, commission, c.currency.toLowerCase(), t + AFFILIATE_HOLD_DAYS * DAY, t, t).run();
}
/** A paid subscription invoice of a referred customer (read again from Stripe, with its payment). */
export async function commissionForInvoice(env: Env, invoiceId: string, customer: string) {
  const user = await env.DB.prepare("SELECT id FROM users WHERE stripe_customer=? AND referred_by IS NOT NULL").bind(customer).first<{ id: string }>();
  if (!user) return;
  const affiliate = await earningAffiliate(env, user.id);
  if (!affiliate) return;
  const invoice = await stripe(env).invoices.retrieve(invoiceId, { expand: ["payments"] });
  if (invoice.status !== "paid") return;
  const taxes = (invoice.total_taxes ?? []).reduce((n, t) => n + (t.amount || 0), 0);
  const payment = invoice.payments?.data.find((p) => p.status === "paid" && p.payment.type === "payment_intent");
  const intent = payment?.payment.payment_intent;
  await addCommission(env, {
    id: invoice.id!, affiliate, customer: user.id, kind: "plan", intent: typeof intent === "string" ? intent : intent?.id ?? null,
    amount: invoice.amount_paid - taxes, currency: invoice.currency,
  });
}
/** A paid credit pack of a referred customer. */
export async function commissionForPack(env: Env, session: Stripe.Checkout.Session) {
  if (session.payment_status !== "paid" || session.metadata?.kind !== "topup") return;
  const user = await env.DB.prepare("SELECT id FROM users WHERE id=? AND referred_by IS NOT NULL").bind(String(session.metadata?.user_id || "")).first<{ id: string }>();
  if (!user) return;
  const affiliate = await earningAffiliate(env, user.id);
  if (!affiliate) return;
  const intent = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id ?? null;
  await addCommission(env, {
    id: session.id, affiliate, customer: user.id, kind: "pack", intent,
    amount: (session.amount_total ?? 0) - (session.total_details?.amount_tax ?? 0), currency: session.currency || "usd",
  });
}
/**
 * A refund (part or all of the payment, `refunded` of `charged`) or a chargeback (all of it): the commission on that
 * payment shrinks in proportion, or is voided; once paid out, the difference is taken back from the next payout.
 * Safe to repeat: it always brings the commission to what the payment now earns.
 */
export async function reverseCommission(env: Env, paymentIntent: string, refunded: number, charged: number) {
  const c = await env.DB.prepare("SELECT * FROM commissions WHERE payment_intent=? AND kind<>'reversal'").bind(paymentIntent).first<CommissionRow>();
  if (!c || c.status === "void" || charged <= 0) return;
  const kept = Math.max(0, Math.min(1, 1 - refunded / charged));
  const due = Math.floor(commissionOn(c.amount) * kept);
  const t = now();
  if (c.status === "pending") {
    if (due >= c.commission) return;
    await env.DB.prepare("UPDATE commissions SET commission=?,status=?,updated_at=? WHERE id=? AND status='pending'")
      .bind(due, due > 0 ? "pending" : "void", t, c.id).run();
    return;
  }
  const back = (await env.DB.prepare("SELECT COALESCE(SUM(-commission),0) AS n FROM commissions WHERE reverses=? AND status<>'void'").bind(c.id).first<{ n: number }>())?.n || 0;
  const owed = c.commission - due - back;
  if (owed <= 0) return;
  await env.DB.prepare(
    "INSERT OR IGNORE INTO commissions(id,affiliate_id,customer_id,kind,reverses,amount,commission,currency,status,available_at,created_at,updated_at) VALUES (?,?,?,'reversal',?,0,?,?,'pending',?,?,?)",
  ).bind(`reversal:${c.id}:${refunded}`, c.affiliate_id, c.customer_id, c.id, -owed, c.currency, t, t, t).run();
}

// The affiliate's own page (/api/affiliate) ------------------------------------------------------------------------

/** Balances in cents: on hold (younger than 30 days), available to pay out, and paid. */
async function balances(env: Env, affiliate: string, at = now()) {
  const r = await env.DB.prepare(
    `SELECT COALESCE(SUM(CASE WHEN status='pending' AND available_at>?2 THEN commission END),0) AS held,
            COALESCE(SUM(CASE WHEN status='pending' AND available_at<=?2 THEN commission END),0) AS available,
            COALESCE(SUM(CASE WHEN status='paid' THEN commission END),0) AS paid
     FROM commissions WHERE affiliate_id=?1`,
  ).bind(affiliate, at).first<{ held: number; available: number; paid: number }>();
  return { held: r?.held || 0, available: r?.available || 0, paid: r?.paid || 0 };
}
async function stats(env: Env, affiliate: string) {
  const r = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM users WHERE referred_by=?1) AS signups,
            (SELECT COUNT(DISTINCT customer_id) FROM commissions WHERE affiliate_id=?1 AND kind<>'reversal' AND status<>'void') AS customers`,
  ).bind(affiliate).first<{ signups: number; customers: number }>();
  return { signups: r?.signups || 0, customers: r?.customers || 0 };
}
const commissionView = (c: CommissionRow) => ({
  id: c.id, kind: c.kind, amount: c.amount, commission: c.commission, currency: c.currency, createdAt: c.created_at, availableAt: c.available_at,
  status: c.status === "pending" ? (c.available_at > now() ? "held" : "available") : c.status,
});
const affiliateView = (a: AffiliateRow) => ({ code: a.code, status: a.status, payoutEmail: a.payout_email, clicks: a.clicks, createdAt: a.created_at });

const payoutEmail = z.string().trim().max(254).transform((s) => s.toLowerCase()).pipe(z.email({ error: "Enter the email address of your PayPal account." }));
const codeSchema = z.string().trim().toLowerCase().refine((s) => REFERRAL_CODE.test(s), "Use 3 to 24 lowercase letters, digits or dashes.")
  .refine((s) => !RESERVED_CODES.includes(s), "This code is taken. Choose another one.");
/** A code from the name, made unique. */
async function freshCode(env: Env, name: string) {
  const base = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 14) || "creator";
  for (let i = 0; i < 5; i++) {
    const code = `${base.length >= 3 ? base : "creator"}-${uid().slice(0, 4)}`;
    if (!(await env.DB.prepare("SELECT 1 FROM affiliates WHERE code=?").bind(code).first())) return code;
  }
  return `creator-${uid().slice(0, 8)}`;
}

export const affiliate = new Hono<App>();
affiliate.get("/", async (c) => {
  const u = c.get("user");
  const a = await c.env.DB.prepare("SELECT * FROM affiliates WHERE user_id=?").bind(u.id).first<AffiliateRow>();
  if (!a) return c.json({ affiliate: null });
  const commissions = (await c.env.DB.prepare("SELECT * FROM commissions WHERE affiliate_id=? ORDER BY created_at DESC LIMIT 100").bind(u.id).all<CommissionRow>()).results;
  const payouts = (await c.env.DB.prepare("SELECT id,amount,currency,created_at FROM affiliate_payouts WHERE affiliate_id=? ORDER BY created_at DESC LIMIT 24").bind(u.id).all<any>()).results;
  return c.json({
    affiliate: affiliateView(a), ...(await stats(c.env, u.id)), balances: await balances(c.env, u.id),
    commissions: commissions.map(commissionView), payouts: payouts.map((p) => ({ id: p.id, amount: p.amount, currency: p.currency, createdAt: p.created_at })),
  });
});
affiliate.post("/join", async (c) => {
  const u = c.get("user");
  if (!u.verified) throw new HTTPException(403, { message: "Confirm your email before joining the affiliate program." });
  await rate(c, "affiliate-join", 10, 3600, u.id);
  const d = z.object({
    payoutEmail, acceptTerms: z.boolean().default(false).refine((v) => v, "Accept the affiliate terms to join."),
  }).parse(await c.req.json());
  if (await c.env.DB.prepare("SELECT 1 FROM affiliates WHERE user_id=?").bind(u.id).first()) throw new HTTPException(409, { message: "You're already an affiliate." });
  const code = await freshCode(c.env, u.name);
  await c.env.DB.prepare("INSERT INTO affiliates(user_id,code,status,payout_email,terms_version,created_at,updated_at) VALUES (?,?,'active',?,?,?,?)")
    .bind(u.id, code, d.payoutEmail, AFFILIATE_TERMS_VERSION, now(), now()).run();
  return c.json({ ok: true, code }, 201);
});
affiliate.patch("/", async (c) => {
  const u = c.get("user");
  await rate(c, "affiliate-edit", 30, 3600, u.id);
  const d = z.object({ payoutEmail: payoutEmail.optional(), code: codeSchema.optional() }).parse(await c.req.json());
  const a = await c.env.DB.prepare("SELECT * FROM affiliates WHERE user_id=?").bind(u.id).first<AffiliateRow>();
  if (!a) throw new HTTPException(404, { message: "Join the affiliate program first." });
  if (d.code && d.code !== a.code && await c.env.DB.prepare("SELECT 1 FROM affiliates WHERE code=?").bind(d.code).first())
    throw new HTTPException(409, { message: "This code is taken. Choose another one." });
  await c.env.DB.prepare("UPDATE affiliates SET code=?,payout_email=?,updated_at=? WHERE user_id=?")
    .bind(d.code ?? a.code, d.payoutEmail ?? a.payout_email, now(), u.id).run();
  return c.json({ ok: true });
});

// Administrators: Admin → Growth (mounted under the administrators' routes) -----------------------------------------

export const adminAffiliates = new Hono<App>();
adminAffiliates.get("/", async (c) => {
  const rows = (await c.env.DB.prepare(
    `SELECT a.*,u.email,u.name,
       (SELECT COUNT(*) FROM users r WHERE r.referred_by=a.user_id) AS signups,
       (SELECT COUNT(DISTINCT customer_id) FROM commissions m WHERE m.affiliate_id=a.user_id AND m.kind<>'reversal' AND m.status<>'void') AS customers,
       (SELECT COALESCE(SUM(commission),0) FROM commissions m WHERE m.affiliate_id=a.user_id AND m.status='pending' AND m.available_at>?1) AS held,
       (SELECT COALESCE(SUM(commission),0) FROM commissions m WHERE m.affiliate_id=a.user_id AND m.status='pending' AND m.available_at<=?1) AS available,
       (SELECT COALESCE(SUM(commission),0) FROM commissions m WHERE m.affiliate_id=a.user_id AND m.status='paid') AS paid
     FROM affiliates a JOIN users u ON u.id=a.user_id ORDER BY available DESC, a.created_at DESC LIMIT 500`,
  ).bind(now()).all<any>()).results;
  return c.json({
    minPayout: AFFILIATE_MIN_PAYOUT,
    affiliates: rows.map((r) => ({
      id: r.user_id, email: r.email, name: r.name, code: r.code, status: r.status, payoutEmail: r.payout_email, clicks: r.clicks,
      signups: r.signups, customers: r.customers, held: r.held, available: r.available, paid: r.paid, createdAt: r.created_at,
    })),
  });
});
/** One affiliate's commissions with their customers (administrators only), and payouts. */
adminAffiliates.get("/:id", async (c) => {
  const id = c.req.param("id");
  const commissions = (await c.env.DB.prepare(
    "SELECT m.*,u.email AS customer_email FROM commissions m LEFT JOIN users u ON u.id=m.customer_id WHERE m.affiliate_id=? ORDER BY m.created_at DESC LIMIT 200",
  ).bind(id).all<CommissionRow & { customer_email: string | null }>()).results;
  const payouts = (await c.env.DB.prepare("SELECT * FROM affiliate_payouts WHERE affiliate_id=? ORDER BY created_at DESC LIMIT 50").bind(id).all<any>()).results;
  return c.json({
    commissions: commissions.map((m) => ({ ...commissionView(m), customer: m.customer_email ?? "deleted account" })),
    payouts: payouts.map((p) => ({ id: p.id, amount: p.amount, currency: p.currency, paidTo: p.paid_to, reference: p.reference, createdAt: p.created_at })),
  });
});
adminAffiliates.patch("/:id", async (c) => {
  const d = z.object({ status: z.enum(["active", "paused"]) }).parse(await c.req.json());
  const r = await c.env.DB.prepare("UPDATE affiliates SET status=?,updated_at=? WHERE user_id=?").bind(d.status, now(), c.req.param("id")).run();
  if (!r.meta.changes) throw new HTTPException(404, { message: "Affiliate not found." });
  return c.json({ ok: true });
});
/**
 * Records a payout the administrator sent (PayPal, bank): every commission available now is marked paid with it.
 * `expected` is the amount the administrator saw; a different balance (a commission became available meanwhile, or
 * a refund came in) is refused, so the record always matches what was sent.
 */
adminAffiliates.post("/:id/payouts", async (c) => {
  const id = c.req.param("id");
  const d = z.object({ expected: z.number().int().positive(), reference: z.string().trim().max(200).default("") }).parse(await c.req.json());
  const t = now();
  const { available } = await balances(c.env, id, t);
  if (available !== d.expected) throw new HTTPException(409, { message: "The balance changed meanwhile. Reload and check it again." });
  if (available <= 0) throw new HTTPException(400, { message: "Nothing to pay out." });
  const payoutId = uid();
  const currency = (await c.env.DB.prepare("SELECT currency FROM commissions WHERE affiliate_id=? LIMIT 1").bind(id).first<{ currency: string }>())?.currency || "usd";
  const to = (await c.env.DB.prepare("SELECT payout_email FROM affiliates WHERE user_id=?").bind(id).first<{ payout_email: string }>())?.payout_email || "";
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO affiliate_payouts(id,affiliate_id,paid_to,amount,currency,reference,created_at) VALUES (?,?,?,?,?,?,?)").bind(payoutId, id, to, available, currency, d.reference, t),
    c.env.DB.prepare("UPDATE commissions SET status='paid',payout_id=?,updated_at=? WHERE affiliate_id=? AND status='pending' AND available_at<=?").bind(payoutId, t, id, t),
  ]);
  return c.json({ ok: true, amount: available });
});
