import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { App } from "../types";
import { now, DAY } from "../types";
import { isAdmin } from "../auth";
import { GRANT_PREFIX } from "../billing";
import { adminWithdrawals } from "../withdrawals";
import { planGrants } from "../plan-grants";
import { operationsSnapshot } from "../operations";
import { adminVoices } from "./admin-voices";
import { adminLibrary } from "./admin-library";
import { adminExamples } from "../examples";
import { adminAvatars } from "../avatars";

// Administration: health and operations, withdrawals and plan grants, the narration voices, the shared library (music
// by mood, clips and pictures), each style's example video, the presenters' avatars and contact messages.
export const admin = new Hono<App>();
admin.use("*", async (c, next) => {
  if (!isAdmin(c.env, c.get("user"))) throw new HTTPException(404, { message: "Not found." });
  await next();
});
admin.get("/operations", async (c) => c.json(await operationsSnapshot(c.env)));
admin.route("/withdrawals", adminWithdrawals);
admin.route("/grants", planGrants);
admin.route("/voices", adminVoices);
admin.route("/library", adminLibrary);
admin.route("/examples", adminExamples);
admin.route("/avatars", adminAvatars);
admin.get("/overview", async (c) => {
  const since = now() - DAY;
  const one = async (sql: string, ...args: unknown[]) => (await c.env.DB.prepare(sql).bind(...args).first<{ n: number }>())?.n || 0;
  return c.json({
    users: await one("SELECT COUNT(*) AS n FROM users"),
    newUsers: await one("SELECT COUNT(*) AS n FROM users WHERE created_at>?", since),
    // Stripe subscriptions only; administrators' grants are counted apart.
    paying: await one("SELECT COUNT(DISTINCT user_id) AS n FROM subscriptions WHERE status='active' AND substr(id,1,6)<>?", GRANT_PREFIX),
    granted: await one("SELECT COUNT(DISTINCT user_id) AS n FROM subscriptions WHERE substr(id,1,6)=? AND period_end>?", GRANT_PREFIX, now()),
    videos: await one("SELECT COUNT(*) AS n FROM videos WHERE created_at>?", since),
    series: await one("SELECT COUNT(*) AS n FROM series WHERE status='active'"),
    failedRuns: await one("SELECT COUNT(*) AS n FROM runs WHERE status='failed' AND created_at>?", since),
    activeRuns: await one("SELECT COUNT(*) AS n FROM runs WHERE status IN ('queued','running')"),
    published: await one("SELECT COUNT(*) AS n FROM publications WHERE status='published' AND published_at>?", since),
    failedPublications: await one("SELECT COUNT(*) AS n FROM publications WHERE status='failed' AND updated_at>?", since),
    config: {
      media: c.env.MEDIA_ENABLED === "true", fal: !!c.env.FAL_KEY, elevenlabs: !!c.env.ELEVENLABS_API_KEY,
      stripe: !!c.env.STRIPE_SECRET_KEY, billing: c.env.BILLING_ENABLED === "true", tokens: !!c.env.TOKEN_ENCRYPTION_KEY,
      heygen: !!c.env.HEYGEN_API_KEY, tiktok: !!c.env.TIKTOK_CLIENT_KEY, instagram: !!c.env.INSTAGRAM_APP_ID, youtube: !!c.env.GOOGLE_CLIENT_ID,
    },
  });
});
admin.get("/messages", async (c) =>
  c.json({ messages: (await c.env.DB.prepare("SELECT * FROM contact_messages ORDER BY created_at DESC LIMIT 100").all()).results }));
