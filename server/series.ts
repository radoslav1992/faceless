import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { App, DbUser, Env } from "./types";
import { MINUTE, now, uid } from "./types";
import { siteUrl } from "./config";
import { dbFailure, json, ownedSeries } from "./db";
import { rate, sendMail } from "./security";
import { allowance } from "./billing";
import { canCreate, checkReferences, createVideo, requireVerified, videoView } from "./videos";
import { scheduleEpisode, cancelScheduled } from "./publishing";
import { voiceUsable } from "./voices";
import { backdropFor, conceptToSpec, musicCatalog, writeVideo } from "./story";
import { episodeCredits, LATE_GRACE, MAKE_AHEAD, seriesSettingsSchema, type SeriesSettings } from "../shared/series";
import { seriesTemplates, templateOf, type TemplateId } from "../shared/templates";
import { slots, validZone } from "../shared/schedule";
import { planById } from "../shared/plans";
import { PRODUCT } from "../shared/brand";

// Series: a faceless channel on autopilot. For every slot of its schedule an episode is written, made ahead of time
// (MAKE_AHEAD) and, unless the series asks for review first, posted to its channels at that slot. The cron hands each
// due series to the ContentGeneration workflow (`episode`), which writes the script (slow, retried), creates the video
// for that slot (one per slot: a unique index) and moves the series on to its next slot.
export const series = new Hono<App>();

/** A series' settings (defaults when missing or damaged). */
export function seriesSettings(s: { settings: string }): SeriesSettings {
  const parsed = seriesSettingsSchema.safeParse(json(s.settings, {}));
  return parsed.success ? parsed.data : seriesSettingsSchema.parse({});
}
/** The first posting slot after `after` (null: the schedule has none within 60 days). */
export const nextSlot = (settings: SeriesSettings, after: number) => slots(settings.schedule, after, 60)[0] ?? null;

/** Why the last slot was skipped, in plain words. */
const blockedText: Record<string, string> = {
  credits: "Skipped: not enough credits left. Add a credit pack or upgrade, and the next episode goes ahead.",
  trial: "Paused: your free trial has ended. Choose a plan to keep the series going.",
  failed: "Skipped: we couldn't write that episode. The next one is tried as usual.",
  busy: "Skipped: too much was being made at once. The next episode goes ahead.",
};
function seriesView(s: any, extra: Record<string, unknown> = {}) {
  const settings = seriesSettings(s);
  return {
    id: s.id, name: s.name, template: s.template, status: s.status, settings, nextSlot: s.next_slot,
    blocked: s.blocked ? blockedText[s.blocked] || null : null, credits: episodeCredits(settings),
    createdAt: s.created_at, updatedAt: s.updated_at, ...extra,
  };
}

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  template: z.enum(seriesTemplates as [TemplateId, ...TemplateId[]]),
  settings: z.record(z.string(), z.unknown()).default({}),
  /** Make the first episode now (for the next slot), so the owner sees it straight away. */
  first: z.boolean().default(true),
});
/** Settings as given, checked against the account: a valid time zone, the owner's connected accounts, a topic. */
/** `keptVoice`: the series' voice before an edit, which it keeps even once that voice is no longer offered. */
async function checkSettings(env: Env, user: DbUser, template: TemplateId, settings: SeriesSettings, keptVoice: string | null = null) {
  if (!validZone(settings.schedule.timezone)) throw new HTTPException(400, { message: "Choose a valid time zone." });
  if (!(await voiceUsable(env, settings.voiceId, keptVoice))) throw new HTTPException(400, { message: "Choose one of the voices offered." });
  if (template === "custom" && settings.prompt.length < 3) throw new HTTPException(400, { message: "Describe what the videos of this series are about." });
  if (settings.accounts.length) {
    const rows = (await env.DB.prepare(`SELECT id,platform FROM social_accounts WHERE user_id=? AND id IN (${settings.accounts.map(() => "?").join(",")})`)
      .bind(user.id, ...settings.accounts).all<{ id: string; platform: string }>()).results;
    if (rows.length !== new Set(settings.accounts).size) throw new HTTPException(400, { message: "Choose accounts you have connected." });
  }
  if (settings.music.trackId && !(await env.DB.prepare("SELECT 1 FROM library_items WHERE id=? AND kind='music' AND active=1").bind(settings.music.trackId).first()))
    throw new HTTPException(400, { message: "This track is no longer in the library. Choose another one." });
  if (settings.backdropId && !(await env.DB.prepare("SELECT 1 FROM library_items WHERE id=? AND kind='clip' AND active=1").bind(settings.backdropId).first()))
    throw new HTTPException(400, { message: "This background clip is no longer in the library. Choose another one." });
}

series.get("/", async (c) => {
  const user = c.get("user");
  const rows = (await c.env.DB.prepare(
    `SELECT s.*,(SELECT COUNT(*) FROM videos v WHERE v.series_id=s.id) AS videos,
      (SELECT COUNT(*) FROM videos v WHERE v.series_id=s.id AND v.status='pending' AND v.render_status='ready') AS review,
      (SELECT v.cover_asset FROM videos v WHERE v.series_id=s.id AND v.cover_asset IS NOT NULL ORDER BY v.created_at DESC LIMIT 1) AS cover
     FROM series s WHERE s.user_id=? ORDER BY s.created_at DESC`,
  ).bind(user.id).all<any>()).results;
  return c.json({ series: rows.map((s) => seriesView(s, { videos: s.videos, review: s.review, coverAssetId: s.cover })) });
});
series.post("/", async (c) => {
  const user = c.get("user");
  await rate(c, "series-create", 20, 3600, user.id);
  requireVerified(user);
  const d = createSchema.parse(await c.req.json());
  const settings = seriesSettingsSchema.parse(d.settings);
  await checkSettings(c.env, user, d.template, settings);
  const a = await allowance(c.env, user);
  const plan = planById(a.plan);
  const count = (await c.env.DB.prepare("SELECT COUNT(*) AS n FROM series WHERE user_id=?").bind(user.id).first<{ n: number }>())?.n || 0;
  if (count >= plan.series)
    throw new HTTPException(402, { message: `Your plan runs ${plan.series} series at a time. Upgrade, or delete a series first.` });
  if (a.trialEnded) throw new HTTPException(402, { message: "Your free trial has ended. Choose a plan to start a series." });
  const id = uid(), t = now();
  const first = nextSlot(settings, t + 10 * MINUTE);
  // Claimed while its first episode is written now, so the cron does not start a second writer for that slot.
  await c.env.DB.prepare("INSERT INTO series(id,user_id,name,template,settings,status,next_slot,attempted_at,created_at,updated_at) VALUES (?,?,?,?,?,'active',?,?,?,?)")
    .bind(id, user.id, d.name, d.template, JSON.stringify(settings), first, d.first ? t : null, t, t).run();
  // The first episode is made now for the first slot: the owner sees what the series makes before anything posts.
  let started = false;
  if (d.first && first !== null) started = await startEpisode(c.env, id, first, true);
  const row = await ownedSeries(c.env, user.id, id);
  return c.json({ series: seriesView(row), started }, 201);
});
series.get("/:id", async (c) => {
  const user = c.get("user");
  const s = await ownedSeries(c.env, user.id, c.req.param("id"));
  const settings = seriesSettings(s), t = now();
  // The coming slots (two weeks) beside the episodes already made for them.
  const upcoming = s.status === "active" ? slots(settings.schedule, t, 14).slice(0, 30) : [];
  const videos = (await c.env.DB.prepare(
    `SELECT v.*,(SELECT phase FROM runs r WHERE r.video_id=v.id AND r.status IN ('queued','running') LIMIT 1) AS phase,
      (SELECT json_group_array(json_object('id',x.id,'platform',x.platform,'accountName',x.account_name,'scheduledAt',x.scheduled_at,'status',x.status,'draft',x.draft,'url',x.url,'error',x.error,'views',x.views,'likes',x.likes)) FROM publications x WHERE x.video_id=v.id AND x.status<>'canceled') AS publications
     FROM videos v WHERE v.series_id=? AND v.user_id=? ORDER BY COALESCE(v.slot_at,v.created_at) DESC LIMIT 60`,
  ).bind(s.id, user.id).all<any>()).results;
  const made = new Set(videos.map((v) => v.slot_at).filter(Boolean));
  return c.json({
    series: seriesView(s),
    videos: videos.map((v) => videoView(v)),
    upcoming: upcoming.map((at) => ({ at, made: made.has(at) })),
  });
});
series.patch("/:id", async (c) => {
  const user = c.get("user");
  const s = await ownedSeries(c.env, user.id, c.req.param("id"));
  const d = z.object({
    name: z.string().trim().min(1).max(80).optional(),
    status: z.enum(["active", "paused"]).optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
  }).parse(await c.req.json());
  // Partial updates are merged into the stored settings and validated as a whole.
  const settings = d.settings ? seriesSettingsSchema.parse({ ...seriesSettings(s), ...d.settings }) : seriesSettings(s);
  await checkSettings(c.env, user, s.template, settings, seriesSettings(s).voiceId);
  const status = d.status ?? s.status;
  // A new schedule or a resumed series starts again from the next slot from now (made slots are never made twice).
  const restart = status === "active" && (s.status !== "active" || JSON.stringify(settings.schedule) !== JSON.stringify(seriesSettings(s).schedule));
  const next = restart ? nextSlot(settings, now() + 10 * MINUTE) : s.next_slot;
  await c.env.DB.prepare("UPDATE series SET name=?,settings=?,status=?,next_slot=?,failures=CASE WHEN ? THEN 0 ELSE failures END,blocked=CASE WHEN ? THEN NULL ELSE blocked END,updated_at=? WHERE id=?")
    .bind(d.name ?? s.name, JSON.stringify(settings), status, next, restart ? 1 : 0, restart ? 1 : 0, now(), s.id).run();
  // Pausing stops what was still to post; changed channels apply to episodes not scheduled yet.
  if (status === "paused" && s.status !== "paused") await cancelScheduled(c.env, user.id, s.id);
  return c.json({ series: seriesView({ ...(await ownedSeries(c.env, user.id, s.id)) }) });
});
series.delete("/:id", async (c) => {
  const user = c.get("user");
  const s = await ownedSeries(c.env, user.id, c.req.param("id"));
  // Its videos stay (in Videos); what was still to post is cancelled.
  await cancelScheduled(c.env, user.id, s.id);
  try {
    await c.env.DB.prepare("DELETE FROM series WHERE id=?").bind(s.id).run();
  } catch (e) {
    dbFailure(e);
  }
  return c.json({ ok: true });
});
/** "Make one now": an extra episode outside the schedule (or the episode of an upcoming slot not made yet). */
series.post("/:id/episodes", async (c) => {
  const user = c.get("user");
  await rate(c, "series-episode", 30, 3600, user.id);
  requireVerified(user);
  const s = await ownedSeries(c.env, user.id, c.req.param("id"));
  const { slot } = z.object({ slot: z.number().int().positive().optional() }).parse(await c.req.json().catch(() => ({})));
  const settings = seriesSettings(s);
  if (slot !== undefined && !slots(settings.schedule, now(), 15).includes(slot)) throw new HTTPException(400, { message: "Pick one of the series' coming posting times." });
  const a = await allowance(c.env, user);
  canCreate(a, episodeCredits(settings));
  const video = await makeEpisode(c.env, user, s, slot ?? null);
  if ("error" in video) throw new HTTPException(video.status as 503, { message: video.error });
  return c.json({ video }, 201);
});

/**
 * Writes and creates one episode of a series: for `slot` (one video per slot), or an extra one (null). Returns the
 * video, or why it could not be made (`blocked`: the reason kept on the series when a slot is skipped).
 */
export async function makeEpisode(env: Env, user: DbUser, s: any, slot: number | null): Promise<{ id: string } | { error: string; status: number; blocked: string }> {
  const settings = seriesSettings(s), template = templateOf(s.template);
  const a = await allowance(env, user);
  if (a.trialEnded) return { error: "Your free trial has ended. Choose a plan to keep the series going.", status: 402, blocked: "trial" };
  if (a.used + episodeCredits(settings) > a.limit) return { error: "Not enough credits left for this episode.", status: 402, blocked: "credits" };
  const recent = (await env.DB.prepare("SELECT title FROM videos WHERE series_id=? AND title<>'' ORDER BY created_at DESC LIMIT 40").bind(s.id).all<{ title: string }>()).results.map((r) => r.title);
  const catalog = settings.music.trackId ? [] : await musicCatalog(env, settings.music.mood);
  const backdropId = template.kind === "backdrop" ? await backdropFor(env, settings.backdropId) : null;
  const concept = await writeVideo(env, {
    template: s.template, prompt: settings.prompt, seconds: settings.seconds, language: settings.language, style: settings.style,
    subject: settings.subject, recent, music: catalog,
  });
  if (!concept) return { error: "We couldn't write this episode right now. Please try again in a minute.", status: 503, blocked: "failed" };
  const picked = settings.music.trackId || (concept.music && catalog.find((m) => m.ref === concept.music)?.id) || catalog[0]?.id;
  const spec = conceptToSpec(concept, {
    kind: template.kind, voiceId: settings.voiceId, style: settings.style, language: settings.language, captions: settings.captions,
    subject: settings.subject, animate: settings.animate, hashtags: settings.hashtags, backdropId,
    music: picked && settings.music.mood !== "none" ? { trackId: picked, volume: settings.music.volume } : null,
  });
  if (!spec) return { error: "The episode we wrote didn't come out right. Please try again.", status: 502, blocked: "failed" };
  try {
    await checkReferences(env, user.id, spec, settings.voiceId);
    // One video per slot: a retried workflow step finds the episode it already created.
    const key = slot ? `episode:${s.id}:${slot}` : uid();
    const previous = await env.DB.prepare("SELECT video_id FROM runs WHERE user_id=? AND idempotency_key=?").bind(user.id, key).first<{ video_id: string }>();
    if (previous) return { id: previous.video_id };
    return await createVideo(env, user, spec, a, key, { seriesId: s.id, slotAt: slot, approved: !settings.review, maxCredits: episodeCredits(settings) });
  } catch (e) {
    if (e instanceof HTTPException) return { error: e.message, status: e.status, blocked: e.status === 402 ? "credits" : e.status === 429 ? "busy" : "failed" };
    throw e;
  }
}

/** Hands the episode of `slot` to the workflow (named by series and slot, so it is started once). */
async function startEpisode(env: Env, seriesId: string, slot: number, first = false) {
  if (!env.CONTENT) return false;
  try {
    await env.CONTENT.create({ id: `episode-${seriesId}-${slot}`, params: { episode: { seriesId, slot, first } } });
    return true;
  } catch (e) {
    // Already started (or the binding failed): the series is tried again on a later minute.
    console.warn("Episode not started", { seriesId, error: (e as Error)?.name });
    return false;
  }
}

/**
 * The workflow's episode step: writes and creates the episode of `slot` once, then moves the series on. A slot
 * that cannot be made (no credits, trial over) is skipped with the reason kept; a writer failure is retried by the
 * cron up to three times before the slot is skipped.
 */
export async function runEpisode(env: Env, seriesId: string, slot: number) {
  const s = await env.DB.prepare("SELECT * FROM series WHERE id=?").bind(seriesId).first<any>();
  if (!s || s.status !== "active") return { state: "stopped" as const };
  const user = await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(s.user_id).first<DbUser>();
  if (!user) return { state: "stopped" as const };
  const made = await env.DB.prepare("SELECT id FROM videos WHERE series_id=? AND slot_at=?").bind(seriesId, slot).first<{ id: string }>();
  const result = made ? { id: made.id } : await makeEpisode(env, user, s, slot);
  const settings = seriesSettings(s), after = nextSlot(settings, slot);
  if ("id" in result) {
    await env.DB.prepare("UPDATE series SET next_slot=?,failures=0,blocked=NULL,attempted_at=NULL,updated_at=? WHERE id=? AND (next_slot IS NULL OR next_slot<=?)")
      .bind(after, now(), seriesId, slot).run();
    return { state: "made" as const, videoId: result.id };
  }
  const retry = result.blocked === "failed" && s.failures + 1 < 3;
  await env.DB.prepare(`UPDATE series SET failures=?,blocked=?,next_slot=CASE WHEN ? THEN next_slot ELSE ? END,updated_at=? WHERE id=? AND (next_slot IS NULL OR next_slot<=?)`)
    .bind(retry ? s.failures + 1 : 0, retry ? s.blocked : result.blocked, retry ? 1 : 0, after, now(), seriesId, slot).run();
  // Running out of credits or the trial is worth an e-mail once (not for every skipped slot).
  if (!retry && result.blocked !== s.blocked && ["credits", "trial"].includes(result.blocked) && settings.notify)
    await mail(env, user.email, `Your series “${s.name}” skipped an episode`, [
      blockedText[result.blocked], "", `Open the series: ${siteUrl(env)}/app/series/${s.id}`,
    ]).catch(() => {});
  return { state: retry ? ("retry" as const) : ("skipped" as const), reason: result.blocked };
}

/** Cron (every minute): series whose next slot is within reach are handed to the workflow, a few at a time. */
export async function dispatchSeries(env: Env) {
  const t = now();
  // Slots long missed (the series was paused, or the cron was down) are not made late: on to the next one.
  const missed = (await env.DB.prepare("SELECT id,settings FROM series WHERE status='active' AND next_slot IS NOT NULL AND next_slot<? LIMIT 50").bind(t - LATE_GRACE).all<any>()).results;
  for (const s of missed)
    await env.DB.prepare("UPDATE series SET next_slot=?,updated_at=? WHERE id=? AND next_slot<?").bind(nextSlot(seriesSettings(s), t + 10 * MINUTE), t, s.id, t - LATE_GRACE).run();
  const due = (await env.DB.prepare(
    "SELECT * FROM series WHERE status='active' AND next_slot IS NOT NULL AND next_slot<=? AND (attempted_at IS NULL OR attempted_at<?) ORDER BY next_slot LIMIT 20",
  ).bind(t + MAKE_AHEAD.review, t - 15 * MINUTE).all<any>()).results;
  let started = 0;
  for (const s of due) {
    if (started >= 10) break;
    const settings = seriesSettings(s);
    if (s.next_slot > t + MAKE_AHEAD[settings.review ? "review" : "autopilot"]) continue;
    // Claimed for 15 minutes: the next tries wait while the workflow writes.
    const claimed = await env.DB.prepare("UPDATE series SET attempted_at=? WHERE id=? AND (attempted_at IS NULL OR attempted_at<?)").bind(t, s.id, t - 15 * MINUTE).run();
    if (!claimed.meta.changes) continue;
    if (!env.CONTENT) { console.error("Series cannot run: the CONTENT workflow binding is missing"); return; }
    try {
      await env.CONTENT.create({ id: `episode-${s.id}-${s.next_slot}-${s.failures}`, params: { episode: { seriesId: s.id, slot: s.next_slot } } });
      started++;
    } catch (e) {
      console.warn("Episode not started; tried again later", { seriesId: s.id, error: (e as Error)?.name });
    }
  }
}

const mail = (env: Env, to: string, subject: string, lines: string[]) => sendMail(env, to, subject, [...lines, "", `— ${PRODUCT.name}`].join("\n"));
const when = (at: number, tz: string) => new Intl.DateTimeFormat("en-US", { timeZone: validZone(tz) ? tz : "UTC", dateStyle: "medium", timeStyle: "short" }).format(new Date(at * 1000));

/**
 * A video is ready: an approved episode is scheduled on its series' channels, and the owner hears about it once
 * (the series' e-mail notice): when it posts, or that it waits for their review.
 */
export async function videoReady(env: Env, videoId: string) {
  const v = await env.DB.prepare("SELECT v.*,s.name AS series_name,s.settings AS series_settings,u.email FROM videos v JOIN users u ON u.id=v.user_id LEFT JOIN series s ON s.id=v.series_id WHERE v.id=?")
    .bind(videoId).first<any>();
  if (!v || v.render_status !== "ready") return;
  let scheduled = 0;
  if (v.series_id && v.status === "approved") scheduled = await scheduleEpisode(env, videoId);
  if (!v.series_id || v.notified_at) return;
  const settings = seriesSettings({ settings: v.series_settings });
  if (!settings.notify) return;
  const claimed = await env.DB.prepare("UPDATE videos SET notified_at=? WHERE id=? AND notified_at IS NULL").bind(now(), videoId).run();
  if (!claimed.meta.changes) return;
  const link = `${siteUrl(env)}/app/videos/${videoId}`;
  const next = v.status === "pending"
    ? "It's waiting for your review: approve it to post it, edit it, or reject it."
    : scheduled && v.slot_at ? `It posts on ${when(Math.max(v.slot_at, now()), settings.schedule.timezone)}. You can still edit it before then.`
      : settings.accounts.length ? "It's ready to download or post." : "It's ready to download.";
  await mail(env, v.email, `New episode of “${v.series_name}”: ${v.title || v.hook || "your video"}`, [
    `A new video of your series “${v.series_name}” is ready.`, "", v.title || v.hook || "", "", next, "", `Watch and edit it: ${link}`,
  ]).catch((e) => console.warn("Ready notice not sent", { videoId, error: (e as Error)?.name }));
}
/** An episode could not be made: the owner hears about it (once) when the series sends notices. */
export async function videoFailed(env: Env, videoId: string) {
  const v = await env.DB.prepare("SELECT v.id,v.series_id,v.notified_at,v.render_error,s.name AS series_name,s.settings AS series_settings,u.email FROM videos v JOIN users u ON u.id=v.user_id JOIN series s ON s.id=v.series_id WHERE v.id=?")
    .bind(videoId).first<any>();
  if (!v || v.notified_at || !seriesSettings({ settings: v.series_settings }).notify) return;
  const claimed = await env.DB.prepare("UPDATE videos SET notified_at=? WHERE id=? AND notified_at IS NULL").bind(now(), videoId).run();
  if (!claimed.meta.changes) return;
  await mail(env, v.email, `An episode of “${v.series_name}” couldn't be made`, [
    v.render_error || "This video couldn't be made.", "", `Try it again: ${siteUrl(env)}/app/videos/${videoId}`,
  ]).catch(() => {});
}

