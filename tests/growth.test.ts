import { afterEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";
import worker from "../server/index";
import { webhook } from "../server/billing";
import { now, DAY } from "../server/types";
import { call, signedIn, testEnv } from "./helpers";
import { AFFILIATE_HOLD_DAYS, CALL_CREDITS } from "../shared/growth";

// Growth programs (shared/growth.ts): affiliates earn 30% of what the customers they referred pay for 12 months,
// tracked without cookies, from Stripe's webhook, held 30 days, lowered or taken back by refunds, and paid out by an
// administrator; customers book a call for credits, added once when an administrator marks the call done.

afterEach(() => vi.unstubAllGlobals());
const secret = "whsec_local_test_only";
const stripeClient = new Stripe("sk_test_local_only", { httpClient: Stripe.createFetchHttpClient() });
/** A signed Stripe event, as the webhook receives it. */
async function send(env: any, id: string, type: string, object: object) {
  const body = JSON.stringify({ id, type, object: "event", created: now(), data: { object } });
  const signature = await stripeClient.webhooks.generateTestHeaderStringAsync({ payload: body, secret });
  return webhook(new Request("https://x/api/billing/webhook", { method: "POST", headers: { "stripe-signature": signature }, body }), env);
}
/** Stripe's API as the Worker reads it back: the subscription and invoices of a referred customer. */
function stripeApi(invoices: Record<string, object>) {
  const sub = {
    id: "sub_1", object: "subscription", customer: "cus_r", status: "active", cancel_at_period_end: false, metadata: {},
    items: { data: [{ id: "si_1", price: { id: "price_starter" }, current_period_start: now() - 10, current_period_end: now() + 30 * DAY }] },
  };
  vi.stubGlobal("fetch", async (input: any) => {
    const url = new URL(String(input?.url ?? input));
    const invoice = url.pathname.match(/^\/v1\/invoices\/(\w+)$/);
    if (invoice) return Response.json(invoices[invoice[1]]);
    if (url.pathname === "/v1/subscriptions/sub_1") return Response.json(sub);
    if (url.pathname === "/v1/subscriptions") return Response.json({ object: "list", data: [], has_more: false });
    throw new Error("unexpected Stripe call " + url.pathname);
  });
}
const invoice = (id: string, paid: number, tax = 0) => ({
  id, object: "invoice", customer: "cus_r", status: "paid", amount_paid: paid + tax, currency: "usd", total_taxes: tax ? [{ amount: tax }] : [],
  payments: { object: "list", data: [{ status: "paid", payment: { type: "payment_intent", payment_intent: `pi_${id}` } }] },
});
async function setup(extra: Record<string, unknown> = {}) {
  const { env, sqlite } = testEnv({ STRIPE_SECRET_KEY: "sk_test_local_only", STRIPE_WEBHOOK_SECRET: secret, STRIPE_PRICE_STARTER: "price_starter", ...extra });
  const admin = signedIn(sqlite, "admin@example.com"), aff = signedIn(sqlite, "maya.creator@gmail.com");
  const as = (who: { cookie: string }) => (method: string, path: string, body?: unknown) => call(worker, env, method, path, body, who.cookie);
  return { env, sqlite, admin: as(admin), aff: as(aff), affId: aff.id };
}
async function join(env: any, aff: (m: string, p: string, b?: unknown) => Promise<any>) {
  const joined = await aff("POST", "/api/affiliate/join", { payoutEmail: "Maya@PayPal.test", acceptTerms: true });
  expect(joined.status).toBe(201);
  return joined.data.code as string;
}
const register = (env: any, email: string, referralCode?: string) =>
  call(worker, env, "POST", "/api/auth/register", { name: "Sam Lee", email, password: "a-long-password", acceptTerms: true, ...(referralCode && { referralCode }) });
const referrer = (sqlite: any, email: string) => (sqlite.prepare("SELECT referred_by FROM users WHERE email=?").get(email) as any)?.referred_by ?? null;

describe("affiliates", () => {
  it("join with a payout address and the terms, and share a link that sets no cookie", async () => {
    const { env, sqlite, aff, affId } = await setup();
    const refused = await aff("POST", "/api/affiliate/join", { payoutEmail: "maya@paypal.test" });
    expect([refused.status, refused.data.error]).toEqual([400, "Accept the affiliate terms to join."]);
    const code = await join(env, aff);
    expect(code).toMatch(/^test-user-[0-9a-f]{4}$/);
    expect((await aff("POST", "/api/affiliate/join", { payoutEmail: "maya@paypal.test", acceptTerms: true })).status).toBe(409);
    // The link opens the home page with the code; visits are counted once a day per visitor; no cookie.
    for (let i = 0; i < 2; i++) {
      const r = await call(worker, env, "GET", `/r/${code}`);
      expect([r.status, r.headers.get("location"), r.headers.get("set-cookie")]).toEqual([302, `/?ref=${code}`, null]);
    }
    expect((await call(worker, env, "GET", "/r/nobody-here")).headers.get("location")).toBe("/");
    // A new code: free ones only, never ours.
    expect((await aff("PATCH", "/api/affiliate", { code: "hookstreak" })).status).toBe(400);
    expect((await aff("PATCH", "/api/affiliate", { code: "maya-stories" })).status).toBe(200);
    const page = (await aff("GET", "/api/affiliate")).data;
    expect(page.affiliate).toMatchObject({ code: "maya-stories", payoutEmail: "maya@paypal.test", clicks: 1, status: "active" });
    expect(page).toMatchObject({ signups: 0, customers: 0, balances: { held: 0, available: 0, paid: 0 }, commissions: [] });
    // Sign-ups with the code are hers; her own other mailbox and unknown codes are nobody's.
    await register(env, "sam@example.com", "MAYA-STORIES");
    await register(env, "maya.creator+2@gmail.com", "maya-stories");
    await register(env, "mayacreator@gmail.com", "maya-stories");
    await register(env, "kim@example.com", "no-such-code");
    expect(["sam@example.com", "maya.creator+2@gmail.com", "mayacreator@gmail.com", "kim@example.com"].map((e) => referrer(sqlite, e))).toEqual([affId, null, null, null]);
  });

  it("earn 30% of a referred customer's payments without tax for 12 months, held 30 days, never showing who they are", async () => {
    const { env, sqlite, aff, admin, affId } = await setup();
    const code = await join(env, aff);
    await register(env, "sam@example.com", code);
    sqlite.prepare("UPDATE users SET stripe_customer='cus_r',verified=1 WHERE email='sam@example.com'").run();
    const sam = (sqlite.prepare("SELECT id FROM users WHERE email='sam@example.com'").get() as any).id;
    stripeApi({ in_1: invoice("in_1", 1900, 380), in_2: invoice("in_2", 1900) });
    const paid = (id: string, n: string) => send(env, `evt_${n}`, "invoice.paid", { id, object: "invoice", customer: "cus_r", parent: { subscription_details: { subscription: "sub_1" } } });
    await paid("in_1", "1");
    await paid("in_1", "1b");
    // A credit pack too.
    await send(env, "evt_pack", "checkout.session.completed", {
      id: "cs_pack", object: "checkout.session", mode: "payment", payment_status: "paid", customer: "cus_r", payment_intent: "pi_pack",
      amount_total: 2800, currency: "usd", total_details: { amount_tax: 0 }, metadata: { kind: "topup", pack: "pack40", credits: "40", user_id: sam },
    });
    const rows = sqlite.prepare("SELECT id,kind,payment_intent,amount,commission,status,available_at-created_at AS hold FROM commissions ORDER BY id").all();
    expect(rows).toEqual([
      { id: "cs_pack", kind: "pack", payment_intent: "pi_pack", amount: 2800, commission: 840, status: "pending", hold: AFFILIATE_HOLD_DAYS * DAY },
      { id: "in_1", kind: "plan", payment_intent: "pi_in_1", amount: 1900, commission: 570, status: "pending", hold: AFFILIATE_HOLD_DAYS * DAY },
    ]);
    const page = (await aff("GET", "/api/affiliate")).data;
    expect(page).toMatchObject({ signups: 1, customers: 1, balances: { held: 1410, available: 0, paid: 0 } });
    expect(page.commissions.map((c: any) => c.status)).toEqual(["held", "held"]);
    expect(JSON.stringify(page)).not.toContain("sam");
    // Administrators see who the customers are.
    const detail = (await admin("GET", `/api/admin/affiliates/${affId}`)).data;
    expect(detail.commissions.map((c: any) => c.customer)).toEqual(["sam@example.com", "sam@example.com"]);
    // After 12 months from the first payment, or while paused, payments earn nothing.
    sqlite.prepare("UPDATE commissions SET created_at=created_at-400*86400").run();
    await paid("in_2", "2");
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM commissions").get()).toEqual({ n: 2 });
    sqlite.prepare("UPDATE commissions SET created_at=created_at+400*86400").run();
    await admin("PATCH", `/api/admin/affiliates/${affId}`, { status: "paused" });
    await paid("in_2", "3");
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM commissions").get()).toEqual({ n: 2 });
    await admin("PATCH", `/api/admin/affiliates/${affId}`, { status: "active" });
    await paid("in_2", "4");
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM commissions").get()).toEqual({ n: 3 });
  });

  it("lose what refunds take back, and are paid out by an administrator from the available balance", async () => {
    const { env, sqlite, aff, admin, affId } = await setup();
    const code = await join(env, aff);
    await register(env, "sam@example.com", code);
    sqlite.prepare("UPDATE users SET stripe_customer='cus_r',verified=1 WHERE email='sam@example.com'").run();
    stripeApi({ in_1: invoice("in_1", 1900) });
    await send(env, "evt_1", "invoice.paid", { id: "in_1", object: "invoice", customer: "cus_r", parent: { subscription_details: { subscription: "sub_1" } } });
    // Half refunded while held: half the commission.
    const refund = (n: string, refunded: number) =>
      send(env, `evt_r${n}`, "charge.refunded", { id: "ch_1", object: "charge", customer: "cus_r", payment_intent: "pi_in_1", amount: 1900, amount_refunded: refunded, refunded: refunded === 1900 });
    await refund("1", 950);
    expect(sqlite.prepare("SELECT commission,status FROM commissions WHERE id='in_1'").get()).toEqual({ commission: 285, status: "pending" });
    // 30 days on, it's available and paid out (the administrator confirms the amount they sent).
    sqlite.prepare("UPDATE commissions SET available_at=?").run(now() - 1);
    const list = (await admin("GET", "/api/admin/affiliates")).data.affiliates;
    expect(list[0]).toMatchObject({ code, available: 285, held: 0, payoutEmail: "maya@paypal.test", signups: 1, customers: 1 });
    expect((await admin("POST", `/api/admin/affiliates/${affId}/payouts`, { expected: 999 })).status).toBe(409);
    expect((await admin("POST", `/api/admin/affiliates/${affId}/payouts`, { expected: 285, reference: "PP-123" })).data).toEqual({ ok: true, amount: 285 });
    expect(sqlite.prepare("SELECT status,payout_id IS NOT NULL AS linked FROM commissions WHERE id='in_1'").get()).toEqual({ status: "paid", linked: 1 });
    expect(sqlite.prepare("SELECT paid_to,amount,reference FROM affiliate_payouts").get()).toEqual({ paid_to: "maya@paypal.test", amount: 285, reference: "PP-123" });
    // Refunded in full after the payout: taken back from the next one, once however often Stripe says so.
    await refund("2", 1900);
    await refund("3", 1900);
    expect(sqlite.prepare("SELECT kind,commission,reverses FROM commissions WHERE kind='reversal'").all()).toEqual([{ kind: "reversal", commission: -285, reverses: "in_1" }]);
    expect((await aff("GET", "/api/affiliate")).data.balances).toEqual({ held: 0, available: -285, paid: 285 });
    expect((await admin("POST", `/api/admin/affiliates/${affId}/payouts`, { expected: -285 })).status).toBe(400);
    // Only administrators.
    expect((await aff("GET", "/api/admin/affiliates")).status).toBe(404);
  });
});

describe("calls for credits", () => {
  it("are offered only with a scheduling page, open it with the customer's details, and add the credits once", async () => {
    const off = await setup();
    const user0 = signedIn(off.sqlite, "kim@example.com");
    expect((await call(worker, off.env, "GET", "/api/calls", undefined, user0.cookie)).data).toMatchObject({ enabled: false, eligible: false });
    expect((await call(worker, off.env, "POST", "/api/calls", {}, user0.cookie)).status).toBe(404);

    const { env, sqlite, admin } = await setup({ CALL_BOOKING_URL: "https://cal.com/hookstreak/15min" });
    const user = signedIn(sqlite, "kim@example.com");
    const as = (method: string, path: string, body?: unknown) => call(worker, env, method, path, body, user.cookie);
    const me = async () => (await as("GET", "/api/auth/me")).data.user;
    expect((await as("GET", "/api/calls")).data).toMatchObject({ enabled: true, eligible: true, credits: CALL_CREDITS, minutes: 15, status: null });
    const booked = await as("POST", "/api/calls", {});
    expect(booked.data.url).toBe("https://cal.com/hookstreak/15min?name=Test+User&email=kim%40example.com");
    const before = (await me()).limit;
    const calls = (await admin("GET", "/api/admin/calls")).data;
    expect(calls).toMatchObject({ enabled: true, credits: CALL_CREDITS, calls: [{ userId: user.id, email: "kim@example.com", plan: "free", status: "requested" }] });
    const done = await admin("POST", `/api/admin/calls/${user.id}/done`, { notes: "Makes scary stories; wants longer videos." });
    expect(done.data).toEqual({ ok: true, credits: CALL_CREDITS, emailed: true });
    expect((await me()).limit).toBe(before + CALL_CREDITS);
    expect(env.EMAIL.sent.at(-1)).toMatchObject({ to: "kim@example.com", subject: `${CALL_CREDITS} credits added — thanks for the call` });
    expect((await admin("POST", `/api/admin/calls/${user.id}/done`, {})).status).toBe(409);
    expect((await me()).limit).toBe(before + CALL_CREDITS);
    expect((await as("GET", "/api/calls")).data).toMatchObject({ eligible: false, status: "done" });
    expect((await as("POST", "/api/calls", {})).status).toBe(409);
    expect((await admin("GET", "/api/admin/calls")).data.calls[0]).toMatchObject({ status: "done", credits: CALL_CREDITS, notes: "Makes scary stories; wants longer videos." });
    expect((await as("GET", "/api/admin/calls")).status).toBe(404);
  });

  it("can be missed and booked again, and need credits the customer can use", async () => {
    const { env, sqlite, admin } = await setup({ CALL_BOOKING_URL: "https://cal.com/hookstreak/15min" });
    const user = signedIn(sqlite, "lee@example.com");
    const as = (method: string, path: string, body?: unknown) => call(worker, env, method, path, body, user.cookie);
    await as("POST", "/api/calls", {});
    expect((await admin("POST", `/api/admin/calls/${user.id}/missed`, { notes: "No show." })).status).toBe(200);
    expect((await as("GET", "/api/calls")).data).toMatchObject({ eligible: true, status: "missed" });
    await as("POST", "/api/calls", {});
    // "Not now" hides it from Home, but never closes a booked call.
    await as("DELETE", "/api/calls");
    expect((await as("GET", "/api/calls")).data.status).toBe("requested");
    // Once the free trial has ended, the credits couldn't be spent: no new booking, and the administrator is told why.
    sqlite.prepare("UPDATE users SET created_at=? WHERE id=?").run(now() - 8 * DAY, user.id);
    expect((await as("GET", "/api/calls")).data).toMatchObject({ eligible: false });
    expect((await as("POST", "/api/calls", {})).status).toBe(402);
    const refused = await admin("POST", `/api/admin/calls/${user.id}/done`, {});
    expect([refused.status, refused.data.error]).toEqual([409, expect.stringContaining("free month")]);
  });
});
