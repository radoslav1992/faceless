import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { App, Env } from "./types";
import { serveObject } from "./storage";

// The shared library people pick from and search: background music (tagged with moods), clips (storytime backgrounds,
// scenes), pictures (scenes) and sound effects (shared/sounds.ts). Administrators fill it in Admin → Library (server/routes/admin.ts) with a name, a
// description and tags people search by; items made with AI say so, and videos that use them are disclosed as AI-made.
export const library = new Hono<App>();
export const libraryKinds = ["music", "clip", "image", "sfx"] as const;
export type LibraryKind = (typeof libraryKinds)[number];
export type LibraryRow = {
  id: string; kind: LibraryKind; name: string; description: string; category: string; tags: string; object_key: string; thumb_key: string | null; mime: string;
  bytes: number; duration: number; width: number; height: number; ai: number; source_asset: string | null; active: number; created_at: number;
};
export const splitTags = (tags: string) => String(tags || "").split(",").map((t) => t.trim()).filter(Boolean);
export function libraryView(r: LibraryRow) {
  return {
    id: r.id, kind: r.kind, name: r.name, description: r.description || "", category: r.category || "", tags: splitTags(r.tags), duration: r.duration,
    width: r.width, height: r.height,
    ai: !!r.ai, url: `/api/library/${r.id}/file`,
    // A picture is its own thumbnail when it has none.
    thumb: r.thumb_key ? `/api/library/${r.id}/thumb` : r.kind === "image" ? `/api/library/${r.id}/file` : null,
  };
}

/** Text for matching: lowercase, without accents. */
const fold = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
/** The words of a search (up to 8), folded; a plural matches its singular ("waves" finds "wave"). */
export function searchTerms(q: string) {
  return fold(q).split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(0, 8).map((t) => (t.length > 3 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t));
}
/**
 * How well an item matches every term of a search (0: not every term is in its name, genre or category, description
 * or tags). Name matches count most, then the genre or category, then tags, then the description.
 */
export function searchScore(r: Pick<LibraryRow, "name" | "description" | "tags"> & { category?: string }, terms: string[]) {
  const name = fold(r.name), category = fold(r.category || ""), tags = fold(r.tags), description = fold(r.description || "");
  let score = 0;
  for (const t of terms) {
    const s = (name.includes(t) ? 4 : 0) + (category.includes(t) ? 3 : 0) + (tags.includes(t) ? 2 : 0) + (description.includes(t) ? 1 : 0);
    if (!s) return 0;
    score += s;
  }
  return score;
}
/** Library items read per search: the library is curated, so it is searched whole. */
const SEARCHED = 2000;
/**
 * Active items of these kinds matching a search (best first, else newest first) and one tag, up to `limit`; `tags`
 * lists the tags of the items matching the search (before the tag), for filters.
 */
export async function searchLibrary(env: Env, o: { kinds: readonly LibraryKind[]; q?: string; tag?: string; limit?: number }) {
  const rows = (await env.DB.prepare(`SELECT * FROM library_items WHERE active=1 AND kind IN (${o.kinds.map(() => "?").join(",")}) ORDER BY created_at DESC LIMIT ?`)
    .bind(...o.kinds, SEARCHED).all<LibraryRow>()).results;
  const terms = searchTerms(o.q || "");
  const found = terms.length
    ? rows.map((r) => ({ r, score: searchScore(r, terms) })).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).map((x) => x.r)
    : rows;
  const items = found.map(libraryView);
  const tags = [...new Set(items.flatMap((i) => i.tags))].sort((a, b) => a.localeCompare(b));
  const tag = o.tag?.trim().toLowerCase();
  return { items: (tag ? items.filter((i) => i.tags.some((t) => t.toLowerCase() === tag)) : items).slice(0, o.limit ?? 500), tags };
}

/** One kind or several ("clip,image"). */
const kindList = z.string().max(40).transform((s) => [...new Set(s.split(",").map((k) => k.trim()).filter(Boolean))]).pipe(z.array(z.enum(libraryKinds)).min(1));
library.get("/", async (c) => {
  const q = z.object({
    kind: kindList.optional(), q: z.string().max(100).optional(), tag: z.string().max(40).optional(),
    /** Particular items (the ones a video uses), whatever their kind. */
    ids: z.string().max(40 * 50).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(500),
  }).parse(c.req.query());
  if (q.ids !== undefined) {
    const ids = [...new Set(q.ids.split(",").filter((id) => /^[\w-]{1,40}$/.test(id)))].slice(0, 50);
    const rows = ids.length
      ? (await c.env.DB.prepare(`SELECT * FROM library_items WHERE active=1 AND id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all<LibraryRow>()).results
      : [];
    return c.json({ items: rows.map(libraryView), tags: [] });
  }
  return c.json(await searchLibrary(c.env, { kinds: q.kind ?? libraryKinds, q: q.q, tag: q.tag, limit: q.limit }));
});
library.get("/:id/file", async (c) => {
  const r = await c.env.DB.prepare("SELECT object_key FROM library_items WHERE id=? AND active=1").bind(c.req.param("id")).first<{ object_key: string }>();
  if (!r) throw new HTTPException(404, { message: "Not found." });
  return serveObject(c.env, r.object_key, c.req.header("Range"), "private, max-age=86400");
});
library.get("/:id/thumb", async (c) => {
  const r = await c.env.DB.prepare("SELECT thumb_key FROM library_items WHERE id=? AND active=1").bind(c.req.param("id")).first<{ thumb_key: string | null }>();
  if (!r?.thumb_key) throw new HTTPException(404, { message: "Not found." });
  return serveObject(c.env, r.thumb_key, null, "private, max-age=86400");
});
