import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { App, DbUser, Env } from "./types";
import { now } from "./types";
import { rate, sendMail } from "./security";
import { allowance } from "./billing";
import { CALL_CREDITS, CALL_MINUTES } from "../shared/growth";
import { PRODUCT } from "../shared/brand";

// A call with the founders for credits (shared/growth.ts, table call_offers): customers on a plan or a running trial
// book a short call on the scheduling page CALL_BOOKING_URL (Cal.com, Calendly…, with their name and email filled
// in); after it, an administrator marks it done with notes, which adds CALL_CREDITS credits once per account to the
// current month (they roll over like credit packs), and tells the customer. Without CALL_BOOKING_URL nothing is offered.

type CallRow = { user_id: string; status: "requested" | "done" | "missed" | "dismissed"; credits: number; notes: string; requested_at: number; done_at: number | null; updated_at: number };

/** The scheduling page with the customer's name and email filled in (both Cal.com and Calendly read them). */
export function bookingUrl(env: Env, u: Pick<DbUser, "name" | "email">) {
  const raw = env.CALL_BOOKING_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return null;
    if (!url.searchParams.has("name")) url.searchParams.set("name", u.name);
    if (!url.searchParams.has("email")) url.searchParams.set("email", u.email);
    return url.href;
  } catch {
    return null;
  }
}
/** Whether the customer can use credits now: on a plan, or within the free trial. */
async function canUseCredits(env: Env, u: DbUser) {
  const a = await allowance(env, u);
  return { usable: !a.trialEnded, plan: a.plan, trialEndsAt: a.trialEndsAt, window: a.window };
}

export const calls = new Hono<App>();
calls.get("/", async (c) => {
  const u = c.get("user");
  const row = await c.env.DB.prepare("SELECT * FROM call_offers WHERE user_id=?").bind(u.id).first<CallRow>();
  const { usable, trialEndsAt } = await canUseCredits(c.env, u);
  const enabled = !!bookingUrl(c.env, u);
  return c.json({
    enabled, credits: CALL_CREDITS, minutes: CALL_MINUTES, status: row?.status ?? null, trialEndsAt,
    // Offered once per account, to those who can use the credits.
    eligible: enabled && !!u.verified && usable && row?.status !== "done",
  });
});
/** Opens the scheduling page (the customer books there); the offer is now "requested" until an administrator closes it. */
calls.post("/", async (c) => {
  const u = c.get("user");
  await rate(c, "call-request", 20, 3600, u.id);
  const url = bookingUrl(c.env, u);
  if (!url) throw new HTTPException(404, { message: "Calls aren't offered right now." });
  if (!u.verified) throw new HTTPException(403, { message: "Confirm your email first." });
  if (!(await canUseCredits(c.env, u)).usable) throw new HTTPException(402, { message: "Calls for credits are for customers on a plan or a free trial." });
  const t = now();
  const r = await c.env.DB.prepare(
    "INSERT INTO call_offers(user_id,status,requested_at,updated_at) VALUES (?1,'requested',?2,?2) ON CONFLICT(user_id) DO UPDATE SET status='requested',requested_at=?2,updated_at=?2 WHERE call_offers.status<>'done'",
  ).bind(u.id, t).run();
  if (!r.meta.changes) throw new HTTPException(409, { message: "You've already had your call. Thank you!" });
  return c.json({ url });
});
/** "Not now": the offer leaves the home page (Billing still has it). */
calls.delete("/", async (c) => {
  const u = c.get("user");
  const t = now();
  await c.env.DB.prepare(
    "INSERT INTO call_offers(user_id,status,requested_at,updated_at) VALUES (?1,'dismissed',?2,?2) ON CONFLICT(user_id) DO UPDATE SET status='dismissed',updated_at=?2 WHERE call_offers.status NOT IN ('done','requested')",
  ).bind(u.id, t).run();
  return c.json({ ok: true });
});

// Administrators: Admin → Growth ------------------------------------------------------------------------------------

export const adminCalls = new Hono<App>();
adminCalls.get("/", async (c) => {
  const rows = (await c.env.DB.prepare(
    `SELECT o.*,u.email,u.name,(SELECT plan FROM subscriptions s WHERE s.user_id=u.id AND s.status='active' AND s.period_end>?1 ORDER BY s.period_end DESC LIMIT 1) AS plan
     FROM call_offers o JOIN users u ON u.id=o.user_id WHERE o.status<>'dismissed' ORDER BY o.status='requested' DESC, o.requested_at DESC LIMIT 300`,
  ).bind(now()).all<CallRow & { email: string; name: string; plan: string | null }>()).results;
  return c.json({
    enabled: !!c.env.CALL_BOOKING_URL?.trim(), credits: CALL_CREDITS,
    calls: rows.map((r) => ({
      userId: r.user_id, email: r.email, name: r.name, plan: r.plan ?? "free", status: r.status, credits: r.credits, notes: r.notes,
      requestedAt: r.requested_at, doneAt: r.done_at,
    })),
  });
});
const notes = z.object({ notes: z.string().trim().max(4000).default("") });
/** The call took place: its notes are kept and the credits added (once per account), and the customer is told. */
adminCalls.post("/:userId/done", async (c) => {
  const d = notes.parse(await c.req.json());
  const user = await c.env.DB.prepare("SELECT * FROM users WHERE id=?").bind(c.req.param("userId")).first<DbUser>();
  const row = user && await c.env.DB.prepare("SELECT * FROM call_offers WHERE user_id=?").bind(user.id).first<CallRow>();
  if (!user || !row) throw new HTTPException(404, { message: "Call not found." });
  if (row.status === "done") throw new HTTPException(409, { message: "This call was already marked done and credited." });
  const { usable, window } = await canUseCredits(c.env, user);
  // Credits of an ended trial could never be spent: the customer needs a plan (or a free month) first.
  if (!usable) throw new HTTPException(409, { message: "Their free trial has ended, so they couldn't use the credits. Give them a free month in Admin → Billing (or wait until they subscribe), then mark the call done." });
  const t = now();
  // Credits first, only while the offer is still open (a second click adds nothing), then the offer is closed.
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE usage_windows SET quota=quota+?1,topped=topped+?1 WHERE id=?2 AND EXISTS(SELECT 1 FROM call_offers WHERE user_id=?3 AND status<>'done')")
      .bind(CALL_CREDITS, window, user.id),
    c.env.DB.prepare("UPDATE call_offers SET status='done',credits=?,notes=?,done_at=?,updated_at=? WHERE user_id=? AND status<>'done'")
      .bind(CALL_CREDITS, d.notes, t, t, user.id),
  ]);
  let emailed = true;
  try {
    await sendMail(c.env, user.email, `${CALL_CREDITS} credits added — thanks for the call`, [
      `Hi ${user.name.split(" ")[0] || "there"},`,
      "",
      `Thank you for talking with us. We've added ${CALL_CREDITS} credits to your ${PRODUCT.name} account.`,
      "What you told us goes straight into what we build next.",
      "",
      `— The ${PRODUCT.name} team`,
    ].join("\n"));
  } catch {
    emailed = false;
  }
  return c.json({ ok: true, credits: CALL_CREDITS, emailed });
});
/** The customer didn't come: notes kept, no credits; they can book again. */
adminCalls.post("/:userId/missed", async (c) => {
  const d = notes.parse(await c.req.json());
  const r = await c.env.DB.prepare("UPDATE call_offers SET status='missed',notes=?,updated_at=? WHERE user_id=? AND status<>'done'").bind(d.notes, now(), c.req.param("userId")).run();
  if (!r.meta.changes) throw new HTTPException(404, { message: "Call not found, or already done." });
  return c.json({ ok: true });
});
/** Notes of a call, kept with it (what was asked, what hurt, what they want next). */
adminCalls.patch("/:userId", async (c) => {
  const d = notes.parse(await c.req.json());
  const r = await c.env.DB.prepare("UPDATE call_offers SET notes=?,updated_at=? WHERE user_id=?").bind(d.notes, now(), c.req.param("userId")).run();
  if (!r.meta.changes) throw new HTTPException(404, { message: "Call not found." });
  return c.json({ ok: true });
});
