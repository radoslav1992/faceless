import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../server/index";
import { ContentGeneration } from "../server/content-workflow";
import { planRender, type PlanContext } from "../server/render-plan";
import { deleteHeyGenCopies } from "../server/avatars";
import { drainCleanup } from "../server/maintenance";
import { call, signedIn, subscribe, testEnv } from "./helpers";
import {
  narrationCurrent, pendingMedia, presenterCurrent, presenterKey, presenterNeeded, showsPresenter, specCredits, specSchema, spokenSeconds, type StorySpec,
} from "../shared/formats";
import { narrationKey, storyScript, FPS } from "../shared/story";
import { PRESENTER_CREDITS, pictureCredits, presenterCredits, videoCredits, voiceCredits } from "../shared/credits";
import { ALIGNMENT_URL } from "../server/providers/elevenlabs";

// On-screen presenters (shared/presenter.ts, server/avatars.ts): avatars administrators add from HeyGen, the price by
// the voice's length and quality, the scenes they speak, the run that has HeyGen animate the avatar to the ElevenLabs
// voice once, the render that cuts that video into the scenes in time with the voice, and the cleanup of HeyGen's copy.

afterEach(() => vi.unstubAllGlobals());
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const said: [string, number, number][] = [
  ["Octopuses have three hearts and blue blood.", 0.2, 2.6],
  ["Two hearts pump blood to the gills, while the third one feeds the rest of the body.", 3.0, 7.8],
  ["When an octopus swims, that third heart stops beating.", 8.2, 10.9],
  ["That is why they would rather crawl than swim.", 11.3, 13.6],
  ["Nature found a strange answer to a simple problem.", 14.0, 16.5],
];
const DURATION = 17;
const words = said.flatMap(([text, start, end]) => {
  const parts = text.split(" "), step = (end - start) / parts.length;
  return parts.map((w, i) => ({ text: w, start: r3(start + i * step), end: r3(start + (i + 1) * step - 0.02) }));
});
const scene = (n: number, extra: Record<string, unknown> = {}) => ({ text: said[n][0], description: `Doodle of sentence ${n + 1}`, keys: [], ...extra });
const story = (extra: Record<string, unknown> = {}) =>
  specSchema.parse({ format: "story", narration: { kind: "voice", voiceId: "george" }, scenes: said.map((_, n) => scene(n)), ...extra }) as StorySpec;

describe("the presenter's price and scenes", () => {
  it("costs 1 credit per started 5 seconds of voice, 3 in high quality", () => {
    expect([presenterCredits(5, "regular"), presenterCredits(5.01, "regular"), presenterCredits(17, "regular"), presenterCredits(17, "high"), presenterCredits(0, "high")])
      .toEqual([1, 2, 4, 12, 3]);
    expect(PRESENTER_CREDITS).toEqual({ regular: 1, high: 3 });
  });

  it("speaks the hook and every other picture scene (or all of them), and those scenes need no picture", () => {
    const mix = story({ presenter: { avatarId: id(9) }, scenes: said.map((_, n) => scene(n, n === 2 ? { source: "library", libraryId: id(5) } : {})) });
    expect(mix.presenter).toEqual({ avatarId: id(9), quality: "regular", layout: "mix" });
    expect(mix.scenes.map((_, i) => showsPresenter(mix, i))).toEqual([true, false, false, false, true]);
    expect(pendingMedia(mix).map((m) => m.path[1])).toEqual([1, 3]);
    const full = { ...mix, presenter: { ...mix.presenter!, layout: "full" as const } };
    expect(full.scenes.map((_, i) => showsPresenter(full, i))).toEqual([true, true, true, true, true]);
    expect(pendingMedia(full)).toEqual([]);
    // A background clip replaces every scene's picture, so no scene shows a presenter (and the server refuses both).
    expect(showsPresenter({ ...mix, backdrop: { libraryId: id(6) } }, 0)).toBe(false);
  });

  it("is charged once for the avatar, quality and recording; layout changes are free and new words make it again", () => {
    const fresh = story({ presenter: { avatarId: id(9), quality: "high" } });
    const seconds = spokenSeconds(fresh);
    expect(specCredits(fresh, true)).toBe(videoCredits(seconds) + presenterCredits(seconds, "high"));
    expect(specCredits({ ...fresh, presenter: null }, true)).toBe(videoCredits(seconds));
    // Made: the voice and the presenter video are kept.
    const generated = { key: narrationKey("george", storyScript(fresh.scenes)), voiceAssetId: id(20), words };
    const pictures = fresh.scenes.map((s, i) => (i % 2 ? { ...s, imageId: id(30 + i) } : s));
    const made = { ...fresh, scenes: pictures, generated, presented: { key: "", assetId: id(21), voiceAssetId: id(20) } } as StorySpec;
    made.presented!.key = presenterKey(made);
    expect([narrationCurrent(made), presenterCurrent(made), presenterNeeded(made)]).toEqual([true, true, false]);
    expect(specCredits(made, false)).toBe(0);
    // "Presenter only" shows no pictures: free; back to "Presenter + pictures", the kept pictures show again: free.
    expect(specCredits({ ...made, presenter: { ...made.presenter!, layout: "full" } }, false)).toBe(0);
    // Another quality or avatar: a new presenter video, by the recorded voice's length.
    expect(specCredits({ ...made, presenter: { ...made.presenter!, quality: "regular" } }, false)).toBe(presenterCredits(16.48, "regular"));
    // New words: the voice and the presenter again.
    const reworded = { ...made, scenes: made.scenes.map((s, i) => (i === 0 ? { ...s, text: "Octopuses have three hearts." } : s)) };
    expect(specCredits(reworded, false)).toBe(voiceCredits(storyScript(reworded.scenes)) + presenterCredits(spokenSeconds(reworded), "high"));
    // A presenter video made from another recording never counts as made for this one.
    expect(presenterCurrent({ ...made, presented: { ...made.presented!, voiceAssetId: id(22) } })).toBe(false);
    // "Presenter + pictures" where no scene has an AI picture or clip: nothing to make or pay.
    const own = { ...fresh, scenes: fresh.scenes.map((s) => ({ ...s, source: "own" as const, assetId: id(40) })) };
    expect(presenterNeeded(own)).toBe(false);
    expect(specCredits(own, true)).toBe(videoCredits(seconds));
  });
});

describe("the presenter in the render", () => {
  const made = () => {
    const spec = story({ presenter: { avatarId: id(9) }, scenes: said.map((_, n) => scene(n, n % 2 ? { imageId: id(30 + n) } : { transition: n === 2 ? "fade" : "auto" })) });
    const full = {
      ...spec, generated: { key: narrationKey("george", storyScript(spec.scenes)), voiceAssetId: id(20), words },
      presented: { key: "", assetId: id(21), voiceAssetId: id(20) },
    } as StorySpec;
    full.presented!.key = presenterKey(full);
    return full;
  };
  const ctx: PlanContext = {
    media: {
      [id(31)]: { key: "media/u/31.jpg", kind: "image", duration: 0, ai: true },
      [id(33)]: { key: "media/u/33.jpg", kind: "image", duration: 0, ai: true },
      [id(21)]: { key: "media/u/presenter.mp4", kind: "video", duration: DURATION, ai: true },
    },
    narration: { key: "media/u/voice.wav", duration: DURATION, words },
    watermark: "",
  };

  it("cuts the presenter's video into its scenes at the voice's time, so the lips stay in sync", () => {
    const { compose } = planRender(made(), ctx);
    const input = compose.keys.indexOf("media/u/presenter.mp4");
    expect(compose.segments.map((s) => [s.kind, s.input === input])).toEqual([["video", true], ["image", false], ["video", true], ["image", false], ["video", true]]);
    // Each segment starts on the output clock where its trim starts in the presenter's video (= the voice).
    let start = 0;
    compose.segments.forEach((s, k) => {
      if (k) start += compose.segments[k - 1].duration - (s.transition?.duration ?? 0);
      if (s.input === input) expect(s).toMatchObject({ kind: "video", audio: 0, trim: expect.closeTo(start, 1) });
    });
    expect(compose.segments[2].transition?.kind).toBe("fade");
    expect(compose.segments[4].trim! * FPS).toBeGreaterThan(0);
    expect(compose.voice).toMatchObject({ input: compose.keys.indexOf("media/u/voice.wav"), start: 0 });
    expect(compose.synthetic).toBe(true);
    // "Presenter only": every scene.
    const full = made();
    full.presenter!.layout = "full";
    expect(planRender(full, ctx).compose.segments.every((s) => s.input === input)).toBe(true);
  });

  it("never renders a presenter video made for other words or another recording", () => {
    const stale = made();
    stale.presented!.voiceAssetId = id(22);
    expect(() => planRender(stale, ctx)).toThrow("MEDIA_INPUT");
    const missing = made();
    expect(() => planRender(missing, { ...ctx, media: { ...ctx.media, [id(21)]: undefined as any } })).toThrow("MEDIA_INPUT");
  });
});

// HeyGen as the Worker sees it ------------------------------------------------------------------------------------

const PREVIEW = (look: string) => `https://files2.heygen.ai/avatar/${look}/preview.jpg`;
const look = (lookId: string, name: string, gender: string, engines: string[], status = "completed") =>
  ({ id: lookId, name, gender, supported_api_engines: engines, preview_image_url: PREVIEW(lookId), status, tags: ["studio"] });
const looks = {
  anna: look("look_anna", "Anna in the studio", "female", ["avatar_iii", "avatar_iv", "avatar_v"]),
  ben: look("look_ben", "Ben", "male", ["avatar_iv"]),
  old: look("look_old", "Old Look", "male", ["avatar_iii"]),
  dana: look("look_dana", "Dana", "female", ["avatar_iv", "avatar_v"]),
  own: look("look_own", "Our founder", "", ["avatar_iv"]),
};
/** A JPEG header declaring width×height (enough for imageInfo). */
function jpeg(width = 1080, height = 1920) {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9, ...new Array(40).fill(0)]);
}
/** ElevenLabs character timings of the script, saying `said`. */
function alignment() {
  const characters: string[] = [], starts: number[] = [], ends: number[] = [];
  said.forEach(([text, start, end], i) => {
    if (i) { characters.push(" "); starts.push(start - 0.1); ends.push(start); }
    const step = (end - start) / text.length;
    [...text].forEach((ch, k) => { characters.push(ch); starts.push(start + k * step); ends.push(start + (k + 1) * step); });
  });
  return { characters, character_start_times_seconds: starts, character_end_times_seconds: ends };
}
/** HeyGen (avatars, videos), ElevenLabs and fal; `submit` answers HeyGen's video requests (a status to refuse them). */
function providers({ submit = 200 } = {}) {
  const calls: { method: string; url: string; body?: any; headers: Record<string, string> }[] = [];
  let videos = 0, polls = 0, fal = 0;
  vi.stubGlobal("fetch", async (input: any, init: any = {}) => {
    const url = String(input?.url ?? input), method = init.method || input?.method || "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, body, headers: init.headers || {} });
    if (url.startsWith("https://api.heygen.com/")) {
      expect(init.headers["x-api-key"]).toBe("hg");
      expect(init.redirect).toBe("manual");
      const path = url.slice("https://api.heygen.com/v3".length);
      if (path === "/avatars/looks?ownership=public&limit=50") return Response.json({ data: [looks.anna, looks.ben, looks.old, look("look_wip", "Soon", "male", [], "processing")], next_token: "page2", has_more: true });
      if (path === "/avatars/looks?ownership=public&limit=50&token=page2") return Response.json({ data: [looks.dana], has_more: false });
      const one = path.match(/^\/avatars\/looks\/(\w+)$/);
      if (one) {
        const found = Object.values(looks).find((l) => l.id === one[1]);
        return found ? Response.json({ data: found }) : Response.json({ error: { code: "not_found" } }, { status: 404 });
      }
      if (path === "/videos" && method === "POST") return submit === 200 ? Response.json({ data: { video_id: `vid_${++videos}` } }) : Response.json({ error: { message: "No credits" } }, { status: submit });
      const video = path.match(/^\/videos\/(vid_\d+)$/);
      if (video && method === "DELETE") return Response.json({ data: { deleted: true } });
      if (video) return Response.json({ data: { id: video[1], status: ++polls % 2 ? "processing" : "completed", video_url: `https://resource2.heygen.ai/video/${video[1]}.mp4?Expires=1` } });
      throw new Error("unexpected HeyGen call " + method + " " + path);
    }
    if (url.startsWith("https://files2.heygen.ai/avatar/")) return new Response(jpeg(800, 800), { headers: { "Content-Type": "image/jpeg" } });
    if (url.startsWith("https://resource2.heygen.ai/video/")) return new Response(new Uint8Array(5000).fill(3), { headers: { "Content-Type": "video/mp4" } });
    if (url === ALIGNMENT_URL) return Response.json({ words: words.map((w) => ({ ...w, loss: 0.1 })), characters: [], loss: 0.1 });
    if (url.includes("api.elevenlabs.io")) return Response.json({ audio_base64: Buffer.from(new Uint8Array(DURATION * 48000)).toString("base64"), alignment: alignment() });
    const queue = url.match(/^https:\/\/queue\.fal\.run\/(.+?)(\/requests\/.*)?$/);
    if (queue && method === "POST") {
      const r = `r${++fal}`;
      return Response.json({ request_id: r, status_url: `https://queue.fal.run/${queue[1]}/requests/${r}/status`, response_url: `https://queue.fal.run/${queue[1]}/requests/${r}` });
    }
    if (queue && url.endsWith("/status")) return Response.json({ status: "COMPLETED" });
    if (queue) return Response.json({ images: [{ url: "https://v3.fal.media/files/shot.jpg" }] });
    if (url === "https://v3.fal.media/files/shot.jpg") return new Response(jpeg());
    throw new Error("unexpected " + url);
  });
  return calls;
}
/** A fake renderer container: accepts jobs, completes them at once, serves small files. */
function renderer(log: any[] = []) {
  const jobs = new Map<string, any>();
  return {
    log, jobs,
    idFromName: (n: string) => n,
    get: () => ({
      fetch: async (url: string, init: any = {}) => {
        const path = new URL(url).pathname.split("/").filter(Boolean);
        if (init.method === "POST") { const p = JSON.parse(init.body); log.push(p); jobs.set(p.id, p); return Response.json({ status: "running" }, { status: 202 }); }
        if (init.method === "DELETE") return Response.json({});
        const job = jobs.get(path[1]);
        if (!job) return new Response("{}", { status: 404 });
        if (path[2] === "file") return new Response(path[3] === "0" ? new Uint8Array(4000).fill(7) : jpeg());
        return Response.json({ status: "completed", duration: DURATION, files: 2 });
      },
    }),
  };
}
const step = { do: async (_name: string, a: any, b?: any) => (b ?? a)(), sleep: async () => {} };
async function setup(overrides: Record<string, unknown> = {}) {
  const { env, sqlite } = testEnv({ MEDIA_ENABLED: "true", FAL_KEY: "fal", ELEVENLABS_API_KEY: "el", HEYGEN_API_KEY: "hg", MEDIA_RENDERER: renderer(), ...overrides });
  const admin = signedIn(sqlite, "admin@example.com"), user = signedIn(sqlite);
  subscribe(sqlite, user.id, "starter");
  for (const u of [admin, user]) await call(worker, env, "GET", "/api/auth/me", undefined, u.cookie);
  const as = (who: { cookie: string }) => (method: string, path: string, body?: unknown) => call(worker, env, method, path, body, who.cookie);
  const used = () => (sqlite.prepare("SELECT used FROM usage_windows WHERE id LIKE ?").get(`${user.id}:sub_%`) as any).used as number;
  const run = async () => { for (const c of env.CONTENT.created.splice(0)) await new ContentGeneration({} as any, env).run({ payload: c.params } as any, step as any); };
  return { env, sqlite, admin: as(admin), user: as(user), userId: user.id, used, run };
}
const offered = async (env: any) => (await call(worker, env, "GET", "/api/public/avatars")).data.avatars as any[];

describe("presenters in Admin → Presenters", () => {
  it("are offered only once HeyGen is set up", async () => {
    const { env, admin } = await setup({ HEYGEN_API_KEY: "" });
    expect(await offered(env)).toEqual([]);
    expect((await admin("GET", "/api/admin/avatars")).data).toEqual({ avatars: [], enabled: false });
    const stock = await admin("GET", "/api/admin/avatars/stock");
    expect([stock.status, stock.data.error]).toEqual([503, expect.stringContaining("HEYGEN_API_KEY")]);
  });

  it("are added from HeyGen's stock after confirming the plan allows it, with a copy of their preview", async () => {
    const { env, admin, user } = await setup();
    providers();
    const page = (await admin("GET", "/api/admin/avatars/stock")).data;
    // Only finished avatars, each with the qualities its engines allow (none: Avatar III only), page by page.
    expect(page.looks.map((l: any) => [l.id, l.name, l.gender, l.qualities, l.added])).toEqual([
      ["look_anna", "Anna in the studio", "female", ["regular", "high"], null], ["look_ben", "Ben", "male", ["regular"], null], ["look_old", "Old Look", "male", [], null],
    ]);
    expect(page.nextPage).toBe("page2");
    expect((await admin("GET", "/api/admin/avatars/stock?page=page2")).data.looks.map((l: any) => l.id)).toEqual(["look_dana"]);
    // Previews come through the Worker (the page's policy allows only its own images), from HeyGen's hosts only.
    const image = await admin("GET", page.looks[0].image);
    expect([image.status, image.headers.get("Content-Type")]).toEqual([200, "image/jpeg"]);
    expect((await admin("GET", `/api/admin/avatars/stock/image?src=${encodeURIComponent("https://example.com/a.jpg")}`)).status).toBe(404);

    const refused = await admin("POST", "/api/admin/avatars/stock", { lookId: "look_anna" });
    expect([refused.status, refused.data.error]).toEqual([400, expect.stringContaining("HeyGen plan")]);
    const added = await admin("POST", "/api/admin/avatars/stock", { lookId: "look_anna", page: null, rightsConfirmed: true });
    expect(added.status).toBe(201);
    const anna = added.data.avatar;
    expect(anna).toMatchObject({ name: "Anna in the studio", gender: "female", qualities: ["regular", "high"], stock: true, active: true, lookId: "look_anna", usage: 0 });
    expect(env.MEDIA.objects.has(`avatars/${anna.id}/preview.jpg`)).toBe(true);
    expect((await admin("POST", "/api/admin/avatars/stock", { lookId: "look_anna", rightsConfirmed: true })).status).toBe(409);
    const old = await admin("POST", "/api/admin/avatars/stock", { lookId: "look_old", rightsConfirmed: true });
    expect([old.status, old.data.error]).toEqual([400, expect.stringContaining("Avatar IV or V")]);
    // An avatar of the account's own, linked by its ID.
    const own = await admin("POST", "/api/admin/avatars/link", { lookId: "look_own", rightsConfirmed: true });
    expect([own.status, own.data.avatar.stock, own.data.avatar.name]).toEqual([201, false, "Our founder"]);
    expect((await admin("POST", "/api/admin/avatars/link", { lookId: "look_missing", rightsConfirmed: true })).status).toBe(502);
    expect((await admin("GET", "/api/admin/avatars/stock")).data.looks[0].added).toBe(anna.id);

    // What people see: name, gender, preview and qualities (never the HeyGen avatar behind it).
    const list = await offered(env);
    expect(list).toEqual([
      { id: anna.id, name: "Anna in the studio", gender: "female", preview: `/api/public/avatars/${anna.id}/preview`, qualities: ["regular", "high"] },
      { id: own.data.avatar.id, name: "Our founder", gender: "", preview: `/api/public/avatars/${own.data.avatar.id}/preview`, qualities: ["regular"] },
    ]);
    const preview = await call(worker, env, "GET", list[0].preview);
    expect([preview.status, preview.headers.get("Content-Type")]).toEqual([200, "image/jpeg"]);
    // Administrators only.
    expect((await user("GET", "/api/admin/avatars")).status).toBe(404);
    expect((await user("POST", "/api/admin/avatars/stock", { lookId: "look_ben", rightsConfirmed: true })).status).toBe(404);
  });

  it("are renamed, ordered, re-checked with HeyGen, hidden, and deleted only when no video has them", async () => {
    const { env, sqlite, admin, userId } = await setup();
    providers();
    const anna = (await admin("POST", "/api/admin/avatars/stock", { lookId: "look_anna", rightsConfirmed: true })).data.avatar;
    const ben = (await admin("POST", "/api/admin/avatars/stock", { lookId: "look_ben", rightsConfirmed: true })).data.avatar;
    await admin("PATCH", `/api/admin/avatars/${ben.id}`, { name: "Ben at his desk", sort: 1 });
    expect((await offered(env)).map((a) => a.name)).toEqual(["Ben at his desk", "Anna in the studio"]);
    // HeyGen dropped Avatar V for her: high quality is no longer offered.
    looks.anna.supported_api_engines = ["avatar_iv"];
    try {
      expect((await admin("POST", `/api/admin/avatars/${anna.id}/check`)).data.avatar.qualities).toEqual(["regular"]);
    } finally {
      looks.anna.supported_api_engines = ["avatar_iii", "avatar_iv", "avatar_v"];
    }
    await admin("PATCH", `/api/admin/avatars/${anna.id}`, { active: false });
    expect((await offered(env)).map((a) => a.id)).toEqual([ben.id]);
    // A video with her keeps her: she can be hidden, not deleted.
    sqlite.prepare("INSERT INTO videos(id,user_id,spec,created_at,updated_at) VALUES (?,?,?,1,1)").run(id(1), userId, JSON.stringify(story({ presenter: { avatarId: anna.id } })));
    expect((await admin("GET", "/api/admin/avatars")).data.avatars.find((a: any) => a.id === anna.id).usage).toBe(1);
    const busy = await admin("DELETE", `/api/admin/avatars/${anna.id}`);
    expect([busy.status, busy.data.error]).toEqual([409, expect.stringContaining("Hide it instead")]);
    expect((await admin("DELETE", `/api/admin/avatars/${ben.id}`)).status).toBe(200);
    // Its preview goes with it.
    await drainCleanup(env);
    expect(env.MEDIA.objects.has(`avatars/${ben.id}/preview.jpg`)).toBe(false);
    expect(env.MEDIA.objects.has(`avatars/${anna.id}/preview.jpg`)).toBe(true);
  });
});

describe("presenters in the content run", () => {
  async function withAvatars() {
    const s = await setup();
    const calls = providers();
    const anna = (await s.admin("POST", "/api/admin/avatars/stock", { lookId: "look_anna", rightsConfirmed: true })).data.avatar;
    const ben = (await s.admin("POST", "/api/admin/avatars/stock", { lookId: "look_ben", rightsConfirmed: true })).data.avatar;
    calls.splice(0);
    return { ...s, calls, anna, ben };
  }

  it("refuses presenters that aren't offered, in a quality they lack, without the AI voice or over a background clip", async () => {
    const { env, sqlite, admin, user, anna, ben } = await withAvatars();
    sqlite.prepare("INSERT INTO library_items(id,kind,name,object_key,mime,bytes,duration,created_at) VALUES (?,'clip','Rain','library/c1/file.mp4','video/mp4',10,20,1)").run(id(78));
    const make = (extra: Record<string, unknown>) => user("POST", "/api/videos", { spec: story(extra), idempotencyKey: crypto.randomUUID() });
    expect((await make({ presenter: { avatarId: id(77) } })).data.error).toMatch(/presenters offered/);
    expect((await make({ presenter: { avatarId: ben.id, quality: "high" } })).data.error).toMatch(/quality/);
    expect((await make({ presenter: { avatarId: anna.id }, backdrop: { libraryId: id(78) } })).data.error).toMatch(/background clip/);
    expect((await make({ presenter: { avatarId: anna.id }, backdrop: { libraryId: id(78) } })).status).toBe(400);
    await admin("PATCH", `/api/admin/avatars/${anna.id}`, { active: false });
    expect((await make({ presenter: { avatarId: anna.id } })).data.error).toMatch(/presenters offered/);
    env.HEYGEN_API_KEY = "";
    const off = await make({ presenter: { avatarId: ben.id } });
    expect([off.status, off.data.error]).toEqual([503, expect.stringMatching(/aren't available/)]);
  });

  it("has HeyGen animate the avatar to the recorded voice once, cuts it into its scenes and deletes HeyGen's copy", async () => {
    const { env, sqlite, user, used, run, calls, anna } = await withAvatars();
    const spec = story({ presenter: { avatarId: anna.id, quality: "regular", layout: "mix" } });
    const seconds = spokenSeconds(spec), price = videoCredits(seconds) + presenterCredits(seconds, "regular");
    const created = await user("POST", "/api/videos", { spec, idempotencyKey: crypto.randomUUID() });
    expect([created.status, created.data.credits, used()]).toEqual([201, price, price]);
    await run();
    let video = (await user("GET", `/api/videos/${created.data.id}`)).data.video;
    expect(video.renderStatus).toBe("ready");
    // Pictures only for the scenes between the presenter's (2 and 4), then the voice, then the presenter.
    const order = calls.filter((c) => c.method === "POST").map((c) => (c.url.includes("fal.run") ? "picture" : c.url.includes("elevenlabs") ? "voice" : c.url.includes("heygen") ? "presenter" : c.url));
    expect(order).toEqual(["picture", "picture", "voice", "presenter"]);
    const runId = (sqlite.prepare("SELECT id FROM runs WHERE video_id=?").get(video.id) as any).id;
    const submit = calls.find((c) => c.method === "POST" && c.url === "https://api.heygen.com/v3/videos")!;
    expect(submit.headers["Idempotency-Key"]).toBe(`${runId}-presenter`);
    expect(submit.body).toMatchObject({ type: "avatar", avatar_id: "look_anna", engine: { type: "avatar_iv" }, resolution: "1080p", aspect_ratio: "auto", output_format: "mp4" });
    // HeyGen reads the ElevenLabs recording through the run's capability link: the voice is ours, only the lips are HeyGen's.
    const voice = sqlite.prepare("SELECT object_key FROM media_assets WHERE id=?").get(video.spec.generated.voiceAssetId) as any;
    const state = JSON.parse((sqlite.prepare("SELECT provider FROM runs WHERE id=?").get(runId) as any).provider);
    expect(submit.body.audio_url).toBe(`https://app.test/api/render-inputs/${runId}/${state.inputs.indexOf(voice.object_key)}?token=${state.token}`);
    // Saved as an AI clip of the video, for this avatar, quality and recording.
    expect(video.spec.presented).toEqual({ key: presenterKey(video.spec), assetId: expect.any(String), voiceAssetId: video.spec.generated.voiceAssetId });
    const asset = sqlite.prepare("SELECT kind,video_id,mime,object_key,meta FROM media_assets WHERE id=?").get(video.spec.presented.assetId) as any;
    expect([asset.kind, asset.video_id, asset.mime, JSON.parse(asset.meta)]).toEqual(["ai_clip", video.id, "video/mp4", { ai: true, presenter: true, avatarId: anna.id, quality: "regular" }]);
    expect(env.MEDIA.objects.get(asset.object_key).bytes.length).toBe(5000);
    // HeyGen's copy is deleted once ours is saved.
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toEqual(["https://api.heygen.com/v3/videos/vid_1"]);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM cleanup_tasks WHERE prefix LIKE 'heygen/%'").get()).toEqual({ n: 0 });
    // The render: the presenter on scenes 1, 3 and 5, in time with the voice; marked as AI-made.
    const composes = () => env.MEDIA_RENDERER.log.filter((p: any) => p.operation === "compose");
    const presenterInput = (c: any) => c.segments[0].input;
    const first = composes().at(-1);
    expect(first.segments.map((s: any) => (s.input === presenterInput(first) ? "presenter" : s.kind))).toEqual(["presenter", "image", "presenter", "image", "presenter"]);
    expect(first.segments.filter((s: any) => s.input === presenterInput(first)).map((s: any) => s.trim)).toEqual([0, expect.any(Number), expect.any(Number)]);
    expect(first.synthetic).toBe(true);
    expect(used()).toBe(price);

    const edit = async (change: (s: any) => any, credits: number) => {
      const r = await user("PUT", `/api/videos/${video.id}`, { spec: change(video.spec), idempotencyKey: crypto.randomUUID() });
      expect(r.data).toMatchObject({ rendering: true, credits });
      await run();
      video = (await user("GET", `/api/videos/${video.id}`)).data.video;
      expect(video.renderStatus).toBe("ready");
      return composes().at(-1);
    };
    const heygenVideos = () => calls.filter((c) => c.method === "POST" && c.url.includes("heygen")).length;
    // "Presenter only": free, the same presenter video on every scene. A browser can't swap the presenter's video.
    const full = await edit((s) => ({ ...s, presenter: { ...s.presenter, layout: "full" }, presented: { ...s.presented, assetId: id(99) } }), 0);
    expect(full.segments.every((s: any) => s.input === presenterInput(full))).toBe(true);
    expect(heygenVideos()).toBe(1);
    // High quality: a new presenter video with Avatar V, by the recorded voice's length; the old one is deleted.
    const before = video.spec.presented.assetId;
    const spoken = video.spec.generated.words.at(-1).end;
    await edit((s) => ({ ...s, presenter: { ...s.presenter, quality: "high", layout: "mix" } }), presenterCredits(spoken, "high"));
    expect(calls.filter((c) => c.method === "POST" && c.url.includes("heygen")).at(-1)!.body.engine).toEqual({ type: "avatar_v" });
    expect(video.spec.presented.assetId).not.toBe(before);
    expect(sqlite.prepare("SELECT id FROM media_assets WHERE id=?").get(before)).toBeUndefined();
    expect(used()).toBe(price + presenterCredits(spoken, "high"));
    // No presenter: free; its video goes, the pictures it covered are made (scenes 1, 3 and 5).
    const plain = await edit((s) => ({ ...s, presenter: null }), pictureCredits(3));
    expect(plain.segments.map((s: any) => s.kind)).toEqual(["image", "image", "image", "image", "image"]);
    expect(video.spec.presented).toBeUndefined();
    expect((sqlite.prepare("SELECT kind FROM media_assets WHERE video_id=? ORDER BY kind").all(video.id) as any[]).map((r) => r.kind))
      .toEqual(["ai_image", "ai_image", "ai_image", "ai_image", "ai_image", "cover", "render", "voice"]);
  });

  it("refunds the video when HeyGen refuses, after the voice, and keeps nothing at HeyGen", async () => {
    const { env, user, used, run, anna } = await withAvatars();
    providers({ submit: 402 });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const created = await user("POST", "/api/videos", { spec: story({ presenter: { avatarId: anna.id, layout: "full" } }), idempotencyKey: crypto.randomUUID() });
    expect(used()).toBeGreaterThan(0);
    await run();
    const video = (await user("GET", `/api/videos/${created.data.id}`)).data.video;
    expect(video.renderStatus).toBe("failed");
    expect(video.renderError).toMatch(/presenters are temporarily unavailable.*credits were refunded/);
    expect(used()).toBe(0);
    expect(env.MEDIA_RENDERER.log.filter((p: any) => p.operation === "compose")).toEqual([]);
  });

  it("retries deleting HeyGen's copies hourly, and gives up after two weeks", async () => {
    const { env, sqlite } = await setup();
    const now = Math.floor(Date.now() / 1000);
    sqlite.prepare("INSERT INTO cleanup_tasks(prefix,created_at) VALUES ('heygen/video/vid_7',?),('heygen/video/vid_8',?)").run(now - 60, now - 15 * 86400);
    const deleted: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init: any) => {
      if (url.endsWith("vid_8")) return new Response("{}", { status: 500 });
      deleted.push(`${init.method} ${url}`);
      return Response.json({});
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    // Storage cleanup leaves them alone (they're not files of ours).
    await drainCleanup(env);
    expect((sqlite.prepare("SELECT COUNT(*) AS n FROM cleanup_tasks").get() as any).n).toBe(2);
    await deleteHeyGenCopies(env);
    expect(deleted).toEqual(["DELETE https://api.heygen.com/v3/videos/vid_7"]);
    expect(sqlite.prepare("SELECT prefix FROM cleanup_tasks").all()).toEqual([]);
  });
});
