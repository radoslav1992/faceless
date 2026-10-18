import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { App, DbUser, Env } from "./types";
import { mediaEnabled, now, uid } from "./types";
import { dbFailure, json, ownedVideo } from "./db";
import { rate } from "./security";
import { allowance, type Allowance } from "./billing";
import { scheduleEpisode } from "./publishing";
import { voiceUsable } from "./voices";
import { avatarFor } from "./avatars";
import { heygenEnabled } from "./providers/heygen";
import {
  isHighlight, presenterNeeded, referencedAssets, referencedLibrary, specCredits, specHook, specSchema, visualPart, type HighlightSpec, type Spec, type StorySpec,
} from "../shared/formats";
import { storyScript, STORY_MAX_CHARS, STORY_MAX_SECONDS } from "../shared/story";
import { creditsLabel } from "../shared/credits";

// Videos: made from a spec by a run (AI pictures and clips, the voice, the render; for a clip of a long video, where
// its people are and the render). A series makes them for its posting slots (server/series.ts); people also make
// one-off videos and clips (server/highlights.ts), and edit any video before it posts.
export const videos = new Hono<App>();

/**
 * Every file, library item, voice and presenter the spec uses exists and is the owner's (or shared). The voice must be
 * one that is offered, or `keptVoice`: the one the video (or its series) already has, which keeps working once hidden;
 * the presenter's avatar likewise (`keptAvatar`).
 */
export async function checkReferences(env: Env, userId: string, spec: Spec, keptVoice?: string | null, keptAvatar?: string | null) {
  const assets = referencedAssets(spec);
  if (assets.length) {
    const found = (await env.DB.prepare(`SELECT id FROM media_assets WHERE user_id=? AND status='ready' AND id IN (${assets.map(() => "?").join(",")})`)
      .bind(userId, ...assets).all<{ id: string }>()).results;
    if (found.length !== assets.length) throw new HTTPException(400, { message: "A file in this video is missing or still uploading. Choose it again." });
  }
  const items = referencedLibrary(spec);
  if (items.length) {
    const found = new Map((await env.DB.prepare(`SELECT id,kind FROM library_items WHERE active=1 AND id IN (${items.map(() => "?").join(",")})`)
      .bind(...items).all<{ id: string; kind: string }>()).results.map((r) => [r.id, r.kind]));
    if (found.size !== items.length) throw new HTTPException(400, { message: "A clip, picture or track in this video is no longer in the library. Choose another one." });
    // Music is a track, the background a clip, a scene a clip or a picture.
    const wrong = (id: string | undefined, kinds: string[]) => !!id && !kinds.includes(found.get(id)!);
    if (wrong(spec.music?.trackId, ["music"])) throw new HTTPException(400, { message: "Choose a library track for the music." });
    if (!isHighlight(spec) && (wrong(spec.backdrop?.libraryId, ["clip"]) || spec.scenes.some((s) => wrong(s.libraryId, ["clip", "image"]))))
      throw new HTTPException(400, { message: "Choose a library clip for the background, and a clip or picture for each scene." });
  }
  if (isHighlight(spec)) return checkSource(env, userId, spec);
  // An AI voice reads at most STORY_MAX_CHARS; an own voiceover is a recording with sound, up to the render's three minutes.
  if (spec.narration.kind === "voice") {
    if (!(await voiceUsable(env, spec.narration.voiceId, keptVoice))) throw new HTTPException(400, { message: "Choose one of the voices offered." });
    if (storyScript(spec.scenes).length > STORY_MAX_CHARS) throw new HTTPException(400, { message: `The script can be up to ${STORY_MAX_CHARS.toLocaleString("en-US")} characters (about ${Math.round(STORY_MAX_CHARS / 15)} seconds).` });
  } else {
    const a = await env.DB.prepare("SELECT mime,duration,meta FROM media_assets WHERE id=? AND user_id=?").bind(spec.narration.assetId, userId).first<{ mime: string; duration: number; meta: string }>();
    if (!a || !/^(audio|video)\//.test(a.mime) || a.meta.includes('"hasAudio":false')) throw new HTTPException(400, { message: "Choose your voiceover: one of your audio or video files with sound." });
    if (a.duration > STORY_MAX_SECONDS + 0.5) throw new HTTPException(400, { message: "A video can be up to 3 minutes long. Choose a shorter recording." });
  }
  if (spec.presenter) await checkPresenter(env, spec, keptAvatar);
}
/**
 * A presenter speaks the AI voice over the scenes (never over a background clip), as an avatar that is offered (or the
 * video's own, `keptAvatar`) in the quality chosen. A new presenter video needs the presenter service.
 */
async function checkPresenter(env: Env, spec: StorySpec, keptAvatar?: string | null) {
  const p = spec.presenter!;
  if (spec.narration.kind !== "voice") throw new HTTPException(400, { message: "A presenter speaks the AI voice. Choose an AI voice for the narration, or remove the presenter." });
  if (spec.backdrop) throw new HTTPException(400, { message: "A presenter can't be shown over a background clip. Remove one of them." });
  const avatar = await avatarFor(env, p.avatarId);
  if (!avatar || (!avatar.active && avatar.id !== keptAvatar)) throw new HTTPException(400, { message: "Choose one of the presenters offered." });
  // A presenter video already made for it (or not shown in any scene) needs nothing new.
  if (!presenterNeeded(spec)) return;
  if (!heygenEnabled(env)) throw new HTTPException(503, { message: "On-screen presenters aren't available right now. Remove the presenter, or try again later." });
  if (!avatar.qualities.includes(p.quality)) throw new HTTPException(400, { message: "This presenter isn't offered in that quality. Choose the other one." });
}
/** A clip's video is one of the owner's own uploads, and its moment lies within it. */
async function checkSource(env: Env, userId: string, spec: HighlightSpec) {
  const a = await env.DB.prepare("SELECT kind,mime,duration FROM media_assets WHERE id=? AND user_id=?").bind(spec.source.assetId, userId).first<{ kind: string; mime: string; duration: number }>();
  if (!a || a.kind !== "upload" || !a.mime.startsWith("video/")) throw new HTTPException(400, { message: "Clips are cut from your own videos. Choose one of them." });
  if (spec.source.start >= a.duration - 1) throw new HTTPException(400, { message: "This moment starts after the end of the video. Choose it again." });
}
/** Starts the run's background work; a failed start is retried by maintenance (the run stays queued). */
export async function dispatchRun(env: Env, runId: string) {
  try {
    await env.CONTENT!.create({ id: runId, params: { runId } });
  } catch (e) {
    console.error("Run dispatch failed; maintenance will retry", { runId, error: (e as Error)?.name });
  }
}
export function requireMedia(env: Env) {
  if (!mediaEnabled(env) || !env.CONTENT) throw new HTTPException(503, { message: "Video making is being set up. Please try again soon." });
}
/** New videos need a confirmed email (the free trial is once per mailbox). */
export function requireVerified(user: DbUser) {
  if (!user.verified) throw new HTTPException(403, { message: "Confirm your email to make videos. We sent you a link when you signed up." });
}
/** Refuses new videos after the free trial, or when the credits left don't cover `credits`. */
export function canCreate(a: Allowance, credits = 1) {
  if (a.trialEnded) throw new HTTPException(402, { message: "Your free trial has ended. Choose a plan to keep making videos." });
  if (a.used + credits > a.limit)
    throw new HTTPException(402, { message: `This needs ${creditsLabel(credits)} and you have ${creditsLabel(Math.max(0, a.limit - a.used))} left. Upgrade or add a credit pack.` });
}
/**
 * Creates a video and its first run in one transaction (the video quota and the credits are reserved by the
 * triggers). A series' episode carries its series and slot (one video per slot).
 */
/** What a new video costs: its length (an owner's recording by its own length). */
export async function newVideoCredits(env: Env, userId: string, spec: Spec) {
  if (isHighlight(spec)) return specCredits(spec, true);
  const recording = spec.narration.kind === "upload"
    ? await env.DB.prepare("SELECT duration FROM media_assets WHERE id=? AND user_id=?").bind(spec.narration.assetId, userId).first<{ duration: number }>()
    : null;
  return specCredits(spec, true, recording?.duration || undefined);
}
export async function createVideo(
  env: Env, user: DbUser, spec: Spec, a: Allowance, key: string,
  from: { seriesId?: string; slotAt?: number | null; approved?: boolean; maxCredits?: number } = {},
) {
  requireMedia(env);
  // A series episode never costs more than the series says it does, however long the writer ran.
  const credits = Math.min(await newVideoCredits(env, user.id, spec), from.maxCredits ?? Infinity);
  const videoId = uid(), runId = uid(), t = now(), approved = from.approved ?? true;
  try {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO videos(id,user_id,series_id,kind,slot_at,spec,hook,caption,title,status,reviewed_at,render_status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,'queued',?,?)",
      ).bind(videoId, user.id, from.seriesId ?? null, spec.kind, from.slotAt ?? null, JSON.stringify(spec), specHook(spec).slice(0, 300), spec.caption, spec.title,
        approved ? "approved" : "pending", approved ? t : null, t, t),
      env.DB.prepare(
        "INSERT INTO runs(id,user_id,video_id,window_id,idempotency_key,kind,credits,status,payload,created_at,updated_at) VALUES (?,?,?,?,?,'video',?,'queued',?,?,?)",
      ).bind(runId, user.id, videoId, a.window, key, credits, JSON.stringify({ revision: 1, watermark: a.plan === "free" }), t, t),
    ]);
  } catch (e) {
    dbFailure(e);
  }
  await dispatchRun(env, runId);
  return { id: videoId, runId, credits };
}
/**
 * A new run for an existing video (after an edit, or to retry a failed render), priced against `before` (the stored
 * spec). A clip that was never made (its first run failed and was refunded) costs what a new one does.
 */
async function rerun(env: Env, user: DbUser, video: any, spec: Spec, key: string, before: Spec) {
  requireMedia(env);
  const previous = await env.DB.prepare("SELECT video_id FROM runs WHERE user_id=? AND idempotency_key=?").bind(user.id, key).first<{ video_id: string }>();
  if (previous) return { credits: 0 };
  const a = await allowance(env, user);
  const credits = isHighlight(spec) && !video.video_asset ? specCredits(spec, true) : specCredits(spec, false, undefined, before);
  if (credits > 0) canCreate(a, credits);
  const runId = uid(), t = now();
  try {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO runs(id,user_id,video_id,window_id,idempotency_key,kind,credits,status,payload,created_at,updated_at) VALUES (?,?,?,?,?,'video',?,'queued',?,?,?)",
      ).bind(runId, user.id, video.id, a.window, key, credits, JSON.stringify({ revision: video.revision + 1, watermark: a.plan === "free" }), t, t),
      env.DB.prepare("UPDATE videos SET spec=?,hook=?,caption=?,title=?,render_status='queued',render_error=NULL,revision=revision+1,updated_at=? WHERE id=?")
        .bind(JSON.stringify(spec), specHook(spec).slice(0, 300), spec.caption, spec.title, t, video.id),
    ]);
  } catch (e) {
    dbFailure(e);
  }
  await dispatchRun(env, runId);
  return { credits };
}

/** What the app shows for a video (never internal run payloads). */
export function videoView(v: any, detail = false) {
  const spec = json<any>(v.spec, {});
  return {
    id: v.id, seriesId: v.series_id, seriesName: v.series_name ?? null, slotAt: v.slot_at, status: v.status, renderStatus: v.render_status,
    renderError: v.render_error, phase: v.phase ?? null, hook: v.hook, caption: v.caption, title: v.title,
    hashtags: spec.hashtags || [], topic: spec.topic || "", style: spec.style || null,
    duration: v.duration, videoAssetId: v.video_asset, coverAssetId: v.cover_asset,
    revision: v.revision, createdAt: v.created_at, updatedAt: v.updated_at, reviewedAt: v.reviewed_at,
    ...(v.publications !== undefined && { publications: json<any[]>(v.publications, []) }),
    ...(detail && { spec }),
  };
}
const views = {
  making: "v.render_status IN ('queued','running')",
  review: "v.status='pending' AND v.render_status='ready'",
  ready: "v.render_status='ready'",
  failed: "v.render_status='failed'",
  all: "1=1",
} as const;
/** The video's publications (where and when it posts, and how it went), as a JSON list for list views. */
export const PUBLICATIONS = `(SELECT json_group_array(json_object('id',x.id,'platform',x.platform,'accountName',x.account_name,'scheduledAt',x.scheduled_at,'status',x.status,'url',x.url,'error',x.error,'views',x.views,'likes',x.likes)) FROM publications x WHERE x.video_id=v.id AND x.status<>'canceled') AS publications`;
videos.get("/", async (c) => {
  const user = c.get("user");
  const q = z.object({
    series: z.uuid().optional(),
    view: z.enum(Object.keys(views) as [keyof typeof views]).default("all"),
    limit: z.coerce.number().int().min(1).max(100).default(30),
    before: z.coerce.number().int().optional(),
  }).parse(c.req.query());
  const where = [`v.user_id=?`, views[q.view]], args: unknown[] = [user.id];
  if (q.series) { where.push("v.series_id=?"); args.push(q.series); }
  if (q.before) { where.push("v.created_at<?"); args.push(q.before); }
  const rows = (await c.env.DB.prepare(
    `SELECT v.*,s.name AS series_name,(SELECT phase FROM runs r WHERE r.video_id=v.id AND r.status IN ('queued','running') LIMIT 1) AS phase,${PUBLICATIONS}
     FROM videos v LEFT JOIN series s ON s.id=v.series_id WHERE ${where.join(" AND ")} ORDER BY v.created_at DESC LIMIT ?`,
  ).bind(...args, q.limit).all<any>()).results;
  const counts = await c.env.DB.prepare(
    `SELECT SUM(${views.making}) AS making, SUM(${views.review}) AS review, SUM(${views.failed}) AS failed, COUNT(*) AS total FROM videos v WHERE v.user_id=?${q.series ? " AND v.series_id=?" : ""}`,
  ).bind(user.id, ...(q.series ? [q.series] : [])).first<any>();
  return c.json({ videos: rows.map((v) => videoView(v)), counts: { making: counts?.making || 0, review: counts?.review || 0, failed: counts?.failed || 0, total: counts?.total || 0 } });
});
/** A one-off video from a spec (written in the editor); it is the author's own, so it needs no review. */
const createSchema = z.object({ spec: specSchema, idempotencyKey: z.uuid() });
videos.post("/", async (c) => {
  const user = c.get("user");
  await rate(c, "video-create", 60, 3600, user.id);
  const d = createSchema.parse(await c.req.json());
  const previous = await c.env.DB.prepare("SELECT video_id FROM runs WHERE user_id=? AND idempotency_key=?").bind(user.id, d.idempotencyKey).first<{ video_id: string }>();
  if (previous) return c.json({ id: previous.video_id });
  requireVerified(user);
  const spec = stripGenerated(d.spec);
  await checkReferences(c.env, user.id, spec);
  const a = await allowance(c.env, user);
  canCreate(a, await newVideoCredits(c.env, user.id, spec));
  return c.json(await createVideo(c.env, user, spec, a, d.idempotencyKey), 201);
});
/** The browser never sets the recorded voice, the presenter's video or a clip's tracking: only the server's runs do. */
function stripGenerated(spec: Spec): Spec {
  const { generated: _g, presented: _p, tracked: _t, ...rest } = spec as Spec & { generated?: unknown; presented?: unknown; tracked?: unknown };
  return rest as Spec;
}
/**
 * What the server owns of the stored spec (the paid recording, the presenter's video while the edit keeps a presenter,
 * a clip's tracking), carried into the edit `next`.
 */
function serverParts(stored: Spec, next: Spec) {
  const s = stored as Spec & { generated?: unknown; presented?: unknown; tracked?: unknown };
  const presenter = !isHighlight(next) && !!next.presenter;
  return { ...(s.generated ? { generated: s.generated } : {}), ...(s.presented && presenter ? { presented: s.presented } : {}), ...(s.tracked ? { tracked: s.tracked } : {}) };
}
videos.get("/:id", async (c) => {
  const user = c.get("user");
  const v = await ownedVideo(c.env, user.id, c.req.param("id"));
  const run = await c.env.DB.prepare("SELECT phase,status FROM runs WHERE video_id=? ORDER BY created_at DESC LIMIT 1").bind(v.id).first<any>();
  const extra = await c.env.DB.prepare(`SELECT s.name AS series_name,${PUBLICATIONS.replace("v.id", "?")} FROM (SELECT 1) LEFT JOIN series s ON s.id=?`)
    .bind(v.id, v.series_id).first<any>();
  return c.json({ video: videoView({ ...v, ...extra, phase: run?.status === "queued" || run?.status === "running" ? run.phase : null }, true) });
});
videos.put("/:id", async (c) => {
  const user = c.get("user");
  await rate(c, "video-edit", 200, 3600, user.id);
  const v = await ownedVideo(c.env, user.id, c.req.param("id"));
  const d = z.object({ spec: specSchema, idempotencyKey: z.uuid() }).parse(await c.req.json());
  const stored = json<Spec>(v.spec, d.spec);
  if ((stored.format || "story") !== d.spec.format) throw new HTTPException(400, { message: "A video can't change its type. Make a new one instead." });
  // The paid recording stays with the video while its words and voice do not change, the presenter's video while its
  // avatar, quality and recording do not (and a clip's tracking while its moment does not).
  const spec = { ...stripGenerated(d.spec), ...serverParts(stored, d.spec) } as Spec;
  await checkReferences(c.env, user.id, spec, !isHighlight(stored) && stored.narration?.kind === "voice" ? stored.narration.voiceId : null,
    !isHighlight(stored) ? stored.presenter?.avatarId : null);
  if (visualPart(spec) === visualPart(stored) && v.render_status === "ready") {
    await c.env.DB.prepare("UPDATE videos SET spec=?,caption=?,title=?,updated_at=? WHERE id=?").bind(JSON.stringify(spec), spec.caption, spec.title, now(), v.id).run();
    return c.json({ video: videoView({ ...v, spec: JSON.stringify(spec), caption: spec.caption, title: spec.title }, true), rendering: false });
  }
  if (["queued", "running"].includes(v.render_status)) throw new HTTPException(409, { message: "This video is still being made. Edit it when it's ready." });
  const live = await c.env.DB.prepare("SELECT 1 FROM publications WHERE video_id=? AND status='publishing'").bind(v.id).first();
  if (live) throw new HTTPException(409, { message: "This video is being published right now. Edit it in a minute." });
  const { credits } = await rerun(c.env, user, v, spec, d.idempotencyKey, stored);
  return c.json({ video: videoView(await ownedVideo(c.env, user.id, v.id), true), rendering: true, credits });
});
videos.post("/:id/render", async (c) => {
  const user = c.get("user");
  const v = await ownedVideo(c.env, user.id, c.req.param("id"));
  const { idempotencyKey } = z.object({ idempotencyKey: z.uuid() }).parse(await c.req.json());
  if (["queued", "running"].includes(v.render_status)) throw new HTTPException(409, { message: "This video is already being made." });
  const spec = json<Spec>(v.spec, {} as Spec);
  const { credits } = await rerun(c.env, user, v, spec, idempotencyKey, spec);
  return c.json({ ok: true, credits });
});
/**
 * Review: approving an episode of a series schedules it on the series' channels (at its slot, or at once when that
 * has passed); rejecting it cancels anything scheduled.
 */
videos.post("/:id/review", async (c) => {
  const user = c.get("user");
  const v = await ownedVideo(c.env, user.id, c.req.param("id"));
  const { decision } = z.object({ decision: z.enum(["approve", "reject"]) }).parse(await c.req.json());
  if (v.render_status !== "ready") throw new HTTPException(409, { message: "This video isn't ready yet." });
  if (decision === "reject") {
    const live = await c.env.DB.prepare("SELECT 1 FROM publications WHERE video_id=? AND status IN ('publishing','published')").bind(v.id).first();
    if (live) throw new HTTPException(409, { message: "This video is already being published." });
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE publications SET status='canceled',updated_at=? WHERE video_id=? AND status='scheduled'").bind(now(), v.id),
      c.env.DB.prepare("UPDATE videos SET status='rejected',reviewed_at=?,updated_at=? WHERE id=?").bind(now(), now(), v.id),
    ]);
    return c.json({ ok: true, status: "rejected", scheduled: 0 });
  }
  await c.env.DB.prepare("UPDATE videos SET status='approved',reviewed_at=?,updated_at=? WHERE id=?").bind(now(), now(), v.id).run();
  let scheduled = 0;
  try { scheduled = await scheduleEpisode(c.env, v.id); }
  catch (e) { console.error("Episode scheduling failed", { videoId: v.id, error: (e as Error)?.name }); }
  return c.json({ ok: true, status: "approved", scheduled });
});
videos.delete("/:id", async (c) => {
  const v = await ownedVideo(c.env, c.get("user").id, c.req.param("id"));
  try {
    await c.env.DB.prepare("DELETE FROM videos WHERE id=?").bind(v.id).run();
  } catch (e) {
    dbFailure(e);
  }
  return c.json({ ok: true });
});
