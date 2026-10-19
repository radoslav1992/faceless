import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import worker from "../server/index";
import { searchScore, searchTerms } from "../server/library";
import { fitSuggestion } from "../server/describe";
import { mediaName } from "../server/routes/admin-library";
import { planRender } from "../server/render-plan";
import { call, signedIn, SITE, subscribe, testEnv } from "./helpers";

// The shared library: music, clips and pictures administrators add (uploads, or their own uploads and AI media with its
// details), describe, give a genre or category and tag in Admin → Library (by hand, or filled in by a multimodal model),
// and people search by name, genre or category, description and tag. Items made with AI say so, and videos that use
// one are disclosed as AI-made.

/** A PNG's bytes: its signature and IHDR size, then filler. */
function png(width: number, height: number, bytes = 200) {
  const b = new Uint8Array(bytes).fill(1);
  b.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  return b;
}
async function setup() {
  const { env, sqlite } = testEnv({ MEDIA_ENABLED: "true" });
  const admin = signedIn(sqlite, "admin@example.com"), user = signedIn(sqlite);
  for (const u of [admin, user]) {
    subscribe(sqlite, u.id, "daily");
    await call(worker, env, "GET", "/api/auth/me", undefined, u.cookie);
  }
  const as = (who: { cookie: string }) => (method: string, path: string, body?: unknown) => call(worker, env, method, path, body, who.cookie);
  /** An administrator's upload: the file as the raw body, its details in the query. */
  const upload = async (query: Record<string, string>, body: Uint8Array, type: string) => {
    const res = await worker.fetch(new Request(`${SITE}/api/admin/library/file?${new URLSearchParams(query)}`, {
      method: "PUT", headers: { Origin: SITE, Cookie: admin.cookie, "Content-Type": type }, body: body.slice(),
    }), env, { waitUntil: () => {}, passThroughOnException: () => {} } as any);
    return { status: res.status, data: await res.json() as any };
  };
  /** A file of the administrator's media (an upload or an AI picture or clip made for a video), stored. */
  const own = async (kind: string, name: string, mime: string, body: Uint8Array, extra: { duration?: number; meta?: object; userId?: string } = {}) => {
    const id = crypto.randomUUID(), key = `media/${extra.userId ?? admin.id}/${id}.bin`;
    await env.MEDIA.put(key, body, { httpMetadata: { contentType: mime } });
    sqlite.prepare("INSERT INTO media_assets(id,user_id,kind,name,object_key,mime,bytes,duration,width,height,status,meta,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,'ready',?,1,1)")
      .run(id, extra.userId ?? admin.id, kind, name, key, mime, body.length, extra.duration ?? 0, mime.startsWith("image/") ? 1024 : 1080, mime.startsWith("image/") ? 1536 : 1920, JSON.stringify(extra.meta ?? {}));
    return id;
  };
  return { env, sqlite, admin: as(admin), user: as(user), upload, own, userId: user.id };
}

describe("library", () => {
  it("keeps the items it had when pictures, descriptions and the AI mark arrive", () => {
    const sqlite = new DatabaseSync(":memory:");
    const dir = new URL("../migrations/", import.meta.url);
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    for (const f of files.filter((f) => f < "0004")) sqlite.exec(readFileSync(new URL(f, dir), "utf8"));
    sqlite.prepare("INSERT INTO library_items(id,kind,name,tags,object_key,thumb_key,mime,bytes,duration,width,height,active,created_at) VALUES ('m1','music','Calm piano','calm','library/m1/file.mp3',NULL,'audio/mpeg',10,30,0,0,0,5)").run();
    for (const f of files.filter((f) => f >= "0004")) sqlite.exec(readFileSync(new URL(f, dir), "utf8"));
    expect(sqlite.prepare("SELECT id,kind,name,description,tags,ai,source_asset,active,created_at FROM library_items").all())
      .toEqual([{ id: "m1", kind: "music", name: "Calm piano", description: "", tags: "calm", ai: 0, source_asset: null, active: 0, created_at: 5 }]);
    // Pictures are a kind now; deleting an item still queues its files for deletion.
    sqlite.prepare("INSERT INTO library_items(id,kind,name,object_key,mime,bytes,created_at) VALUES ('p1','image','Moon','library/p1/file.png','image/png',10,6)").run();
    sqlite.prepare("DELETE FROM library_items WHERE id='p1'").run();
    expect(sqlite.prepare("SELECT prefix FROM cleanup_tasks").all()).toEqual([{ prefix: "library/p1/" }]);
  });

  it("takes pictures, clips and music uploaded with a description, tags and the AI mark", async () => {
    const { env, admin, user, upload } = await setup();
    const picture = await upload({ kind: "image", name: "Misty forest", description: "Pine forest in morning fog, seen from above", tags: "nature, Nature, fog", ai: "1" }, png(1080, 1920), "image/png");
    expect(picture.status).toBe(201);
    expect(picture.data.item).toMatchObject({
      kind: "image", name: "Misty forest", description: "Pine forest in morning fog, seen from above", tags: ["nature", "fog"], ai: true, width: 1080, height: 1920, duration: 0,
      // A picture is its own thumbnail until it has one.
      thumb: `/api/library/${picture.data.id}/file`, active: true, usage: 0,
    });
    // The size is read from the picture, not taken from the browser; what isn't a picture, or is too large, is refused.
    expect((await upload({ kind: "image", name: "Fake", width: "10", height: "10" }, new Uint8Array(200).fill(3), "image/png")).status).toBe(400);
    expect((await upload({ kind: "image", name: "Huge" }, png(5000, 5000), "image/png")).data.error).toMatch(/up to 4096 pixels/);
    expect([...env.MEDIA.objects.keys()].filter((k: string) => k.startsWith("library/"))).toHaveLength(1);
    expect((await upload({ kind: "image", name: "Clip as picture" }, png(10, 10), "video/mp4")).status).toBe(415);
    // Clips and tracks need their length.
    expect((await upload({ kind: "clip", name: "Waves" }, new Uint8Array(200), "video/mp4")).data.error).toMatch(/between half a second and 10 minutes/);
    const clip = await upload({ kind: "clip", name: "Waves", description: "Slow ocean waves at sunset", duration: "12.5", width: "1080", height: "1920" }, new Uint8Array(200), "video/mp4");
    expect(clip.data.item).toMatchObject({ kind: "clip", duration: 12.5, ai: false, thumb: null });
    // Only administrators.
    expect((await user("GET", "/api/admin/library")).status).toBe(404);
    expect((await admin("GET", "/api/admin/library")).data.items.map((i: any) => i.name)).toEqual(expect.arrayContaining(["Misty forest", "Waves"]));
  });

  it("are added from the administrator's own media with its details, once", async () => {
    const { admin, own, userId, sqlite } = await setup();
    const prompt = "A glowing jellyfish drifting through dark water, soft blue light, cinematic";
    const picture = await own("ai_image", `AI picture: ${prompt}`, "image/png", png(1024, 1536), { meta: { prompt, ai: true } });
    const clip = await own("upload", "beach_sunset.mp4", "video/mp4", new Uint8Array(300), { duration: 8 });
    const voice = await own("voice", "Voiceover", "audio/wav", new Uint8Array(300), { duration: 8 });
    const theirs = await own("upload", "Theirs.png", "image/png", png(10, 10), { userId });
    const listed = (await admin("GET", "/api/admin/library/media?kind=image")).data.files;
    expect(listed.map((f: any) => [f.id, f.ai, f.prompt, f.added])).toEqual([[picture, true, prompt, null]]);

    const added = await admin("POST", "/api/admin/library/from-media", { assetId: picture });
    expect(added.status).toBe(201);
    expect(added.data.item).toMatchObject({ kind: "image", name: "A glowing jellyfish drifting through dark water, soft blue…", description: prompt, ai: true, width: 1024, height: 1536, fromMedia: true });
    // A copy: the library keeps it when the media file is deleted.
    expect(sqlite.prepare("SELECT object_key FROM library_items").get()).toMatchObject({ object_key: expect.stringMatching(/^library\//) });
    expect((await admin("POST", "/api/admin/library/from-media", { assetId: picture })).status).toBe(409);
    expect((await admin("GET", "/api/admin/library/media?kind=image")).data.files[0].added).toBe(added.data.id);
    // An upload: its file name, no AI mark; changed at once.
    const fromClip = await admin("POST", "/api/admin/library/from-media", { assetId: clip, tags: "beach, calm" });
    expect(fromClip.data.item).toMatchObject({ kind: "clip", name: "beach sunset", description: "", tags: ["beach", "calm"], ai: false, duration: 8 });
    // Not narrations, not other people's files.
    expect((await admin("POST", "/api/admin/library/from-media", { assetId: voice })).status).toBe(400);
    expect((await admin("POST", "/api/admin/library/from-media", { assetId: theirs })).status).toBe(404);
    // Then renamed, described, tagged and marked.
    const edited = await admin("PATCH", `/api/admin/library/${fromClip.data.id}`, { name: "Golden beach", description: "Waves on a beach at golden hour", tags: "beach,  sunset ", ai: true });
    expect(edited.data.item).toMatchObject({ name: "Golden beach", description: "Waves on a beach at golden hour", tags: ["beach", "sunset"], ai: true });
    expect((await admin("PATCH", `/api/admin/library/${crypto.randomUUID()}`, { name: "X" })).status).toBe(404);
    expect(mediaName("Interview_take_2.mov", "")).toBe("Interview take 2");
  });

  it("is searched by name, description and tag, best match first", async () => {
    const { admin, user, upload } = await setup();
    const add = async (kind: string, name: string, description: string, tags = "") =>
      (await upload({ kind, name, description, tags, duration: "10" }, kind === "image" ? png(100, 100) : new Uint8Array(200), kind === "image" ? "image/png" : kind === "clip" ? "video/mp4" : "audio/mpeg")).data.id;
    const ocean = await add("clip", "Ocean waves", "Slow waves at sunset", "nature");
    const city = await add("clip", "City at night", "Neon streets and rain, with waves of traffic", "urban");
    const cafe = await add("image", "Café corner", "A cosy coffee shop window", "food");
    const piano = await add("music", "Calm piano", "Soft, slow and hopeful", "calm");
    const hidden = await add("clip", "Old waves", "");
    await admin("PATCH", `/api/admin/library/${hidden}`, { active: false });
    const search = async (query: string) => (await user("GET", `/api/library?${query}`)).data;
    // A name match ranks above a description match; plurals and accents don't matter; switched-off items are not offered.
    expect((await search("kind=clip&q=wave")).items.map((i: any) => i.id)).toEqual([ocean, city]);
    expect((await search("kind=clip,image&q=CAFE")).items.map((i: any) => i.id)).toEqual([cafe]);
    expect((await search("kind=clip&q=sunset%20waves")).items.map((i: any) => i.id)).toEqual([ocean]);
    expect((await search("kind=clip&q=volcano")).items).toEqual([]);
    // Pictures and clips together for scenes; one kind; a tag; the tags of what was found.
    expect((await search("kind=clip,image")).items.map((i: any) => i.id).sort()).toEqual([ocean, city, cafe].sort());
    expect((await search("kind=music")).items.map((i: any) => [i.id, i.description])).toEqual([[piano, "Soft, slow and hopeful"]]);
    expect((await search("kind=clip&q=waves&tag=urban")).items.map((i: any) => i.id)).toEqual([city]);
    expect((await search("kind=clip&q=waves")).tags).toEqual(["nature", "urban"]);
    expect((await user("GET", "/api/library?kind=voice")).status).toBe(400);
    // Particular items (the ones a video shows), switched-off ones left out.
    expect((await search(`ids=${cafe},${hidden}`)).items.map((i: any) => i.id)).toEqual([cafe]);
    expect(searchTerms("Waves, glass & Café!")).toEqual(["wave", "glass", "cafe"]);
    expect(searchScore({ name: "Ocean", description: "", tags: "" }, ["ocean", "night"])).toBe(0);
  });

  it("has a genre or category, written by hand, that people search by", async () => {
    const { admin, user, upload } = await setup();
    const track = await upload({ kind: "music", name: "Night drive", category: "Synthwave", tags: "calm", duration: "90" }, new Uint8Array(200), "audio/mpeg");
    expect(track.data.item).toMatchObject({ name: "Night drive", category: "Synthwave" });
    const clip = (await upload({ kind: "clip", name: "Rain on glass", duration: "10" }, new Uint8Array(200), "video/mp4")).data.id;
    expect((await admin("PATCH", `/api/admin/library/${clip}`, { category: "Weather" })).data.item.category).toBe("Weather");
    expect((await admin("PATCH", `/api/admin/library/${clip}`, { category: "x".repeat(41) })).status).toBe(400);
    expect((await user("GET", "/api/library?kind=music&q=synthwave")).data.items.map((i: any) => [i.name, i.category])).toEqual([["Night drive", "Synthwave"]]);
    expect((await user("GET", "/api/library?kind=clip&q=weather")).data.items.map((i: any) => i.id)).toEqual([clip]);
    // A genre counts more than a tag, less than the name.
    expect(searchScore({ name: "Night drive", description: "", category: "Synthwave", tags: "synthwave" }, ["synthwave"])).toBe(5);
  });

  it("fills in a file's details with a multimodal model from the samples the browser made, saving nothing", async () => {
    const { env, admin, user, upload, sqlite } = await setup();
    const calls: { model: string; input: any }[] = [];
    let reply: unknown = { name: "Neon City Rain", description: "Rain falls on a neon-lit street at night.", category: "city", tags: ["Rain", "neon", "night", "rain"] };
    env.AI.run = async (model: string, input: any) => {
      calls.push({ model, input });
      if (reply instanceof Error) throw reply;
      return { candidates: [{ content: { parts: [{ text: "thinking…", thought: true }, { text: "```json\n" + JSON.stringify(reply) + "\n```" }] } }] };
    };
    const jpeg = (n: number) => btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xe0, ...new Array(n).fill(7)));
    const wav = () => {
      const b = new Uint8Array(400);
      b.set([..."RIFF"].map((c) => c.charCodeAt(0)), 0);
      b.set([..."WAVE"].map((c) => c.charCodeAt(0)), 8);
      return btoa(String.fromCharCode(...b));
    };
    const describe = (body: object) => admin("POST", "/api/admin/library/describe", body);

    // A clip: its frames, in order, to Gemini, with the name as data and the categories to choose from.
    const clip = await describe({ kind: "clip", name: "IMG 2041", duration: 12.4, frames: [jpeg(50), jpeg(60)] });
    expect(clip.status).toBe(200);
    expect(clip.data.suggestion).toEqual({ name: "Neon City Rain", description: "Rain falls on a neon-lit street at night.", category: "City", tags: ["rain", "neon", "night"] });
    const { model, input } = calls[0];
    expect(model).toBe("google/gemini-3.8-flash");
    expect(input.contents[0].parts).toEqual([
      { text: JSON.stringify({ name: "IMG 2041", seconds: 12 }) },
      { inlineData: { mimeType: "image/jpeg", data: jpeg(50) } },
      { inlineData: { mimeType: "image/jpeg", data: jpeg(60) } },
    ]);
    expect(input.systemInstruction.parts[0].text).toMatch(/frames taken across it[\s\S]*Nature, Ocean, Space, City/);
    expect(input.generationConfig.responseMimeType).toBe("application/json");

    // A track: a part of it as WAV; moods from the app's list come first and a genre from its list.
    reply = { name: "Late Night Lo-fi", description: "Mellow beats with soft keys.", category: "LO-FI", tags: ["piano", "Calm", "slow", "ambient"] };
    const track = await describe({ kind: "music", name: "track01", duration: 184, audio: wav() });
    expect(track.data.suggestion).toEqual({ name: "Late Night Lo-fi", description: "Mellow beats with soft keys.", category: "Lo-fi", tags: ["calm", "ambient", "piano", "slow"] });
    expect(calls[1].input.contents[0].parts[1]).toEqual({ inlineData: { mimeType: "audio/wav", data: wav() } });
    expect(calls[1].input.systemInstruction.parts[0].text).toMatch(/Ambient, Lo-fi, Cinematic[\s\S]*1 to 3 moods from this list that fit \(calm, upbeat/);
    // The administrator's name is kept when it is a title, and guides the moods ("Lake Monster": dark, for scary stories).
    expect(calls[1].input.systemInstruction.parts[0].text).toMatch(/current name exactly as it is when it is a real title[\s\S]*dark = scary, horror/);
    expect(calls[1].input.systemInstruction.parts[0].text).toMatch(/"Lake Monster" is music for scary stories\): let it guide the moods, genre and description as far as what you hear allows/);
    env.DESCRIBE_MODEL = "google/gemini-3.7-flash";
    await describe({ kind: "image", name: "", frames: [jpeg(10)] });
    expect(calls[2].model).toBe("google/gemini-3.7-flash");

    // Samples that don't fit the kind, or aren't JPEGs or a WAV, never reach the model.
    const asked = calls.length;
    for (const body of [
      { kind: "music", frames: [jpeg(10)] }, { kind: "music", audio: jpeg(10) }, { kind: "clip", audio: wav() }, { kind: "image", frames: [jpeg(10), jpeg(10)] },
      { kind: "clip", frames: [btoa("GIF89a" + "x".repeat(20))] }, { kind: "clip", frames: ["not base64!"] }, { kind: "clip", frames: [] },
      { kind: "clip", frames: new Array(9).fill(jpeg(5)) },
    ]) expect((await describe(body)).status, JSON.stringify(body).slice(0, 60)).toBe(400);
    expect((await user("POST", "/api/admin/library/describe", { kind: "image", frames: [jpeg(10)] })).status).toBe(404);
    expect(calls).toHaveLength(asked);
    // The model failing or answering nonsense: a message to fill it in by hand.
    for (const r of [new Error("down"), { nothing: true }]) {
      reply = r;
      expect((await describe({ kind: "image", frames: [jpeg(10)] })).data.error).toMatch(/couldn't describe this right now/);
    }
    expect(fitSuggestion("image", { name: "", description: "", category: "Nature", tags: [] })).toBeNull();
    expect(fitSuggestion("image", { name: "Moon", description: "", category: "Not a category", tags: ["a,b", "#moon"] })).toEqual({ name: "Moon", description: "", category: "", tags: ["ab", "moon"] });
    // Nothing was saved.
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM library_items").get()).toEqual({ n: 0 });

    // Samples as large as the browser makes them (a minute of a track is a 2.6 MB WAV, 3.5 MB as base64; frames of a
    // clip up to 8 × 1.6 MB) are taken; the API's 1 MB limit for other requests does not apply.
    reply = { name: "Long Track", description: "A long ambient track.", category: "Ambient", tags: ["ambient"] };
    const minute = new Uint8Array(44 + 60 * 22050 * 2);
    minute.set([..."RIFF"].map((c) => c.charCodeAt(0)), 0);
    minute.set([..."WAVE"].map((c) => c.charCodeAt(0)), 8);
    expect((await describe({ kind: "music", name: "long", duration: 180, audio: Buffer.from(minute).toString("base64") })).status).toBe(200);
    const frame = Buffer.from(new Uint8Array(1_600_000).fill(7).map((v, i) => (i < 3 ? [0xff, 0xd8, 0xff][i] : v))).toString("base64");
    expect((await describe({ kind: "clip", name: "big", duration: 30, frames: new Array(8).fill(frame) })).status).toBe(200);

    // Administrators read a switched-off item's file (to describe it); people don't.
    const off = (await upload({ kind: "clip", name: "Old", duration: "5" }, new Uint8Array(200).fill(9), "video/mp4")).data.id;
    await admin("PATCH", `/api/admin/library/${off}`, { active: false });
    expect((await admin("GET", `/api/admin/library/${off}/file`)).status).toBe(200);
    expect((await user("GET", `/api/library/${off}/file`)).status).toBe(404);
    expect((await user("GET", `/api/admin/library/${off}/file`)).status).toBe(404);
  });

  it("is used where it fits: music for music, a clip behind a story, a clip or picture in a scene", async () => {
    const { admin, user, upload } = await setup();
    const picture = (await upload({ kind: "image", name: "Moon" }, png(100, 100), "image/png")).data.id;
    const track = (await upload({ kind: "music", name: "Calm", duration: "30" }, new Uint8Array(200), "audio/mpeg")).data.id;
    const make = (spec: object) => user("POST", "/api/videos", {
      spec: { format: "story", narration: { kind: "voice", voiceId: "george" }, scenes: [{ text: "Hello there.", description: "A wave" }], ...spec }, idempotencyKey: crypto.randomUUID(),
    });
    expect((await make({ scenes: [{ text: "Hello there.", source: "library", libraryId: track }] })).data.error).toBe("Choose a library clip for the background, and a clip or picture for each scene.");
    expect((await make({ music: { trackId: picture, volume: 0.2 } })).data.error).toBe("Choose a library track for the music.");
    expect((await make({ backdrop: { libraryId: picture } })).data.error).toBe("Choose a library clip for the background, and a clip or picture for each scene.");
    const made = await make({ scenes: [{ text: "Hello there.", source: "library", libraryId: picture }], music: { trackId: track, volume: 0.2 } });
    expect(made.status).toBe(201);
    // Administrators see what uses each item.
    const usage = Object.fromEntries((await admin("GET", "/api/admin/library")).data.items.map((i: any) => [i.id, i.usage]));
    expect(usage).toEqual({ [picture]: 1, [track]: 1 });
  });

  it("marks videos that show an AI-made library item as AI-made", () => {
    const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const spec = (libraryId: string): any => ({
      format: "story", narration: { kind: "upload", assetId: id(1) }, style: "doodle", subject: "", headline: null, music: null, backdrop: null,
      captions: { enabled: false, style: "bold" }, scenes: [{ text: "Hello there.", description: "", keys: [], source: "library", libraryId, clipSeconds: 5, transition: "auto" }],
    });
    const ctx = (ai: boolean): any => ({
      media: { [id(2)]: { key: "library/a/file.png", kind: "image", duration: 0, ai } },
      narration: { key: "media/u/voice.mp3", duration: 3, words: [{ text: "Hello", start: 0, end: 0.5 }, { text: "there.", start: 0.6, end: 1.2 }] }, watermark: "",
    });
    expect(planRender(spec(id(2)), ctx(true)).compose.synthetic).toBe(true);
    expect(planRender(spec(id(2)), ctx(false)).compose.synthetic).toBe(false);
  });
});
