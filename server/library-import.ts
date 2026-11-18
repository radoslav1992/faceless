import type { Env } from "./types";

// Реч БГ starts with Hookstreak's library (docs/SITES.md): its music, sound effects, background clips and pictures,
// its voices, its presenters and its example videos are copied into this site's own database and bucket, a few at a
// time, by the scheduled maintenance. Hookstreak's database and bucket are bound to Реч БГ's Worker for this alone
// (HOOKSTREAK_DB, HOOKSTREAK_MEDIA in wrangler.rechbg.jsonc) and are only ever read. Where those bindings are missing,
// as on Hookstreak itself, nothing here runs.
//
// It only adds. A copied item is this site's own from then on: renaming it, hiding it or deleting it here is never
// undone, and what Hookstreak later changes or removes stays as it was copied. What Hookstreak adds later is copied on
// a following pass. Voices come without their sample: Hookstreak's is spoken in English, and Admin → Voices makes
// one in this site's language.

/** Files copied in one pass: the Worker's subrequests are shared with the rest of the maintenance. */
const PASS = 12;
type Row = Record<string, string | number | null>;
type Source = {
  table: string;
  /** What is read from Hookstreak. */
  select: string;
  /** The column that tells whether this site has the row already. */
  key: string;
  /** The columns of a row that name files to copy. */
  files: readonly string[];
  /** What is not carried over: it refers to something of Hookstreak's own, or is made again here. */
  cleared?: readonly string[];
};
const sources: readonly Source[] = [
  {
    // Not the sounds made for one person's video, nor those still waiting for an administrator's review.
    table: "library_items", key: "id", files: ["object_key", "thumb_key"], cleared: ["source_asset"],
    select: "SELECT id,kind,name,description,tags,object_key,thumb_key,mime,bytes,duration,width,height,ai,source_asset,active,created_at,category FROM library_items WHERE review=0 AND made_for IS NULL ORDER BY created_at",
  },
  {
    table: "voices", key: "id", files: [], cleared: ["preview_key"],
    select: "SELECT id,provider_id,name,description,gender,accent,age,preview_key,active,is_default,sort,created_at,updated_at FROM voices ORDER BY sort,created_at",
  },
  {
    table: "avatars", key: "id", files: ["preview_key"],
    select: "SELECT id,look_id,name,gender,engines,preview_key,stock,active,sort,created_at,updated_at FROM avatars ORDER BY sort,created_at",
  },
  {
    // A style that has an example here keeps it.
    table: "style_examples", key: "template", files: ["video_key", "poster_key", "preview_key"], cleared: ["source_video"],
    select: "SELECT template,id,video_key,poster_key,duration,source_video,created_at,preview_key FROM style_examples ORDER BY created_at",
  },
];

/** Copies one stored file; false when Hookstreak no longer has it. */
async function copyFile(e: Env, key: string) {
  const file = await e.HOOKSTREAK_MEDIA!.get(key);
  if (!file) return false;
  await e.MEDIA.put(key, file.body, { httpMetadata: file.httpMetadata, customMetadata: file.customMetadata });
  return true;
}

/**
 * One pass: up to PASS files' worth of library rows that this site does not have yet. Answers with how many rows it
 * added and how many are still to come (null where Hookstreak's library is not connected). A table that cannot be
 * read or written (the two databases a migration apart) is skipped and logged; the others go on.
 */
export async function importLibrary(e: Env, pass = PASS): Promise<{ added: number; left: number } | null> {
  if (!e.HOOKSTREAK_DB || !e.HOOKSTREAK_MEDIA) return null;
  let added = 0, left = 0, files = 0;
  for (const source of sources) {
    try {
      const theirs = (await e.HOOKSTREAK_DB.prepare(source.select).all<Row>()).results;
      const mine = new Set((await e.DB.prepare(`SELECT ${source.key} AS k FROM ${source.table}`).all<{ k: string }>()).results.map((r) => r.k));
      for (const row of theirs) {
        if (mine.has(String(row[source.key]))) continue;
        if (files >= pass) { left++; continue; }
        const keys = source.files.map((column) => row[column]).filter((key): key is string => typeof key === "string" && !!key);
        // The files first: a row is added only with everything it points to.
        const copied = await Promise.all(keys.map((key) => copyFile(e, key)));
        files += Math.max(1, keys.length);
        if (copied.includes(false)) { console.warn("Library item not copied: a file is missing", { table: source.table, id: row[source.key] }); continue; }
        const copy: Row = { ...row };
        for (const column of source.cleared ?? []) copy[column] = null;
        // One voice is the default (a unique index): a site that has chosen its own keeps it.
        if (source.table === "voices" && copy.is_default && await e.DB.prepare("SELECT 1 FROM voices WHERE is_default=1").first()) copy.is_default = 0;
        const columns = Object.keys(copy);
        // Someone may have added the same voice or presenter here by hand (their provider's ID is unique): theirs stays.
        const done = await e.DB.prepare(`INSERT OR IGNORE INTO ${source.table}(${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`)
          .bind(...columns.map((column) => copy[column])).run();
        if (done.meta.changes) added++;
        // Not added after all: its copied files have no row, so they are removed again.
        else if (keys.length) await e.MEDIA.delete(keys);
      }
    } catch (error) {
      console.error("Library import skipped a table", { table: source.table, error: (error as Error).message });
    }
  }
  if (added || left) console.log("Library import", { added, left });
  return { added, left };
}
