import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { App, DbUser, Env } from "./types";
import { now, uid } from "./types";
import { hit, hmac, rate, safeEqual, sha } from "./security";
import { siteUrl } from "./config";
import { allowance } from "./billing";
import { canCreate, checkReferences, createVideo, newVideoCredits, videoView } from "./videos";
import { findClips, findSchema, ownedSource, SOURCE_FIELDS, sourceView } from "./highlights";
import { importLink } from "./imports";
import { draftVideo, type DraftRequest } from "./story";
import { nextSlot, seriesSettings } from "./series";
import { cancelScheduled } from "./publishing";
import { serveObject } from "./storage";
import { templateIds, templates, type TemplateId } from "../shared/templates";
import { storyStyleIds, storyStyles } from "../shared/story";
import { voiceIdSchema } from "../shared/voices";
import { activeVoices } from "./voices";
import { languageCodes, languages } from "../shared/series";
import { PRODUCT } from "../shared/brand";
import { specSchema } from "../shared/formats";
import { captionStyles } from "../shared/captions";
import { layoutChoiceIds, MOMENT_COUNTS, momentLengthIds, momentSpec, type LayoutChoice, type Moment } from "../shared/highlights";

// API access: personal API keys (only a SHA-256 is stored), a small REST API (/api/v1) and an MCP server (/mcp,
// Streamable HTTP, JSON-RPC 2.0) so AI assistants can make and fetch videos — and clips of the owner's long videos —
// for their owner. Both act as the key's owner with the same credits, limits and checks as the app; nothing here
// bypasses billing.

export const apiKeys = new Hono<App>();
const KEY_PREFIX = "hss_";
const MAX_KEYS = 10;

apiKeys.get("/", async (c) => {
  const rows = await c.env.DB.prepare("SELECT id,name,prefix,last_used_at AS lastUsedAt,created_at AS createdAt FROM api_keys WHERE user_id=? ORDER BY created_at DESC")
    .bind(c.get("user").id).all();
  return c.json({ keys: rows.results });
});
/** A new key: shown once, never again. */
apiKeys.post("/", async (c) => {
  const user = c.get("user");
  await rate(c, "api-key", 10, 3600, user.id);
  if (!user.verified) throw new HTTPException(403, { message: "Confirm your email before creating API keys." });
  const { name } = z.object({ name: z.string().trim().min(1).max(60) }).parse(await c.req.json());
  const count = (await c.env.DB.prepare("SELECT COUNT(*) AS n FROM api_keys WHERE user_id=?").bind(user.id).first<{ n: number }>())?.n || 0;
  if (count >= MAX_KEYS) throw new HTTPException(400, { message: `You can have ${MAX_KEYS} API keys. Delete one first.` });
  const secret = KEY_PREFIX + Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, "0")).join("");
  const id = uid();
  await c.env.DB.prepare("INSERT INTO api_keys(id,user_id,name,key_hash,prefix,created_at) VALUES (?,?,?,?,?,?)")
    .bind(id, user.id, name, await sha(secret), secret.slice(0, 7), now()).run();
  return c.json({ key: { id, name, prefix: secret.slice(0, 7), createdAt: now() }, secret }, 201);
});
apiKeys.delete("/:id", async (c) => {
  const r = await c.env.DB.prepare("DELETE FROM api_keys WHERE id=? AND user_id=?").bind(c.req.param("id"), c.get("user").id).run();
  if (!r.meta.changes) throw new HTTPException(404, { message: "API key not found." });
  return c.json({ ok: true });
});

/** The key's owner, from `Authorization: Bearer hss_…`; 401 otherwise. */
async function keyUser(c: Context<App>): Promise<DbUser> {
  const header = c.req.header("Authorization") || "";
  const secret = /^Bearer\s+(hss_[0-9a-f]{48})$/i.exec(header.trim())?.[1];
  if (!secret) throw new HTTPException(401, { message: "Send your API key as: Authorization: Bearer hss_…" });
  const row = await c.env.DB.prepare("SELECT k.id AS key_id,k.last_used_at,u.* FROM api_keys k JOIN users u ON u.id=k.user_id WHERE k.key_hash=?")
    .bind(await sha(secret)).first<DbUser & { key_id: string; last_used_at: number | null }>();
  if (!row) throw new HTTPException(401, { message: "This API key isn't valid. Create a new one in Settings." });
  // At most one write a minute per key.
  if (!row.last_used_at || row.last_used_at < now() - 60) await c.env.DB.prepare("UPDATE api_keys SET last_used_at=? WHERE id=?").bind(now(), row.key_id).run();
  const { key_id: _k, last_used_at: _l, ...user } = row;
  return user as DbUser;
}

/** A download link for a made video that works without a session for an hour (for assistants and scripts). */
async function signedFile(env: Env, videoId: string, assetId: string) {
  // Signed with the server's secret only: without one there are no links (never a guessable signature).
  if (!env.TOKEN_ENCRYPTION_KEY) return null;
  const exp = now() + 3600;
  const sig = await hmac(env.TOKEN_ENCRYPTION_KEY, `file:${videoId}:${assetId}:${exp}`);
  return `${siteUrl(env)}/api/v1/files/${videoId}?exp=${exp}&sig=${sig}`;
}
async function videoOut(env: Env, v: any) {
  const view = videoView(v);
  return {
    id: view.id, title: view.title, topic: view.topic, status: view.renderStatus, phase: view.phase, error: view.renderError,
    seriesId: view.seriesId, duration: view.duration, createdAt: view.createdAt,
    url: `${siteUrl(env)}/app/videos/${view.id}`,
    download: view.renderStatus === "ready" && view.videoAssetId ? await signedFile(env, view.id, view.videoAssetId) : null,
  };
}

const createSchema = z.object({
  type: z.enum(templateIds as [TemplateId, ...TemplateId[]]).default("story"),
  prompt: z.string().trim().max(600).default(""),
  script: z.string().trim().max(2400).default(""),
  title: z.string().trim().max(140).default(""),
  animal: z.string().trim().max(60).default(""),
  object: z.string().trim().max(60).default(""),
  seconds: z.number().int().min(15).max(160).default(45),
  language: z.enum(languageCodes as [string, ...string[]]).default("en"),
  voice: voiceIdSchema.optional(),
  style: z.enum(storyStyleIds as [string, ...string[]]).optional(),
});
/** Writes and makes a video for the key's owner (credits charged as in the app). */
async function makeVideo(env: Env, user: DbUser, input: unknown) {
  const d = createSchema.parse(input);
  if ((await hit(env, "api-videos", 3600, user.id)) > 30) throw new HTTPException(429, { message: "That's a lot of videos for one hour. Try again later." });
  const recent = (await env.DB.prepare("SELECT title FROM videos WHERE user_id=? AND title<>'' ORDER BY created_at DESC LIMIT 20").bind(user.id).all<{ title: string }>()).results.map((r) => r.title);
  const spec = await draftVideo(env, {
    template: d.type, prompt: d.prompt, script: d.script, title: d.title, mashup: { animal: d.animal, object: d.object },
    seconds: d.seconds, language: d.language, voiceId: d.voice, style: d.style,
  } as DraftRequest, recent);
  const a = await allowance(env, user);
  canCreate(a, await newVideoCredits(env, user.id, spec));
  const made = await createVideo(env, user, spec, a, uid());
  const v = await env.DB.prepare("SELECT * FROM videos WHERE id=?").bind(made.id).first<any>();
  return { ...(await videoOut(env, v)), credits: made.credits };
}
async function getVideo(env: Env, user: DbUser, id: string) {
  const v = await env.DB.prepare("SELECT v.*,(SELECT phase FROM runs r WHERE r.video_id=v.id AND r.status IN ('queued','running') LIMIT 1) AS phase FROM videos v WHERE v.id=? AND v.user_id=?")
    .bind(id, user.id).first<any>();
  if (!v) throw new HTTPException(404, { message: "Video not found." });
  return videoOut(env, v);
}
async function listVideos(env: Env, user: DbUser, limit = 20) {
  const rows = (await env.DB.prepare("SELECT * FROM videos WHERE user_id=? ORDER BY created_at DESC LIMIT ?").bind(user.id, Math.min(50, Math.max(1, limit))).all<any>()).results;
  return Promise.all(rows.map((v) => videoOut(env, v)));
}
async function listSeries(env: Env, user: DbUser) {
  const rows = (await env.DB.prepare("SELECT * FROM series WHERE user_id=? ORDER BY created_at DESC").bind(user.id).all<any>()).results;
  return rows.map((s) => {
    const settings = seriesSettings(s);
    return { id: s.id, name: s.name, type: s.template, status: s.status, nextSlot: s.next_slot ? new Date(s.next_slot * 1000).toISOString() : null, seconds: settings.seconds, language: settings.language };
  });
}
async function setSeriesStatus(env: Env, user: DbUser, id: string, status: "active" | "paused") {
  const s = await env.DB.prepare("SELECT * FROM series WHERE id=? AND user_id=?").bind(id, user.id).first<any>();
  if (!s) throw new HTTPException(404, { message: "Series not found." });
  // Resuming starts again from the next slot from now, as in the app.
  const next = status === "active" && s.status !== "active" ? nextSlot(seriesSettings(s), now() + 600) : s.next_slot;
  await env.DB.prepare("UPDATE series SET status=?,next_slot=?,failures=0,blocked=NULL,updated_at=? WHERE id=?").bind(status, next, now(), id).run();
  if (status === "paused") await cancelScheduled(env, user.id, id);
  return { id, status };
}
async function account(env: Env, user: DbUser) {
  const a = await allowance(env, user);
  return { plan: a.plan, credits: { left: Math.max(0, a.limit - a.used), used: a.used, total: a.limit }, renewsAt: a.renewsAt ? new Date(a.renewsAt * 1000).toISOString() : null };
}
// Clips of long videos ------------------------------------------------------------------------------------------------
/** A long video as the API shows it: where it stands, what finding clips in it costs, and the moments found. */
function sourceOut(s: ReturnType<typeof sourceView>) {
  return {
    id: s.id, name: s.name, duration: s.duration, status: s.status, importing: s.importing, error: s.status === "failed" ? s.error : s.momentsError,
    speech: s.speech, transcribeCredits: s.transcribeCredits,
    searching: !!s.wanted || s.speech === "pending", clips: s.clips,
    // score: the moment's virality score; reactions: the times people laughed, applauded or cheered in it.
    moments: s.moments.map((m, index) => ({
      index, title: m.title, start: m.start, end: m.end, score: m.score, reactions: m.reactions ?? 0, why: m.why, caption: m.caption, hashtags: m.hashtags,
    })),
  };
}
async function listSources(env: Env, user: DbUser) {
  const rows = (await env.DB.prepare(`SELECT ${SOURCE_FIELDS} FROM media_assets a WHERE a.user_id=? AND a.kind='upload' AND a.mime LIKE 'video/%' AND a.status<>'uploading' ORDER BY a.created_at DESC LIMIT 50`)
    .bind(user.id).all<any>()).results;
  return rows.map((a) => sourceOut(sourceView(a)));
}
const getSource = async (env: Env, user: DbUser, id: string) => sourceOut(sourceView(await ownedSource(env, user.id, id)));
/** Imports a video from a link (server/imports.ts); it is downloaded and checked in the background. */
async function importSource(env: Env, user: DbUser, input: any) {
  const d = z.object({ url: z.string().trim().min(1).max(2000) }).parse(input);
  return getSource(env, user, await importLink(env, user, d.url));
}
async function findIn(env: Env, user: DbUser, id: string, input: any) {
  const d = findSchema.parse({ ...input, idempotencyKey: input?.idempotencyKey || uid() });
  const { status, body } = await findClips(env, user, id, d);
  return { ...sourceOut(body.source), ...("credits" in body && { credits: body.credits }), searching: status === 202 };
}
const clipSchema = z.object({
  source: z.uuid(),
  /** A moment found in it (its index), or seconds `start` to `end`. */
  moment: z.number().int().min(0).optional(), start: z.number().min(0).optional(), end: z.number().min(0).optional(),
  title: z.string().trim().max(100).optional(),
  layout: z.enum(layoutChoiceIds as [LayoutChoice, ...LayoutChoice[]]).default("follow"),
  style: z.enum(captionStyles).default("bold"),
  captions: z.boolean().default(true), hookTitle: z.boolean().default(true), removePauses: z.boolean().default(true),
});
/** Makes a clip of a moment of one of the owner's videos (1 credit per started minute). */
async function makeClip(env: Env, user: DbUser, input: unknown) {
  const d = clipSchema.parse(input);
  if ((await hit(env, "api-videos", 3600, user.id)) > 30) throw new HTTPException(429, { message: "That's a lot of videos for one hour. Try again later." });
  const s = sourceView(await ownedSource(env, user.id, d.source));
  let m: Moment | undefined = d.moment !== undefined ? s.moments[d.moment] : undefined;
  if (d.moment !== undefined && !m) throw new HTTPException(404, { message: "Moment not found. Find clips in the video first." });
  if (!m) {
    if (d.start === undefined || d.end === undefined) throw new HTTPException(400, { message: "Give a moment's index, or its start and end in seconds." });
    m = { title: d.title || "Clip", why: "", caption: "", hashtags: [], start: d.start, end: d.end, text: "", score: 0, scores: { hook: 1, payoff: 1, clarity: 1, energy: 1 } };
  }
  const moment = { ...m, title: d.title || m.title };
  const spec = specSchema.parse({
    ...momentSpec(s.id, moment, { layout: d.layout, style: d.style, captions: d.captions, title: d.hookTitle, cuts: d.removePauses, fillers: d.removePauses }),
    moment: d.moment !== undefined ? { score: m.score, why: m.why } : null,
  });
  await checkReferences(env, user.id, spec);
  const a = await allowance(env, user);
  canCreate(a, await newVideoCredits(env, user.id, spec));
  const made = await createVideo(env, user, spec, a, uid());
  const v = await env.DB.prepare("SELECT * FROM videos WHERE id=?").bind(made.id).first<any>();
  return { ...(await videoOut(env, v)), credits: made.credits };
}

const videoTypes = () => templateIds.map((id) => ({ id, name: templates[id].name, kind: templates[id].kind, about: templates[id].short, example: templates[id].examples[0] }));

/** REST: /api/v1 (bearer key; no session, no Origin check). */
export const restApi = new Hono<App>();
restApi.use("*", async (c, next) => {
  if (c.req.path.startsWith("/api/v1/files/")) return next();
  c.set("user", await keyUser(c));
  await next();
});
restApi.get("/me", async (c) => c.json(await account(c.env, c.get("user"))));
restApi.get("/types", async (c) => c.json({ types: videoTypes(), styles: storyStyleIds, voices: (await activeVoices(c.env)).map((v) => v.id), languages: languages.map((l) => l[0]) }));
restApi.get("/videos", async (c) => c.json({ videos: await listVideos(c.env, c.get("user"), Number(c.req.query("limit")) || 20) }));
restApi.post("/videos", async (c) => c.json({ video: await makeVideo(c.env, c.get("user"), await c.req.json()) }, 201));
restApi.get("/videos/:id", async (c) => c.json({ video: await getVideo(c.env, c.get("user"), c.req.param("id")) }));
restApi.get("/series", async (c) => c.json({ series: await listSeries(c.env, c.get("user")) }));
restApi.get("/sources", async (c) => c.json({ sources: await listSources(c.env, c.get("user")) }));
restApi.post("/sources", async (c) => c.json({ source: await importSource(c.env, c.get("user"), await c.req.json()) }, 202));
restApi.get("/sources/:id", async (c) => c.json({ source: await getSource(c.env, c.get("user"), c.req.param("id")) }));
restApi.post("/sources/:id/find", async (c) => {
  const source = await findIn(c.env, c.get("user"), c.req.param("id"), await c.req.json());
  return c.json({ source }, source.searching ? 202 : 200);
});
restApi.post("/clips", async (c) => c.json({ video: await makeClip(c.env, c.get("user"), await c.req.json()) }, 201));
restApi.post("/series/:id/:action{pause|resume}", async (c) =>
  c.json({ series: await setSeriesStatus(c.env, c.get("user"), c.req.param("id"), c.req.param("action") === "pause" ? "paused" : "active") }));
/** A signed download link (made by videoOut): the made video's MP4. */
restApi.get("/files/:id", async (c) => {
  const exp = Number(c.req.query("exp")), sig = c.req.query("sig") || "";
  const v = await c.env.DB.prepare("SELECT v.video_asset,v.title,a.object_key FROM videos v JOIN media_assets a ON a.id=v.video_asset WHERE v.id=?").bind(c.req.param("id")).first<any>();
  const expected = v && Number.isInteger(exp) && c.env.TOKEN_ENCRYPTION_KEY ? await hmac(c.env.TOKEN_ENCRYPTION_KEY, `file:${c.req.param("id")}:${v.video_asset}:${exp}`) : "";
  if (!v || !(exp > now()) || !expected || !safeEqual(expected, sig)) throw new HTTPException(404, { message: "This link has expired. Ask for the video again." });
  const response = await serveObject(c.env, v.object_key, c.req.header("Range"), "private, no-store");
  response.headers.set("Content-Disposition", `attachment; filename="${(v.title || "video").replace(/[^\w.\- ]+/g, "_").slice(0, 80)}.mp4"`);
  return response;
});

// MCP --------------------------------------------------------------------------------------------------------------
export const MCP_PROTOCOL = "2025-06-18";
const tools = [
  {
    name: "list_video_types",
    description: `The video types (faceless styles) ${PRODUCT.name} can make, with art styles, voices and languages.`,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "create_video",
    description: "Writes and makes a short faceless video (vertical 9:16, narrated, subtitled). Costs credits: 1 per started 30 seconds. Returns the video; poll get_video until status is 'ready' to get the download link.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        type: { type: "string", enum: templateIds, description: "Video type (see list_video_types). Default: story." },
        prompt: { type: "string", description: "Topic, idea or scenario." },
        script: { type: "string", description: "For type 'script': the exact words to narrate." },
        title: { type: "string", description: "For type 'storytime': the title question." },
        animal: { type: "string", description: "For type 'mashup': the animal." },
        object: { type: "string", description: "For type 'mashup': the object." },
        seconds: { type: "integer", minimum: 15, maximum: 160, description: "Length of narration in seconds (default 45)." },
        language: { type: "string", enum: languageCodes, description: "Narration language (default en)." },
        voice: { type: "string", description: "A voice id from list_video_types (default: the type's voice)." },
        style: { type: "string", enum: storyStyleIds, description: "Art style of the pictures." },
      },
    },
  },
  {
    name: "get_video",
    description: "A video's status ('queued', 'running', 'ready', 'failed'), title and, when ready, a download link valid for one hour.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
  },
  {
    name: "list_videos",
    description: "The most recent videos, newest first.",
    inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 50 } }, additionalProperties: false },
  },
  {
    name: "list_series",
    description: "The autopilot series: what each makes and when its next episode is due.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "set_series_status",
    description: "Pauses or resumes a series.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, status: { type: "string", enum: ["active", "paused"] } }, required: ["id", "status"], additionalProperties: false },
  },
  {
    name: "list_long_videos",
    description: "The owner's uploaded videos (podcasts, interviews, streams) that clips can be cut from: length, whether their speech is known, what transcribing costs (transcribeCredits), and the moments found so far.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "import_video",
    description: "Imports one of the owner's videos from a link, to find clips in it: a direct link to an MP4, MOV or WebM file, or a Dropbox or Google Drive link anyone can open. A YouTube link works only for a video on the owner's own connected channel, when YouTube import is available on their plan; other video platform pages can't be imported. The video is downloaded and checked in the background: call get_long_video until its status is 'ready' (or 'failed', with the error).",
    inputSchema: { type: "object", properties: { url: { type: "string", description: "https link to the video file or share link." } }, required: ["url"], additionalProperties: false },
  },
  {
    name: "find_clips",
    description: "Finds the best stand-alone moments in one of the owner's videos, each with a virality score of 10–99: an AI estimate of how well it works as a short on its own (hook, payoff, clarity, energy, and the laughter or applause heard in it), not a prediction of views. Free when its speech is known or it is up to 10 minutes long; a longer video is transcribed first for transcribeCredits (pass them as credits to agree to the price). When 'searching' is true, call list_long_videos or get_long_video later for the moments.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["source"],
      properties: {
        source: { type: "string", description: "The video's id (see list_long_videos)." },
        count: { type: "integer", enum: [...MOMENT_COUNTS], description: "How many moments (default 5)." },
        length: { type: "string", enum: momentLengthIds, description: "short 15–30 s, medium 30–60 s (default), long 60–90 s." },
        focus: { type: "string", description: "Optional: what the moments should be about." },
        credits: { type: "integer", description: "For a video over 10 minutes not transcribed yet: its transcribeCredits." },
      },
    },
  },
  {
    name: "get_long_video",
    description: "One of the owner's videos with the moments found in it (index, times, title, virality score, reactions heard).",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
  },
  {
    name: "make_clip",
    description: "Makes a vertical clip of a moment (by its index from find_clips, or start and end in seconds): framed in a layout, with captions and a hook title. Costs 1 credit per started minute. Poll get_video until it is ready.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["source"],
      properties: {
        source: { type: "string" }, moment: { type: "integer", minimum: 0 }, start: { type: "number" }, end: { type: "number" },
        title: { type: "string", description: "Hook title and the clip's name (default: the moment's)." },
        layout: { type: "string", enum: layoutChoiceIds, description: "follow (default: speaker focus), speakers, screen, crop or fit." },
        style: { type: "string", enum: captionStyles, description: "Caption style (default bold)." },
        captions: { type: "boolean" }, hookTitle: { type: "boolean" }, removePauses: { type: "boolean" },
      },
    },
  },
  {
    name: "get_account",
    description: "The plan and the credits left this month.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
] as const;

type Rpc = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: any };
const result = (id: Rpc["id"], value: unknown) => ({ jsonrpc: "2.0", id: id ?? null, result: value });
const rpcError = (id: Rpc["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

async function callTool(env: Env, user: DbUser, name: string, args: any) {
  switch (name) {
    case "list_video_types":
      return {
        types: videoTypes(), styles: storyStyleIds.map((s) => ({ id: s, name: storyStyles[s].name })),
        voices: (await activeVoices(env)).map((v) => ({ id: v.id, name: v.name, description: v.description, tone: v.description, gender: v.gender, accent: v.accent })),
        languages: languages.map(([code, n]) => ({ code, name: n })),
      };
    case "create_video": return makeVideo(env, user, args || {});
    case "get_video": return getVideo(env, user, String(args?.id || ""));
    case "list_videos": return { videos: await listVideos(env, user, Number(args?.limit) || 20) };
    case "list_series": return { series: await listSeries(env, user) };
    case "set_series_status": return setSeriesStatus(env, user, String(args?.id || ""), args?.status === "paused" ? "paused" : "active");
    case "list_long_videos": return { videos: await listSources(env, user) };
    case "import_video": return importSource(env, user, args || {});
    case "find_clips": return findIn(env, user, String(args?.source || ""), args || {});
    case "get_long_video": return getSource(env, user, String(args?.id || ""));
    case "make_clip": return makeClip(env, user, args || {});
    case "get_account": return account(env, user);
    default: throw new HTTPException(404, { message: `Unknown tool: ${name}` });
  }
}
async function handle(env: Env, user: DbUser, m: Rpc) {
  switch (m.method) {
    case "initialize":
      return result(m.id, {
        protocolVersion: typeof m.params?.protocolVersion === "string" ? m.params.protocolVersion : MCP_PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: PRODUCT.slug, version: "1.0.0" },
        instructions: `Make faceless short videos with ${PRODUCT.name}: call list_video_types, then create_video, then get_video until it is ready. To clip the owner's long videos: list_long_videos (or import_video from a link), find_clips, then make_clip.`,
      });
    case "ping": return result(m.id, {});
    case "tools/list": return result(m.id, { tools });
    case "tools/call": {
      try {
        const value = await callTool(env, user, String(m.params?.name || ""), m.params?.arguments);
        return result(m.id, { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: value, isError: false });
      } catch (e) {
        // A tool's failure is its result, in plain words (never internals).
        const message = e instanceof HTTPException ? e.message : e instanceof z.ZodError ? `Invalid arguments: ${e.issues.map((i) => i.path.join(".") || i.message).slice(0, 5).join(", ")}` : "Something went wrong. Please try again.";
        if (!(e instanceof HTTPException) && !(e instanceof z.ZodError)) console.error("MCP tool failed", { tool: m.params?.name, error: (e as Error)?.name });
        return result(m.id, { content: [{ type: "text", text: message }], isError: true });
      }
    }
    default: return rpcError(m.id, -32601, `Method not found: ${m.method}`);
  }
}
/** The MCP endpoint: JSON-RPC requests (one or a batch) answered as JSON; notifications get 202 and no body. */
export const mcp = new Hono<App>();
mcp.post("/", async (c) => {
  let user: DbUser;
  try { user = await keyUser(c); }
  catch (e) {
    c.header("WWW-Authenticate", 'Bearer realm="mcp"');
    return c.json(rpcError(null, -32001, (e as Error).message), 401);
  }
  await rate(c, "mcp", 300, 3600, user.id);
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json(rpcError(null, -32700, "Parse error"), 400); }
  const messages = (Array.isArray(body) ? body : [body]) as Rpc[];
  if (!messages.length || messages.length > 20 || messages.some((m) => !m || m.jsonrpc !== "2.0" || typeof m.method !== "string"))
    return c.json(rpcError(null, -32600, "Invalid request"), 400);
  const answers = [];
  for (const m of messages) if (m.id !== undefined && m.id !== null) answers.push(await handle(c.env, user, m));
  if (!answers.length) return c.body(null, 202);
  c.header("MCP-Protocol-Version", MCP_PROTOCOL);
  return c.json(Array.isArray(body) ? answers : answers[0]);
});
// No server-initiated stream: GET is not offered (Streamable HTTP allows that), DELETE has no session to end.
mcp.get("/", (c) => c.json(rpcError(null, -32000, "Use POST for MCP requests."), 405));
mcp.delete("/", (c) => c.body(null, 405));
