import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../server/index";
import { drainCleanup, maintenance } from "../server/maintenance";
import { makePreviews } from "../server/examples";
import { call, signedIn, SITE, subscribe, testEnv } from "./helpers";

// Style examples: an administrator makes one of their finished videos a style's example (Admin → Examples); it is
// copied, so it stays when the video goes, and anyone can see it on the style's card. A new choice replaces the old
// one and its files are deleted. The cards play a short preview the renderer makes from it on the next maintenance
// passes; the full video stays at its own address.

const SCARY = "scary-video-bytes".padEnd(32, ".");
const PREVIEW = "preview-bytes".padEnd(32, ".");

/** A renderer whose jobs run until a test finishes them (`status`), or that is busy with other work. */
function renderer() {
  const jobs = new Map<string, { payload: any; status: "running" | "completed" | "failed" }>();
  const r = {
    jobs, calls: [] as string[], busy: false, status: "running" as "running" | "completed" | "failed", onFile: () => {},
    idFromName: (n: string) => n,
    get: (name: string) => ({
      fetch: async (url: string, init: { method?: string; body?: string } = {}) => {
        const path = new URL(url).pathname, id = path.split("/")[2], method = init.method ?? "GET";
        r.calls.push(`${method} ${path}`);
        if (method === "POST") {
          if (r.busy) return Response.json({ status: "busy" }, { status: 429 });
          const payload = JSON.parse(init.body!);
          if (!jobs.has(payload.id)) jobs.set(payload.id, { payload: { ...payload, container: name }, status: "running" });
          return Response.json({ status: "running" }, { status: 202 });
        }
        if (method === "DELETE") { jobs.delete(id); return Response.json({}); }
        if (!jobs.has(id)) return Response.json({}, { status: 404 });
        if (path.endsWith("/file/0")) { r.onFile(); return new Response(PREVIEW, { headers: { "Content-Type": "video/mp4" } }); }
        return Response.json(r.status === "failed" ? { status: "failed", error: "MEDIA_FORMAT", detail: "ffmpeg: broken" } : { status: r.status, files: 1, duration: 8 });
      },
    }),
  };
  return r;
}

afterEach(() => { vi.restoreAllMocks(); });

async function setup(media?: ReturnType<typeof renderer>) {
  const { env, sqlite } = testEnv({ MEDIA_ENABLED: "true", ...(media ? { MEDIA_RENDERER: media } : {}) });
  const admin = signedIn(sqlite, "admin@example.com"), user = signedIn(sqlite);
  // A plan gives them storage for their videos.
  for (const u of [admin, user]) {
    subscribe(sqlite, u.id, "daily");
    await call(worker, env, "GET", "/api/auth/me", undefined, u.cookie);
  }
  const as = (who: { cookie: string }) => (method: string, path: string, body?: unknown) => call(worker, env, method, path, body, who.cookie);
  /** A video of `userId`: its rendered file and cover stored, finished unless `status` says otherwise. */
  const video = async (userId: string, text: string, { status = "ready", cover = true } = {}) => {
    // Files under 24 bytes count as empty.
    const body = text.padEnd(32, ".");
    const id = crypto.randomUUID(), file = crypto.randomUUID(), poster = crypto.randomUUID();
    await env.MEDIA.put(`media/${userId}/${file}.mp4`, new TextEncoder().encode(body), { httpMetadata: { contentType: "video/mp4" } });
    sqlite.prepare("INSERT INTO videos(id,user_id,kind,spec,title,render_status,duration,created_at,updated_at) VALUES (?,?,'story','{}','A scary one',?,42,1,1)").run(id, userId, status);
    sqlite.prepare("INSERT INTO media_assets(id,user_id,video_id,kind,name,object_key,mime,bytes,duration,status,created_at,updated_at) VALUES (?,?,?,'render','video.mp4',?,'video/mp4',?,42,'ready',1,1)")
      .run(file, userId, id, `media/${userId}/${file}.mp4`, body.length);
    sqlite.prepare("UPDATE videos SET video_asset=? WHERE id=?").run(file, id);
    if (cover) {
      await env.MEDIA.put(`media/${userId}/${poster}.jpg`, new TextEncoder().encode("poster"), { httpMetadata: { contentType: "image/jpeg" } });
      sqlite.prepare("INSERT INTO media_assets(id,user_id,video_id,kind,name,object_key,mime,bytes,status,created_at,updated_at) VALUES (?,?,?,'cover','cover.jpg',?,'image/jpeg',6,'ready',1,1)")
        .run(poster, userId, id, `media/${userId}/${poster}.jpg`);
      sqlite.prepare("UPDATE videos SET cover_asset=? WHERE id=?").run(poster, id);
    }
    return id;
  };
  // A maintenance pass at a minute that runs no hourly or five-minute work; the preview stage alone, without its waits.
  const pass = () => maintenance(env, Date.UTC(2026, 9, 18, 12, 1));
  const waits: number[] = [];
  const previews = () => makePreviews(env, async (ms) => { waits.push(ms); });
  return { env, sqlite, admin: as(admin), user: as(user), adminId: admin.id, userId: user.id, video, pass, previews, waits };
}

describe("style examples", () => {
  it("copies an administrator's finished video as a style's example that everyone sees", async () => {
    const { env, sqlite, admin, user, adminId, userId, video } = await setup();
    const mine = await video(adminId, "scary-video-bytes");
    // Only administrators manage examples, from their own finished videos.
    expect((await user("GET", "/api/admin/examples")).status).toBe(404);
    const listed = (await admin("GET", "/api/admin/examples")).data;
    expect(listed.examples).toEqual([]);
    expect(listed.videos).toEqual([expect.objectContaining({ id: mine, kind: "story", title: "A scary one", duration: 42 })]);
    expect((await admin("PUT", "/api/admin/examples/scary", { videoId: await video(userId, "theirs") })).status).toBe(404);
    expect((await admin("PUT", "/api/admin/examples/scary", { videoId: await video(adminId, "unfinished", { status: "running" }) })).status).toBe(404);
    for (const style of ["nope", "constructor"]) expect((await admin("PUT", `/api/admin/examples/${style}`, { videoId: mine })).status).toBe(404);

    const set = await admin("PUT", "/api/admin/examples/scary", { videoId: mine });
    expect(set.status).toBe(200);
    expect(set.data.example).toMatchObject({ template: "scary", duration: 42, sourceVideoId: mine });
    const { video: url, poster } = set.data.example;
    expect(url).toMatch(/^\/api\/public\/examples\/[\w-]+\/video$/);
    // Signed out too: the list, the video and its poster, kept by browsers for good.
    const pub = await call(worker, env, "GET", "/api/public/examples");
    // No preview yet: the cards play the video.
    expect(pub.data.examples).toEqual({ scary: { video: url, poster, preview: null, duration: 42 } });
    const file = await call(worker, env, "GET", url);
    expect([file.status, file.data, file.headers.get("Content-Type"), file.headers.get("Accept-Ranges"), file.headers.get("Cache-Control")])
      .toEqual([200, SCARY, "video/mp4", "bytes", "public, max-age=31536000, immutable"]);
    expect((await call(worker, env, "GET", poster)).data).toBe("poster");

    // The example is a copy: deleting the video keeps it.
    sqlite.prepare("DELETE FROM videos WHERE id=?").run(mine);
    expect((await call(worker, env, "GET", url)).data).toBe(SCARY);
    expect((await admin("GET", "/api/admin/examples")).data.examples).toEqual([expect.objectContaining({ template: "scary", sourceVideoId: null })]);
  });

  it("replaces a style's example and deletes the old one's files; removing it brings the drawing back", async () => {
    const { env, sqlite, admin, adminId, video } = await setup();
    const first = (await admin("PUT", "/api/admin/examples/history", { videoId: await video(adminId, "first") })).data.example;
    const second = (await admin("PUT", "/api/admin/examples/history", { videoId: await video(adminId, "second", { cover: false }) })).data.example;
    expect(second.video).not.toBe(first.video);
    // Without a cover there's no poster; the player shows the first frame.
    expect(second.poster).toBeNull();
    expect((await call(worker, env, "GET", first.video)).status).toBe(404);
    expect((await call(worker, env, "GET", second.video)).data).toBe("second".padEnd(32, "."));
    const oldId = first.video.split("/")[4];
    expect(sqlite.prepare("SELECT prefix FROM cleanup_tasks").all()).toEqual([{ prefix: `examples/${oldId}/` }]);
    // The hourly cleanup deletes the old example's folder, nothing else.
    const files = async () => (await env.MEDIA.list({ prefix: "examples/" })).objects.map((o: { key: string }) => o.key.split("/")[1]);
    expect(new Set(await files())).toEqual(new Set([oldId, second.video.split("/")[4]]));
    await drainCleanup(env);
    expect(await files()).toEqual([second.video.split("/")[4]]);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM manual_reviews").get()).toEqual({ n: 0 });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM cleanup_tasks").get()).toEqual({ n: 0 });

    expect((await admin("DELETE", "/api/admin/examples/history")).status).toBe(200);
    expect((await call(worker, env, "GET", "/api/public/examples")).data.examples).toEqual({});
    expect((await call(worker, env, "GET", second.video)).status).toBe(404);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM cleanup_tasks").get()).toEqual({ n: 1 });
  });

  it("makes a short preview for the cards when a renderer is free; the full video stays at its own address", async () => {
    const media = renderer();
    const { env, sqlite, admin, adminId, video, pass, previews, waits } = await setup(media);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const example = (await admin("PUT", "/api/admin/examples/scary", { videoId: await video(adminId, "scary-video-bytes") })).data.example;
    const id = example.video.split("/")[4];
    expect([example.preview, example.previewStatus]).toEqual([null, "making"]);

    // Every renderer busy with people's videos: it waits, and no try is spent.
    media.busy = true;
    await pass();
    expect([media.jobs.size, sqlite.prepare("SELECT preview_slot,preview_tries FROM style_examples").get()]).toEqual([0, { preview_slot: null, preview_tries: 0 }]);
    // A free renderer takes it; the pass asks every 4 seconds, 12 times, so the renderer never sleeps through it.
    media.busy = false;
    await previews();
    expect([...media.jobs.values()].map((j) => j.payload)).toEqual([
      { id, operation: "preview", url: `${SITE}/api/public/examples/${id}/video`, seconds: 8, container: expect.stringMatching(/^render-[0-2]$/) },
    ]);
    expect([waits.length, new Set(waits), media.calls.filter((c) => c === `GET /jobs/${id}`).length]).toEqual([11, new Set([4000]), 12]);
    expect(sqlite.prepare("SELECT preview_slot FROM style_examples").get()).toEqual({ preview_slot: Number(media.jobs.get(id)!.payload.container.at(-1)) });
    expect((await call(worker, env, "GET", "/api/public/examples")).data.examples.scary.preview).toBeNull();
    // Still running then: the next pass asks the same renderer, collects the file and releases the job.
    media.status = "completed";
    await pass();
    // Tried on each of the 3 busy renderers, then once on the free one: never submitted again.
    expect(media.calls.filter((c) => c.startsWith("POST"))).toHaveLength(4);
    expect(media.jobs.size).toBe(0);
    expect(media.calls.filter((c) => c.startsWith("DELETE"))).toEqual([`DELETE /jobs/${id}`]);
    const shown = (await call(worker, env, "GET", "/api/public/examples")).data.examples.scary;
    expect(shown).toEqual({ video: example.video, poster: example.poster, preview: `/api/public/examples/${id}/preview`, duration: 42 });
    const file = await call(worker, env, "GET", shown.preview);
    expect([file.status, file.data, file.headers.get("Content-Type"), file.headers.get("Cache-Control")]).toEqual([200, PREVIEW, "video/mp4", "public, max-age=31536000, immutable"]);
    expect((await call(worker, env, "GET", example.video)).data).toBe(SCARY);
    expect((await admin("GET", "/api/admin/examples")).data.examples).toEqual([expect.objectContaining({ preview: shown.preview, previewStatus: "ready" })]);
    // Done: later passes leave the renderer alone.
    const calls = media.calls.length;
    await pass();
    expect(media.calls.length).toBe(calls);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("tries a failing preview three times, then the cards keep the full video", async () => {
    const media = renderer();
    const { env, sqlite, admin, adminId, video, pass } = await setup(media);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const id = (await admin("PUT", "/api/admin/examples/scary", { videoId: await video(adminId, "scary-video-bytes") })).data.example.video.split("/")[4];
    media.status = "failed";
    for (let i = 0; i < 6; i++) await pass();
    expect(media.calls.filter((c) => c.startsWith("POST"))).toHaveLength(3);
    expect(media.jobs.size).toBe(0);
    expect(sqlite.prepare("SELECT preview_key,preview_slot,preview_tries FROM style_examples").get()).toEqual({ preview_key: null, preview_slot: null, preview_tries: 3 });
    expect(console.error).toHaveBeenCalledWith("Example preview failed", { id, error: "MEDIA_FORMAT", detail: "ffmpeg: broken" });
    expect(console.error).not.toHaveBeenCalledWith("Maintenance stage failed", expect.anything());
    expect((await call(worker, env, "GET", "/api/public/examples")).data.examples.scary.preview).toBeNull();
    expect((await admin("GET", "/api/admin/examples")).data.examples[0].previewStatus).toBe("failed");
    // A new choice starts again; a quick render is collected in the same pass.
    media.status = "completed";
    await admin("PUT", "/api/admin/examples/scary", { videoId: await video(adminId, "another") });
    await pass();
    expect((await call(worker, env, "GET", "/api/public/examples")).data.examples.scary.preview).toMatch(/\/preview$/);
  });

  it("drops a preview that arrives after its example was removed", async () => {
    const media = renderer();
    const { env, admin, adminId, sqlite, video, pass } = await setup(media);
    const id = (await admin("PUT", "/api/admin/examples/scary", { videoId: await video(adminId, "first") })).data.example.video.split("/")[4];
    // Removed in Admin while its preview is being collected.
    media.status = "completed";
    media.onFile = () => { sqlite.prepare("DELETE FROM style_examples").run(); };
    await pass();
    expect(media.calls.some((c) => c.endsWith("/file/0"))).toBe(true);
    expect((await env.MEDIA.list({ prefix: `examples/${id}/preview` })).objects).toEqual([]);
    expect(media.jobs.size).toBe(0);
  });
});
