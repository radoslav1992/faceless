import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../server/index";
import { ContentGeneration } from "../server/content-workflow";
import { claimSpeech, scribeWords, SCRIBE_MODEL, SCRIBE_URL, spendSpeech, SPEECH_FILES_PER_DAY, SPEECH_MINUTES_PER_DAY, storedTranscript, transcribe } from "../server/speech";
import { ProviderError } from "../server/providers/http";
import { SPEECH_MAX_SECONDS, speechSpans, speechTurns } from "../shared/speech";
import { call, signedIn, subscribe, testEnv } from "./helpers";

// Speech to text with ElevenLabs Scribe v2 (as rech-bg): the request and its answer, and the free transcription of
// uploads up to 10 minutes after their check (bounded per person and day).

const step = { do: async (_name: string, a: any, b?: any) => (b ?? a)(), sleep: async () => {} };
afterEach(() => vi.unstubAllGlobals());

/** A stored file as the workflow hands it to Scribe. */
const fileOf = (bytes: Uint8Array, type = "video/mp4") => ({ body: new Blob([bytes as BlobPart]).stream(), size: bytes.length, type, name: "upload.mp4" });
/** What Scribe receives: the form fields and the uploaded file, read from the streamed multipart body. */
async function received(init: any) {
  const form = await new Response(init.body, { headers: { "Content-Type": init.headers["Content-Type"] } }).formData();
  const file = form.get("file") as File;
  form.delete("file");
  return { fields: Object.fromEntries(form.entries()), file: { name: file.name, type: file.type, bytes: new Uint8Array(await file.arrayBuffer()) } };
}
/** Scribe's answer: words with spacing between them, as the API returns it. */
const scribe = (words: [string, number, number][], language = "eng") => ({
  language_code: language, language_probability: 0.98, text: words.map((w) => w[0]).join(" "),
  words: words.flatMap(([text, start, end], i) => [
    ...(i ? [{ text: " ", start, end: start, type: "spacing", logprob: 0 }] : []),
    { text, start, end, type: "word", logprob: -0.1, speaker_id: "speaker_0" },
  ]),
});

describe("Scribe answers", () => {
  it("keeps real words in order, within the file, without brackets or control characters", () => {
    const answer = {
      language_code: "ENG",
      words: [
        { text: "Hello", start: 0.5, end: 0.9, type: "word" }, { text: " ", start: 0.9, end: 1, type: "spacing" },
        { text: "(laughs)", start: 1, end: 2, type: "audio_event" },
        // A word that starts before the previous one ended starts at its end (times only go forward).
        { text: "<b>world</b>.", start: 0.8, end: 1.4, type: "word" },
        { text: "no-time", type: "word" }, { text: "   ", start: 2, end: 3, type: "word" }, { text: 7, start: 3, end: 4, type: "word" },
        { text: "a\u0000[b]", start: 3, end: 3.333, type: "word" },
        // Past the file's end it is cut to the end; one fully past it is dropped.
        { text: "end", start: 9.5, end: 10.7, type: "word" }, { text: "after", start: 10.8, end: 11, type: "word" },
      ],
    };
    expect(scribeWords(answer, 10)).toEqual({
      language: "eng",
      words: [{ text: "Hello", start: 0.5, end: 0.9 }, { text: "bworld/b.", start: 0.9, end: 1.4 }, { text: "ab", start: 3, end: 3.33 }, { text: "end", start: 9.5, end: 10 }],
      events: [{ text: "laughs", start: 1, end: 2 }],
    });
    expect(scribeWords({ detail: "x" }, 10)).toEqual({ language: "", words: [] });
    expect(scribeWords(null, 10)).toEqual({ language: "", words: [] });
  });

  it("tells speakers apart (numbered as they first speak) and keeps the sounds that are not speech", () => {
    const word = (text: string, start: number, end: number, speaker_id?: unknown) => ({ text, start, end, type: "word", speaker_id });
    const answer = {
      language_code: "eng",
      words: [
        word("So", 0, 0.3, "speaker_3"), word("tell", 0.4, 0.7, "speaker_3"), word("me.", 0.8, 1, "speaker_3"),
        word("Well,", 1.2, 1.5, "speaker_1"), word("it", 1.6, 1.8, "speaker_1"),
        { text: "(LAUGHTER)", start: 1.8, end: 3.1, type: "audio_event", speaker_id: "speaker_1" },
        // The same speaker after a long pause starts a new turn; a word without a speaker belongs to none.
        word("started", 4, 4.5, "speaker_1"), word("hm", 4.6, 4.8), word("small.", 4.9, 5.3, "speaker_1"),
        word("Right.", 5.5, 5.9, "speaker_3"),
        { text: "[applause]", start: 6, end: 9, type: "audio_event" }, { text: "...", start: 9, end: 9.5, type: "audio_event" },
      ],
    };
    expect(scribeWords(answer, 30)).toMatchObject({
      turns: [[0, 1, 0], [1.2, 1.8, 1], [4, 5.3, 1], [5.5, 5.9, 0]],
      events: [{ text: "laughter", start: 1.8, end: 3.1 }, { text: "applause", start: 6, end: 9 }],
    });
    expect(scribeWords(answer, 30).words).toHaveLength(9);
    // Who talks when, for the renderer: the turns of a moment, cut to it; without speakers, the stretches of speech.
    const t = scribeWords(answer, 30);
    expect(speechTurns(t, 0.5, 5)).toEqual([[0.5, 1, 0], [1.2, 1.8, 1], [4, 5, 1]]);
    expect(speechTurns({ words: t.words }, 0.5, 5)).toEqual([[0.5, 1.8, -1], [4, 5, -1]]);
    expect(speechTurns(null, 0, 10)).toEqual([]);
    // For the tracker: phrase by phrase (a pause of more than 0.3 s ends one, and so does another speaker), each with
    // its turn's speaker ("hm", heard without one, goes with the turn it falls in).
    expect(speechSpans(t, 0, 10)).toEqual([[0, 1, 0], [1.2, 1.8, 1], [4, 5.3, 1], [5.5, 5.9, 0]]);
    expect(speechSpans({ words: t.words }, 0.5, 5)).toEqual([[0.5, 1.8, -1], [4, 5, -1]]);
    // A word just outside its turn (a turn's edges are rounded) goes with the nearest one within a second.
    const edges = { words: [{ text: "Yes.", start: 0, end: 0.4 }, { text: "No.", start: 2.5, end: 2.9 }, { text: "Hm.", start: 9, end: 9.2 }], turns: [[0.1, 2, 0], [3, 4, 1]] as [number, number, number][] };
    expect(speechSpans(edges, 0, 10)).toEqual([[0, 0.4, 0], [2.5, 2.9, 1], [9, 9.2, -1]]);
    expect(speechSpans({ words: [], turns: t.turns }, 0.5, 5)).toEqual(speechTurns({ words: [], turns: t.turns }, 0.5, 5));
    expect(speechSpans(null, 0, 10)).toEqual([]);
    const stored = JSON.stringify({ transcript: t });
    expect(storedTranscript(stored, 4.2, 6.5)).toMatchObject({ turns: [[4, 5.3, 1], [5.5, 5.9, 0]], events: [{ text: "applause" }] });
    expect(storedTranscript(JSON.stringify({ transcript: { language: "eng", words: t.words } }))).toEqual({ language: "eng", words: t.words });
  });

  it("uploads the file itself, streamed (no link for ElevenLabs to fetch, no language), and reads the words", async () => {
    const seen: any[] = [];
    vi.stubGlobal("fetch", async (url: string, init: any) => {
      seen.push({ url, method: init.method, key: init.headers["xi-api-key"], redirect: init.redirect, ...(await received(init)) });
      return Response.json(scribe([["Here's", 1, 1.4], ["how.", 1.4, 1.7]], "bul"));
    });
    const env: any = { ELEVENLABS_API_KEY: " el-key " };
    const bytes = new Uint8Array(300_000).map((_, i) => i % 251);
    expect(await transcribe(env, fileOf(bytes), 30)).toEqual({
      language: "bul", words: [{ text: "Here's", start: 1, end: 1.4 }, { text: "how.", start: 1.4, end: 1.7 }], turns: [[1, 1.7, 0]],
    });
    expect(seen).toEqual([{
      url: SCRIBE_URL, method: "POST", key: "el-key", redirect: "manual",
      fields: { model_id: SCRIBE_MODEL, timestamps_granularity: "word", diarize: "true", tag_audio_events: "true" },
      file: { name: "upload.mp4", type: "video/mp4", bytes },
    }]);
    expect(SCRIBE_MODEL).toBe("scribe_v2");
  });

  it("turns failures into codes and never calls without a key", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ detail: { status: "quota_exceeded", message: "secret" } }, { status: 401 }));
    const file = () => fileOf(new Uint8Array(100));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // The account's credits are used up: ElevenLabs reads the file first (it prices by length), then refuses.
    await expect(transcribe({ ELEVENLABS_API_KEY: "k" } as any, file(), 5)).rejects.toMatchObject({ code: "SPEECH_CREDITS" });
    expect(warn).toHaveBeenLastCalledWith("Scribe refused", { status: 401, reason: "quota_exceeded" });
    vi.stubGlobal("fetch", async () => Response.json({ detail: { status: "invalid_api_key", message: "secret" } }, { status: 401 }));
    await expect(transcribe({ ELEVENLABS_API_KEY: "k" } as any, file(), 5)).rejects.toMatchObject({ code: "SPEECH_UNAVAILABLE" });
    // A key without the Speech to Text permission says so (Admin → Operations shows the reason).
    vi.stubGlobal("fetch", async () => Response.json({ detail: { status: "missing_permissions", message: "secret" } }, { status: 401 }));
    await expect(transcribe({ ELEVENLABS_API_KEY: "k" } as any, file(), 5)).rejects.toMatchObject({ code: "SPEECH_PERMISSION" });
    vi.stubGlobal("fetch", async () => new Response("oops", { status: 500 }));
    await expect(transcribe({ ELEVENLABS_API_KEY: "k" } as any, file(), 5)).rejects.toMatchObject({ code: "SPEECH_FAILED" });
    const never = vi.fn();
    vi.stubGlobal("fetch", never);
    await expect(transcribe({} as any, file(), 5)).rejects.toBeInstanceOf(ProviderError);
    expect(never).not.toHaveBeenCalled();
  });
});

/**
 * A renderer that checks uploads: `duration` seconds of video with sound, or the check fails with `error` (as the
 * renderer refuses a file longer than the payload's maxSeconds with MEDIA_TOO_LONG).
 */
function renderer(duration: number, log: any[], error?: string) {
  const jobs = new Map<string, any>();
  return {
    idFromName: (n: string) => n,
    get: () => ({
      fetch: async (url: string, init: any = {}) => {
        const path = new URL(url).pathname.split("/").filter(Boolean);
        if (init.method === "POST") {
          const p = JSON.parse(init.body);
          if (!jobs.has(p.id)) { log.push(p); jobs.set(p.id, p); }
          return Response.json({ status: "running" }, { status: 202 });
        }
        if (init.method === "DELETE") return Response.json({});
        if (!jobs.get(path[1])) return new Response("{}", { status: 404 });
        if (error) return Response.json({ status: "failed", error });
        return Response.json({ status: "completed", duration, files: 0, meta: { kind: "video", width: 1920, height: 1080, hasAudio: true } });
      },
    }),
  };
}
/** Scribe: receives the uploaded file, then answers `words` (or `status`, with an ElevenLabs `reason`). */
function scribeService(words: () => [string, number, number][], status = 200, reason?: string) {
  const calls: { name: string; type: string; bytes: number }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: any) => {
    if (url !== SCRIBE_URL) throw new Error("unexpected " + url);
    const { file } = await received(init);
    calls.push({ name: file.name, type: file.type, bytes: file.bytes.length });
    return status === 200 ? Response.json(scribe(words())) : Response.json(reason ? { detail: { status: reason } } : {}, { status });
  });
  return calls;
}
function setup(duration = 130, error?: string) {
  const { env, sqlite } = testEnv({ MEDIA_ENABLED: "true", ELEVENLABS_API_KEY: "el" });
  const log: any[] = [];
  env.MEDIA_RENDERER = renderer(duration, log, error);
  const user = signedIn(sqlite);
  return { env, sqlite, user, log };
}
/** An uploaded video waiting for its check (as /complete leaves it: the token the renderer reads it with). */
async function upload(env: any, sqlite: any, user: { id: string; cookie: string }) {
  await call(worker, env, "GET", "/api/auth/me", undefined, user.cookie);
  const id = crypto.randomUUID(), key = `media/${user.id}/${id}.mp4`;
  await env.MEDIA.put(key, new Uint8Array(5000).fill(9), { httpMetadata: { contentType: "video/mp4" } });
  sqlite.prepare("INSERT INTO media_assets(id,user_id,kind,name,object_key,mime,bytes,status,meta,created_at,updated_at) VALUES (?,?,'upload','Demo.mp4',?,'video/mp4',5000,'checking',?,1,1)")
    .run(id, user.id, key, JSON.stringify({ token: "t".repeat(64) }));
  return id;
}
const run = (env: any, payload: Record<string, string>) => new ContentGeneration({} as any, env).run({ payload } as any, step as any);
const meta = (sqlite: any, id: string) => JSON.parse((sqlite.prepare("SELECT meta FROM media_assets WHERE id=?").get(id) as any).meta);

describe("speech in uploads (free, up to 10 minutes)", () => {
  it("transcribes an upload after its check, sending ElevenLabs the stored file itself", async () => {
    const { env, sqlite, user, log } = setup();
    const calls = scribeService(() => [["Here's", 1, 1.4], ["how", 1.4, 1.7], ["it", 123, 123.2], ["works.", 123.2, 123.8]]);
    const id = await upload(env, sqlite, user);
    await run(env, { inspectId: id });
    expect(log.map((p) => [p.operation, p.maxSeconds])).toEqual([["inspect", SPEECH_MAX_SECONDS]]);
    expect(log[0].url).toBe(`https://app.test/api/upload-inputs/${id}?token=${"t".repeat(64)}`);
    expect(calls).toEqual([{ name: "upload.mp4", type: "video/mp4", bytes: 5000 }]);
    const one = await call(worker, env, "GET", `/api/media/${id}`, undefined, user.cookie);
    expect(one.data.asset).toMatchObject({ status: "ready", hasAudio: true, speech: "found", speechLanguage: "eng", duration: 130 });
    expect(one.data.asset.transcript).toEqual({
      language: "eng",
      words: [{ text: "Here's", start: 1, end: 1.4 }, { text: "how", start: 1.4, end: 1.7 }, { text: "it", start: 123, end: 123.2 }, { text: "works.", start: 123.2, end: 123.8 }],
      turns: [[1, 1.7, 0], [123, 123.8, 0]],
    });
    // The words of one moment, from what is kept with the file.
    const stored = (sqlite.prepare("SELECT meta FROM media_assets WHERE id=?").get(id) as any).meta;
    expect(storedTranscript(stored, 100, 130)?.words.map((w) => w.text)).toEqual(["it", "works."]);
    // Lists say whether speech was found, without the words (not even read from the database).
    const list = await call(worker, env, "GET", "/api/media?type=video", undefined, user.cookie);
    expect(list.data.assets[0]).toMatchObject({ id, speech: "found" });
    expect(list.data.assets[0].transcript).toBeUndefined();
    // Once checked, the file has no link anyone can read it through.
    expect((await call(worker, env, "GET", `/api/upload-inputs/${id}?token=${"t".repeat(64)}`)).status).toBe(404);
    expect(meta(sqlite, id).listen).toBeUndefined();
  });

  it("keeps a failed transcription a usable upload, and finds speech again on request", async () => {
    const { env, sqlite, user } = setup();
    vi.spyOn(console, "error").mockImplementation(() => {});
    scribeService(() => [], 401, "missing_permissions");
    const id = await upload(env, sqlite, user);
    await run(env, { inspectId: id });
    const failed = (await call(worker, env, "GET", `/api/media/${id}`, undefined, user.cookie)).data.asset;
    expect(failed).toMatchObject({ status: "ready", speech: "failed", error: null, transcript: null });
    // The reason is kept for the owner's message and Admin → Operations.
    expect(meta(sqlite, id).speech).toMatchObject({ status: "failed", code: "SPEECH_PERMISSION" });
    const calls = scribeService(() => [["hi", 0.2, 0.5]]);
    const again = await call(worker, env, "POST", `/api/media/${id}/speech`, {}, user.cookie);
    expect(again.status).toBe(202);
    expect(again.data.asset.speech).toBe("pending");
    // Asking again while it runs starts nothing new.
    expect((await call(worker, env, "POST", `/api/media/${id}/speech`, {}, user.cookie)).status).toBe(200);
    expect(env.CONTENT.created).toHaveLength(1);
    await run(env, env.CONTENT.created[0].params);
    expect(calls).toHaveLength(1);
    expect((await call(worker, env, "GET", `/api/media/${id}`, undefined, user.cookie)).data.asset).toMatchObject({ speech: "found", transcript: { words: [{ text: "hi", start: 0.2, end: 0.5 }] } });
  });

  it("says when there is no speech, and refuses what cannot hold any", async () => {
    const { env, sqlite, user } = setup();
    scribeService(() => []);
    const id = await upload(env, sqlite, user);
    await run(env, { inspectId: id });
    expect((await call(worker, env, "GET", `/api/media/${id}`, undefined, user.cookie)).data.asset).toMatchObject({ status: "ready", speech: "none" });
    expect((await call(worker, env, "POST", `/api/media/${id}/speech`, {}, user.cookie)).status).toBe(409);
    const image = crypto.randomUUID();
    sqlite.prepare("INSERT INTO media_assets(id,user_id,kind,name,object_key,mime,bytes,width,height,status,created_at,updated_at) VALUES (?,?,'upload','x',?,'image/jpeg',10,10,10,'ready',1,1)")
      .run(image, user.id, `media/${user.id}/${image}.jpg`);
    expect((await call(worker, env, "POST", `/api/media/${image}/speech`, {}, user.cookie)).status).toBe(400);
    expect((await call(worker, env, "POST", `/api/media/${id}/speech`, {}, signedIn(sqlite).cookie)).status).toBe(404);
  });

  it("never calls Scribe twice for one claim (an answer lost mid-step fails instead of paying again)", async () => {
    const { env, sqlite, user } = setup();
    const calls = scribeService(() => [["x", 0, 1]]);
    const id = await upload(env, sqlite, user);
    // The check is done and the speech claimed, as if a first attempt had called Scribe and then died.
    sqlite.prepare("UPDATE media_assets SET status='ready',duration=130,meta=? WHERE id=?")
      .run(JSON.stringify({ hasAudio: true, speech: { status: "pending", at: Math.floor(Date.now() / 1000), claim: "earlier" }, listen: { until: 9e9 } }), id);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await run(env, { inspectId: id });
    expect(calls).toHaveLength(0);
    expect(meta(sqlite, id).speech.status).toBe("failed");
  });

  it("is bounded per person and day, in files and in minutes, shared with script matching", async () => {
    const { env } = testEnv();
    // 30 minutes: three 10-minute files, then nothing; another person has their own allowance.
    for (let i = 0; i < 3; i++) expect(await claimSpeech(env, "u1", {}, 600)).toMatchObject({ speech: { status: "pending" }, listen: { until: expect.any(Number) } });
    expect(await claimSpeech(env, "u1", {}, 30)).toBeNull();
    expect(await claimSpeech(env, "u2", {}, 61)).not.toBeNull();
    // 20 files of a few seconds, then nothing (minutes are left, files are not).
    for (let i = 0; i < SPEECH_FILES_PER_DAY; i++) expect(await claimSpeech(env, "u3", {}, 5)).not.toBeNull();
    expect(await claimSpeech(env, "u3", {}, 5)).toBeNull();
    expect([SPEECH_FILES_PER_DAY, SPEECH_MINUTES_PER_DAY]).toEqual([20, 30]);
    // Script matching (forced alignment) takes from the same allowance and gives it back when it fails.
    expect(await spendSpeech(env, "u3", 5)).toBe(false);
    await spendSpeech(env, "u3", 5, true);
    expect(await spendSpeech(env, "u3", 5)).toBe(true);
    expect(await claimSpeech(env, "u3", {}, 5)).toBeNull();
    // A claim that does not fit takes nothing: after one minute, 30 more are refused but 29 still fit.
    expect(await claimSpeech(env, "u4", {}, 60)).not.toBeNull();
    expect(await claimSpeech(env, "u4", {}, 30 * 60)).toBeNull();
    expect(await claimSpeech(env, "u4", {}, 29 * 60)).not.toBeNull();
  });

  it("never transcribes a file over 10 minutes for free; long videos only on paid plans", async () => {
    // On the free trial the renderer is asked to refuse files over 10 minutes: such an upload fails, unheard.
    const refused = setup(3000, "MEDIA_TOO_LONG");
    let calls = scribeService(() => [["x", 0, 1]]);
    const long = await upload(refused.env, refused.sqlite, refused.user);
    await run(refused.env, { inspectId: long });
    expect(refused.log[0]).toMatchObject({ operation: "inspect", maxSeconds: SPEECH_MAX_SECONDS });
    expect(calls).toHaveLength(0);
    expect((await call(worker, refused.env, "GET", `/api/media/${long}`, undefined, refused.user.cookie)).data.asset)
      .toMatchObject({ status: "failed", bytes: 0, error: "Videos can be up to 10 minutes long on the free trial; paid plans take videos up to 2 hours.", speech: null });

    // A long video uploaded on a paid plan is checked up to 2 hours and kept, but never sent to Scribe for free (nor on
    // "Find speech": clips are found in it for credits, server/highlights.ts).
    const { env, sqlite, user, log } = setup(3000);
    calls = scribeService(() => [["x", 0, 1]]);
    const id = await upload(env, sqlite, user);
    sqlite.prepare("UPDATE media_assets SET meta=? WHERE id=?").run(JSON.stringify({ token: "t".repeat(64), maxSeconds: 7200 }), id);
    await run(env, { inspectId: id });
    expect(log[0]).toMatchObject({ operation: "inspect", maxSeconds: 7200 });
    expect(calls).toHaveLength(0);
    expect((await call(worker, env, "GET", `/api/media/${id}`, undefined, user.cookie)).data.asset).toMatchObject({ status: "ready", duration: 3000, speech: null });
    const asked = await call(worker, env, "POST", `/api/media/${id}/speech`, {}, user.cookie);
    expect(asked.status).toBe(400);
    expect(asked.data.error).toMatch(/longer than 10 minutes: find clips in it on the Clips page/);
    expect(meta(sqlite, id).listen).toBeUndefined();

    // Uploads: 500 MB and 10 minutes on the free trial, 2,000 MB and 2 hours on a paid plan.
    const free = await call(worker, env, "POST", "/api/media/uploads", { name: "Podcast.mp4", mime: "video/mp4", bytes: 800 * 1024 * 1024 }, user.cookie);
    expect(free.status).toBe(413);
    expect(free.data.error).toBe("Videos can be up to 500 MB on the free trial; paid plans take videos up to 2 hours.");
    const short = await call(worker, env, "POST", "/api/media/uploads", { name: "Clip.mp4", mime: "video/mp4", bytes: 1000 }, user.cookie);
    expect(meta(sqlite, short.data.id)).toEqual({ token: expect.stringMatching(/^[0-9a-f]{64}$/), maxSeconds: 600 });
    subscribe(sqlite, user.id, "studio");
    const paid = await call(worker, env, "POST", "/api/media/uploads", { name: "Podcast.mp4", mime: "video/mp4", bytes: 800 * 1024 * 1024 }, user.cookie);
    expect(paid.status).toBe(201);
    expect(meta(sqlite, paid.data.id).maxSeconds).toBe(7200);
    const huge = await call(worker, env, "POST", "/api/media/uploads", { name: "Stream.mp4", mime: "video/mp4", bytes: 2100 * 1024 * 1024 }, user.cookie);
    expect(huge.status).toBe(413);
    expect(huge.data.error).toBe("Videos can be up to 2,000 MB.");
    // Tracks keep their own limit whatever the plan.
    const track = await call(worker, env, "POST", "/api/media/uploads", { name: "Song.mp3", mime: "audio/mpeg", bytes: 60 * 1024 * 1024 }, user.cookie);
    expect(track.data.error).toBe("Tracks can be up to 50 MB.");
  });
});
