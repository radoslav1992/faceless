import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { App } from "./types";
import { now, uid, DAY } from "./types";
import { rate } from "./security";
import { GRANT_PREFIX, addMonths } from "./billing";
import { GRANT_MONTHS, paidPlans } from "../shared/plans";

// Administrator grants: a paid plan for 1 to 12 months without Stripe (testers, partners, support cases). A grant is a
// subscription row that ends on its own; its own ID gives each of its months a fresh usage window with the plan's
// credits. Billing, reconciliation and refunds never touch it (see allowance, reconcileStripe and endPaidAccess in
// billing.ts). Mounted after the administrator check (routes/admin.ts).
export const planGrants = new Hono<App>();
const email = z.string().max(254).transform((s) => s.toLowerCase().trim()).pipe(z.email());
const months = z.number().int().refine((n) => (GRANT_MONTHS as readonly number[]).includes(n), { message: `Choose ${GRANT_MONTHS.join(", ")} months.` });

/** Grants that are running or ended in the last 90 days, newest first, with what each has used (all its months). */
planGrants.get("/", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT s.id,s.plan,s.period_start AS start,s.period_end AS end,u.email,u.name,
      (SELECT COALESCE(SUM(w.used),0) FROM usage_windows w WHERE w.user_id=u.id AND instr(w.id,':'||s.id||':')>0) AS used
     FROM subscriptions s JOIN users u ON u.id=s.user_id
     WHERE substr(s.id,1,6)=? AND s.period_end>? ORDER BY s.period_start DESC LIMIT 100`,
  ).bind(GRANT_PREFIX, now() - 90 * DAY).all();
  return c.json({ grants: results, now: now() });
});

/** Accounts whose email contains `q` (at least 2 characters), with the plan they pay for and a running grant. */
planGrants.get("/accounts", async (c) => {
  const q = z.string().trim().toLowerCase().min(2).max(254).safeParse(c.req.query("q"));
  if (!q.success) throw new HTTPException(400, { message: "Type at least 2 characters of the email." });
  const t = now(), like = `%${q.data.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  const { results } = await c.env.DB.prepare(
    `SELECT u.id,u.email,u.name,u.created_at AS createdAt,
      (SELECT s.plan FROM subscriptions s WHERE s.user_id=u.id AND substr(s.id,1,6)<>?3 AND s.status='active' AND s.period_end>?4
        ORDER BY s.period_end DESC LIMIT 1) AS paidPlan,
      g.id AS grantId,g.plan AS grantPlan,g.period_end AS grantEnd
     FROM users u LEFT JOIN subscriptions g ON g.user_id=u.id AND substr(g.id,1,6)=?3 AND g.period_end>?4
     WHERE u.email LIKE ?1 ESCAPE '\\' ORDER BY instr(lower(u.email),?2)<>1, u.email LIMIT 10`,
  ).bind(like, q.data, GRANT_PREFIX, t).all();
  return c.json({ accounts: results });
});

/** Gives a user a plan for 1 to 12 months. A running grant of that user is replaced (it starts again with a full plan). */
planGrants.post("/", async (c) => {
  await rate(c, "plan-grant", 60, 3600, c.get("user").id);
  const d = z.object({ email, plan: z.enum(paidPlans), months: months.default(1) }).parse(await c.req.json());
  const user = await c.env.DB.prepare("SELECT id,email FROM users WHERE email=?").bind(d.email).first<{ id: string; email: string }>();
  if (!user) throw new HTTPException(404, { message: "There's no account with this email. The person needs to sign up first." });
  const t = now(), id = `${GRANT_PREFIX}${uid()}`, end = addMonths(t, d.months);
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE subscriptions SET period_end=? WHERE user_id=? AND substr(id,1,6)=? AND period_end>?").bind(t, user.id, GRANT_PREFIX, t),
    c.env.DB.prepare(
      "INSERT INTO subscriptions(id,user_id,plan,status,period_start,period_end,cancel_at_period_end,event_created) VALUES (?,?,?,'active',?,?,1,?)",
    ).bind(id, user.id, d.plan, t, end, t),
  ]);
  // A paid subscription keeps billing in Stripe while the grant runs: the administrator should know.
  const paid = await c.env.DB.prepare(
    "SELECT plan FROM subscriptions WHERE user_id=? AND substr(id,1,6)!=? AND status='active' AND period_end>? LIMIT 1",
  ).bind(user.id, GRANT_PREFIX, t).first<{ plan: string }>();
  console.log("Plan granted", { grant: id, plan: d.plan, months: d.months, by: c.get("user").id });
  return c.json({ id, end, paidPlan: paid?.plan ?? null }, 201);
});

/** Ends a grant now; the user returns to their paid plan or the free plan. */
planGrants.delete("/:id", async (c) => {
  const id = c.req.param("id");
  if (!id.startsWith(GRANT_PREFIX)) throw new HTTPException(404, { message: "Not found." });
  const t = now();
  const r = await c.env.DB.prepare("UPDATE subscriptions SET period_end=? WHERE id=? AND period_end>?").bind(t, id, t).run();
  if (!r.meta.changes) throw new HTTPException(404, { message: "This grant has already ended." });
  console.log("Plan grant ended", { grant: id, by: c.get("user").id });
  return c.json({ ok: true });
});
