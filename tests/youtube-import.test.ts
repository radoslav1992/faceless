import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../server/index";
import { ContentGeneration } from "../server/content-workflow";
import { seal } from "../server/crypto";
import { API } from "../server/social/youtube";
import { SCRIBE_URL } from "../server/speech";
import { isoSeconds, youtubeId } from "../shared/youtube";
import { call, signedIn, subscribe, testEnv } from "./helpers";

// Videos imported for clips from the person's own YouTube channel (a beta behind YOUTUBE_IMPORT, paid plans): the
// YouTube API says which channel a video is on, only a connected channel counts, the renderer's download container
// fetches the video, and it is then checked and transcribed like an upload.

const MB = 1024 * 1024;
const CHANNEL = "UCownchannel0000000000aa", OTHER = "UCsomeoneelse000000000bb";
const step = { do: async (_name: string, a: any, b?: any) => (b ?? a)(), sleep: async () => {} };
afterEach(() => vi.unstubAllGlobals());

/** A videos.list item. */
const item = (id: string, extra: { title?: string; duration?: string; channel?: string; privacy?: string; live?: string; upload?: string; rating?: string } = {}) => ({
  id,
  snippet: { title: extra.title ?? `Video ${id}`, channelId: extra.channel ?? CHANNEL, publishedAt: "2026-10-01T10:00:00Z", liveBroadcastContent: extra.live ?? "none" },
  contentDetails: { duration: extra.duration ?? "PT5M", ...(extra.rating && { contentRating: { ytRating: extra.rating } }) },
  status: { privacyStatus: extra.privacy ?? "public", uploadStatus: extra.upload ?? "processed" },
});
const VIDEOS = [
  item("aaaaaaaaaaa", { title: "Episode 12: pricing" }),
  item("bbbbbbbbbbb", { privacy: "private" }),
  item("ccccccccccc", { live: "upcoming" }),
  item("ddddddddddd", { duration: "PT3H" }),
  item("eeeeeeeeeee", { duration: "PT12S" }),
  item("fffffffffff", { rating: "ytAgeRestricted" }),
  item("ggggggggggg", { privacy: "unlisted", duration: "PT1H2M" }),
];
/** YouTube's API and Scribe as the Worker sees them; `seen` lists the API paths called. */
function google(videos = VIDEOS, status = 200) {
  const seen: string[] = [];
  vi.stubGlobal("fetch", async (url: string, init: any = {}) => {
    if (url === SCRIBE_URL) return Response.json({ language_code: "eng", words: [{ text: "Hello.", start: 1, end: 1.5, type: "word", speaker_id: "speaker_0" }] });
    if (!url.startsWith(API + "/")) throw new Error("unexpected " + url);
    expect(init.headers.Authorization).toBe("Bearer ya29.token");
    const u = new URL(url), path = u.pathname.split("/").at(-1)!;
    seen.push(`${path}?${u.searchParams}`);
    if (status !== 200) return Response.json({ error: { errors: [{ reason: "authError" }] } }, { status });
    if (path === "channels") return Response.json({ items: [{ id: CHANNEL, contentDetails: { relatedPlaylists: { uploads: "UUownchannel0000000000aa" } } }] });
    if (path === "playlistItems") return Response.json({ items: videos.map((v) => ({ contentDetails: { videoId: v.id } })) });
    if (path === "videos") {
      const ids = u.searchParams.get("id")!.split(",");
      return Response.json({ items: videos.filter((v) => ids.includes(v.id)) });
    }
    throw new Error("unexpected " + url);
  });
  return seen;
}
/** The renderer containers: a YouTube download (one MP4) and upload checks; `names` lists the containers asked. */
function renderer(log: any[], names: string[], refuse?: string) {
  const jobs = new Map<string, any>();
  return {
    idFromName: (n: string) => n,
    get: (name: string) => ({
      fetch: async (url: string, init: any = {}) => {
        const path = new URL(url).pathname.split("/").filter(Boolean);
        if (init.method === "POST") {
          const p = JSON.parse(init.body);
          if (!jobs.has(p.id)) { log.push(p); names.push(`${p.operation}@${name}`); jobs.set(p.id, p); }
          return Response.json({ status: "running" }, { status: 202 });
        }
        if (init.method === "DELETE") { jobs.delete(path[1]); return Response.json({}); }
        const job = jobs.get(path[1]);
        if (!job) return new Response("{}", { status: 404 });
        if (job.operation === "youtube") {
          if (refuse) return Response.json({ status: "failed", error: refuse });
          if (path[2] === "file") return new Response(new Uint8Array(7000).fill(3), { headers: { "Content-Type": "video/mp4" } });
          return Response.json({ status: "completed", files: 1 });
        }
        return Response.json({ status: "completed", duration: 300, files: 0, meta: { kind: "video", width: 1920, height: 1080, hasAudio: true } });
      },
    }),
  };
}
async function setup({ plan = "starter" as "starter" | null, channel = true, refuse }: { plan?: "starter" | null; channel?: boolean; refuse?: string } = {}) {
  const log: any[] = [], names: string[] = [];
  const { env, sqlite } = testEnv({ MEDIA_ENABLED: "true", YOUTUBE_IMPORT: "true", ELEVENLABS_API_KEY: "el", GOOGLE_CLIENT_ID: "g", GOOGLE_CLIENT_SECRET: "s", MEDIA_RENDERER: renderer(log, names, refuse) });
  const user = signedIn(sqlite);
  if (plan) subscribe(sqlite, user.id, plan);
  await call(worker, env, "GET", "/api/auth/me", undefined, user.cookie);
  const account = crypto.randomUUID();
  if (channel) {
    const tokens = { accessToken: "ya29.token", refreshToken: "r", expiresAt: Math.floor(Date.now() / 1000) + 3600, scope: "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly" };
    sqlite.prepare("INSERT INTO social_accounts(id,user_id,platform,external_id,name,credentials,status,created_at,updated_at) VALUES (?,?,'youtube',?,'My Show',?,'active',1,1)")
      .run(account, user.id, CHANNEL, await seal(env, tokens));
  }
  const importLink = (url: string) => call(worker, env, "POST", "/api/media/imports", { url }, user.cookie);
  const run = async () => { for (const c of env.CONTENT.created.splice(0)) await new ContentGeneration({} as any, env).run({ payload: c.params } as any, step as any); };
  const asset = (id: string) => sqlite.prepare("SELECT * FROM media_assets WHERE id=?").get(id) as any;
  return { env, sqlite, user, log, names, account, importLink, run, asset };
}

describe("YouTube links", () => {
  it("are read in every form YouTube gives them, with the length YouTube's API states", () => {
    for (const link of ["https://www.youtube.com/watch?v=aaaaaaaaaaa&t=42s", "https://youtu.be/aaaaaaaaaaa?si=x", "https://m.youtube.com/shorts/aaaaaaaaaaa",
      "https://youtube.com/live/aaaaaaaaaaa", "https://www.youtube-nocookie.com/embed/aaaaaaaaaaa", "https://music.youtube.com/watch?v=aaaaaaaaaaa"])
      expect(youtubeId(link)).toBe("aaaaaaaaaaa");
    for (const link of ["https://www.youtube.com/watch?v=short", "https://www.youtube.com/@channel", "https://evil.com/watch?v=aaaaaaaaaaa", "not a link", "https://youtu.be/"])
      expect(youtubeId(link)).toBeNull();
    expect(["PT5M", "PT1H2M3S", "P1DT1H", "PT12.5S", "PT", "5 minutes", null].map(isoSeconds)).toEqual([300, 3723, 90000, 12.5, null, null, null]);
  });
});

describe("importing from the person's own YouTube channel", () => {
  it("lists the channel's latest videos and why one can't be imported, only when it is on and on a paid plan", async () => {
    const { env, user } = await setup();
    const seen = google();
    const listed = (await call(worker, env, "GET", "/api/media/youtube", undefined, user.cookie)).data;
    expect(listed).toMatchObject({ enabled: true, reason: null, channels: [{ name: "My Show" }] });
    expect(listed.channels[0].videos.map((v: any) => [v.id, v.seconds, v.problem])).toEqual([
      ["aaaaaaaaaaa", 300, null],
      ["bbbbbbbbbbb", 300, "This video is private on YouTube. Make it unlisted or public, then import it."],
      ["ccccccccccc", 300, "Live streams and premieres can be imported once they've finished."],
      ["ddddddddddd", 10800, "Videos can be up to 2 hours long."],
      ["eeeeeeeeeee", 12, "Clips need a video of at least 20 seconds."],
      ["fffffffffff", 300, "Age-restricted videos can't be imported. Download it in YouTube Studio and upload the file."],
      ["ggggggggggg", 3720, null],
    ]);
    expect(listed.channels[0].videos[0]).toMatchObject({ title: "Episode 12: pricing", privacy: "public", published: "2026-10-01T10:00:00Z" });
    // Three API reads per channel: the channel's uploads list, its latest videos, their details.
    expect(seen.map((s) => s.split("?")[0])).toEqual(["channels", "playlistItems", "videos"]);
    expect(seen[0]).toContain(`id=${CHANNEL}`);

    env.YOUTUBE_IMPORT = "false";
    expect((await call(worker, env, "GET", "/api/media/youtube", undefined, user.cookie)).data).toEqual({ enabled: false, reason: "off", channels: [] });
    const free = await setup({ plan: null });
    expect((await call(worker, free.env, "GET", "/api/media/youtube", undefined, free.user.cookie)).data).toMatchObject({ enabled: false, reason: "plan" });
    const alone = await setup({ channel: false });
    expect((await call(worker, alone.env, "GET", "/api/media/youtube", undefined, alone.user.cookie)).data).toMatchObject({ enabled: true, reason: "no-channel" });
  });

  it("imports one of them: the download container fetches it, then it is checked and transcribed like an upload", async () => {
    const { env, user, log, names, importLink, run, asset } = await setup();
    google();
    const r = await importLink("https://youtu.be/aaaaaaaaaaa");
    expect(r.status).toBe(202);
    const id = r.data.asset.id;
    // The size is reserved from the video's length (5 minutes at up to 2 MB a second, and a margin).
    expect(r.data.asset).toMatchObject({ name: "Episode 12: pricing", mime: "video/mp4", status: "checking", importing: true, bytes: 650 * MB });
    expect(JSON.parse(asset(id).meta).import).toEqual({ youtube: "aaaaaaaaaaa", channel: CHANNEL, limit: 650 * MB, at: expect.any(Number) });
    await run();
    expect(log.map((p) => p.operation)).toEqual(["youtube", "inspect"]);
    expect(log[0]).toMatchObject({ video: "aaaaaaaaaaa", maxSeconds: 7200, maxBytes: 650 * MB });
    // Downloads have their own container, so renders never wait behind one.
    expect(names).toEqual(["youtube@download-0", expect.stringMatching(/^inspect@render-[0-2]$/)]);
    expect(new Uint8Array(await (await env.MEDIA.get(`media/${user.id}/${id}.mp4`)).arrayBuffer())).toEqual(new Uint8Array(7000).fill(3));
    expect((await call(worker, env, "GET", `/api/media/${id}`, undefined, user.cookie)).data.asset).toMatchObject({ status: "ready", bytes: 7000, importing: false, speech: "found" });
    expect(JSON.parse(asset(id).meta).import).toBeUndefined();
  });

  it("refuses videos of other channels and what YouTube won't let it download, before anything starts", async () => {
    const { env, sqlite, account, importLink } = await setup();
    google([...VIDEOS, item("zzzzzzzzzzz", { channel: OTHER })]);
    const error = async (link: string) => { const r = await importLink(link); return [r.status, r.data.error]; };
    expect(await error("https://www.youtube.com/watch?v=zzzzzzzzzzz")).toEqual([403,
      "Only videos from your own YouTube channel can be imported. Connect that channel on the Channels page, or upload the file."]);
    expect(await error("https://www.youtube.com/watch?v=bbbbbbbbbbb")).toEqual([422, "This video is private on YouTube. Make it unlisted or public, then import it."]);
    expect(await error("https://www.youtube.com/watch?v=yyyyyyyyyyy")).toEqual([404, "We couldn't find this video on YouTube. Check the link."]);
    expect(env.CONTENT.created).toEqual([]);
    // Switched off: YouTube links are refused as before, without asking YouTube.
    env.YOUTUBE_IMPORT = "false";
    expect((await error("https://youtu.be/aaaaaaaaaaa"))[1]).toMatch(/^YouTube links can't be imported/);
    env.YOUTUBE_IMPORT = "true";
    // A connection Google no longer accepts must be made again.
    google(VIDEOS, 401);
    expect(await error("https://youtu.be/aaaaaaaaaaa")).toEqual([409, "Your YouTube connection has expired. Reconnect the channel on the Channels page."]);
    expect((sqlite.prepare("SELECT status FROM social_accounts WHERE id=?").get(account) as any).status).toBe("expired");
    expect(await error("https://youtu.be/aaaaaaaaaaa")).toEqual([409, "Connect your YouTube channel on the Channels page to import its videos."]);
    // The free trial uploads files instead.
    const free = await setup({ plan: null });
    google();
    const trial = await call(worker, free.env, "POST", "/api/media/imports", { url: "https://youtu.be/aaaaaaaaaaa" }, free.user.cookie);
    expect([trial.status, trial.data.error]).toEqual([402, "Importing from YouTube is part of the paid plans. Upload the file instead, or choose a plan."]);
  });

  it("fails the video with YouTube's reason when the download is refused, and gives the storage back", async () => {
    const { importLink, run, asset, env } = await setup({ refuse: "YOUTUBE_BLOCKED" });
    google();
    const id = (await importLink("https://youtu.be/ggggggggggg")).data.asset.id;
    expect(asset(id).bytes).toBe(2000 * MB);
    await run();
    expect(asset(id)).toMatchObject({ status: "failed", bytes: 0 });
    expect(JSON.parse(asset(id).meta).error).toBe("YouTube is blocking downloads from our servers right now. Try again later, or download the video in YouTube Studio and upload the file.");
    expect(env.MEDIA.objects.size).toBe(0);
  });
});
