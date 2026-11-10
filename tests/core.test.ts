import { afterEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";
import worker from "../server/index";
import { addMonths, allowance, creditTopup, mailbox, periodMonth, webhook } from "../server/billing";
import { now } from "../server/types";
import { CALL_CREDITS } from "../shared/growth";
import { hashPassword } from "../server/security";
import { call, signedIn, subscribe, testEnv, SITE } from "./helpers";
import { slots, nextFreeSlot, zonedTime } from "../shared/schedule";
import { layoutOverlay, overlayItems, screenText, defaultLook } from "../shared/overlay";

afterEach(() => vi.unstubAllGlobals());

describe("auth", () => {
  it("registers, confirms the email, signs in and out", async () => {
    const { env, sqlite } = testEnv();
    const r = await call(worker, env, "POST", "/api/auth/register", { name: "Ana", email: "Ana@Example.com", password: "a-long-password", acceptTerms: true });
    expect(r.data).toEqual({ ok: true, emailSent: true });
    const mail = env.EMAIL.sent[0];
    expect(mail.to).toBe("ana@example.com");
    const token = String(mail.text).match(/token=([0-9a-f]{64})/)![1];
    expect((await call(worker, env, "POST", "/api/auth/verify", { token })).status).toBe(200);
    expect((await call(worker, env, "POST", "/api/auth/verify", { token })).status).toBe(400);
    const login = await call(worker, env, "POST", "/api/auth/login", { email: "ana@example.com", password: "a-long-password" });
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const me = await call(worker, env, "GET", "/api/auth/me", undefined, cookie);
    expect(me.data.user).toMatchObject({ email: "ana@example.com", verified: true, plan: "free", limit: 4, trialEnded: false });
    expect(sqlite.prepare("SELECT version FROM terms_acceptances").get()).toBeTruthy();
    await call(worker, env, "POST", "/api/auth/logout", {}, cookie);
    expect((await call(worker, env, "GET", "/api/auth/me", undefined, cookie)).data.user).toBeNull();
  });
  it("does not reveal whether an address is registered", async () => {
    const { env } = testEnv();
    const body = { name: "Ana", email: "ana@example.com", password: "a-long-password", acceptTerms: true };
    const first = await call(worker, env, "POST", "/api/auth/register", body);
    const second = await call(worker, env, "POST", "/api/auth/register", body);
    expect(second.data).toEqual(first.data);
    expect(env.EMAIL.sent[1].subject).toMatch(/Sign-up attempt/);
  });
  it("refuses wrong passwords and cross-site requests", async () => {
    const { env, sqlite } = testEnv();
    const user = signedIn(sqlite);
    expect((await call(worker, env, "POST", "/api/auth/login", { email: user.email, password: "wrong-password-1" })).status).toBe(401);
    const forged = await worker.fetch(new Request(`${SITE}/api/series`, { method: "POST", headers: { Origin: "https://evil.example", Cookie: user.cookie, "Content-Type": "application/json" }, body: "{}" }), env, { waitUntil() {} } as any);
    expect(forged.status).toBe(403);
    expect((await call(worker, env, "GET", "/api/series")).status).toBe(401);
  });
  it("resets a password and signs out other sessions", async () => {
    const { env, sqlite } = testEnv();
    const user = signedIn(sqlite);
    await call(worker, env, "POST", "/api/auth/forgot", { email: user.email });
    const token = String(env.EMAIL.sent[0].text).match(/token=([0-9a-f]{64})/)![1];
    expect((await call(worker, env, "POST", "/api/auth/reset", { token, password: "another-long-password" })).status).toBe(200);
    expect((await call(worker, env, "GET", "/api/auth/me", undefined, user.cookie)).data.user).toBeNull();
  });
  it("deletes an account with its password, files queued for removal", async () => {
    const { env, sqlite } = testEnv();
    const user = signedIn(sqlite);
    sqlite.prepare("UPDATE users SET password_hash=? WHERE id=?").run(await hashPassword("a-long-password"), user.id);
    expect((await call(worker, env, "DELETE", "/api/settings/account", { password: "nope" }, user.cookie)).status).toBe(400);
    expect((await call(worker, env, "DELETE", "/api/settings/account", { password: "a-long-password" }, user.cookie)).status).toBe(200);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM users WHERE id=?").get(user.id)).toEqual({ n: 0 });
    expect(sqlite.prepare("SELECT prefix FROM cleanup_tasks").all()).toEqual([{ prefix: `media/${user.id}/` }]);
  });
  it("refuses to delete an account while something is being made, before its paid plan is touched", async () => {
    const { env, sqlite } = testEnv({ STRIPE_SECRET_KEY: "sk_test_local_only" });
    const user = signedIn(sqlite);
    sqlite.prepare("UPDATE users SET password_hash=?,stripe_customer='cus_busy' WHERE id=?").run(await hashPassword("a-long-password"), user.id);
    sqlite.prepare("INSERT INTO usage_windows(id,user_id,quota) VALUES (?,?,10)").run(`${user.id}:trial`, user.id);
    sqlite.prepare("INSERT INTO runs(id,user_id,window_id,idempotency_key,kind,status,created_at,updated_at) VALUES ('r1',?,?,'k1','video','running',1,1)")
      .run(user.id, `${user.id}:trial`);
    const stripe: string[] = [];
    vi.stubGlobal("fetch", async (url: any) => { stripe.push(String(url)); return Response.json({ data: [] }); });
    const r = await call(worker, env, "DELETE", "/api/settings/account", { password: "a-long-password" }, user.cookie);
    expect(r.status).toBe(409);
    expect(r.data.error).toMatch(/still being made or published/);
    // Stripe was never asked to cancel anything, and the account is still there.
    expect(stripe).toEqual([]);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM users WHERE id=?").get(user.id)).toEqual({ n: 1 });
    vi.unstubAllGlobals();
  });
});

describe("plans and usage windows", () => {
  it("gives the free trial once per mailbox and a paid window per period", async () => {
    const { env, sqlite } = testEnv();
    const a = signedIn(sqlite, "jo.hn+promo@gmail.com");
    const db = env.DB;
    const user = sqlite.prepare("SELECT * FROM users WHERE id=?").get(a.id) as any;
    expect(await allowance(env, user)).toMatchObject({ plan: "free", used: 0, limit: 4 });
    // Another account of the same Gmail mailbox starts with the trial used up.
    const b = signedIn(sqlite, "john@gmail.com");
    const second = await allowance(env, sqlite.prepare("SELECT * FROM users WHERE id=?").get(b.id) as any);
    expect(second.used).toBe(4);
    expect(mailbox("J.O.H.N+x@GoogleMail.com")).toBe("john@gmail.com");
    subscribe(sqlite, a.id, "daily");
    const paid = await allowance(env, user);
    expect(paid).toMatchObject({ plan: "daily", limit: 60, used: 0, carried: 0, trialEndsAt: null, interval: "month" });
    expect(db).toBeTruthy();
  });
  it("gives the free trial once per mailbox to accounts opened at the same moment", async () => {
    const { env, sqlite } = testEnv();
    const a = signedIn(sqlite, "jo.hn@gmail.com"), b = signedIn(sqlite, "john@gmail.com");
    const row = (id: string) => sqlite.prepare("SELECT * FROM users WHERE id=?").get(id) as any;
    // The other account's first request is handled in full right after the first account's window is written.
    const batch = env.DB.batch;
    let other: Promise<any> | null = null;
    env.DB.batch = async (statements: any[]) => {
      const result = await batch(statements);
      if (!other) await (other = allowance(env, row(b.id)));
      return result;
    };
    expect(await allowance(env, row(a.id))).toMatchObject({ plan: "free", used: 0, limit: 4 });
    expect(await other).toMatchObject({ plan: "free", used: 4, limit: 4 });
  });
  it("credit triggers refuse work beyond the quota and refund failed work", async () => {
    const { env, sqlite } = testEnv();
    const a = signedIn(sqlite);
    await allowance(env, sqlite.prepare("SELECT * FROM users WHERE id=?").get(a.id) as any);
    const window = `${a.id}:trial`;
    expect(() => sqlite.prepare("INSERT INTO runs(id,user_id,window_id,idempotency_key,kind,credits,created_at,updated_at) VALUES ('r1',?,?,'k1','video',5,1,1)").run(a.id, window)).toThrow(/QUOTA_EXCEEDED/);
    sqlite.prepare("INSERT INTO runs(id,user_id,window_id,idempotency_key,kind,credits,created_at,updated_at) VALUES ('r2',?,?,'k2','video',4,1,1)").run(a.id, window);
    expect((sqlite.prepare("SELECT used FROM usage_windows WHERE id=?").get(window) as any).used).toBe(4);
    sqlite.prepare("UPDATE runs SET status='failed' WHERE id='r2'").run();
    sqlite.prepare("UPDATE runs SET status='failed' WHERE id='r2'").run();
    expect((sqlite.prepare("SELECT used FROM usage_windows WHERE id=?").get(window) as any).used).toBe(0);
  });
  it("cuts a yearly period into months, each with the plan's credits", async () => {
    const start = Date.UTC(2026, 0, 31) / 1000, end = Date.UTC(2027, 0, 31) / 1000;
    expect(periodMonth(start, start + 30 * 86400, start + 86400)).toEqual({ index: 0, start, end: start + 30 * 86400 });
    // A start on the 31st falls back to the last day of shorter months, as Stripe does.
    expect(periodMonth(start, end, Date.UTC(2026, 1, 15) / 1000)).toEqual({ index: 0, start, end: Date.UTC(2026, 1, 28) / 1000 });
    expect(periodMonth(start, end, Date.UTC(2026, 2, 5) / 1000)).toEqual({ index: 1, start: Date.UTC(2026, 1, 28) / 1000, end: Date.UTC(2026, 2, 31) / 1000 });
    // Past the year's end, while the renewal isn't confirmed yet: still the 12th month, never a 13th with new credits.
    const yearEnd = Date.UTC(2027, 0, 31) / 1000;
    expect(periodMonth(start, yearEnd, yearEnd - 86400)).toMatchObject({ index: 11 });
    expect(periodMonth(start, yearEnd, yearEnd + 2 * 86400)).toMatchObject({ index: 11, end: yearEnd });
    const { env, sqlite } = testEnv();
    const a = signedIn(sqlite);
    subscribe(sqlite, a.id, "starter", { days: 365, startedAgo: 40 * 86400 });
    const user = sqlite.prepare("SELECT * FROM users WHERE id=?").get(a.id) as any;
    const year = await allowance(env, user);
    expect(year).toMatchObject({ plan: "starter", interval: "year", limit: 30 });
    expect(year.window).toMatch(/:1$/);
  });
  it("rolls unused credits into the next month, capped, and adds paid credit packs once", async () => {
    const { env, sqlite } = testEnv();
    const a = signedIn(sqlite);
    const user = sqlite.prepare("SELECT * FROM users WHERE id=?").get(a.id) as any;
    // Last month: Starter (30 credits) plus a pack of 10, of which 12 were used.
    const old = subscribe(sqlite, a.id, "starter", { days: 30, startedAgo: 31 * 86400 });
    sqlite.prepare("UPDATE subscriptions SET status='canceled' WHERE id=?").run(old);
    sqlite.prepare("INSERT INTO usage_windows(id,user_id,plan,quota,used,carried,topped,created_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(`${a.id}:${old}:x`, a.id, "starter", 40, 12, 0, 10, now() - 31 * 86400);
    subscribe(sqlite, a.id, "starter");
    const month = await allowance(env, user);
    expect(month).toMatchObject({ limit: 30 + 28, carried: 28, topped: 0 });
    // Never more than three months' worth plus packs.
    sqlite.prepare("UPDATE usage_windows SET used=0,quota=500 WHERE id=?").run(month.window);
    const next = subscribe(sqlite, a.id, "starter", { startedAgo: 10 });
    sqlite.prepare("UPDATE subscriptions SET status='canceled' WHERE id<>?").run(next);
    expect((await allowance(env, user)).carried).toBe(90);
    // A paid pack lands in the current month once, however often Stripe reports it.
    const session = { id: "cs_1", payment_status: "paid", amount_total: 800, currency: "usd", payment_intent: "pi_1", metadata: { kind: "topup", pack: "pack10", credits: "10", user_id: a.id } } as any;
    const before = (await allowance(env, user)).limit;
    await creditTopup(env, session);
    await creditTopup(env, session);
    expect(await allowance(env, user)).toMatchObject({ limit: before + 10, topped: 10 });
    // A forged pack size is ignored.
    await creditTopup(env, { ...session, id: "cs_2", metadata: { ...session.metadata, credits: "1000" } });
    expect((await allowance(env, user)).limit).toBe(before + 10);
  });
  it("rolls a month of the same subscription over however late the account is next seen; a lapsed plan's only within 45 days", async () => {
    const { env, sqlite } = testEnv();
    const day = 86400;
    const fresh = (email: string) => { const a = signedIn(sqlite, email); return sqlite.prepare("SELECT * FROM users WHERE id=?").get(a.id) as any; };
    // A Starter subscriber left 25 credits last month and first opens the app 16 days into this one: the old month's
    // window was written when it was first used, 47 days ago.
    const user = fresh("late@example.com");
    const sub = subscribe(sqlite, user.id, "starter", { startedAgo: 16 * day });
    const window = (id: string, sub: string, start: number, ago: number) =>
      sqlite.prepare("INSERT INTO usage_windows(id,user_id,plan,quota,used,carried,topped,created_at) VALUES (?,?,'starter',30,5,0,0,?)").run(`${id}:${sub}:${start}`, id, now() - ago);
    window(user.id, sub, now() - 47 * day, 47 * day);
    expect(await allowance(env, user)).toMatchObject({ plan: "starter", limit: 55, carried: 25 });
    // A plan that ended long ago brings nothing back to a new subscription.
    const back = fresh("back@example.com");
    window(back.id, "sub_old", now() - 77 * day, 77 * day);
    subscribe(sqlite, back.id, "starter", { startedAgo: 16 * day });
    expect(await allowance(env, back)).toMatchObject({ plan: "starter", limit: 30, carried: 0 });
  });
  it("rolls over only the paid share of a month cut short by a change between monthly and yearly billing, however often", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const day = 86400, at = (t: number) => vi.setSystemTime(t * 1000);
      let t = Date.UTC(2026, 3, 1) / 1000; // April: 30 days
      at(t);
      const { env, sqlite } = testEnv();
      const a = signedIn(sqlite);
      const user = sqlite.prepare("SELECT * FROM users WHERE id=?").get(a.id) as any;
      const sub = subscribe(sqlite, a.id, "daily", { startedAgo: 0 });
      // A new period of the subscription from now (Stripe starts one at once when the interval changes).
      const period = (months: number) => sqlite.prepare("UPDATE subscriptions SET period_start=?1,period_end=?2 WHERE id=?3").run(t, addMonths(t, months), sub);
      period(1);
      expect(await allowance(env, user)).toMatchObject({ limit: 60, carried: 0 });
      // Half way through the month, nothing used, to yearly billing: Stripe pays back half the month, so half its
      // credits roll over next to the new month's.
      t += 15 * day;
      at(t); period(12);
      expect(await allowance(env, user)).toMatchObject({ interval: "year", limit: 90, carried: 30 });
      // Back and forth every hour: each change pays back nearly all of the month before, so nothing piles up.
      for (const months of [1, 12, 1, 12, 1]) {
        t += 3600;
        at(t); period(months);
        expect(await allowance(env, user)).toMatchObject({ limit: 90, carried: 30 });
      }
      // A credit pack bought in a month cut short rolls over whole, even when the plan's credits were all used.
      await creditTopup(env, { id: "cs_1", payment_status: "paid", amount_total: 800, currency: "usd", payment_intent: "pi_1", metadata: { kind: "topup", pack: "pack10", credits: "10", user_id: a.id } } as any);
      const bought = await allowance(env, user);
      expect(bought).toMatchObject({ limit: 100, topped: 10 });
      sqlite.prepare("UPDATE usage_windows SET used=95 WHERE id=?").run(bought.window);
      t += 3600;
      at(t); period(12);
      expect(await allowance(env, user)).toMatchObject({ limit: 65, carried: 5 });
      t += 3600;
      at(t); period(1);
      expect(await allowance(env, user)).toMatchObject({ limit: 65, carried: 5 });
      // A renewal starts where the month ended: everything left rolls over, as always.
      t = addMonths(t, 1);
      at(t + 3600); period(1);
      expect(await allowance(env, user)).toMatchObject({ limit: 125, carried: 65 });
      // So does a month of another subscription.
      at(t + 10 * day);
      sqlite.prepare("UPDATE subscriptions SET status='canceled' WHERE id=?").run(sub);
      subscribe(sqlite, a.id, "daily", { startedAgo: 0 });
      expect(await allowance(env, user)).toMatchObject({ limit: 185, carried: 125 });
    } finally {
      vi.useRealTimers();
    }
  });
  it("moves credit packs and call credits on from a free month or the free trial, never their own credits", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const at = (t: number) => vi.setSystemTime(t * 1000), start = Date.UTC(2026, 3, 1) / 1000;
      at(start);
      const { env, sqlite } = testEnv({ CALL_BOOKING_URL: "https://cal.com/hookstreak/15min" });
      const admin = signedIn(sqlite, "admin@example.com"), a = signedIn(sqlite);
      const row = (id: string) => sqlite.prepare("SELECT * FROM users WHERE id=?").get(id) as any;
      const callDone = async (who: { id: string; cookie: string }) => {
        await call(worker, env, "POST", "/api/calls", {}, who.cookie);
        expect((await call(worker, env, "POST", `/api/admin/calls/${who.id}/done`, { notes: "" }, admin.cookie)).status).toBe(200);
      };
      // A free Creator plan (60 credits a month) with a pack of 10 bought in its first month; 65 of the 70 used.
      const grant = (await call(worker, env, "POST", "/api/admin/grants", { email: a.email, plan: "daily", months: 3 }, admin.cookie)).data.id;
      await creditTopup(env, { id: "cs_1", payment_status: "paid", amount_total: 800, currency: "usd", payment_intent: "pi_1", metadata: { kind: "topup", pack: "pack10", credits: "10", user_id: a.id } } as any);
      const first = await allowance(env, row(a.id));
      expect(first).toMatchObject({ granted: true, limit: 70, topped: 10 });
      sqlite.prepare("UPDATE usage_windows SET used=65 WHERE id=?").run(first.window);
      // Its second month: the plan's 60 and the pack's 5 left.
      at(addMonths(start, 1) + 3600);
      sqlite.prepare("UPDATE sessions SET expires_at=?").run(now() + 86400);
      const second = await allowance(env, row(a.id));
      expect(second).toMatchObject({ granted: true, used: 0, limit: 65, carried: 5 });
      // A call for credits in it; 20 used. Then the free plan ends and the customer subscribes: the pack's and the
      // call's credits go on (35), what was left of the free month's own credits doesn't.
      await callDone(a);
      expect(await allowance(env, row(a.id))).toMatchObject({ limit: 65 + CALL_CREDITS, topped: CALL_CREDITS });
      sqlite.prepare("UPDATE usage_windows SET used=20 WHERE id=?").run(second.window);
      sqlite.prepare("UPDATE subscriptions SET period_end=? WHERE id=?").run(now() - 1, grant);
      subscribe(sqlite, a.id, "starter", { startedAgo: 0 });
      expect(await allowance(env, row(a.id))).toMatchObject({ plan: "starter", granted: false, limit: 30 + 5 + CALL_CREDITS, carried: 5 + CALL_CREDITS });
      // Moved, not copied: the free month keeps only its own credits.
      expect(sqlite.prepare("SELECT quota,carried,topped FROM usage_windows WHERE id=?").get(second.window)).toEqual({ quota: 60, carried: 0, topped: 0 });
      // A call in the free trial: its credits go on to the first paid month, the trial's own 4 don't.
      const b = signedIn(sqlite);
      await callDone(b);
      expect(await allowance(env, row(b.id))).toMatchObject({ plan: "free", limit: 4 + CALL_CREDITS });
      subscribe(sqlite, b.id, "starter", { startedAgo: 0 });
      expect(await allowance(env, row(b.id))).toMatchObject({ plan: "starter", limit: 30 + CALL_CREDITS, carried: CALL_CREDITS });
      expect(sqlite.prepare("SELECT quota,topped FROM usage_windows WHERE id=?").get(`${b.id}:trial`)).toEqual({ quota: 4, topped: 0 });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Stripe webhook", () => {
  const secret = "whsec_local_test_only";
  const stripe = new Stripe("sk_test_local_only", { httpClient: Stripe.createFetchHttpClient() });
  it("rejects forged signatures and applies a paid subscription read back from Stripe", async () => {
    const { env, sqlite } = testEnv({ STRIPE_SECRET_KEY: "sk_test_local_only", STRIPE_WEBHOOK_SECRET: secret, STRIPE_PRICE_DAILY: "price_daily" });
    const a = signedIn(sqlite);
    sqlite.prepare("UPDATE users SET stripe_customer='cus_1' WHERE id=?").run(a.id);
    await expect(webhook(new Request("https://x/api/billing/webhook", { method: "POST", headers: { "stripe-signature": "bad" }, body: "{}" }), env)).rejects.toThrow("Invalid signature");
    const sub = {
      id: "sub_1", object: "subscription", customer: "cus_1", status: "active", cancel_at_period_end: false, metadata: {},
      items: { data: [{ id: "si_1", price: { id: "price_daily" }, current_period_start: now() - 10, current_period_end: now() + 30 * 86400 }] },
      latest_invoice: { id: "in_1", status: "paid" },
    };
    vi.stubGlobal("fetch", async () => Response.json(sub));
    const body = JSON.stringify({ id: "evt_1", type: "customer.subscription.updated", object: "event", created: now(), data: { object: sub } });
    const signature = await stripe.webhooks.generateTestHeaderStringAsync({ payload: body, secret });
    await webhook(new Request("https://x/api/billing/webhook", { method: "POST", headers: { "stripe-signature": signature }, body }), env);
    const me = await call(worker, env, "GET", "/api/auth/me", undefined, a.cookie);
    expect(me.data.user).toMatchObject({ plan: "daily", limit: 60, hasSubscription: true });
  });
});

describe("posting schedule", () => {
  it("lists slots in the series' time zone across DST", () => {
    const from = Date.UTC(2026, 2, 27, 0, 0) / 1000; // Friday before the EU clock change
    const s = slots({ timezone: "Europe/Sofia", times: ["09:00"], days: [0, 1, 2, 3, 4, 5, 6] }, from, 3);
    expect(s.map((t) => new Date(t * 1000).toISOString())).toEqual([
      "2026-03-27T07:00:00.000Z", "2026-03-28T07:00:00.000Z", "2026-03-29T06:00:00.000Z", "2026-03-30T06:00:00.000Z",
    ]);
    expect(zonedTime(2026, 1, 1, 12, 0, "UTC")).toBe(Date.UTC(2026, 0, 1, 12) / 1000);
    const taken = [s[0]];
    expect(nextFreeSlot({ timezone: "Europe/Sofia", times: ["09:00"], days: [0, 1, 2, 3, 4, 5, 6] }, from, taken)).toBe(s[1]);
  });
});

describe("on-screen text", () => {
  it("drops emoji and wraps long text inside the frame", () => {
    expect(screenText("hello 🔥 world\n\n\nnext")).toBe("hello world\nnext");
    const layout = layoutOverlay("a ".repeat(200), defaultLook(), 1080, 1920);
    expect(layout.lines.every((l) => l.width <= 1080 * 0.82)).toBe(true);
    expect(layout.lines.length * layout.lineHeight).toBeLessThanOrEqual(1920 * 0.7 + layout.lineHeight);
    const items = overlayItems("hi there", { ...defaultLook(), background: "#ffffff" }, 1080, 1920);
    expect(items.map((i) => i.kind)).toEqual(["box", "text"]);
  });
});

describe("public address", () => {
  const fetchAt = (env: any, url: string, method = "GET") =>
    worker.fetch(new Request(url, { method, redirect: "manual" }), env, { waitUntil: () => {}, passThroughOnException: () => {} } as any);
  it("sends the other domains to SITE_URL with the same path, keeping the method", async () => {
    const { env } = testEnv();
    for (const host of ["https://www.app.test", "https://app.example"]) {
      const r = await fetchAt(env, `${host}/pricing?plan=daily`);
      expect(r.status).toBe(308);
      expect(r.headers.get("location")).toBe(`${SITE}/pricing?plan=daily`);
    }
    expect((await fetchAt(env, "https://www.app.test/api/billing/webhook", "POST")).status).toBe(308);
  });
  it("leaves the site itself, workers.dev and local development alone", async () => {
    const { env } = testEnv();
    for (const url of [`${SITE}/api/health`, "https://faceless.someone.workers.dev/api/health", "http://localhost:8787/api/health"])
      expect((await fetchAt(env, url)).status).toBe(200);
  });
});
