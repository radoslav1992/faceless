import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../server/index";
import { ContentGeneration } from "../server/content-workflow";
import { ACTIVE_IMPORTS, checkedUrl, fileLink, PlatformLink, videoMime } from "../server/imports";
import { SCRIBE_URL } from "../server/speech";
import { call, signedIn, subscribe, testEnv } from "./helpers";

// Videos imported from a link for clips: the link is checked (public https hosts only, on every redirect), share links
// of Dropbox and Google Drive lead to the file, video platform pages are refused with what to do instead, and the file
// is downloaded into storage by the workflow, then checked and transcribed like an upload.

const MB = 1024 * 1024;
const step = { do: async (_name: string, a: any, b?: any) => (b ?? a)(), sleep: async () => {} };
afterEach(() => vi.unstubAllGlobals());

/** A video file's bytes: an MP4 (or MOV) box header, then filler. */
function video(bytes: number, brand = "isom") {
  const b = new Uint8Array(bytes).fill(7);
  b.set([0, 0, 0, 0x18, ...new TextEncoder().encode("ftyp"), ...new TextEncoder().encode(brand)]);
  return b;
}
/** The web as the Worker sees it: answers by URL (a function per link), and records every request. */
function web(routes: Record<string, (init: any) => Response>) {
  const seen: string[] = [];
  vi.stubGlobal("fetch", async (url: string, init: any = {}) => {
    seen.push(url);
    if (url === SCRIBE_URL)
      return Response.json({ language_code: "eng", words: [{ text: "Hello.", start: 1, end: 1.5, type: "word", speaker_id: "speaker_0" }] });
    const route = routes[url];
    if (!route) throw new Error("unexpected " + url);
    expect(init.redirect).toBe("manual");
    return route(init);
  });
  return seen;
}
const file = (bytes: Uint8Array, headers: Record<string, string> = {}) => () => new Response(bytes.slice(), { headers: { "Content-Type": "video/mp4", ...headers } });
/** A renderer that checks uploads: `duration` seconds of 1080p video with sound. */
function renderer(log: any[], duration = 300) {
  const jobs = new Map<string, any>();
  return {
    idFromName: (n: string) => n,
    get: () => ({
      fetch: async (url: string, init: any = {}) => {
        const path = new URL(url).pathname.split("/").filter(Boolean);
        if (init.method === "POST") { const p = JSON.parse(init.body); if (!jobs.has(p.id)) log.push(p); jobs.set(p.id, p); return Response.json({ status: "running" }, { status: 202 }); }
        if (init.method === "DELETE") return Response.json({});
        if (!jobs.get(path[1])) return new Response("{}", { status: 404 });
        return Response.json({ status: "completed", duration, files: 0, meta: { kind: "video", width: 1920, height: 1080, hasAudio: true } });
      },
    }),
  };
}
async function setup(plan: "starter" | null = "starter") {
  const log: any[] = [];
  const { env, sqlite } = testEnv({ MEDIA_ENABLED: "true", ELEVENLABS_API_KEY: "el", MEDIA_RENDERER: renderer(log) });
  const user = signedIn(sqlite);
  if (plan) subscribe(sqlite, user.id, plan);
  await call(worker, env, "GET", "/api/auth/me", undefined, user.cookie);
  const importLink = (url: string) => call(worker, env, "POST", "/api/media/imports", { url }, user.cookie);
  const run = async () => { for (const c of env.CONTENT.created.splice(0)) await new ContentGeneration({} as any, env).run({ payload: c.params } as any, step as any); };
  const asset = (id: string) => sqlite.prepare("SELECT * FROM media_assets WHERE id=?").get(id) as any;
  const count = () => (sqlite.prepare("SELECT COUNT(*) AS n FROM media_assets").get() as any).n as number;
  return { env, sqlite, user, log, importLink, run, asset, count };
}

describe("links", () => {
  it("are public https links; share links lead to the file and video platform pages are refused", () => {
    const env: any = { SITE_URL: "https://app.test" };
    const code = (raw: string) => { try { checkedUrl(env, raw); return "ok"; } catch (e) { return e instanceof PlatformLink ? e.platform : (e as Error).message; } };
    expect(code("https://cdn.example.com/show.mp4")).toBe("ok");
    expect(["http://cdn.example.com/a.mp4", "ftp://cdn.example.com/a.mp4", "not a link", "javascript:alert(1)"].map(code)).toEqual(Array(4).fill("LINK_INVALID"));
    expect([
      "https://user:pw@cdn.example.com/a.mp4", "https://cdn.example.com:8443/a.mp4", "https://127.0.0.1/a.mp4", "https://2130706433/a.mp4", "https://[::1]/a.mp4",
      "https://localhost/a.mp4", "https://intranet/a.mp4", "https://nas.local/a.mp4", "https://metadata.internal/a", "https://app.test/api/media/x/file",
    ].map(code)).toEqual(Array(10).fill("LINK_PRIVATE"));
    expect(["https://www.youtube.com/watch?v=abc", "https://youtu.be/abc", "https://m.youtube.com/shorts/abc", "https://www.tiktok.com/@a/video/1", "https://vimeo.com/1"].map(code))
      .toEqual(["YouTube", "YouTube", "YouTube", "TikTok", "Vimeo"]);
    expect(new PlatformLink("YouTube").advice).toMatch(/YouTube's terms don't allow downloading its videos\. If it's your own video, download it in YouTube Studio/);

    expect(fileLink(new URL("https://dropbox.com/scl/fi/abc123/talk.mov?rlkey=k1&dl=0")).href).toBe("https://www.dropbox.com/scl/fi/abc123/talk.mov?rlkey=k1&dl=1");
    expect(fileLink(new URL("https://www.dropbox.com/s/abc/talk.mp4?raw=1")).href).toBe("https://www.dropbox.com/s/abc/talk.mp4?dl=1");
    expect(fileLink(new URL("https://drive.google.com/file/d/1AbCdEfGhIjK_lmn-op/view?usp=sharing")).href)
      .toBe("https://drive.usercontent.google.com/download?id=1AbCdEfGhIjK_lmn-op&export=download&confirm=t");
    expect(fileLink(new URL("https://drive.google.com/open?id=1AbCdEfGhIjK_lmn-op&resourcekey=0-xyz")).href)
      .toBe("https://drive.usercontent.google.com/download?id=1AbCdEfGhIjK_lmn-op&export=download&confirm=t&resourcekey=0-xyz");
    expect(fileLink(new URL("https://drive.google.com/drive/folders/abc")).href).toBe("https://drive.google.com/drive/folders/abc");

    expect([videoMime(video(64)), videoMime(video(64, "qt  ")), videoMime(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2])), videoMime(new TextEncoder().encode("<!doctype html><html>"))])
      .toEqual(["video/mp4", "video/quicktime", "video/webm", null]);
  });
});

describe("importing a video from a link", () => {
  it("opens the link at once, downloads the file, then checks and transcribes it like an upload", async () => {
    const { env, user, log, importLink, run, asset } = await setup();
    const link = "https://cdn.example.com/shows/Episode%2012.mp4", bytes = video(5000);
    const seen = web({ [link]: file(bytes, { "Content-Length": "5000" }) });
    const r = await importLink(` ${link} `);
    expect(r.status).toBe(202);
    const id = r.data.asset.id;
    expect(r.data.asset).toMatchObject({ status: "checking", importing: true, name: "Episode 12.mp4", mime: "video/mp4", bytes: 5000 });
    expect(env.CONTENT.created).toEqual([{ id: `import-${id}`, params: { importId: id } }]);
    expect(JSON.parse(asset(id).meta)).toEqual({ token: expect.stringMatching(/^[0-9a-f]{64}$/), maxSeconds: 7200, import: { url: link, limit: 5000, at: expect.any(Number) } });
    // The Clips page shows it importing.
    const listed = await call(worker, env, "GET", "/api/highlights/sources", undefined, user.cookie);
    expect(listed.data.sources).toEqual([expect.objectContaining({ id, importing: true, status: "checking" })]);
    expect(JSON.stringify(listed.data)).not.toContain("cdn.example.com");

    await run();
    expect(new Uint8Array(await (await env.MEDIA.get(`media/${user.id}/${id}.mp4`)).arrayBuffer())).toEqual(bytes);
    expect(log.map((p) => [p.operation, p.url])).toEqual([["inspect", expect.stringMatching(new RegExp(`^https://app\\.test/api/upload-inputs/${id}\\?token=`))]]);
    const ready = (await call(worker, env, "GET", `/api/media/${id}`, undefined, user.cookie)).data.asset;
    expect(ready).toMatchObject({ status: "ready", importing: false, duration: 300, bytes: 5000, speech: "found" });
    expect(JSON.parse(asset(id).meta).import).toBeUndefined();
    // Opened once while the person waited and once to download; then Scribe heard it.
    expect(seen).toEqual([link, link, SCRIBE_URL]);
  });

  it("follows share links and redirects, every hop under the same rules", async () => {
    const { user, importLink, run, asset } = await setup();
    const share = "https://www.dropbox.com/scl/fi/abc123/talk.mov?rlkey=k1&dl=0", direct = "https://www.dropbox.com/scl/fi/abc123/talk.mov?rlkey=k1&dl=1";
    const content = "https://uc1.dl.dropboxusercontent.com/cd/0/get/xyz/file", bytes = video(9000, "qt  ");
    const redirect = (to: string) => () => new Response(null, { status: 302, headers: { Location: to } });
    web({
      [direct]: redirect(content),
      [content]: file(bytes, { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="talk.mov"; filename*=UTF-8''Talk%20%E2%80%94%20final.mov` }),
      "https://cdn.example.com/to-local": redirect("http://127.0.0.1/secret"),
      "https://cdn.example.com/to-metadata": redirect("https://169.254.169.254/latest/meta-data/"),
      "https://cdn.example.com/to-youtube": redirect("https://www.youtube.com/watch?v=abc"),
      "https://cdn.example.com/loop": redirect("/loop"),
    });
    const r = await importLink(share);
    expect(r.status).toBe(202);
    // No size told: the plan's largest video is reserved until the file is in.
    expect(r.data.asset).toMatchObject({ name: "Talk — final.mov", mime: "video/quicktime", bytes: 2000 * MB });
    const id = r.data.asset.id;
    expect(asset(id).object_key).toBe(`media/${user.id}/${id}.mov`);
    await run();
    expect(asset(id)).toMatchObject({ status: "ready", bytes: 9000 });

    for (const hop of ["to-local", "to-metadata"])
      expect((await importLink(`https://cdn.example.com/${hop}`)).data.error).toBe("This link can't be reached from our servers. Use a public link to the video file.");
    expect((await importLink("https://cdn.example.com/to-youtube")).data.error).toMatch(/^YouTube links can't be imported/);
    expect((await importLink("https://cdn.example.com/loop")).data.error).toBe("This video couldn't be downloaded from its link. Try again, or upload the file.");
  });

  it("refuses pages, missing files and what the plan can't take before anything is stored", async () => {
    const { sqlite, user, importLink, count } = await setup(null);
    const seen = web({
      "https://cdn.example.com/page": () => new Response("<!doctype html><title>Sign in</title>", { headers: { "Content-Type": "text/html; charset=utf-8" } }),
      "https://cdn.example.com/gone.mp4": () => new Response("nope", { status: 404 }),
      "https://cdn.example.com/notes.bin": () => new Response("plain words, not a video at all", { headers: { "Content-Type": "application/octet-stream" } }),
      "https://cdn.example.com/huge.mp4": file(video(100), { "Content-Length": String(600 * MB) }),
      "https://cdn.example.com/broken.mp4": () => { throw new TypeError("network"); },
    });
    const error = async (link: string) => { const r = await importLink(link); return [r.status, r.data.error]; };
    expect(await error("https://cdn.example.com/page")).toEqual([422, "That link opens a web page, not a video file. Use a direct link to the file, or a Dropbox or Google Drive link shared with anyone who has it."]);
    expect(await error("https://cdn.example.com/gone.mp4")).toEqual([422, "The video at this link couldn't be opened: it may be private, moved or deleted. Check that anyone with the link can open it."]);
    expect(await error("https://cdn.example.com/notes.bin")).toEqual([422, "This link isn't an MP4, MOV or WebM video."]);
    expect(await error("https://cdn.example.com/broken.mp4")).toEqual([422, "This video couldn't be downloaded from its link. Try again, or upload the file."]);
    // The free trial takes videos up to 500 MB.
    expect(await error("https://cdn.example.com/huge.mp4")).toEqual([413, "Videos can be up to 500 MB on the free trial; paid plans take videos up to 2 hours."]);
    // Video platform pages are never fetched.
    const before = seen.length;
    expect((await error("https://youtu.be/dQw4w9WgXcQ"))[1]).toBe(
      "YouTube links can't be imported: YouTube's terms don't allow downloading its videos. If it's your own video, download it in YouTube Studio (Content → ⋮ → Download) and upload the file here.");
    expect(await error("http://cdn.example.com/a.mp4")).toEqual([422, "Paste a link that starts with https://."]);
    expect(seen.length).toBe(before);
    expect(count()).toBe(0);
    // An unconfirmed email imports nothing.
    sqlite.prepare("UPDATE users SET verified=0 WHERE id=?").run(user.id);
    expect((await importLink("https://cdn.example.com/page")).status).toBe(403);
  });

  it("downloads a few at a time, fails a download that breaks or grows, and gives the storage back", async () => {
    const { env, sqlite, importLink, run, asset } = await setup();
    let answer = (n: number) => file(video(n), { "Content-Length": String(n) })();
    web({ "https://cdn.example.com/a.mp4": () => answer(5000) });
    const ids: string[] = [];
    for (let i = 0; i < ACTIVE_IMPORTS; i++) ids.push((await importLink("https://cdn.example.com/a.mp4")).data.asset.id);
    const busy = await importLink("https://cdn.example.com/a.mp4");
    expect([busy.status, busy.data.error]).toEqual([429, "3 videos are being imported for you. Wait for one to finish, then try again."]);
    // Gone by the time it is downloaded; larger than the link said; deleted before the download.
    const [gone, grown, deleted] = ids;
    sqlite.prepare("DELETE FROM media_assets WHERE id=?").run(deleted);
    const jobs = env.CONTENT.created.splice(0);
    const runOne = (id: string) => new ContentGeneration({} as any, env).run({ payload: jobs.find((j: any) => j.params.importId === id).params } as any, step as any);
    answer = () => new Response("nope", { status: 404 });
    await runOne(gone);
    expect(asset(gone)).toMatchObject({ status: "failed", bytes: 0 });
    expect(JSON.parse(asset(gone).meta).error).toBe("The video at this link couldn't be opened: it may be private, moved or deleted. Check that anyone with the link can open it.");
    answer = () => file(video(8000))();
    await runOne(grown);
    expect(asset(grown)).toMatchObject({ status: "failed", bytes: 0 });
    expect(JSON.parse(asset(grown).meta).error).toBe("This video is larger than your plan takes: up to 500 MB on the free trial and 2 GB on paid plans.");
    await runOne(deleted);
    expect(env.MEDIA.objects.size).toBe(0);
    // With those finished, another import starts; deleted while it downloads, its file is not kept.
    answer = (n = 5000) => file(video(n), { "Content-Length": String(n) })();
    const late = (await importLink("https://cdn.example.com/a.mp4")).data.asset.id;
    answer = (n = 5000) => { sqlite.prepare("DELETE FROM media_assets WHERE id=?").run(late); return file(video(n), { "Content-Length": String(n) })(); };
    await run();
    expect(asset(late)).toBeUndefined();
    expect(env.MEDIA.objects.size).toBe(0);
  });
});
