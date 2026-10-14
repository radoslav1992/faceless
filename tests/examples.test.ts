import { describe, expect, it } from "vitest";
import worker from "../server/index";
import { call, signedIn, subscribe, testEnv } from "./helpers";

// Style examples: an administrator makes one of their finished videos a style's example (Admin → Examples); it is
// copied, so it stays when the video goes, and anyone can see it on the style's card. A new choice replaces the old
// one and its files are deleted.

const SCARY = "scary-video-bytes".padEnd(32, ".");

async function setup() {
  const { env, sqlite } = testEnv({ MEDIA_ENABLED: "true" });
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
  return { env, sqlite, admin: as(admin), user: as(user), adminId: admin.id, userId: user.id, video };
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
    expect(pub.data.examples).toEqual({ scary: { video: url, poster, duration: 42 } });
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

    expect((await admin("DELETE", "/api/admin/examples/history")).status).toBe(200);
    expect((await call(worker, env, "GET", "/api/public/examples")).data.examples).toEqual({});
    expect((await call(worker, env, "GET", second.video)).status).toBe(404);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM cleanup_tasks").get()).toEqual({ n: 2 });
  });
});
