import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";
import worker from "../server/index";
import { maintenance, drainCleanup, CLEANUP_CALLS } from "../server/maintenance";
import { addMonths, confirmPendingContracts, reconcileStripe, webhook } from "../server/billing";
import { applyRetention } from "../server/retention";
import { attention, operationsSnapshot, reportAttention, reviewRuns } from "../server/operations";
import { countUpload, quotaDay, reportUploads, uploadsToday } from "../server/youtube-quota";
import { IMMEDIATE_START_TEXT, IMMEDIATE_START_VERSION, withdrawalRefund } from "../shared/withdrawal";
import { now, DAY, HOUR } from "../server/types";
import { call, signedIn, testEnv } from "./helpers";

// Operations: administrator-only routes, withdrawals within 14 days, retention, plan grants and the hourly operations
// summary. Stripe is mocked at fetch; D1 is node:sqlite with every migration.

const secret = "whsec_local_test_only";
const signer = new Stripe("sk_test_local_only", { httpClient: Stripe.createFetchHttpClient() });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
const HOURLY = Date.UTC(2026, 9, 9, 12, 17);
const me = async (env: any, cookie: string) => (await call(worker, env, "GET", "/api/auth/me", undefined, cookie)).data.user;
const windowOf = (sqlite: any, id: string) => sqlite.prepare("SELECT used,quota FROM usage_windows WHERE id=?").get(id);

function admins(overrides: Record<string, unknown> = {}) {
  const { env, sqlite } = testEnv(overrides);
  return { env, sqlite, admin: signedIn(sqlite, "admin@example.com"), user: signedIn(sqlite) };
}

/* ------------------------------------------------------------------------------------------------ admin routes */

describe("administrator-only routes", () => {
  it("hide every admin route from other people and need a session", async () => {
    const { env, sqlite, user } = admins();
    sqlite.prepare("INSERT INTO library_items(id,kind,name,object_key,mime,bytes,created_at) VALUES ('item1','music','Calm','library/item1/file.mp3','audio/mpeg',10,1)").run();
    const fetched: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => { fetched.push(url); return Response.json({}); });
    const routes: [string, string, unknown?][] = [
      ["GET", "/api/admin/operations"], ["GET", "/api/admin/overview"], ["GET", "/api/admin/messages"],
      ["GET", "/api/admin/withdrawals"], ["GET", "/api/admin/withdrawals/quote?email=a@example.com"],
      ["POST", "/api/admin/withdrawals", { email: "a@example.com", refund: 0 }], ["GET", "/api/admin/grants"],
      ["GET", "/api/admin/grants/accounts?q=example"], ["POST", "/api/admin/grants", { email: user.email, plan: "studio" }], ["DELETE", "/api/admin/grants/grant_x"],
      ["GET", "/api/admin/library"], ["PUT", "/api/admin/library/file?kind=music&name=x&duration=10", {}],
      ["PUT", "/api/admin/library/item1/thumb", {}], ["PATCH", "/api/admin/library/item1", { active: false }], ["DELETE", "/api/admin/library/item1"],
    ];
    for (const [method, path, body] of routes) {
      expect((await call(worker, env, method, path, body, user.cookie)).status, `${method} ${path}`).toBe(404);
      expect((await call(worker, env, method, path, body)).status, `${method} ${path} signed out`).toBe(401);
    }
    expect(fetched).toEqual([]);
    expect(sqlite.prepare("SELECT id,active FROM library_items").all()).toEqual([{ id: "item1", active: 1 }]);
    expect((await me(env, user.cookie)).plan).toBe("free");
  });

  it("need a confirmed email on the administrators' list", async () => {
    const { env, sqlite, admin } = admins();
    expect((await call(worker, env, "GET", "/api/admin/operations", undefined, admin.cookie)).status).toBe(200);
    sqlite.prepare("UPDATE users SET verified=0 WHERE id=?").run(admin.id);
    expect((await call(worker, env, "GET", "/api/admin/operations", undefined, admin.cookie)).status).toBe(404);
  });
});

/* ------------------------------------------------------------------------------------------------ withdrawals */

describe("withdrawal refund", () => {
  it("is what was paid less the used share of the period's credits, in whole cents", () => {
    const u = (used: number) => ({ used, quota: 60 });
    expect(withdrawalRefund(3500, u(0))).toBe(3500);
    expect(withdrawalRefund(3500, u(15))).toBe(2625); // a quarter used
    expect(withdrawalRefund(2900, { used: 3, quota: 10 })).toBe(2030); // 0.7 × 2900 without float loss
    expect(withdrawalRefund(1900, { used: 1, quota: 3 })).toBe(1266); // rounded down
    expect(withdrawalRefund(3500, u(60))).toBe(0);
    expect(withdrawalRefund(3500, u(90))).toBe(0);
    expect(withdrawalRefund(3500, u(-5))).toBe(3500);
    expect(withdrawalRefund(0, u(0))).toBe(0);
    // No credits in the period: nothing to measure the share by.
    expect(withdrawalRefund(3500, { used: 0, quota: 0 })).toBe(0);
  });
});

type StripeCall = { method: string; url: string; body: string; key: string | null };
/** A small Stripe API: the calls made, and answers for the ones these flows use. */
function stripeApi(o: { started?: number; refundFails?: boolean; subscriptions?: () => any[]; amount?: number; interval?: "month" | "year" } = {}) {
  const calls: StripeCall[] = [];
  const amount = o.amount ?? 3500, interval = o.interval ?? "month";
  let cancelled = false;
  const sub = () => ({
    id: "sub_1", object: "subscription", customer: "cus_1", status: cancelled ? "canceled" : "active", cancel_at_period_end: false, metadata: {},
    start_date: o.started ?? now() - 3 * DAY,
    items: { data: [{ id: "si_1", price: { id: interval === "year" ? "price_daily_yearly" : "price_daily", recurring: { interval, interval_count: 1 } }, current_period_start: 100, current_period_end: now() + 27 * DAY }] },
    latest_invoice: { id: "in_1", status: "paid" },
  });
  const prices: Record<string, any> = {
    price_daily: { id: "price_daily", active: true, currency: "usd", unit_amount: 3500, recurring: { interval: "month", interval_count: 1 } },
    price_daily_yearly: { id: "price_daily_yearly", active: true, currency: "usd", unit_amount: 35000, recurring: { interval: "year", interval_count: 1 } },
  };
  vi.stubGlobal("fetch", async (input: string, init: any = {}) => {
    const url = String(input), method = init.method || "GET";
    calls.push({ method, url, body: String(init.body || ""), key: new Headers(init.headers).get("Idempotency-Key") });
    if (method === "DELETE" && url.includes("/v1/subscriptions/sub_1")) { cancelled = true; return Response.json(sub()); }
    if (url.includes("/v1/subscriptions/sub_1")) return Response.json(sub());
    if (url.includes("/v1/subscriptions")) return Response.json({ object: "list", has_more: false, data: o.subscriptions ? o.subscriptions() : [sub()] });
    if (url.includes("/v1/invoices")) return Response.json({ object: "list", has_more: false, data: [{ id: "in_1", object: "invoice", created: now() - 3 * DAY, currency: "usd",
      payments: { object: "list", data: [{ status: "paid", amount_paid: amount, payment: { type: "payment_intent", payment_intent: "pi_1" } }] } }] });
    // Which invoice a payment belongs to: pi_1 pays the subscription's invoice in_1.
    if (url.includes("/v1/invoice_payments")) return Response.json({ object: "list", has_more: false, data: new URL(url).searchParams.get("payment[payment_intent]") !== "pi_1" ? [] : [{
      id: "inpay_1", object: "invoice_payment", status: "paid", payment: { type: "payment_intent", payment_intent: "pi_1" },
      invoice: { id: "in_1", object: "invoice", parent: { type: "subscription_details", subscription_details: { subscription: "sub_1" } } } }] });
    if (url.includes("/v1/payment_intents/pi_1")) return Response.json({ id: "pi_1", object: "payment_intent", latest_charge: { id: "ch_1", amount, amount_refunded: 0 } });
    if (url.includes("/v1/refunds")) {
      if (o.refundFails) return Response.json({ error: { type: "invalid_request_error", message: "No" } }, { status: 400 });
      return Response.json({ id: "re_1", object: "refund", amount: Number(new URLSearchParams(init.body).get("amount")) });
    }
    if (url.includes("/v1/customers")) return Response.json({ id: "cus_1", object: "customer" });
    const price = /\/v1\/prices\/([\w]+)/.exec(url);
    if (price && prices[price[1]]) return Response.json(prices[price[1]]);
    if (url.includes("/v1/checkout/sessions")) return Response.json({ id: "cs_test_1", object: "checkout.session", url: "https://checkout.stripe.com/test" });
    return Response.json({ error: { message: "not mocked " + url } }, { status: 404 });
  });
  return calls;
}
async function event(type: string, object: any, id = "evt_" + crypto.randomUUID()) {
  const body = JSON.stringify({ id, type, object: "event", created: now(), data: { object } });
  const signature = await signer.webhooks.generateTestHeaderStringAsync({ payload: body, secret });
  return new Request("https://app.test/api/billing/webhook", { method: "POST", headers: { "stripe-signature": signature }, body });
}
const billingEnv = () => testEnv({
  BILLING_ENABLED: "true", STRIPE_SECRET_KEY: "sk_test_local_only", STRIPE_WEBHOOK_SECRET: secret,
  STRIPE_PRICE_DAILY: "price_daily", STRIPE_PRICE_DAILY_YEARLY: "price_daily_yearly", COMPANY_ADDRESS: "1 Example St, Sofia",
});
/** A customer three days into a paid Creator month (a quarter of its 60 credits used), and an admin. */
function paying() {
  const { env, sqlite } = billingEnv();
  const admin = signedIn(sqlite, "admin@example.com"), client = signedIn(sqlite, "client@example.com");
  sqlite.prepare("UPDATE users SET stripe_customer='cus_1' WHERE id=?").run(client.id);
  sqlite.prepare("INSERT INTO subscriptions(id,user_id,plan,status,period_start,period_end,cancel_at_period_end,event_created) VALUES ('sub_1',?,'daily','active',100,?,0,1)").run(client.id, now() + 27 * DAY);
  sqlite.prepare("INSERT INTO usage_windows(id,user_id,plan,quota,used) VALUES (?,?,'daily',60,15)").run(`${client.id}:sub_1:100`, client.id);
  // An administrator's grant: refunds and withdrawals never touch it.
  sqlite.prepare("INSERT INTO usage_windows(id,user_id,plan,quota,used) VALUES (?,?,'studio',350,0)").run(`${client.id}:grant_1:100`, client.id);
  return { env, sqlite, admin, client };
}

describe("checkout with the request for immediate start", () => {
  it("is refused without the request, or for a plan that isn't offered, before anything is sent to Stripe", async () => {
    const { env, sqlite } = billingEnv();
    const a = signedIn(sqlite);
    const calls = stripeApi({ subscriptions: () => [] });
    for (const body of [{ plan: "daily" }, { plan: "daily", immediateStart: false }, { plan: "daily", interval: "year" }]) {
      const r = await call(worker, env, "POST", "/api/billing/checkout", body, a.cookie);
      expect(r.status).toBe(400);
      expect(r.data.error).toContain("start straight after payment");
    }
    // A plan of the old price list, and one without a configured Stripe price.
    for (const body of [{ plan: "growth", immediateStart: true }, { plan: "studio", immediateStart: true }, { plan: "daily", interval: "week", immediateStart: true }]) {
      const r = await call(worker, env, "POST", "/api/billing/checkout", body, a.cookie);
      expect(r.status).toBe(400);
      expect(r.data.error).toBe("This plan is not available.");
    }
    expect(calls).toEqual([]);
    expect(sqlite.prepare("SELECT COUNT(*) n FROM checkout_consents").get()).toEqual({ n: 0 });
  });

  it("records the request, repeats it on Stripe's page and confirms the contract by email once paid", async () => {
    const { env, sqlite } = billingEnv();
    const a = signedIn(sqlite, "client@example.com");
    const calls = stripeApi({ subscriptions: () => [] });
    const r = await call(worker, env, "POST", "/api/billing/checkout", { plan: "daily", immediateStart: true }, a.cookie);
    expect(r.status).toBe(200);
    expect(r.data.url).toBe("https://checkout.stripe.com/test");
    const session = new URLSearchParams(calls.find((c) => c.url.endsWith("/v1/checkout/sessions"))!.body);
    expect(session.get("line_items[0][price]")).toBe("price_daily");
    expect(session.get("custom_text[submit][message]")).toBe(IMMEDIATE_START_TEXT);
    expect(session.get("subscription_data[metadata][immediate_start]")).toBe(IMMEDIATE_START_VERSION);
    expect(sqlite.prepare("SELECT session_id,user_id,plan,version,completed_at FROM checkout_consents").get())
      .toEqual({ session_id: "cs_test_1", user_id: a.id, plan: "daily:month", version: IMMEDIATE_START_VERSION, completed_at: null });

    stripeApi();
    const send = env.EMAIL.send;
    env.EMAIL.send = vi.fn().mockRejectedValueOnce(new Error("mail down"));
    await webhook(await event("checkout.session.completed", { id: "cs_test_1", object: "checkout.session", mode: "subscription", subscription: "sub_1" }), env);
    expect((sqlite.prepare("SELECT completed_at,confirmed_at FROM checkout_consents").get() as any)).toMatchObject({ completed_at: expect.any(Number), confirmed_at: null });
    expect(await me(env, a.cookie)).toMatchObject({ plan: "daily", limit: 60, hasSubscription: true });
    env.EMAIL.send = send;
    await confirmPendingContracts(env);
    expect(env.EMAIL.sent).toHaveLength(1);
    const mail = env.EMAIL.sent[0];
    expect(mail.to).toBe("client@example.com");
    expect(mail.subject).toBe("Your Creator plan — Hookstreak Shorts");
    expect(mail.text).toContain(IMMEDIATE_START_TEXT);
    expect(mail.text).toContain("$35 a month");
    expect(mail.text).toContain("renews every month");
    expect(mail.text).toContain("https://app.test/terms#withdrawal-form");
    expect(mail.text).toContain("Test Co, 1 Example St, Sofia");
    await confirmPendingContracts(env);
    expect(env.EMAIL.sent).toHaveLength(1);
  });

  it("checks a yearly plan out at its yearly price and confirms it as yearly", async () => {
    const { env, sqlite } = billingEnv();
    const a = signedIn(sqlite, "client@example.com");
    const calls = stripeApi({ subscriptions: () => [] });
    const r = await call(worker, env, "POST", "/api/billing/checkout", { plan: "daily", interval: "year", immediateStart: true }, a.cookie);
    expect(r.status).toBe(200);
    expect(calls.some((c) => c.url.includes("/v1/prices/price_daily_yearly"))).toBe(true);
    expect(new URLSearchParams(calls.find((c) => c.url.endsWith("/v1/checkout/sessions"))!.body).get("line_items[0][price]")).toBe("price_daily_yearly");
    expect(sqlite.prepare("SELECT plan FROM checkout_consents").get()).toEqual({ plan: "daily:year" });
    stripeApi({ interval: "year" });
    await webhook(await event("checkout.session.completed", { id: "cs_test_1", object: "checkout.session", mode: "subscription", subscription: "sub_1" }), env);
    expect(env.EMAIL.sent).toHaveLength(1);
    expect(env.EMAIL.sent[0].text).toContain("$350 a year");
    expect(env.EMAIL.sent[0].text).toContain("renews every year");
  });

  it("refuses a price Stripe no longer sells at the plan's amount", async () => {
    const { env, sqlite } = billingEnv();
    const a = signedIn(sqlite);
    const calls = stripeApi({ subscriptions: () => [] });
    const fetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string, init: any) =>
      String(input).includes("/v1/prices/") ? Response.json({ id: "price_daily", active: true, currency: "usd", unit_amount: 4900, recurring: { interval: "month", interval_count: 1 } }) : fetch(input, init));
    const r = await call(worker, env, "POST", "/api/billing/checkout", { plan: "daily", immediateStart: true }, a.cookie);
    expect(r.status).toBe(503);
    expect(calls.some((c) => c.url.includes("/v1/checkout/sessions"))).toBe(false);
    expect(sqlite.prepare("SELECT COUNT(*) n FROM checkout_consents").get()).toEqual({ n: 0 });
  });
});

describe("withdrawal within 14 days", () => {
  it("shows the amount, then ends the plan, stops its credits, and refunds the unused share once", async () => {
    const { env, sqlite, admin, client } = paying();
    const calls = stripeApi();
    const quote = await call(worker, env, "GET", "/api/admin/withdrawals/quote?email=Client@Example.com", undefined, admin.cookie);
    expect(quote.data).toMatchObject({
      email: "client@example.com", plan: "Creator", open: true, paid: 3500, currency: "usd", used: 15, quota: 60, refund: 2625, withdrawal: null,
    });
    // The amount the administrator saw: more use since then changes it.
    const changed = await call(worker, env, "POST", "/api/admin/withdrawals", { email: "client@example.com", refund: 3500 }, admin.cookie);
    expect(changed.status).toBe(409);
    expect(calls.some((c) => c.method !== "GET")).toBe(false);
    const r = await call(worker, env, "POST", "/api/admin/withdrawals", { email: "client@example.com", refund: 2625 }, admin.cookie);
    expect(r.data).toMatchObject({ withdrawal: { refund: 2625, refunded: 2625, status: "completed", error: null } });
    const refund = calls.find((c) => c.url.endsWith("/v1/refunds"))!;
    expect(new URLSearchParams(refund.body).get("payment_intent")).toBe("pi_1");
    expect(new URLSearchParams(refund.body).get("amount")).toBe("2625");
    expect(refund.key).toBe(`withdrawal-${r.data.withdrawal.id}-pi_1`);
    // The plan ended before the money went back.
    expect(calls.findIndex((c) => c.method === "DELETE" && c.url.includes("/v1/subscriptions/sub_1"))).toBeLessThan(calls.indexOf(refund));
    expect(sqlite.prepare("SELECT status FROM subscriptions WHERE id='sub_1'").get()).toEqual({ status: "canceled" });
    expect(windowOf(sqlite, `${client.id}:sub_1:100`)).toEqual({ used: 15, quota: 15 });
    expect(windowOf(sqlite, `${client.id}:grant_1:100`)).toEqual({ used: 0, quota: 350 });
    expect(sqlite.prepare("SELECT status,paid,refund,refunded,used,quota,currency FROM withdrawals").get())
      .toEqual({ status: "completed", paid: 3500, refund: 2625, refunded: 2625, used: 15, quota: 60, currency: "usd" });
    // Once only.
    const again = await call(worker, env, "POST", "/api/admin/withdrawals", { email: "client@example.com", refund: 2625 }, admin.cookie);
    expect(again.status).toBe(409);
    expect(calls.filter((c) => c.url.endsWith("/v1/refunds"))).toHaveLength(1);
    const list = await call(worker, env, "GET", "/api/admin/withdrawals", undefined, admin.cookie);
    expect(list.data.withdrawals).toEqual([expect.objectContaining({ email: "client@example.com", refund: 2625, status: "completed" })]);
    expect((await call(worker, env, "GET", "/api/admin/withdrawals/quote?email=client@example.com", undefined, admin.cookie)).data.withdrawal).toMatchObject({ status: "completed" });
  });

  it("measures a yearly plan by twelve months of credits, used across its months", async () => {
    const { env, sqlite, admin, client } = paying();
    sqlite.prepare("UPDATE usage_windows SET used=20 WHERE id=?").run(`${client.id}:sub_1:100`);
    sqlite.prepare("INSERT INTO usage_windows(id,user_id,plan,quota,used) VALUES (?,?,'daily',60,40)").run(`${client.id}:sub_1:100:1`, client.id);
    // Another subscription's month is not part of it.
    sqlite.prepare("INSERT INTO usage_windows(id,user_id,plan,quota,used) VALUES (?,?,'daily',60,60)").run(`${client.id}:sub_0:50`, client.id);
    stripeApi({ interval: "year", amount: 28800 });
    const quote = await call(worker, env, "GET", "/api/admin/withdrawals/quote?email=client@example.com", undefined, admin.cookie);
    expect(quote.data).toMatchObject({ paid: 28800, used: 60, quota: 720, refund: 26400 });
  });

  it("counts the credits used before a change between monthly and yearly billing, whose payment is counted too", async () => {
    const { env, sqlite, admin, client } = paying();
    // The subscription's first, monthly period (50 credits used), before yearly billing started a new one at 100.
    sqlite.prepare("INSERT INTO usage_windows(id,user_id,plan,quota,used) VALUES (?,?,'daily',60,50)").run(`${client.id}:sub_1:40`, client.id);
    stripeApi({ interval: "year", amount: 28800 });
    const quote = await call(worker, env, "GET", "/api/admin/withdrawals/quote?email=client@example.com", undefined, admin.cookie);
    expect(quote.data).toMatchObject({ paid: 28800, used: 65, quota: 720, refund: 26200 });
  });

  it("records a refund Stripe refused for completion by hand, and refuses after 14 days or without a paid plan", async () => {
    const { env, sqlite, admin } = paying();
    stripeApi({ refundFails: true });
    const r = await call(worker, env, "POST", "/api/admin/withdrawals", { email: "client@example.com", refund: 2625 }, admin.cookie);
    expect(r.data).toMatchObject({ withdrawal: { refunded: 0, status: "refund_failed", error: expect.stringContaining("by hand") } });
    expect(sqlite.prepare("SELECT status FROM subscriptions WHERE id='sub_1'").get()).toEqual({ status: "canceled" });

    sqlite.exec("DELETE FROM withdrawals; UPDATE usage_windows SET quota=60 WHERE plan='daily'");
    stripeApi({ started: now() - 15 * DAY });
    const late = await call(worker, env, "POST", "/api/admin/withdrawals", { email: "client@example.com", refund: 2625 }, admin.cookie);
    expect(late.status).toBe(400);
    expect(late.data.error).toContain("withdrawal period ended");
    expect((await call(worker, env, "GET", "/api/admin/withdrawals/quote?email=nobody@example.com", undefined, admin.cookie)).status).toBe(404);
    // An account that never paid has no Stripe customer.
    const free = signedIn(sqlite, "free@example.com");
    expect((await call(worker, env, "GET", `/api/admin/withdrawals/quote?email=${free.email}`, undefined, admin.cookie)).status).toBe(404);
  });
});

/* ------------------------------------------------------------------------------------------------ refunds */

describe("refunds made in Stripe", () => {
  /** A customer in a paid Creator month (period from `start`), who bought a pack of 40 credits. */
  async function withPack(start = now() - DAY, end = start + 30 * DAY) {
    const { env, sqlite } = billingEnv();
    const client = signedIn(sqlite, "client@example.com");
    sqlite.prepare("UPDATE users SET stripe_customer='cus_1' WHERE id=?").run(client.id);
    sqlite.prepare("INSERT INTO subscriptions(id,user_id,plan,status,period_start,period_end,cancel_at_period_end,event_created) VALUES ('sub_1',?,'daily','active',?,?,0,1)")
      .run(client.id, start, end);
    const calls = stripeApi();
    await webhook(await event("checkout.session.completed", {
      id: "cs_pack", object: "checkout.session", mode: "payment", payment_status: "paid", customer: "cus_1", payment_intent: "pi_pack",
      amount_total: 2800, currency: "usd", metadata: { kind: "topup", pack: "pack40", credits: "40", user_id: client.id },
    }), env);
    expect(await me(env, client.cookie)).toMatchObject({ plan: "daily", limit: 100, topped: 40 });
    return { env, sqlite, client, calls };
  }
  const refunded = (intent: string) => ({ id: "ch_" + intent, object: "charge", customer: "cus_1", payment_intent: intent, amount: 2800, amount_refunded: 2800, refunded: true });

  it("take a pack's credits back once, also when Stripe sends the event again, and never end the plan for it", async () => {
    const { env, sqlite, client, calls } = await withPack();
    // The refund is applied, then recording the event fails: Stripe sends the same event again later.
    const prepare = env.DB.prepare;
    env.DB.prepare = (sql: string) => sql.startsWith("INSERT OR IGNORE INTO billing_events")
      ? { bind: () => ({ run: async () => { throw new Error("D1 unavailable"); } }) } : prepare(sql);
    await expect(webhook(await event("charge.refunded", refunded("pi_pack"), "evt_refund"), env)).rejects.toThrow("D1 unavailable");
    env.DB.prepare = prepare;
    expect(await me(env, client.cookie)).toMatchObject({ plan: "daily", limit: 60, topped: 0 });
    await webhook(await event("charge.refunded", refunded("pi_pack"), "evt_refund"), env);
    expect(await me(env, client.cookie)).toMatchObject({ plan: "daily", limit: 60, topped: 0 });
    expect(sqlite.prepare("SELECT status FROM subscriptions WHERE id='sub_1'").get()).toEqual({ status: "active" });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM billing_events WHERE id='evt_refund'").get()).toEqual({ n: 1 });
    // Neither does a full refund of a payment that is not one of the subscription's invoices; only that ends the plan.
    await webhook(await event("charge.refunded", refunded("pi_other")), env);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(await me(env, client.cookie)).toMatchObject({ plan: "daily", limit: 60 });
    await webhook(await event("charge.refunded", refunded("pi_1")), env);
    expect(calls.filter((c) => c.method === "DELETE").map((c) => new URL(c.url).pathname)).toEqual(["/v1/subscriptions/sub_1"]);
    expect(await me(env, client.cookie)).toMatchObject({ plan: "free" });
  });

  it("take a pack's credits back from the month they rolled over into", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const start = Date.UTC(2026, 3, 1) / 1000;
      vi.setSystemTime((start + HOUR) * 1000);
      const { env, sqlite, client } = await withPack(start, addMonths(start, 1));
      sqlite.prepare("UPDATE usage_windows SET used=50 WHERE id=?").run(`${client.id}:sub_1:${start}`);
      // Renewed a month later: the 50 left (the pack's 40 among them) roll over.
      vi.setSystemTime((addMonths(start, 1) + HOUR) * 1000);
      sqlite.prepare("UPDATE sessions SET expires_at=?").run(now() + DAY);
      sqlite.prepare("UPDATE subscriptions SET period_start=?,period_end=? WHERE id='sub_1'").run(addMonths(start, 1), addMonths(start, 2));
      expect(await me(env, client.cookie)).toMatchObject({ limit: 110, carried: 50 });
      await webhook(await event("charge.refunded", refunded("pi_pack")), env);
      expect(await me(env, client.cookie)).toMatchObject({ plan: "daily", limit: 70, carried: 10 });
    } finally {
      vi.useRealTimers();
    }
  });
});

/* ------------------------------------------------------------------------------------------------ grants */

describe("plan grants", () => {
  it("give a plan with all its credits for a calendar month without Stripe, and end it", async () => {
    const { env, sqlite, admin, user } = admins();
    expect((await call(worker, env, "POST", "/api/admin/grants", { email: "nobody@example.com", plan: "studio" }, admin.cookie)).status).toBe(404);
    expect((await call(worker, env, "POST", "/api/admin/grants", { email: user.email, plan: "free" }, admin.cookie)).status).toBe(400);
    const r = await call(worker, env, "POST", "/api/admin/grants", { email: ` ${user.email.toUpperCase()} `, plan: "studio" }, admin.cookie);
    expect(r.status).toBe(201);
    expect(r.data.id).toMatch(/^grant_/);
    const start = (sqlite.prepare("SELECT period_start FROM subscriptions WHERE id=?").get(r.data.id) as any).period_start;
    expect(r.data.end).toBe(addMonths(start, 1));
    expect(r.data.paidPlan).toBeNull();
    expect(await me(env, user.cookie)).toMatchObject({ plan: "studio", limit: 350, used: 0, granted: true, hasSubscription: false, periodEnd: r.data.end, trialEndsAt: null });
    expect(sqlite.prepare("SELECT max_bytes FROM media_limits WHERE user_id=?").get(user.id)).toEqual({ max_bytes: 200 * 1024 ** 3 });
    const list = await call(worker, env, "GET", "/api/admin/grants", undefined, admin.cookie);
    expect(list.data.grants).toMatchObject([{ id: r.data.id, plan: "studio", email: user.email, used: 0 }]);
    expect((await call(worker, env, "DELETE", `/api/admin/grants/${r.data.id}`, undefined, admin.cookie)).status).toBe(200);
    expect(await me(env, user.cookie)).toMatchObject({ plan: "free", granted: false });
    expect((await call(worker, env, "DELETE", `/api/admin/grants/${r.data.id}`, undefined, admin.cookie)).status).toBe(404);
    expect((await call(worker, env, "DELETE", "/api/admin/grants/sub_1", undefined, admin.cookie)).status).toBe(404);
  });

  it("last 1, 3, 6 or 12 months, each month with the plan's full credits and nothing carried over", async () => {
    const { env, sqlite, admin, user } = admins();
    expect((await call(worker, env, "POST", "/api/admin/grants", { email: user.email, plan: "studio", months: 2 }, admin.cookie)).status).toBe(400);
    const g = (await call(worker, env, "POST", "/api/admin/grants", { email: user.email, plan: "studio", months: 3 }, admin.cookie)).data;
    const start = (sqlite.prepare("SELECT period_start FROM subscriptions WHERE id=?").get(g.id) as any).period_start;
    expect(g.end).toBe(addMonths(start, 3));
    expect(await me(env, user.cookie)).toMatchObject({ plan: "studio", used: 0, limit: 350, granted: true, renewsAt: addMonths(start, 1), periodEnd: g.end });
    // Into its second month: the first month's credits were nearly all used; the second starts full.
    const s0 = now() - 40 * DAY;
    sqlite.prepare("UPDATE subscriptions SET period_start=?,period_end=? WHERE id=?").run(s0, addMonths(s0, 3), g.id);
    sqlite.prepare("INSERT INTO usage_windows(id,user_id,plan,quota,used,created_at) VALUES (?,?,'studio',350,300,?)").run(`${user.id}:${g.id}:${s0}`, user.id, s0);
    expect(await me(env, user.cookie)).toMatchObject({ plan: "studio", used: 0, limit: 350, carried: 0, granted: true, renewsAt: addMonths(s0, 2), periodEnd: addMonths(s0, 3) });
    expect(windowOf(sqlite, `${user.id}:${g.id}:${s0}:1`)).toEqual({ used: 0, quota: 350 });
    sqlite.prepare("UPDATE usage_windows SET used=20 WHERE id=?").run(`${user.id}:${g.id}:${s0}:1`);
    // The list counts what all its months used.
    const list = (await call(worker, env, "GET", "/api/admin/grants", undefined, admin.cookie)).data;
    expect(list.grants).toMatchObject([{ id: g.id, plan: "studio", start: s0, end: addMonths(s0, 3), used: 320 }]);
    const year = (await call(worker, env, "POST", "/api/admin/grants", { email: user.email, plan: "starter", months: 12 }, admin.cookie)).data;
    const from = (sqlite.prepare("SELECT period_start FROM subscriptions WHERE id=?").get(year.id) as any).period_start;
    expect(year.end).toBe(addMonths(from, 12));
    expect(await me(env, user.cookie)).toMatchObject({ plan: "starter", used: 0, granted: true, periodEnd: year.end });
  });

  it("find accounts by part of their email, with the plan each pays for and a running free plan", async () => {
    const { env, sqlite, admin, user } = admins();
    const other = signedIn(sqlite, "maria_ivanova@studio.test");
    sqlite.prepare("INSERT INTO subscriptions(id,user_id,plan,status,period_start,period_end) VALUES ('sub_m',?,'double','active',?,?)").run(other.id, now() - 60, now() + 20 * DAY);
    const g = (await call(worker, env, "POST", "/api/admin/grants", { email: user.email, plan: "daily", months: 6 }, admin.cookie)).data;
    const find = async (q: string) => call(worker, env, "GET", `/api/admin/grants/accounts?q=${encodeURIComponent(q)}`, undefined, admin.cookie);
    expect((await find("a")).status).toBe(400);
    expect((await find(user.email.slice(0, 9).toUpperCase())).data.accounts).toEqual([
      { id: user.id, email: user.email, name: "Test User", createdAt: expect.any(Number), paidPlan: null, grantId: g.id, grantPlan: "daily", grantEnd: g.end },
    ]);
    expect((await find("IVANOVA@")).data.accounts).toMatchObject([{ id: other.id, paidPlan: "double", grantId: null, grantPlan: null }]);
    // Emails starting with the search come first; % and _ are matched as they are.
    expect((await find("example.com")).data.accounts.map((a: any) => a.email)).toEqual([admin.email, user.email].sort());
    // ("adm": the other test user's email is random hex, which can hold "ad" but never an "m".)
    expect((await find("adm")).data.accounts.map((a: any) => a.email)).toEqual([admin.email]);
    expect((await find("a_i")).data.accounts.map((a: any) => a.email)).toEqual([other.email]);
    expect((await find("%%")).data.accounts).toEqual([]);
    expect((await find("a_m")).data.accounts).toEqual([]);
    expect((await find("nobody")).data.accounts).toEqual([]);
  });

  it("start a new month with a fresh usage window when given again, and end by themselves", async () => {
    const { env, sqlite, admin, user } = admins();
    const first = (await call(worker, env, "POST", "/api/admin/grants", { email: user.email, plan: "daily" }, admin.cookie)).data;
    await me(env, user.cookie);
    sqlite.prepare("UPDATE usage_windows SET used=55 WHERE id LIKE ?").run(`${user.id}:grant_%`);
    expect(await me(env, user.cookie)).toMatchObject({ plan: "daily", used: 55, limit: 60 });
    const second = (await call(worker, env, "POST", "/api/admin/grants", { email: user.email, plan: "daily" }, admin.cookie)).data;
    expect(second.id).not.toBe(first.id);
    // The replaced grant ended at once; the new one starts with its full plan and nothing used (free months take no
    // part in rollover).
    expect(sqlite.prepare("SELECT period_end<=? AS ended FROM subscriptions WHERE id=?").get(now(), first.id)).toEqual({ ended: 1 });
    expect(await me(env, user.cookie)).toMatchObject({ plan: "daily", used: 0, limit: 60, carried: 0, granted: true });
    sqlite.prepare("UPDATE subscriptions SET period_end=? WHERE id=?").run(now() - 1, second.id);
    expect(await me(env, user.cookie)).toMatchObject({ plan: "free", granted: false, paymentIssue: false });
  });

  it("win over a lower paid plan while they run, never hide a higher one, and are left alone by Stripe", async () => {
    const { env, sqlite, admin, user } = admins({ BILLING_ENABLED: "true", STRIPE_SECRET_KEY: "sk_test_local_only", STRIPE_PRICE_STARTER: "price_starter" });
    sqlite.prepare("UPDATE users SET stripe_customer='cus_9' WHERE id=?").run(user.id);
    sqlite.prepare("INSERT INTO subscriptions(id,user_id,plan,status,period_start,period_end) VALUES ('sub_9',?,'starter','active',?,?)").run(user.id, now() - 60, now() + 20 * DAY);
    const g = (await call(worker, env, "POST", "/api/admin/grants", { email: user.email, plan: "daily" }, admin.cookie)).data;
    expect(g.paidPlan).toBe("starter");
    expect(await me(env, user.cookie)).toMatchObject({ plan: "daily", granted: true, hasSubscription: true });
    sqlite.prepare("UPDATE subscriptions SET plan='studio' WHERE id='sub_9'").run();
    expect(await me(env, user.cookie)).toMatchObject({ plan: "studio", granted: false, hasSubscription: true });
    sqlite.prepare("UPDATE subscriptions SET plan='starter' WHERE id='sub_9'").run();

    // The nightly reconciliation never asks Stripe about a grant, even one that ended.
    sqlite.prepare("DELETE FROM subscriptions WHERE id='sub_9'").run();
    sqlite.prepare("UPDATE subscriptions SET period_end=? WHERE id=?").run(now() - DAY, g.id);
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => { calls.push(url); return Response.json({ object: "list", data: [], has_more: false }); });
    await reconcileStripe(env);
    expect(calls).toEqual([]);
    expect(sqlite.prepare("SELECT status FROM subscriptions WHERE id=?").get(g.id)).toEqual({ status: "active" });
    expect(JSON.parse((sqlite.prepare("SELECT value FROM operations_state WHERE key='stripe'").get() as any).value)).toMatchObject({ checked: 0, failed: 0 });
    // A full refund ends paid periods only: the paid month's credits stop, the grant's stay.
    const running = (await call(worker, env, "POST", "/api/admin/grants", { email: user.email, plan: "studio" }, admin.cookie)).data;
    await me(env, user.cookie);
    const start = (sqlite.prepare("SELECT period_start FROM subscriptions WHERE id=?").get(running.id) as any).period_start;
    const granted = windowOf(sqlite, `${user.id}:${running.id}:${start}`);
    expect(granted.quota).toBeGreaterThanOrEqual(350);
    const paidWindows = () => sqlite.prepare("SELECT used,quota FROM usage_windows WHERE id LIKE ?").all(`${user.id}:sub_9:%`) as any[];
    expect(paidWindows()).toEqual([{ used: 0, quota: expect.any(Number) }]);
    expect(paidWindows()[0].quota).toBeGreaterThan(0);
    stripeApi({ subscriptions: () => [] });
    sqlite.prepare("UPDATE users SET stripe_customer='cus_1' WHERE id=?").run(user.id);
    await webhook(await event("charge.refunded", { id: "ch_1", object: "charge", customer: "cus_1", payment_intent: "pi_1", refunded: true }), { ...env, STRIPE_WEBHOOK_SECRET: secret });
    expect(windowOf(sqlite, `${user.id}:${running.id}:${start}`)).toEqual(granted);
    expect(paidWindows()).toEqual([{ used: 0, quota: 0 }]);
    expect(await me(env, user.cookie)).toMatchObject({ plan: "studio", granted: true, limit: granted.quota });
  });
});

/* ------------------------------------------------------------------------------------------------ retention */

describe("retention", () => {
  it("deletes or clears exactly what has expired, and nothing else", async () => {
    const { env, sqlite } = testEnv();
    const t = now(), old = (days: number) => t - days * DAY;
    const keep = signedIn(sqlite, "keep@example.com");
    const ins = (sql: string, ...args: unknown[]) => sqlite.prepare(sql).run(...(args as any[]));
    ins("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES ('s-old',?,?),('s-new',?,?)", keep.id, t - 1, keep.id, t + 60);
    ins("INSERT INTO auth_tokens(token_hash,user_id,kind,expires_at) VALUES ('a-old',?,'verify',?),('a-new',?,'reset',?)", keep.id, t - 1, keep.id, t + 60);
    ins("INSERT INTO rate_limits(key,hits,expires_at) VALUES ('r-old',1,?),('r-new',1,?)", t - 1, t + 60);
    ins("INSERT INTO oauth_states(state_hash,user_id,platform,verifier,expires_at) VALUES ('o-old',?,'tiktok','v',?),('o-new',?,'youtube','v',?)", keep.id, t - 1, keep.id, t + 60);
    ins("INSERT INTO contact_messages(id,name,email,topic,message,created_at) VALUES ('m-old','A','a@x.test','question','hello there',?),('m-new','B','b@x.test','question','hello there',?)", old(366), old(364));
    ins("INSERT INTO billing_events(id,created_at) VALUES ('evt-old',?),('evt-new',?)", old(91), old(89));
    ins("INSERT INTO checkout_intents(user_id,plan,intent_id,expires_at) VALUES (?,'daily:month','i1',?)", keep.id, old(8));
    ins("INSERT INTO trial_history(email_hash,used,updated_at) VALUES ('h-old',1,?),('h-new',1,?),('h-zero',1,0)", old(731), old(729));
    // Evidence: kept while the account exists, then 5 years.
    ins("INSERT INTO terms_acceptances(user_id,version,accepted_at,account_deleted_at) VALUES ('gone-old','v',1,?),('gone-new','v',1,?),(?,'v',1,NULL)", old(5 * 365 + 1), old(5 * 365 - 1), keep.id);
    ins("INSERT INTO checkout_consents(session_id,user_id,plan,version,created_at,completed_at,confirmed_at,account_deleted_at) VALUES ('cs-gone','gone-old','studio:month','v',1,1,1,?),('cs-abandoned',?,'studio:month','v',?,NULL,NULL,NULL),('cs-paid',?,'studio:month','v',?,?,?,NULL),('cs-unconfirmed',?,'daily:year','v',?,?,NULL,NULL),('cs-recent',?,'studio:month','v',?,NULL,NULL,NULL)",
      old(5 * 365 + 1), keep.id, old(31), keep.id, old(400), old(400), old(400), keep.id, old(40), old(40), keep.id, old(2));
    ins("INSERT INTO withdrawals(id,user_id,subscription_id,paid,refund,used,quota,status,created_at,updated_at) VALUES ('w-old','x','sub_a',1,1,0,1,'completed',?,?),('w-new','x','sub_b',1,1,0,1,'completed',?,?)",
      old(5 * 365 + 1), old(5 * 365 + 1), old(5 * 365 - 1), old(5 * 365 - 1));
    // Runs: details go 30 days after they finished; the revision and the watermark choice stay.
    ins("INSERT INTO usage_windows(id,user_id,quota) VALUES (?,?,100)", `${keep.id}:trial`, keep.id);
    const run = (id: string, status: string, updated: number, payload: object, provider: object, created = updated) =>
      ins("INSERT INTO runs(id,user_id,window_id,idempotency_key,kind,status,payload,provider,created_at,updated_at) VALUES (?,?,?,?,'video',?,?,?,?,?)",
        id, keep.id, `${keep.id}:trial`, id, status, JSON.stringify(payload), JSON.stringify(provider), created, updated);
    const state = { token: "tok", tickets: { "ai-0": { request_id: "req_1" } }, words: [{ w: "hi" }] };
    run("run-old", "completed", old(31), { prompt: "my secret product", revision: 2, watermark: true }, state);
    run("run-failed", "failed", old(31), { prompt: "a private idea", description: "my photo" }, state);
    run("run-new", "completed", old(29), { prompt: "recent" }, state);
    run("run-unstarted", "failed", old(33), { prompt: "never sent", revision: 1 }, {});
    run("run-open", "running", old(31), { prompt: "still working" }, state);
    // Publications: a failed or cancelled one drops its media token and ticket after 30 days.
    ins("INSERT INTO videos(id,user_id,spec,created_at,updated_at) VALUES ('v1',?,'{}',1,1)", keep.id);
    const pub = (id: string, status: string, updated: number) =>
      ins("INSERT INTO publications(id,user_id,video_id,platform,scheduled_at,status,token,ticket,created_at,updated_at) VALUES (?,?,'v1','tiktok',1,?,'tk','{\"publish_id\":\"x\"}',1,?)", id, keep.id, status, updated);
    pub("pub-failed-old", "failed", old(31)); pub("pub-canceled-old", "canceled", old(31)); pub("pub-failed-new", "failed", old(29)); pub("pub-scheduled-old", "scheduled", old(31));
    // Accounts never confirmed: 30 days (never one with a Stripe customer).
    const unconfirmed = (email: string, created: number, customer: string | null = null) => {
      const id = crypto.randomUUID();
      ins("INSERT INTO users(id,email,name,password_hash,verified,stripe_customer,created_at) VALUES (?,?,'U','x',0,?,?)", id, email, customer, created);
      ins("INSERT INTO terms_acceptances(user_id,version,accepted_at) VALUES (?,'v',?)", id, created);
      return id;
    };
    const stale = unconfirmed("stale@example.com", old(31)), fresh = unconfirmed("fresh@example.com", old(29)), customer = unconfirmed("cust@example.com", old(40), "cus_x");
    sqlite.prepare("UPDATE users SET created_at=? WHERE id=?").run(old(400), keep.id);

    await applyRetention(env, t);

    const ids = (sql: string) => (sqlite.prepare(sql).all() as any[]).map((r) => Object.values(r)[0]);
    expect(ids("SELECT token_hash FROM sessions WHERE token_hash LIKE 's-%'")).toEqual(["s-new"]);
    expect(ids("SELECT token_hash FROM auth_tokens")).toEqual(["a-new"]);
    expect(ids("SELECT key FROM rate_limits")).toEqual(["r-new"]);
    expect(ids("SELECT state_hash FROM oauth_states")).toEqual(["o-new"]);
    expect(ids("SELECT id FROM contact_messages")).toEqual(["m-new"]);
    expect(ids("SELECT id FROM billing_events")).toEqual(["evt-new"]);
    expect(ids("SELECT intent_id FROM checkout_intents")).toEqual([]);
    expect(ids("SELECT email_hash FROM trial_history ORDER BY email_hash")).toEqual(["h-new", "h-zero"]);
    expect((sqlite.prepare("SELECT updated_at FROM trial_history WHERE email_hash='h-zero'").get() as any).updated_at).toBe(t);
    expect(new Set(ids("SELECT user_id FROM terms_acceptances"))).toEqual(new Set(["gone-new", keep.id, stale, fresh, customer]));
    expect(sqlite.prepare("SELECT account_deleted_at FROM terms_acceptances WHERE user_id=?").get(stale)).toEqual({ account_deleted_at: expect.any(Number) });
    expect(ids("SELECT session_id FROM checkout_consents ORDER BY session_id")).toEqual(["cs-paid", "cs-recent", "cs-unconfirmed"]);
    expect(ids("SELECT id FROM withdrawals")).toEqual(["w-new"]);
    const runs = Object.fromEntries((sqlite.prepare("SELECT id,payload,provider FROM runs").all() as any[]).map((r) => [r.id, { payload: JSON.parse(r.payload), provider: JSON.parse(r.provider) }]));
    // (SQLite's json_extract reads JSON true back as 1.)
    expect({ ...runs["run-old"], payload: { ...runs["run-old"].payload, watermark: !!runs["run-old"].payload.watermark } })
      .toEqual({ payload: { revision: 2, watermark: true }, provider: {} });
    expect(runs["run-failed"]).toEqual({ payload: {}, provider: {} });
    expect(runs["run-new"]).toEqual({ payload: { prompt: "recent" }, provider: state });
    expect(runs["run-unstarted"]).toEqual({ payload: { revision: 1 }, provider: {} });
    expect(runs["run-open"]).toEqual({ payload: { prompt: "still working" }, provider: state });
    expect(sqlite.prepare("SELECT id,token,ticket FROM publications ORDER BY id").all()).toEqual([
      { id: "pub-canceled-old", token: null, ticket: null }, { id: "pub-failed-new", token: "tk", ticket: '{"publish_id":"x"}' },
      { id: "pub-failed-old", token: null, ticket: null }, { id: "pub-scheduled-old", token: "tk", ticket: '{"publish_id":"x"}' },
    ]);
    expect(new Set(ids("SELECT email FROM users"))).toEqual(new Set(["keep@example.com", "fresh@example.com", "cust@example.com"]));
    expect(ids("SELECT prefix FROM cleanup_tasks")).toEqual([`media/${stale}/`]);
    // Videos and their files are the owner's to delete: retention leaves them.
    expect(ids("SELECT id FROM videos")).toEqual(["v1"]);
  });

  it("keeps an unconfirmed account with work in progress until it is done", async () => {
    const { env, sqlite } = testEnv();
    const id = crypto.randomUUID();
    sqlite.prepare("INSERT INTO users(id,email,name,password_hash,verified,created_at) VALUES (?,'busy@example.com','U','x',0,?)").run(id, now() - 40 * DAY);
    sqlite.prepare("INSERT INTO usage_windows(id,user_id,quota) VALUES (?,?,10)").run(`${id}:trial`, id);
    sqlite.prepare("INSERT INTO runs(id,user_id,window_id,idempotency_key,kind,status,created_at,updated_at) VALUES ('r1',?,?,'k','video','running',?,?)").run(id, `${id}:trial`, now(), now());
    sqlite.prepare("INSERT INTO terms_acceptances(user_id,version,accepted_at) VALUES (?,'v',1)").run(id);
    await applyRetention(env);
    expect(sqlite.prepare("SELECT COUNT(*) n FROM users").get()).toEqual({ n: 1 });
    // The refused delete leaves nothing behind: the evidence was not marked deleted, no files were queued.
    expect(sqlite.prepare("SELECT account_deleted_at FROM terms_acceptances").all()).toEqual([{ account_deleted_at: null }]);
    expect(sqlite.prepare("SELECT COUNT(*) n FROM cleanup_tasks").get()).toEqual({ n: 0 });
    // Once the work is done, the next run deletes it.
    sqlite.prepare("UPDATE runs SET status='completed'").run();
    await applyRetention(env);
    expect(sqlite.prepare("SELECT COUNT(*) n FROM users").get()).toEqual({ n: 0 });
    expect(sqlite.prepare("SELECT prefix FROM cleanup_tasks").all()).toEqual([{ prefix: `media/${id}/` }]);
  });
});

/* ------------------------------------------------------------------------------------------------ storage cleanup */

describe("storage cleanup", () => {
  /** Counts the R2 calls cleanup makes, and the keys each delete asks for. */
  function watched(env: any) {
    const calls = { lists: 0, deletes: [] as number[] };
    const list = env.MEDIA.list, del = env.MEDIA.delete;
    env.MEDIA.list = async (o: any) => { calls.lists++; return list(o); };
    env.MEDIA.delete = async (keys: string | string[]) => { calls.deletes.push([keys].flat().length); return del(keys); };
    return calls;
  }
  const waiting = (sqlite: any) => (sqlite.prepare("SELECT COUNT(*) n FROM cleanup_tasks").get() as { n: number }).n;

  it("deletes a deleted account's 5,000 files in one pass, 1,000 keys a call, and what was queued after it", async () => {
    const { env, sqlite } = testEnv();
    const gone = signedIn(sqlite), other = signedIn(sqlite);
    const file = sqlite.prepare("INSERT INTO media_assets(id,user_id,kind,name,object_key,mime,created_at,updated_at) VALUES (?,?,'upload','f',?,'video/mp4',1,1)");
    sqlite.exec("BEGIN");
    for (let i = 0; i < 5000; i++) {
      const id = crypto.randomUUID(), key = `media/${gone.id}/${id}.mp4`;
      file.run(id, gone.id, key);
      env.MEDIA.objects.set(key, { bytes: new Uint8Array(1) });
    }
    sqlite.exec("COMMIT");
    const kept = `media/${other.id}/kept.mp4`, deleted = `media/${other.id}/deleted.mp4`;
    file.run("kept", other.id, kept);
    file.run("deleted", other.id, deleted);
    await env.MEDIA.put(kept, "x");
    await env.MEDIA.put(deleted, "x");
    // The account goes (its folder and one task per file), then someone else deletes a file.
    sqlite.prepare("DELETE FROM users WHERE id=?").run(gone.id);
    sqlite.prepare("DELETE FROM media_assets WHERE id='deleted'").run();
    expect(waiting(sqlite)).toBe(5002);
    const calls = watched(env);
    await drainCleanup(env);
    expect(waiting(sqlite)).toBe(0);
    expect([...env.MEDIA.objects.keys()]).toEqual([kept]);
    expect(Math.max(...calls.deletes)).toBeLessThanOrEqual(1000);
    expect(calls.lists + calls.deletes.length).toBeLessThan(20);
  });

  it("keeps each pass within its time and calls, and the next pass goes on", async () => {
    const { env, sqlite } = testEnv();
    const queue = sqlite.prepare("INSERT INTO cleanup_tasks(prefix,created_at) VALUES (?,1)");
    sqlite.exec("BEGIN");
    for (let i = 0; i < 3000; i++) queue.run(`media/u/${crypto.randomUUID()}.mp4`);
    sqlite.exec("COMMIT");
    // R2 answering slowly: each call takes 20 seconds, so a pass ends after its second batch.
    let clock = Date.now();
    const slow = vi.spyOn(Date, "now").mockImplementation(() => clock);
    const calls = watched(env), del = env.MEDIA.delete;
    env.MEDIA.delete = async (keys: string[]) => { clock += 20_000; return del(keys); };
    await drainCleanup(env);
    expect(waiting(sqlite)).toBe(1000);
    await drainCleanup(env);
    expect(waiting(sqlite)).toBe(0);
    expect(calls.deletes).toEqual([1000, 1000, 1000]);

    // Folders are listed one by one: a pass stops at its share of calls and leaves the rest for the next.
    slow.mockRestore();
    sqlite.exec("BEGIN");
    for (let i = 0; i < 200; i++) {
      queue.run(`library/item${i}/`);
      env.MEDIA.objects.set(`library/item${i}/file.mp3`, { bytes: new Uint8Array(1) });
    }
    sqlite.exec("COMMIT");
    calls.lists = 0;
    calls.deletes = [];
    await drainCleanup(env);
    expect(calls.lists + calls.deletes.length).toBeLessThanOrEqual(CLEANUP_CALLS);
    expect(waiting(sqlite)).toBeGreaterThan(0);
    await drainCleanup(env);
    expect(waiting(sqlite)).toBe(0);
    expect(env.MEDIA.objects.size).toBe(0);
  });
});

describe("maintenance queries", () => {
  it("find unfinished videos and uploads through their small indexes, never by reading every row", async () => {
    const { env, sqlite } = testEnv();
    const statements = new Set<string>(), prepare = env.DB.prepare;
    env.DB.prepare = (sql: string) => { statements.add(sql); return prepare(sql); };
    // An hourly pass (publishing runs every minute, uploads are checked hourly) and a five-minute one (interrupted videos).
    await maintenance(env, HOURLY);
    await maintenance(env, Date.UTC(2026, 9, 9, 12, 20));
    const plan = (sql: string) => (sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...Array(sql.split("?").length - 1).fill(0)) as { detail: string }[])
      .map((r) => r.detail).join("; ");
    const plans = [...statements].filter((sql) => /WHERE render_status|FROM media_assets WHERE status=/.test(sql)).map(plan);
    // "The video couldn't be made in time" (publishing), interrupted videos, and unfinished, unchecked and failed uploads.
    expect(plans).toHaveLength(5);
    for (const p of plans) expect(p).not.toMatch(/SCAN (videos|media_assets)\b/);
    expect(plans.filter((p) => p.includes("USING INDEX videos_unfinished"))).toHaveLength(2);
    expect(plans.filter((p) => /USING (COVERING )?INDEX media_unfinished/.test(p))).toHaveLength(3);
  });
});

/* ------------------------------------------------------------------------------------------------ operations */

describe("YouTube upload allowance", () => {
  // Maintenance checks it every five minutes, at minutes ending in 4 or 9.
  const PASS = Date.UTC(2026, 9, 9, 12, 19);
  const setCount = (sqlite: any, count: number, refused = 0) =>
    sqlite.prepare("INSERT INTO operations_state(key,value,updated_at) VALUES ('youtube-uploads',?,0) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(JSON.stringify({ day: quotaDay(), count, refused }));

  it("counts days in Pacific time, when Google's quota restarts", () => {
    expect(quotaDay(Date.UTC(2026, 10, 2, 7, 59))).toBe("2026-11-01");
    expect(quotaDay(Date.UTC(2026, 10, 2, 8, 0))).toBe("2026-11-02");
    // Summer time: UTC−7.
    expect(quotaDay(Date.UTC(2026, 6, 1, 6, 59))).toBe("2026-06-30");
    expect(quotaDay(Date.UTC(2026, 6, 1, 7, 0))).toBe("2026-07-01");
  });

  it("counts parallel uploads, a refusal without an upload, and starts again each day", async () => {
    const { env, sqlite } = testEnv();
    expect(await uploadsToday(env)).toEqual({ count: 0, limit: 100, refused: false });
    await Promise.all([countUpload(env), countUpload(env), countUpload(env)]);
    expect(await uploadsToday(env)).toEqual({ count: 3, limit: 100, refused: false });
    await countUpload(env, true);
    expect(await uploadsToday(env)).toEqual({ count: 3, limit: 100, refused: true });
    sqlite.prepare("UPDATE operations_state SET value=json_set(value,'$.day','2026-01-01') WHERE key='youtube-uploads'").run();
    expect(await uploadsToday(env)).toEqual({ count: 0, limit: 100, refused: false });
    await countUpload(env);
    expect(await uploadsToday(env)).toEqual({ count: 1, limit: 100, refused: false });
    // The limit Google set, once raised; anything else is the default.
    expect(await uploadsToday({ ...env, YOUTUBE_UPLOADS_DAILY: "300" })).toMatchObject({ limit: 300 });
    for (const v of ["lots", "0", "-5", "2.5"]) expect(await uploadsToday({ ...env, YOUTUBE_UPLOADS_DAILY: v })).toMatchObject({ limit: 100 });
    // A broken database never stops an upload.
    const broken = { ...env, DB: { prepare: () => { throw new Error("D1 down"); } } };
    await expect(countUpload(broken)).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledWith("YouTube upload not counted");
  });

  it("e-mails administrators at 80% of the day's uploads and when YouTube refuses one, each once a day", async () => {
    const { env, sqlite } = testEnv({ ADMIN_EMAILS: "admin@example.com, ops@example.com" });
    setCount(sqlite, 79);
    await maintenance(env, PASS);
    expect(env.EMAIL.sent).toHaveLength(0);
    setCount(sqlite, 80);
    // Not a checking minute.
    await maintenance(env, Date.UTC(2026, 9, 9, 12, 18));
    expect(env.EMAIL.sent).toHaveLength(0);
    await maintenance(env, PASS);
    expect(env.EMAIL.sent.map((m: any) => m.to).sort()).toEqual(["admin@example.com", "ops@example.com"]);
    const mail = env.EMAIL.sent[0];
    expect(mail.subject).toBe("Hookstreak Shorts: YouTube uploads at 80% of today's limit");
    expect(mail.text).toContain("YouTube uploads today: 80 of the 100 a day Google allows Hookstreak Shorts, for all customers together.");
    expect(mail.text).toContain("https://support.google.com/youtube/contact/yt_api_form");
    expect(mail.text).toContain("set YOUTUBE_UPLOADS_DAILY in Cloudflare to the new limit");
    expect(console.warn).toHaveBeenCalledWith("YouTube upload quota", { count: 80, limit: 100, refused: false });
    // More uploads the same day: no second warning.
    setCount(sqlite, 95);
    await maintenance(env, PASS);
    expect(env.EMAIL.sent).toHaveLength(2);
    // YouTube refused one: that is news, once.
    setCount(sqlite, 100, 1);
    await maintenance(env, PASS);
    expect(env.EMAIL.sent).toHaveLength(4);
    expect(env.EMAIL.sent[2].subject).toBe("Hookstreak Shorts: YouTube refused uploads, daily limit reached");
    expect(env.EMAIL.sent[2].text).toContain("(100 uploads counted today; YOUTUBE_UPLOADS_DAILY is 100)");
    await maintenance(env, PASS);
    expect(env.EMAIL.sent).toHaveLength(4);
    // The next day starts over.
    sqlite.prepare("UPDATE operations_state SET value=json_set(value,'$.day','2026-01-01') WHERE key='youtube-uploads-alert'").run();
    setCount(sqlite, 85);
    await maintenance(env, PASS);
    expect(env.EMAIL.sent).toHaveLength(6);
  });

  it("follows a raised limit, and tries a failed e-mail again on the next pass", async () => {
    const { env, sqlite } = testEnv({ YOUTUBE_UPLOADS_DAILY: "300" });
    setCount(sqlite, 200);
    await reportUploads(env);
    expect(env.EMAIL.sent).toHaveLength(0);
    setCount(sqlite, 240);
    const send = env.EMAIL.send;
    env.EMAIL.send = async () => { throw new Error("mail down"); };
    await reportUploads(env);
    expect(console.error).toHaveBeenCalledWith("YouTube quota alert not sent", { recipients: 1 });
    env.EMAIL.send = send;
    await reportUploads(env);
    expect(env.EMAIL.sent).toHaveLength(1);
    expect(env.EMAIL.sent[0].text).toContain("YouTube uploads today: 240 of the 300 a day");
    // Without administrators there is no one to tell.
    const { env: alone, sqlite: db } = testEnv({ ADMIN_EMAILS: "" });
    setCount(db, 99);
    await reportUploads(alone);
    expect(alone.EMAIL.sent).toHaveLength(0);
  });
});

describe("operations summary", () => {
  function ops() {
    const { env, sqlite } = testEnv({ ADMIN_EMAILS: "Admin@Example.com, ops@example.com, not-an-address" });
    const u = signedIn(sqlite, "admin@example.com");
    sqlite.prepare("INSERT INTO usage_windows(id,user_id,quota) VALUES (?,?,1000)").run(`${u.id}:trial`, u.id);
    let n = 0;
    const run = (status: string, o: { created?: number; updated?: number; error?: string; provider?: object } = {}) => {
      const id = `run-${++n}`;
      sqlite.prepare("INSERT INTO runs(id,user_id,window_id,idempotency_key,kind,status,error,provider,created_at,updated_at) VALUES (?,?,?,?,'video',?,?,?,?,?)")
        .run(id, u.id, `${u.id}:trial`, id, status, o.error ?? null, JSON.stringify(o.provider ?? {}), o.created ?? now(), o.updated ?? now());
      return id;
    };
    return { env, sqlite, u, run };
  }
  const alert = (sqlite: any) => sqlite.prepare("SELECT value FROM operations_state WHERE key='alert'").get();

  it("e-mails every administrator once per change, again after 6 hours, and forgets a resolved state", async () => {
    const { env, sqlite, run } = ops();
    run("running", { created: now() - 4 * HOUR });
    for (const error of ["GENERATION_FAILED", "GENERATION_FAILED", "GENERATION_TIMEOUT", "VOICE_FAILED"]) run("failed", { created: now() - 20 * 60, error });
    // Refused prompts are about the content, never an outage.
    for (let i = 0; i < 5; i++) run("failed", { created: now() - 20 * 60, error: "GENERATION_REJECTED" });
    await maintenance(env, HOURLY);
    expect(env.EMAIL.sent.map((m: any) => m.to).sort()).toEqual(["admin@example.com", "ops@example.com"]);
    const mail = env.EMAIL.sent[0];
    expect(mail.subject).toBe("Hookstreak Shorts: maintenance needs a look");
    expect(mail.text).toContain("AI or render runs still open after 3 hours (maintenance should have ended and refunded them): 1");
    expect(mail.text).toContain("fal (AI pictures and clips): 3 failed runs in the last hour (GENERATION_FAILED 2, GENERATION_TIMEOUT 1)");
    // One voice failure is below the burst; refused prompts never count.
    expect(mail.text).not.toMatch(/ElevenLabs|GENERATION_REJECTED/);
    expect(mail.text).toContain("https://app.test/app/admin?tab=operations");
    expect(console.error).toHaveBeenCalledWith("Maintenance attention", expect.objectContaining({ runsStuck: 1, fal: 3 }));
    // Unchanged: nothing more within 6 hours.
    await maintenance(env, HOURLY);
    expect(env.EMAIL.sent).toHaveLength(2);
    // Something new: at once.
    sqlite.prepare("INSERT INTO manual_reviews(area,ref,request_id,reason,created_at) VALUES ('runs','r9','fal request req_9','timeout',?)").run(now());
    await maintenance(env, HOURLY);
    expect(env.EMAIL.sent).toHaveLength(4);
    expect(env.EMAIL.sent[2].text).toContain("Work set aside for a manual check");
    // The same state 7 hours later: a reminder.
    sqlite.prepare("UPDATE operations_state SET value=json_set(value,'$.at',?) WHERE key='alert'").run(now() - 7 * HOUR);
    await maintenance(env, HOURLY);
    expect(env.EMAIL.sent).toHaveLength(6);
    // Not the hourly minute: no summary at all.
    await maintenance(env, Date.UTC(2026, 9, 9, 12, 18));
    expect(env.EMAIL.sent).toHaveLength(6);
    // Resolved: no mail, and the state is forgotten so a recurrence is news again.
    sqlite.exec("UPDATE runs SET status='completed',updated_at=0,created_at=0; DELETE FROM manual_reviews");
    await maintenance(env, HOURLY);
    expect(env.EMAIL.sent).toHaveLength(6);
    expect(alert(sqlite)).toBeUndefined();
  });

  it("reminds of a cleanup backlog every 6 hours while it is worked through, not every hour as its count moves", async () => {
    const { env, sqlite, run } = ops();
    const queue = (n: number) => {
      for (let i = 0; i < n; i++) sqlite.prepare("INSERT INTO cleanup_tasks(prefix,created_at) VALUES (?,?)").run(`media/u/${crypto.randomUUID()}.mp4`, now() - 2 * DAY);
    };
    queue(3);
    await reportAttention(env);
    expect(env.EMAIL.sent).toHaveLength(2);
    expect(env.EMAIL.sent[0].text).toContain("Storage cleanup waiting for more than 1 day: 3");
    // Hours later fewer are left, then more joined: the same problem, no new mail.
    sqlite.prepare("DELETE FROM cleanup_tasks WHERE rowid IN (SELECT rowid FROM cleanup_tasks LIMIT 2)").run();
    await reportAttention(env);
    queue(5);
    await reportAttention(env);
    expect(env.EMAIL.sent).toHaveLength(2);
    // After 6 hours: a reminder, with the count then.
    sqlite.prepare("UPDATE operations_state SET value=json_set(value,'$.at',?) WHERE key='alert'").run(now() - 7 * HOUR);
    await reportAttention(env);
    expect(env.EMAIL.sent).toHaveLength(4);
    expect(env.EMAIL.sent[2].text).toContain("Storage cleanup waiting for more than 1 day: 6");
    // Anything else is news at once.
    run("running", { created: now() - 4 * HOUR });
    await reportAttention(env);
    expect(env.EMAIL.sent).toHaveLength(6);
  });

  it("counts HeyGen's copies waiting for deletion apart from storage cleanup, and gives them up after two weeks without a key", async () => {
    const { env, sqlite } = ops();
    expect(env.HEYGEN_API_KEY).toBeUndefined();
    sqlite.prepare("INSERT INTO cleanup_tasks(prefix,created_at) VALUES ('heygen/video/vid_1',?),('heygen/video/vid_2',?)").run(now() - 2 * DAY, now() - 15 * DAY);
    const fetched: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => { fetched.push(url); return Response.json({}); });
    // The summary goes out first, then the HeyGen stage.
    await maintenance(env, HOURLY);
    expect(env.EMAIL.sent).toHaveLength(2);
    expect(env.EMAIL.sent[0].text).toContain("HeyGen copies of presenter videos and clips not deleted at HeyGen after 1 day");
    expect(env.EMAIL.sent[0].text).not.toContain("Storage cleanup");
    // Nothing could be asked of HeyGen: the copy two weeks old is given up (to delete in HeyGen by hand), the other waits.
    expect(fetched).toEqual([]);
    expect(console.error).toHaveBeenCalledWith("HeyGen copy could not be deleted; remove it in HeyGen", { task: "heygen/video/vid_2" });
    expect(sqlite.prepare("SELECT prefix FROM cleanup_tasks").all()).toEqual([{ prefix: "heygen/video/vid_1" }]);
    expect((await attention(env)).counts).toMatchObject({ cleanup: 0, heygenCleanup: 1 });
    expect((await operationsSnapshot(env)).cleanup).toEqual({ pending: 0, overdue: 0, oldest: null, heygen: 1 });
  });

  it("never lets a mail failure or a failing stage stop maintenance; both are reported next hour", async () => {
    const { env, sqlite, run } = ops();
    run("running", { created: now() - 4 * HOUR });
    env.EMAIL.send = async () => { throw new Error("mail down"); };
    sqlite.prepare("INSERT INTO cleanup_tasks(prefix,created_at) VALUES ('media/u/old.jpg',?)").run(now() - 2 * DAY);
    env.MEDIA.delete = async () => { throw new Error("R2 down"); };
    sqlite.prepare("INSERT INTO sessions(token_hash,user_id,expires_at) SELECT 'expired',id,1 FROM users").run();
    await maintenance(env, HOURLY);
    expect(console.error).toHaveBeenCalledWith("Operator alert not sent", { recipients: 2 });
    expect(console.error).toHaveBeenCalledWith("Maintenance stage failed", expect.objectContaining({ stage: "cleanup" }));
    // Later stages still ran (retention removed the expired session), and the run was recorded.
    expect(sqlite.prepare("SELECT COUNT(*) n FROM sessions WHERE token_hash='expired'").get()).toEqual({ n: 0 });
    expect(alert(sqlite)).toBeUndefined();
    const sent: any[] = [];
    env.EMAIL.send = async (m: any) => { sent.push(m); };
    await maintenance(env, HOURLY);
    expect(sent).toHaveLength(2);
    expect(sent[0].text).toContain("Maintenance stages that failed in the last hour: 1 (cleanup)");
    expect(sent[0].text).toContain("Storage cleanup waiting for more than 1 day: 1");
    const snapshot = await operationsSnapshot(env);
    expect(snapshot.maintenance).toMatchObject({ failed: ["cleanup"] });
    expect(snapshot.stages.map((s) => s.name)).toEqual(["cleanup"]);
    expect(snapshot.cleanup).toMatchObject({ pending: 1, overdue: 1 });
  });

  it("sets aside provider work that may still bill and storage cleanup it refuses, and shows them to administrators", async () => {
    const { env, sqlite, run, u } = ops();
    const timedOut = run("failed", { created: now() - 2 * HOUR, error: "GENERATION_TIMEOUT", provider: { claims: { "ai-0": true }, tickets: { "ai-0": { request_id: "req_1" } } } });
    // Its picture arrived before the run gave up: nothing left at fal.
    run("failed", { created: now() - 2 * HOUR, error: "GENERATION_TIMEOUT", provider: { claims: { "ai-0": true }, tickets: { "ai-0": { request_id: "req_0" } }, assets: { "ai-0": "a1" } } });
    const lost = run("failed", { created: now() - HOUR, error: "GENERATION_UNCERTAIN", provider: { claims: { "ai-1": true, "ai-1-accepted": true, voice: true } } });
    const broken = run("failed", { created: now() - HOUR, error: "INTERNAL", provider: { claims: { "ai-2": true }, tickets: { "ai-2": { request_id: "req_2" } } } });
    // A voice failure is ElevenLabs' answer, nothing left running.
    run("failed", { created: now() - HOUR, error: "VOICE_FAILED", provider: { claims: { voice: true } } });
    await reviewRuns(env);
    expect(sqlite.prepare("SELECT ref,request_id,reason FROM manual_reviews ORDER BY ref").all()).toEqual([
      { ref: timedOut, request_id: "fal request req_1", reason: "timeout" }, { ref: lost, request_id: null, reason: "uncertain" },
      { ref: broken, request_id: "fal request req_2", reason: "failed" },
    ]);
    // Set aside once.
    await reviewRuns(env);
    expect(sqlite.prepare("SELECT COUNT(*) n FROM manual_reviews").get()).toEqual({ n: 3 });
    sqlite.prepare("INSERT INTO cleanup_tasks(prefix,created_at) VALUES ('config/everything',1),('media/u/a.jpg',1),('media/../x',1)").run();
    await env.MEDIA.put("config/everything", "x");
    await env.MEDIA.put("media/u/a.jpg", "x");
    await drainCleanup(env);
    expect(env.MEDIA.objects.has("config/everything")).toBe(true);
    expect(env.MEDIA.objects.has("media/u/a.jpg")).toBe(false);
    expect(sqlite.prepare("SELECT COUNT(*) n FROM cleanup_tasks").get()).toEqual({ n: 0 });
    expect(sqlite.prepare("SELECT ref,reason FROM manual_reviews WHERE area='cleanup' ORDER BY ref").all())
      .toEqual([{ ref: "config/everything", reason: "refused" }, { ref: "media/../x", reason: "refused" }]);

    // Accounts ending at scale, failed and overdue publishing, Stripe: counted and grouped.
    sqlite.prepare("INSERT INTO videos(id,user_id,spec,render_status,created_at,updated_at) VALUES ('v1',?,'{}','ready',1,1)").run(u.id);
    for (let i = 0; i < 5; i++)
      sqlite.prepare("INSERT INTO social_accounts(id,user_id,platform,external_id,name,credentials,status,created_at,updated_at) VALUES (?,?,'instagram',?,'A','x','expired',1,?)").run(`acc${i}`, u.id, `e${i}`, now() - HOUR);
    for (let i = 0; i < 3; i++)
      sqlite.prepare("INSERT INTO publications(id,user_id,video_id,platform,scheduled_at,status,error,created_at,updated_at) VALUES (?,?,'v1','tiktok',?,'failed',?,1,?)")
        .run(`f${i}`, u.id, now() - HOUR, "TikTok had a problem publishing this post. Try again.", now() - 60);
    sqlite.prepare("INSERT INTO publications(id,user_id,video_id,platform,scheduled_at,status,created_at,updated_at) VALUES ('late',?,'v1','youtube',?,'scheduled',1,1)").run(u.id, now() - HOUR);
    sqlite.prepare("INSERT INTO subscriptions(id,user_id,plan,status,period_start,period_end) VALUES ('sub_late',?,'starter','active',1,?),('grant_x',?,'studio','active',1,?)").run(u.id, now() - 5 * DAY, u.id, now() - 5 * DAY);
    sqlite.prepare("INSERT INTO operations_state(key,value,updated_at) VALUES ('stripe',?,1)").run(JSON.stringify({ at: now() - HOUR, checked: 4, updated: 1, failed: 2 }));
    const { counts } = await attention(env);
    expect(counts).toMatchObject({ reconnect: 5, publishFailed: 3, publishOverdue: 1, stripe: 3, review: 5, fal: 3, elevenlabs: 0, other: 0 });
    const s = await operationsSnapshot(env);
    expect(s.failures).toEqual(expect.arrayContaining([
      { area: "publish:tiktok", code: "TikTok had a problem publishing this post.", count: 3 },
      { area: "fal", code: "GENERATION_TIMEOUT", count: 2 }, { area: "fal", code: "GENERATION_UNCERTAIN", count: 1 },
      { area: "elevenlabs", code: "VOICE_FAILED", count: 1 }, { area: "other", code: "INTERNAL", count: 1 },
    ]));
    expect(s.accounts).toEqual([{ platform: "instagram", total: 5, recent: 5 }]);
    expect(s.active).toMatchObject({ overdue: 1 });
    expect(s.stripe).toMatchObject({ renewalsOverdue: 1, grants: 0, reconciliation: { failed: 2 } });
    expect(s.reviews.map((r) => r.reason).sort()).toEqual(["failed", "refused", "refused", "timeout", "uncertain"]);
    const admin = signedIn(sqlite, "ops@example.com");
    const r = await call(worker, { ...env, ADMIN_EMAILS: "ops@example.com" }, "GET", "/api/admin/operations", undefined, admin.cookie);
    expect(r.status).toBe(200);
    expect(r.data.failures.length).toBe(s.failures.length);
  });
});
