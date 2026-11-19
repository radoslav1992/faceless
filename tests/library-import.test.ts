import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { importLibrary } from "../server/library-import";
import { bucket, database } from "./helpers";

// Реч БГ copies Hookstreak's library into its own database and bucket (docs/SITES.md). Hookstreak's side is only read.
let mine: ReturnType<typeof database>, theirs: ReturnType<typeof database>, env: any, files: ReturnType<typeof bucket>;
const bytes = (text: string) => new TextEncoder().encode(text);
const count = (db: ReturnType<typeof database>, table: string) => (db.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

beforeEach(async () => {
  mine = database(); theirs = database();
  const s = theirs.sqlite;
  const item = (id: string, kind: string, name: string, extra: { review?: number; madeFor?: string | null; thumb?: boolean; at?: number } = {}) =>
    s.prepare("INSERT INTO library_items(id,kind,name,description,tags,object_key,thumb_key,mime,bytes,duration,active,created_at,category,review,made_for,source_asset) VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?)")
      .run(id, kind, name, "", "calm", `library/${id}/file`, extra.thumb ? `library/${id}/thumb.jpg` : null, kind === "clip" ? "video/mp4" : "audio/mpeg", 100, 12, extra.at ?? 10, "Ambient", extra.review ?? 0, extra.madeFor ?? null, "their-asset");
  s.exec("INSERT INTO users(id,email,name,password_hash,verified,created_at) VALUES('them','them@example.com','Them','hash',1,1)");
  item("music-1", "music", "Quiet morning", { at: 1 });
  item("clip-1", "clip", "Ocean loop", { thumb: true, at: 2 });
  item("sfx-1", "sfx", "Airy whoosh", { at: 3 });
  item("sfx-review", "sfx", "Waiting for review", { review: 1 });
  item("sfx-made", "sfx", "Made for one video", { madeFor: "them" });
  item("music-gone", "music", "Its file is gone", { at: 4 });
  // Both databases start with the voices the migrations seed, one of them the default. Hookstreak has since added
  // a voice and made it its default.
  s.exec("UPDATE voices SET is_default=0");
  s.exec(`INSERT INTO voices(id,provider_id,name,description,gender,accent,age,preview_key,active,is_default,sort,created_at,updated_at)
    VALUES('nova','el-nova','Nova','Warm storyteller','female','','','voices/nova/sample.mp3',1,1,99,1,1)`);
  s.exec(`INSERT INTO avatars(id,look_id,name,gender,engines,preview_key,stock,active,sort,created_at,updated_at) VALUES('a1','look-1','Anna','female','["avatar_iv"]','avatars/a1/preview.jpg',0,1,0,1,1)`);
  s.exec(`INSERT INTO style_examples(template,id,video_key,poster_key,duration,source_video,created_at,preview_key) VALUES
    ('facts','ex-1','examples/ex-1/video.mp4','examples/ex-1/poster.jpg',30,NULL,1,'examples/ex-1/preview-ab.mp4'),('scary','ex-2','examples/ex-2/video.mp4',NULL,20,NULL,2,NULL)`);
  files = bucket();
  for (const key of ["library/music-1/file", "library/clip-1/file", "library/clip-1/thumb.jpg", "library/sfx-1/file", "library/sfx-review/file", "library/sfx-made/file",
    "voices/nova/sample.mp3", "avatars/a1/preview.jpg", "examples/ex-1/video.mp4", "examples/ex-1/poster.jpg", "examples/ex-1/preview-ab.mp4", "examples/ex-2/video.mp4"])
    await files.put(key, bytes(key), { httpMetadata: { contentType: "application/octet-stream" } });
  // From here on, nothing may be written on Hookstreak's side.
  files.put = files.delete = () => { throw new Error("Hookstreak's bucket is only read"); };
  const prepare = theirs.db.prepare.bind(theirs.db);
  theirs.db.prepare = (sql: string) => { if (!/^\s*SELECT\b/i.test(sql)) throw new Error("Hookstreak's database is only read"); return prepare(sql); };
  env = { DB: mine.db, MEDIA: bucket(), HOOKSTREAK_DB: theirs.db, HOOKSTREAK_MEDIA: files };
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); mine.sqlite.close(); theirs.sqlite.close(); });

it("does nothing where Hookstreak's library is not connected", async () => {
  expect(await importLibrary({ DB: mine.db, MEDIA: bucket() } as any)).toBeNull();
  expect(count(mine, "library_items")).toBe(0);
});

it("copies the library, voices, presenters and examples with their files, a few at a time", async () => {
  // A small pass: the rest waits for the next one.
  const first = await importLibrary(env, 3);
  expect(first!.added).toBeGreaterThan(0);
  expect(first!.left).toBeGreaterThan(0);
  let passes = 1;
  for (; passes < 10; passes++) if ((await importLibrary(env, 3))!.left === 0) break;
  expect(passes).toBeLessThan(10);

  // Music, clips and sounds: not the ones made for one person or waiting for review, and not one whose file is gone.
  const items = mine.sqlite.prepare("SELECT id,name,object_key,thumb_key,source_asset,category FROM library_items ORDER BY created_at").all();
  expect(items).toEqual([
    { id: "music-1", name: "Quiet morning", object_key: "library/music-1/file", thumb_key: null, source_asset: null, category: "Ambient" },
    { id: "clip-1", name: "Ocean loop", object_key: "library/clip-1/file", thumb_key: "library/clip-1/thumb.jpg", source_asset: null, category: "Ambient" },
    { id: "sfx-1", name: "Airy whoosh", object_key: "library/sfx-1/file", thumb_key: null, source_asset: null, category: "Ambient" },
  ]);
  // The new voice keeps its provider, without Hookstreak's English sample; this site's default voice stays the default.
  expect(mine.sqlite.prepare("SELECT id,provider_id,preview_key,is_default FROM voices WHERE id='nova'").get()).toEqual({ id: "nova", provider_id: "el-nova", preview_key: null, is_default: 0 });
  expect(count(mine, "voices")).toBe(count(theirs, "voices"));
  expect(mine.sqlite.prepare("SELECT COUNT(*) AS n FROM voices WHERE is_default=1").get()).toEqual({ n: 1 });
  expect(mine.sqlite.prepare("SELECT id,look_id,preview_key FROM avatars").all()).toEqual([{ id: "a1", look_id: "look-1", preview_key: "avatars/a1/preview.jpg" }]);
  expect(mine.sqlite.prepare("SELECT template,id,video_key,poster_key,preview_key FROM style_examples ORDER BY template").all()).toEqual([
    { template: "facts", id: "ex-1", video_key: "examples/ex-1/video.mp4", poster_key: "examples/ex-1/poster.jpg", preview_key: "examples/ex-1/preview-ab.mp4" },
    { template: "scary", id: "ex-2", video_key: "examples/ex-2/video.mp4", poster_key: null, preview_key: null },
  ]);
  // The files are this site's own copies, byte for byte; nothing else came along.
  expect([...env.MEDIA.objects.keys()].sort()).toEqual([
    "avatars/a1/preview.jpg", "examples/ex-1/poster.jpg", "examples/ex-1/preview-ab.mp4", "examples/ex-1/video.mp4", "examples/ex-2/video.mp4",
    "library/clip-1/file", "library/clip-1/thumb.jpg", "library/music-1/file", "library/sfx-1/file",
  ]);
  expect(new Uint8Array(await (await env.MEDIA.get("library/clip-1/thumb.jpg")).arrayBuffer())).toEqual(bytes("library/clip-1/thumb.jpg"));
});

it("only adds: what was renamed, hidden or deleted here stays so, and what Hookstreak adds later arrives", async () => {
  while ((await importLibrary(env))!.left) { /* until everything is here */ }
  mine.sqlite.exec("UPDATE library_items SET name='Тихо утро',active=0 WHERE id='music-1'");
  mine.sqlite.exec("DELETE FROM style_examples WHERE template='scary'");
  const again = await importLibrary(env);
  // The deleted example is offered again (the style has none here); nothing else is touched.
  expect(again).toEqual({ added: 1, left: 0 });
  expect(mine.sqlite.prepare("SELECT name,active FROM library_items WHERE id='music-1'").get()).toEqual({ name: "Тихо утро", active: 0 });
});

it("takes Hookstreak's default voice only where this site has none, and keeps its own example for a style", async () => {
  mine.sqlite.exec("UPDATE voices SET is_default=0");
  mine.sqlite.exec(`INSERT INTO style_examples(template,id,video_key,poster_key,duration,source_video,created_at,preview_key) VALUES ('facts','own-1','examples/own-1/video.mp4',NULL,25,NULL,5,NULL)`);
  while ((await importLibrary(env))!.left) { /* until everything is here */ }
  expect(mine.sqlite.prepare("SELECT id FROM voices WHERE is_default=1").all()).toEqual([{ id: "nova" }]);
  expect(mine.sqlite.prepare("SELECT id FROM style_examples WHERE template='facts'").get()).toEqual({ id: "own-1" });
  expect(env.MEDIA.objects.has("examples/ex-1/video.mp4")).toBe(false);
});
