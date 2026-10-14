import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { App, Env } from "./types";
import { MB, now, uid } from "./types";
import { extOf, serveObject, storeStream } from "./storage";
import { isTemplate, templates } from "../shared/templates";

// Style examples: one real video per faceless style (shared/templates.ts), played on the style's card in Create, on
// the home page and on the tool pages. Administrators choose one of their own finished videos for a style in
// Admin → Examples; its file and cover are copied under examples/{id}/, so the example stays when the video is
// deleted. A style without one shows its drawing.

const LIMIT = 100 * MB;
type ExampleRow = { template: string; id: string; video_key: string; poster_key: string | null; duration: number; source_video: string | null; created_at: number };
/** A choice's files never change (a new choice has a new id), so browsers keep them. */
const FOREVER = "public, max-age=31536000, immutable";
const exampleView = (r: ExampleRow) => ({
  video: `/api/public/examples/${r.id}/video`, poster: r.poster_key ? `/api/public/examples/${r.id}/poster` : null, duration: r.duration,
});
const rows = async (env: Env) =>
  (await env.DB.prepare("SELECT * FROM style_examples").all<ExampleRow>()).results.filter((r) => isTemplate(r.template));

/** Unauthenticated: each style's example (by template id), and its files. */
export const publicExamples = new Hono<App>();
publicExamples.get("/api/public/examples", async (c) => {
  c.header("Cache-Control", "public, max-age=60");
  return c.json({ examples: Object.fromEntries((await rows(c.env)).map((r) => [r.template, exampleView(r)])) });
});
publicExamples.get("/api/public/examples/:id/:file{video|poster}", async (c) => {
  const r = await c.env.DB.prepare("SELECT video_key,poster_key FROM style_examples WHERE id=?").bind(c.req.param("id")).first<Pick<ExampleRow, "video_key" | "poster_key">>();
  const key = c.req.param("file") === "video" ? r?.video_key : r?.poster_key;
  if (!key) throw new HTTPException(404, { message: "Not found." });
  return serveObject(c.env, key, c.req.param("file") === "video" ? c.req.header("Range") : null, FOREVER);
});

/** Admin → Examples (mounted under the administrators' routes). */
export const adminExamples = new Hono<App>();
/** Every style's example, and the administrator's own finished videos to choose from (newest first). */
adminExamples.get("/", async (c) => {
  const examples = (await rows(c.env)).map((r) => ({ template: r.template, ...exampleView(r), sourceVideoId: r.source_video, createdAt: r.created_at }));
  const videos = (await c.env.DB.prepare(
    `SELECT v.id,v.kind,v.title,v.hook,v.duration,v.video_asset,v.cover_asset,v.created_at FROM videos v
     JOIN media_assets a ON a.id=v.video_asset AND a.status='ready'
     WHERE v.user_id=? AND v.render_status='ready' ORDER BY v.created_at DESC LIMIT 200`,
  ).bind(c.get("user").id).all<any>()).results;
  return c.json({
    examples,
    videos: videos.map((v) => ({
      id: v.id, kind: v.kind, title: v.title || v.hook || "Untitled video", duration: v.duration, createdAt: v.created_at,
      url: `/api/media/${v.video_asset}/file`, cover: v.cover_asset ? `/api/media/${v.cover_asset}/file` : null,
    })),
  });
});
/** Makes one of the administrator's finished videos the style's example (in place of the one it had). */
adminExamples.put("/:template", async (c) => {
  const template = c.req.param("template");
  if (!isTemplate(template)) throw new HTTPException(404, { message: "No such style." });
  const { videoId } = z.object({ videoId: z.string().min(1).max(40) }).parse(await c.req.json());
  const v = await c.env.DB.prepare(
    `SELECT v.id,v.duration,a.object_key,a.mime,a.bytes,p.object_key AS poster_key,p.mime AS poster_mime FROM videos v
     JOIN media_assets a ON a.id=v.video_asset AND a.status='ready'
     LEFT JOIN media_assets p ON p.id=v.cover_asset AND p.status='ready'
     WHERE v.id=? AND v.user_id=? AND v.render_status='ready'`,
  ).bind(videoId, c.get("user").id).first<any>();
  if (!v) throw new HTTPException(404, { message: "Choose one of your finished videos." });
  if (v.bytes > LIMIT) throw new HTTPException(413, { message: `Examples can be up to ${LIMIT / MB} MB. Choose a shorter video.` });
  const source = await c.env.MEDIA.get(v.object_key);
  if (!source) throw new HTTPException(404, { message: "This video's file is no longer available." });
  const id = uid(), videoKey = `examples/${id}/video.${extOf(v.mime)}`;
  const posterKey = v.poster_key ? `examples/${id}/poster.${extOf(v.poster_mime)}` : null;
  try {
    await storeStream(c.env, videoKey, new Response(source.body, { headers: { "Content-Length": String(source.size) } }), LIMIT, v.mime);
    const poster = v.poster_key ? await c.env.MEDIA.get(v.poster_key) : null;
    if (posterKey && poster) await c.env.MEDIA.put(posterKey, poster.body, { httpMetadata: { contentType: v.poster_mime } });
    // The old example's files are queued for deletion by the table's trigger.
    await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM style_examples WHERE template=?").bind(template),
      c.env.DB.prepare("INSERT INTO style_examples(template,id,video_key,poster_key,duration,source_video,created_at) VALUES (?,?,?,?,?,?,?)")
        .bind(template, id, videoKey, poster ? posterKey : null, v.duration, v.id, now()),
    ]);
  } catch (e) {
    await c.env.MEDIA.delete(posterKey ? [videoKey, posterKey] : [videoKey]);
    if ((e as Error).message === "MEDIA_SIZE") throw new HTTPException(413, { message: `Examples can be up to ${LIMIT / MB} MB. Choose a shorter video.` });
    throw e;
  }
  const r = await c.env.DB.prepare("SELECT * FROM style_examples WHERE template=?").bind(template).first<ExampleRow>();
  return c.json({ example: { template, ...exampleView(r!), sourceVideoId: r!.source_video, createdAt: r!.created_at }, name: templates[template].name });
});
adminExamples.delete("/:template", async (c) => {
  await c.env.DB.prepare("DELETE FROM style_examples WHERE template=?").bind(c.req.param("template")).run();
  return c.json({ ok: true });
});
