import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { App, Env } from "../types";
import { MB, now, uid } from "../types";
import { json } from "../db";
import { extOf, head, imageFits, imageInfo, serveObject, storeStream } from "../storage";
import { libraryKinds, libraryView, splitTags, type LibraryKind, type LibraryRow } from "../library";
import { describeMedia } from "../describe";
import { rate } from "../security";
import { soundEffect, SOUND_EFFECT_SECONDS } from "../providers/elevenlabs";
import { ProviderError } from "../providers/http";
import { CATEGORY_MAX } from "../../shared/library";
import { SOUND_MAX_SECONDS, SOUND_MIN_SECONDS } from "../../shared/sounds";

// Admin → Library: the shared music, clips, pictures and sound effects people search and pick from (server/library.ts).
// Items are uploaded, copied from the administrator's own media (an upload, or an AI picture or clip they made for a
// video) with its details: its name, its prompt as the description, whether AI made it — or, for sound effects, made
// with ElevenLabs from a description (POST /generate: a take to listen to, uploaded when kept). Name, description, genre or category,
// tags and the AI mark are edited here, written or suggested by AI (POST /describe); an item is switched off (no
// longer offered) or deleted.
export const adminLibrary = new Hono<App>();

const audio = ["audio/mpeg", "audio/mp4", "audio/x-m4a", "audio/aac", "audio/ogg", "audio/wav", "audio/x-wav"];
const mimes: Record<LibraryKind, string[]> = {
  music: audio,
  clip: ["video/mp4", "video/quicktime", "video/webm"],
  image: ["image/jpeg", "image/png", "image/webp"],
  sfx: audio,
};
const limits: Record<LibraryKind, number> = { music: 50 * MB, clip: 50 * MB, image: 20 * MB, sfx: 10 * MB };
const wrongType: Record<LibraryKind, string> = {
  music: "Upload an MP3, M4A, OGG or WAV track.", clip: "Upload an MP4, MOV or WebM video.", image: "Upload a JPG, PNG or WebP picture.",
  sfx: "Upload an MP3, M4A, OGG or WAV sound.",
};
/** The kind an own media file becomes (audio: music; sound effects are uploaded or made with ElevenLabs). */
const kindOfMime = (mime: string): LibraryKind | null => (libraryKinds.find((k) => mimes[k].includes(mime)) ?? null);
const tooBig = (kind: LibraryKind) => `Library ${kind === "image" ? "pictures" : "files"} can be up to ${limits[kind] / MB} MB.`;
const LENGTH = "Library clips and tracks must be between half a second and 10 minutes long.";
const SOUND_LENGTH = `Sound effects must be between ${SOUND_MIN_SECONDS} and ${SOUND_MAX_SECONDS} seconds long.`;
/** Why a clip, track or sound of `duration` seconds can't be in the library, or null (pictures have no length). */
const lengthProblem = (kind: LibraryKind, duration: number) =>
  kind === "image" ? null
    : kind === "sfx" ? (duration < SOUND_MIN_SECONDS || duration > SOUND_MAX_SECONDS ? SOUND_LENGTH : null)
      : duration < 0.5 || duration > 600 ? LENGTH : null;
const fields = {
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500),
  category: z.string().trim().max(CATEGORY_MAX),
  tags: z.string().trim().max(300),
};
/** Tags as stored: trimmed, comma-separated, each once (as first written). */
function tidyTags(tags: string) {
  const kept = new Map<string, string>();
  for (const t of splitTags(tags)) if (!kept.has(t.toLowerCase())) kept.set(t.toLowerCase(), t.slice(0, 40));
  return [...kept.values()].join(", ");
}
// `review`: a sound effect made with a video that only its owner is offered until it is approved (server/sounds.ts).
const adminView = (r: LibraryRow, usage?: number) => ({
  ...libraryView(r), active: !!r.active, rawTags: r.tags, bytes: r.bytes, createdAt: r.created_at, fromMedia: !!r.source_asset, usage: usage ?? 0,
  review: !!r.review,
});
async function row(env: Env, id: string) {
  const r = await env.DB.prepare("SELECT * FROM library_items WHERE id=?").bind(id).first<LibraryRow>();
  if (!r) throw new HTTPException(404, { message: "Not found." });
  return r;
}
/** The size of a stored picture from its header, or null when it isn't a picture the renderer takes. */
async function storedImage(env: Env, key: string) {
  const info = imageInfo((await head(env, key)) || new Uint8Array());
  return info && imageFits(info) ? info : null;
}

/**
 * How many videos and series use each library item (music, background clip, a scene's clip or picture, the whoosh of
 * scene changes or a scene's sound).
 */
async function libraryUsage(env: Env) {
  const usage = new Map<string, number>();
  const add = (rows: { item: string | null; n: number }[]) => { for (const r of rows) if (r.item) usage.set(r.item, (usage.get(r.item) || 0) + r.n); };
  for (const path of ["$.music.trackId", "$.backdrop.libraryId", "$.sounds.transitionId"])
    add((await env.DB.prepare("SELECT json_extract(spec,?) AS item,COUNT(*) AS n FROM videos GROUP BY item").bind(path).all<any>()).results);
  for (const path of ["$.libraryId", "$.soundId"])
    add((await env.DB.prepare("SELECT json_extract(s.value,?) AS item,COUNT(DISTINCT v.id) AS n FROM videos v, json_each(v.spec,'$.scenes') s GROUP BY item").bind(path).all<any>()).results);
  for (const path of ["$.music.trackId", "$.backdropId"])
    add((await env.DB.prepare("SELECT json_extract(settings,?) AS item,COUNT(*) AS n FROM series GROUP BY item").bind(path).all<any>()).results);
  return usage;
}

adminLibrary.get("/", async (c) => {
  const rows = (await c.env.DB.prepare("SELECT * FROM library_items ORDER BY created_at DESC LIMIT 2000").all<LibraryRow>()).results;
  const usage = await libraryUsage(c.env);
  return c.json({ items: rows.map((r) => adminView(r, usage.get(r.id))) });
});

// Uploads: details first (length and size measured in the admin's browser; a picture's size is read here), then the
// file in one request.
adminLibrary.put("/file", async (c) => {
  const q = z.object({
    kind: z.enum(libraryKinds), name: fields.name, description: fields.description.default(""), category: fields.category.default(""), tags: fields.tags.default(""),
    ai: z.enum(["0", "1"]).default("0"),
    duration: z.coerce.number().min(0).max(600).default(0),
    width: z.coerce.number().int().min(0).max(4096).default(0), height: z.coerce.number().int().min(0).max(4096).default(0),
  }).parse(c.req.query());
  const mime = (c.req.header("Content-Type") || "").split(";")[0].toLowerCase();
  if (!mimes[q.kind].includes(mime)) throw new HTTPException(415, { message: wrongType[q.kind] });
  const problem = lengthProblem(q.kind, q.duration);
  if (problem) throw new HTTPException(400, { message: problem });
  if (Number(c.req.header("Content-Length")) > limits[q.kind]) throw new HTTPException(413, { message: tooBig(q.kind) });
  const id = uid(), key = `library/${id}/file.${extOf(mime)}`;
  let bytes: number;
  try {
    bytes = await storeStream(c.env, key, new Response(c.req.raw.body, { headers: { "Content-Length": c.req.header("Content-Length") || "" } }), limits[q.kind], mime);
  } catch (e) {
    if ((e as Error).message === "MEDIA_SIZE") throw new HTTPException(413, { message: tooBig(q.kind) });
    if ((e as Error).message === "MEDIA_EMPTY") throw new HTTPException(400, { message: "This file is empty." });
    throw e;
  }
  let { width, height } = q;
  if (q.kind === "image") {
    const info = await storedImage(c.env, key);
    if (!info) {
      await c.env.MEDIA.delete(key);
      throw new HTTPException(400, { message: "This isn't a JPG, PNG or WebP picture of up to 4096 pixels on each side." });
    }
    ({ width, height } = info);
  }
  await c.env.DB.prepare("INSERT INTO library_items(id,kind,name,description,category,tags,object_key,mime,bytes,duration,width,height,ai,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .bind(id, q.kind, q.name, q.description, q.category, tidyTags(q.tags), key, mime, bytes, q.kind === "image" ? 0 : q.duration, width, height, Number(q.ai), now()).run();
  return c.json({ id, item: adminView(await row(c.env, id)) }, 201);
});

/** The administrator's own media that can be added: uploads and AI pictures and clips, newest first. */
adminLibrary.get("/media", async (c) => {
  // Own audio becomes music: sound effects are uploaded or made with ElevenLabs.
  const q = z.object({ kind: z.enum(["music", "clip", "image"]) }).parse(c.req.query());
  const user = c.get("user");
  const rows = (await c.env.DB.prepare(
    `SELECT a.id,a.kind,a.name,a.mime,a.bytes,a.duration,a.width,a.height,a.created_at,json_extract(a.meta,'$.prompt') AS prompt,
       (SELECT l.id FROM library_items l WHERE l.source_asset=a.id) AS added
     FROM media_assets a WHERE a.user_id=? AND a.status='ready' AND a.kind IN ('upload','ai_image','ai_clip') AND a.mime IN (${mimes[q.kind].map(() => "?").join(",")})
     ORDER BY a.created_at DESC LIMIT 200`,
  ).bind(user.id, ...mimes[q.kind]).all<any>()).results;
  return c.json({
    files: rows.map((a) => ({
      id: a.id, name: a.name, ai: a.kind !== "upload", prompt: a.prompt || "", mime: a.mime, bytes: a.bytes, duration: a.duration, width: a.width, height: a.height,
      createdAt: a.created_at, url: `/api/media/${a.id}/file`, added: a.added ?? null,
      problem: a.bytes > limits[q.kind] ? tooBig(q.kind) : lengthProblem(q.kind, a.duration),
    })),
  });
});

/** A media file's name without what the app or the camera added: "AI picture: …", a file extension. */
export function mediaName(name: string, prompt: string) {
  const base = (name.replace(/^AI (picture|clip):\s*/i, "").replace(/\.[A-Za-z0-9]{2,4}$/, "").replace(/[_]+/g, " ").trim() || prompt.trim() || "Untitled");
  if (base.length <= 60) return base;
  const cut = base.slice(0, 60);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 30 ? cut.lastIndexOf(" ") : 60).replace(/[\s,.;:–-]+$/, "")}…`;
}
/**
 * Adds one of the administrator's own media files to the library, with its details: its name, its prompt as the
 * description, the AI mark for an AI picture or clip. Changes can be made at once (`name`…) or later.
 */
adminLibrary.post("/from-media", async (c) => {
  const d = z.object({
    assetId: z.string().min(1).max(40), name: fields.name.optional(), description: fields.description.optional(), tags: fields.tags.optional(),
  }).parse(await c.req.json());
  const user = c.get("user");
  const a = await c.env.DB.prepare("SELECT * FROM media_assets WHERE id=? AND user_id=? AND status='ready'").bind(d.assetId, user.id).first<any>();
  if (!a) throw new HTTPException(404, { message: "File not found." });
  const kind = kindOfMime(a.mime);
  if (!kind || !["upload", "ai_image", "ai_clip"].includes(a.kind)) throw new HTTPException(400, { message: "Choose an upload, an AI picture or an AI clip." });
  if (await c.env.DB.prepare("SELECT 1 FROM library_items WHERE source_asset=?").bind(a.id).first()) throw new HTTPException(409, { message: "This file is already in the library." });
  if (a.bytes > limits[kind]) throw new HTTPException(413, { message: tooBig(kind) });
  const problem = lengthProblem(kind, a.duration);
  if (problem) throw new HTTPException(400, { message: problem });
  const source = await c.env.MEDIA.get(a.object_key);
  if (!source) throw new HTTPException(404, { message: "File not found." });
  const id = uid(), key = `library/${id}/file.${extOf(a.mime)}`;
  const bytes = await storeStream(c.env, key, new Response(source.body, { headers: { "Content-Length": String(source.size) } }), limits[kind], a.mime);
  let { width, height } = a as { width: number; height: number };
  if (kind === "image") {
    const info = await storedImage(c.env, key);
    if (!info) {
      await c.env.MEDIA.delete(key);
      throw new HTTPException(400, { message: "This picture is larger than 4096 pixels on a side." });
    }
    ({ width, height } = info);
  }
  const prompt = String(json<any>(a.meta, {}).prompt || "").trim();
  await c.env.DB.prepare(
    "INSERT INTO library_items(id,kind,name,description,tags,object_key,mime,bytes,duration,width,height,ai,source_asset,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).bind(id, kind, d.name ?? mediaName(a.name, prompt), d.description ?? prompt.slice(0, 500), tidyTags(d.tags ?? ""), key, a.mime, bytes, kind === "image" ? 0 : a.duration,
    width, height, a.kind === "upload" ? 0 : 1, a.id, now()).run();
  return c.json({ id, item: adminView(await row(c.env, id)) }, 201);
});

/** Base64 of a sample the browser made, as bytes, when it is of its kind (`magic`) and not too large. */
function sample(text: string, max: number, magic: (b: Uint8Array) => boolean) {
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(text), (ch) => ch.charCodeAt(0));
  } catch {
    return null;
  }
  return bytes.length && bytes.length <= max && magic(bytes) ? bytes : null;
}
const isJpeg = (b: Uint8Array) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
const isWav = (b: Uint8Array) => new TextDecoder().decode(b.subarray(0, 4)) === "RIFF" && new TextDecoder().decode(b.subarray(8, 12)) === "WAVE";
/**
 * Suggests a file's name, description, genre or category and tags with a multimodal model (server/describe.ts), from
 * samples the administrator's browser made: the picture or frames of the clip as JPEGs, a part of the track as a WAV
 * (only those: the model judges the file, not what is filled in). Nothing is saved; the suggestions fill the form.
 */
adminLibrary.post("/describe", async (c) => {
  const d = z.object({
    kind: z.enum(libraryKinds), duration: z.number().min(0).max(600).default(0),
    frames: z.array(z.string().max(2_200_000)).max(8).default([]), audio: z.string().max(11_200_000).optional(),
  }).parse(await c.req.json());
  const frames = d.frames.map((f) => sample(f, 1.6 * MB, isJpeg));
  const audio = d.audio === undefined ? null : sample(d.audio, 8 * MB, isWav);
  const heard = d.kind === "music" || d.kind === "sfx";
  const wanted = heard ? !!audio && !frames.length : !audio && frames.length > 0 && (d.kind === "clip" || frames.length === 1);
  if (!wanted || frames.some((f) => !f) || (d.audio !== undefined && !audio)) throw new HTTPException(400, { message: "These samples can't be described. Reload the page and try again." });
  const suggestion = await describeMedia(c.env, { kind: d.kind, duration: d.duration, frames: frames as Uint8Array[], audio });
  if (!suggestion) throw new HTTPException(503, { message: "The AI couldn't describe this right now. Try again in a minute, or fill it in yourself." });
  return c.json({ suggestion });
});
/**
 * A take of a sound effect made with ElevenLabs from a description (billed by ElevenLabs per take; Sound Effects v3, or
 * v2 for an account without it), as an MP3 to listen to: nothing is saved. The administrator keeps the takes they like by uploading them (PUT /file, made with AI, the
 * description they were made from). 60 an hour.
 */
adminLibrary.post("/generate", async (c) => {
  const d = z.object({
    prompt: z.string().trim().min(3).max(300), seconds: z.number().min(SOUND_EFFECT_SECONDS.min).max(SOUND_EFFECT_SECONDS.max),
  }).parse(await c.req.json());
  await rate(c, "sound-generate", 60, 3600, c.get("user").id);
  let made: Awaited<ReturnType<typeof soundEffect>>;
  try {
    made = await soundEffect(c.env, d.prompt, d.seconds);
  } catch (e) {
    const code = e instanceof ProviderError ? e.code : "SOUND_FAILED";
    console.warn("Sound effect not made", { code });
    throw new HTTPException(code === "SOUND_UNAVAILABLE" ? 503 : 502, {
      message: code === "SOUND_UNAVAILABLE" ? "ElevenLabs isn't set up, or its account can't make sound effects. Upload a sound instead."
        : code === "SOUND_BUSY" ? "ElevenLabs is busy. Try again in a minute." : "ElevenLabs couldn't make this sound. Try again, or describe it differently.",
    });
  }
  // The model that made it (Sound Effects v3, or v2 for an account without v3), shown with the take.
  return new Response(made.audio.slice().buffer, { headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store", "X-Sound-Model": made.model } });
});
/** An item's file whether it is offered or switched off (people only get offered ones), to preview or describe it. */
adminLibrary.get("/:id/file", async (c) => {
  const r = await row(c.env, c.req.param("id"));
  return serveObject(c.env, r.object_key, c.req.header("Range"), "private, no-store");
});

/** A poster image for a clip (a frame the admin's browser captured) or a smaller one for a picture. */
adminLibrary.put("/:id/thumb", async (c) => {
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  const info = imageInfo(bytes);
  if (!info || bytes.length > 2 * MB) throw new HTTPException(400, { message: "The thumbnail must be a JPG, PNG or WebP under 2 MB." });
  const key = `library/${c.req.param("id")}/thumb.${extOf(info.mime)}`;
  const r = await c.env.DB.prepare("UPDATE library_items SET thumb_key=? WHERE id=?").bind(key, c.req.param("id")).run();
  if (!r.meta.changes) throw new HTTPException(404, { message: "Not found." });
  await c.env.MEDIA.put(key, bytes, { httpMetadata: { contentType: info.mime } });
  return c.json({ ok: true });
});
adminLibrary.patch("/:id", async (c) => {
  const d = z.object({
    name: fields.name.optional(), description: fields.description.optional(), category: fields.category.optional(), tags: fields.tags.optional(),
    active: z.boolean().optional(), ai: z.boolean().optional(),
    /** false: approved for everyone (a sound made with a video). */
    review: z.literal(false).optional(),
  }).parse(await c.req.json());
  await row(c.env, c.req.param("id"));
  if (d.review === false) await c.env.DB.prepare("UPDATE library_items SET review=0,made_for=NULL WHERE id=?").bind(c.req.param("id")).run();
  await c.env.DB.prepare(
    "UPDATE library_items SET name=COALESCE(?,name),description=COALESCE(?,description),category=COALESCE(?,category),tags=COALESCE(?,tags),active=COALESCE(?,active),ai=COALESCE(?,ai) WHERE id=?",
  ).bind(d.name ?? null, d.description ?? null, d.category ?? null, d.tags === undefined ? null : tidyTags(d.tags), d.active === undefined ? null : Number(d.active),
    d.ai === undefined ? null : Number(d.ai), c.req.param("id")).run();
  return c.json({ ok: true, item: adminView(await row(c.env, c.req.param("id"))) });
});
adminLibrary.delete("/:id", async (c) => {
  // Videos that used it keep their rendered file; only new renders need another item.
  await c.env.DB.prepare("DELETE FROM library_items WHERE id=?").bind(c.req.param("id")).run();
  return c.json({ ok: true });
});
