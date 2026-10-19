import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { App, Env } from "./types";
import { now, uid } from "./types";
import { rate } from "./security";
import { extOf, serveObject } from "./storage";
import { ProviderError } from "./providers/http";
import { deleteAvatarVideo, fetchHeyGenImage, getLook, heygenEnabled, listStockLooks, type LookSummary } from "./providers/heygen";
import { PRESENTER_ENGINES, presenterQualities, type Avatar, type PresenterQuality } from "../shared/presenter";

// On-screen presenters' avatars (table `avatars`, migrations/0008_avatars.sql), ported from rech-bg's avatar library
// (server/avatars.ts there): administrators add HeyGen's stock avatars (Admin → Presenters, after confirming HeyGen's
// terms let them offer them) or link one of the HeyGen account's own avatars by its ID. Each keeps a copy of its
// preview picture; the HeyGen avatar behind it stays on the server. The engines an avatar supports decide which
// presenter qualities it is offered in. Hidden avatars are not offered; videos that have one keep their presenter video.

type AvatarRow = {
  id: string; look_id: string; name: string; gender: "female" | "male" | ""; engines: string; preview_key: string | null;
  stock: number; active: number; sort: number; created_at: number; updated_at: number;
};
const enginesOf = (r: Pick<AvatarRow, "engines">) => {
  try {
    const list = JSON.parse(r.engines);
    return Array.isArray(list) ? list.filter((e): e is string => typeof e === "string") : [];
  } catch {
    return [];
  }
};
/** The qualities an avatar's engines allow (an avatar whose engines HeyGen did not list: regular only). */
export function qualitiesOf(engines: string[]): PresenterQuality[] {
  if (!engines.length) return ["regular"];
  return presenterQualities.filter((q) => engines.includes(PRESENTER_ENGINES[q]));
}
const avatarView = (r: AvatarRow): Avatar => ({
  id: r.id, name: r.name, gender: r.gender, preview: r.preview_key ? `/api/public/avatars/${r.id}/preview` : null, qualities: qualitiesOf(enginesOf(r)),
});
/** An avatar a video asks for (offered or not: a video keeps its presenter), with its HeyGen avatar. */
export async function avatarFor(env: Env, id: string) {
  const r = await env.DB.prepare("SELECT * FROM avatars WHERE id=?").bind(id).first<AvatarRow>();
  return r ? { ...avatarView(r), lookId: r.look_id, active: !!r.active } : null;
}

/** Unauthenticated: the avatars offered (Create, the editor) and their previews. */
export const publicAvatars = new Hono<App>();
publicAvatars.get("/api/public/avatars", async (c) => {
  c.header("Cache-Control", "public, max-age=60");
  const rows = (await c.env.DB.prepare("SELECT * FROM avatars WHERE active=1 ORDER BY sort, name").all<AvatarRow>()).results;
  // Offered only when the presenter service is set up, and only avatars it can animate in some quality.
  return c.json({ avatars: heygenEnabled(c.env) ? rows.map(avatarView).filter((a) => a.qualities.length) : [] });
});
publicAvatars.get("/api/public/avatars/:id/preview", async (c) => {
  const r = await c.env.DB.prepare("SELECT preview_key FROM avatars WHERE id=?").bind(c.req.param("id")).first<{ preview_key: string | null }>();
  if (!r?.preview_key) throw new HTTPException(404, { message: "Not found." });
  return serveObject(c.env, r.preview_key, null, "public, max-age=86400");
});

// Admin → Presenters (mounted under the administrators' routes) ------------------------------------------------------

const lookId = z.string().trim().regex(/^[a-zA-Z0-9_-]{1,160}$/, "Paste a HeyGen avatar ID (letters, digits, - and _).");
function requireHeyGen(env: Env) {
  if (!heygenEnabled(env)) throw new HTTPException(503, { message: "Set HEYGEN_API_KEY first: avatars come from your HeyGen account." });
}
const heygenFailure = (e: unknown) => {
  if (e instanceof HTTPException) return e;
  const code = e instanceof ProviderError ? e.code : "";
  return new HTTPException(502, {
    message: code === "AVATAR_UNAVAILABLE" ? "HeyGen refused the API key, or the account has no API credits left."
      : code === "AVATAR_BUSY" ? "HeyGen is busy. Try again in a minute." : "HeyGen didn't answer as expected. Check the avatar ID and try again.",
  });
};
/** How many videos have each avatar as their presenter (a used avatar is hidden, not deleted). */
async function avatarUsage(env: Env) {
  const rows = (await env.DB.prepare("SELECT json_extract(spec,'$.presenter.avatarId') AS avatar,COUNT(*) AS n FROM videos WHERE json_extract(spec,'$.presenter.avatarId') IS NOT NULL GROUP BY 1")
    .all<{ avatar: string; n: number }>()).results;
  return new Map(rows.map((r) => [r.avatar, r.n]));
}
const adminView = (r: AvatarRow, usage = 0) => ({
  ...avatarView(r), lookId: r.look_id, engines: enginesOf(r), stock: !!r.stock, active: !!r.active, sort: r.sort, usage, createdAt: r.created_at,
});
/** Adds a HeyGen avatar with a copy of its preview picture, offered at once at the end of the list. */
async function addAvatar(env: Env, look: LookSummary & { id: string }, stock: boolean) {
  if (await env.DB.prepare("SELECT 1 FROM avatars WHERE look_id=?").bind(look.id).first())
    throw new HTTPException(409, { message: "This HeyGen avatar is already in the list." });
  if (look.status !== "completed") throw new HTTPException(400, { message: "This HeyGen avatar isn't ready yet. Try again when HeyGen has finished it." });
  if (look.engines.length && !qualitiesOf(look.engines).length) throw new HTTPException(400, { message: "HeyGen can't animate this avatar with its Avatar IV or V engines." });
  const id = uid();
  let previewKey: string | null = null;
  if (look.previewImageUrl) {
    try {
      const image = await fetchHeyGenImage(look.previewImageUrl);
      previewKey = `avatars/${id}/preview.${extOf(image.mime)}`;
      await env.MEDIA.put(previewKey, image.bytes, { httpMetadata: { contentType: image.mime } });
    } catch {
      // A missing preview is shown as the avatar's initial; it can be added again later.
      previewKey = null;
    }
  }
  const last = await env.DB.prepare("SELECT COALESCE(MAX(sort),0) AS n FROM avatars").first<{ n: number }>();
  await env.DB.prepare("INSERT INTO avatars(id,look_id,name,gender,engines,preview_key,stock,active,sort,created_at,updated_at) VALUES (?,?,?,?,?,?,?,1,?,?,?)")
    .bind(id, look.id, look.name || "Presenter", look.gender, JSON.stringify(look.engines), previewKey, stock ? 1 : 0, (last?.n || 0) + 10, now(), now()).run();
  return adminView((await env.DB.prepare("SELECT * FROM avatars WHERE id=?").bind(id).first<AvatarRow>())!);
}

export const adminAvatars = new Hono<App>();
adminAvatars.get("/", async (c) => {
  const rows = (await c.env.DB.prepare("SELECT * FROM avatars ORDER BY active DESC, sort, name").all<AvatarRow>()).results;
  const usage = await avatarUsage(c.env);
  return c.json({ avatars: rows.map((r) => adminView(r, usage.get(r.id))), enabled: heygenEnabled(c.env) });
});
/**
 * One page of HeyGen's stock avatars, each with the qualities it could be offered in (none: HeyGen can't animate it
 * with Avatar IV or V) and marked when it is already in the list (shown or hidden).
 */
adminAvatars.get("/stock", async (c) => {
  requireHeyGen(c.env);
  const page = z.string().max(1000).optional().parse(c.req.query("page") || undefined);
  let result;
  try { result = await listStockLooks(c.env, page); } catch (e) { throw heygenFailure(e); }
  const added = new Map((await c.env.DB.prepare("SELECT id,look_id FROM avatars").all<{ id: string; look_id: string }>()).results.map((r) => [r.look_id, r.id]));
  return c.json({
    looks: result.looks.filter((l) => l.status === "completed").map((l) => ({
      id: l.id, name: l.name, gender: l.gender, tags: l.tags, qualities: qualitiesOf(l.engines), added: added.get(l.id) ?? null,
      image: l.previewImageUrl ? `/api/admin/avatars/stock/image?src=${encodeURIComponent(l.previewImageUrl)}` : null,
    })),
    nextPage: result.nextToken,
  });
});
/** A stock avatar's preview, through us: the page's security policy allows only our own images. */
adminAvatars.get("/stock/image", async (c) => {
  let image;
  try { image = await fetchHeyGenImage(c.req.query("src") || ""); } catch { throw new HTTPException(404, { message: "Not found." }); }
  return new Response(image.bytes, { headers: { "Content-Type": image.mime, "Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff" } });
});
const rights = z.boolean().default(false).refine((v) => v, "Confirm that your HeyGen plan lets you offer this avatar to your users.");
/** Adds one of HeyGen's stock avatars (as listed on the page the administrator picked it from). */
adminAvatars.post("/stock", async (c) => {
  await rate(c, "avatar-add", 120, 3600, c.get("user").id);
  requireHeyGen(c.env);
  const d = z.object({ lookId, page: z.string().max(1000).nullish(), rightsConfirmed: rights }).parse(await c.req.json());
  let look: (LookSummary & { id: string }) | undefined;
  try { look = (await listStockLooks(c.env, d.page || undefined)).looks.find((l) => l.id === d.lookId); } catch { /* Asked for by itself below. */ }
  if (!look) try { look = await getLook(c.env, d.lookId); } catch (e) { throw heygenFailure(e); }
  return c.json({ avatar: await addAvatar(c.env, look, true) }, 201);
});
/** Links one of the HeyGen account's own avatars (made in HeyGen, e.g. from a consenting person's video) by its ID. */
adminAvatars.post("/link", async (c) => {
  await rate(c, "avatar-add", 120, 3600, c.get("user").id);
  requireHeyGen(c.env);
  const d = z.object({ lookId, rightsConfirmed: rights }).parse(await c.req.json());
  let look;
  try { look = await getLook(c.env, d.lookId); } catch (e) { throw heygenFailure(e); }
  return c.json({ avatar: await addAvatar(c.env, look, false) }, 201);
});
adminAvatars.patch("/:id", async (c) => {
  const d = z.object({
    name: z.string().trim().min(1).max(60).optional(), gender: z.enum(["female", "male", ""]).optional(),
    active: z.boolean().optional(), sort: z.number().int().min(0).max(100000).optional(),
  }).parse(await c.req.json());
  const r = await c.env.DB.prepare("SELECT * FROM avatars WHERE id=?").bind(c.req.param("id")).first<AvatarRow>();
  if (!r) throw new HTTPException(404, { message: "Avatar not found." });
  await c.env.DB.prepare("UPDATE avatars SET name=?,gender=?,active=?,sort=?,updated_at=? WHERE id=?")
    .bind(d.name ?? r.name, d.gender ?? r.gender, d.active === undefined ? r.active : Number(d.active), d.sort ?? r.sort, now(), r.id).run();
  return c.json({ avatar: adminView((await c.env.DB.prepare("SELECT * FROM avatars WHERE id=?").bind(r.id).first<AvatarRow>())!) });
});
/** Reads the avatar's engines from HeyGen again (they decide the qualities offered). */
adminAvatars.post("/:id/check", async (c) => {
  requireHeyGen(c.env);
  const r = await c.env.DB.prepare("SELECT * FROM avatars WHERE id=?").bind(c.req.param("id")).first<AvatarRow>();
  if (!r) throw new HTTPException(404, { message: "Avatar not found." });
  let look;
  try { look = await getLook(c.env, r.look_id); } catch (e) { throw heygenFailure(e); }
  await c.env.DB.prepare("UPDATE avatars SET engines=?,updated_at=? WHERE id=?").bind(JSON.stringify(look.engines), now(), r.id).run();
  return c.json({ avatar: adminView((await c.env.DB.prepare("SELECT * FROM avatars WHERE id=?").bind(r.id).first<AvatarRow>())!) });
});
adminAvatars.delete("/:id", async (c) => {
  const r = await c.env.DB.prepare("SELECT id FROM avatars WHERE id=?").bind(c.req.param("id")).first<{ id: string }>();
  if (!r) throw new HTTPException(404, { message: "Avatar not found." });
  const used = (await avatarUsage(c.env)).get(r.id) || 0;
  if (used) throw new HTTPException(409, { message: `${used} video${used === 1 ? " has" : "s have"} this presenter. Hide it instead: they keep it, and nobody new can choose it.` });
  await c.env.DB.prepare("DELETE FROM avatars WHERE id=?").bind(r.id).run();
  return c.json({ ok: true });
});

// HeyGen's copies of presenter videos -----------------------------------------------------------------------------

/** HeyGen's copy of a presenter video, deleted once ours is saved: queued first, so a failed delete is retried. */
export async function forgetHeyGenVideo(env: Env, videoId: string) {
  const task = `heygen/video/${videoId}`;
  await env.DB.prepare("INSERT OR IGNORE INTO cleanup_tasks(prefix,created_at) VALUES (?,?)").bind(task, now()).run();
  try {
    await deleteAvatarVideo(env, videoId);
    await env.DB.prepare("DELETE FROM cleanup_tasks WHERE prefix=?").bind(task).run();
  } catch {
    console.error("HeyGen copy will be deleted later", { videoId });
  }
}
/** Hourly: retries the HeyGen copies not deleted yet; after two weeks the task is dropped (HeyGen's retention removes it). */
export async function deleteHeyGenCopies(env: Env) {
  if (!heygenEnabled(env)) return;
  const tasks = (await env.DB.prepare("SELECT prefix,created_at FROM cleanup_tasks WHERE prefix LIKE 'heygen/%' ORDER BY created_at LIMIT 50")
    .all<{ prefix: string; created_at: number }>()).results;
  for (const t of tasks) {
    const id = /^heygen\/video\/([a-zA-Z0-9_-]{1,160})$/.exec(t.prefix)?.[1];
    try {
      if (id) await deleteAvatarVideo(env, id);
      await env.DB.prepare("DELETE FROM cleanup_tasks WHERE prefix=?").bind(t.prefix).run();
    } catch {
      if (t.created_at < now() - 14 * 86400) {
        console.error("HeyGen copy could not be deleted; remove it in HeyGen", { task: t.prefix });
        await env.DB.prepare("DELETE FROM cleanup_tasks WHERE prefix=?").bind(t.prefix).run();
      }
    }
  }
}
