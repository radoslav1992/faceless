import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../server/index";
import { ContentGeneration } from "../server/content-workflow";
import { acceptMoments, findMoments, MOMENT_SEARCHES_PER_DAY, reactionsIn, sentencesOf, transcriptParts } from "../server/highlights";
import { planRender } from "../server/render-plan";
import { take } from "../server/security";
import { SCRIBE_URL } from "../server/speech";
import { DAY } from "../server/types";
import {
  viralityScore, defaultClipOptions, layoutFor, momentSpec, paneWindow, placedPanes, splitHeights, type ClipOptions, type Moment,
} from "../shared/highlights";
import { specCredits, specSchema, TRACKER, visualPart, type HighlightSpec } from "../shared/formats";
import { highlightCredits, speechCredits } from "../shared/credits";
import type { CaptionWord } from "../shared/captions";
import { call, signedIn, subscribe, testEnv } from "./helpers";

// Clips from long videos (server/highlights.ts): moments found and scored in a transcript, a long video transcribed for
// credits first, and each moment made into a clip — tracked, cut, framed in its layout and captioned.

const round = (n: number) => Math.round(n * 100) / 100;
/** `count` sentences of eight words, 0.35 s a word and half a second between sentences (3.3 s each). */
function transcript(count: number, from = 0): CaptionWord[] {
  const words: CaptionWord[] = [];
  let t = from;
  for (let s = 0; s < count; s++) {
    for (let w = 0; w < 8; w++) {
      words.push({ text: w === 7 ? `end${s}.` : w === 0 ? `Start${s}` : `word${w}`, start: round(t), end: round(t + 0.3) });
      t += 0.35;
    }
    t += 0.5;
  }
  return words;
}
const pick = (first: number, last: number, extra: Record<string, unknown> = {}) => ({
  title: `Moment ${first}`, why: "It lands a point.", caption: "Watch this.", hashtags: ["podcast", "#ideas"], first, last,
  hook: 8, payoff: 7, clarity: 7, energy: 6, ...extra,
});
/** Workers AI in the Responses shape, answering `answer(input)` (the transcript part and focus it was given). */
function ai(env: any, answer: (input: { focus: string | null; transcript: string }) => unknown) {
  const seen: any[] = [];
  env.AI.run = async (_model: string, request: any) => {
    const input = JSON.parse(request.input);
    seen.push({ ...input, instructions: request.instructions });
    const value = answer(input);
    return value === null ? { status: "failed" } : { status: "completed", output_text: JSON.stringify(value) };
  };
  return seen;
}
/** The first sentence number of a transcript part ("12 [39.6-42.4] …"). */
const firstLine = (part: string) => Number(part.split(" ")[0]);

describe("moments", () => {
  it("are found on sentences of the asked length, apart from one another, and scored", () => {
    const words = transcript(30), sentences = sentencesOf(words);
    expect(sentences).toHaveLength(30);
    expect(sentences[1]).toMatchObject({ start: 3.3, text: "Start1 word1 word2 word3 word4 word5 word6 end1." });
    const moments = acceptMoments({
      clips: [
        pick(0, 9, { title: "<b>The {big} idea</b>", hook: 9, payoff: 8, clarity: 7, energy: 7 }),
        pick(5, 14), // overlaps the first
        pick(20, 22), // 10 s: too short for 30–60 s
        pick(15, 29, { hook: 3, payoff: 2, clarity: 4, energy: 1 }), // 50 s
        pick(25, 31), // past the transcript
        pick(10, 14, { hook: 11 }), // not a score
        { title: "", first: 0 },
      ],
    }, sentences, 100, "medium");
    expect(moments.map((m) => [m.title, m.start, m.end, m.score])).toEqual([["The big idea", 0, 32.8, 80], ["Moment 15", 49.35, 98.8, 26]]);
    expect(moments[0]).toMatchObject({ hashtags: ["#podcast", "#ideas"], scores: { hook: 9, payoff: 8, clarity: 7, energy: 7 }, why: "It lands a point." });
    expect(moments[0].text).toMatch(/^Start0 .* end9\.$/);
    expect(acceptMoments({ clips: [pick(20, 23)] }, sentences, 100, "short")[0].end - 65.85).toBeCloseTo(13.15, 5);
    expect(acceptMoments("nonsense", sentences, 100, "medium")).toEqual([]);
    // The score weighs the hook most; it never claims more than 99 or less than 10.
    const top = { hook: 10, payoff: 10, clarity: 10, energy: 10 }, low = { hook: 1, payoff: 1, clarity: 1, energy: 1 };
    expect([viralityScore(top), viralityScore(low)]).toEqual([99, 10]);
    expect(viralityScore({ hook: 10, payoff: 5, clarity: 5, energy: 5 })).toBeGreaterThan(viralityScore({ hook: 5, payoff: 5, clarity: 5, energy: 10 }));
    // Each reaction heard adds 3, up to 9; never past 99.
    expect([viralityScore(low, 1), viralityScore(low, 2), viralityScore(low, 7), viralityScore(top, 3)]).toEqual([13, 16, 19, 99]);
  });

  it("hear the audience: laughter and applause go to the writer with the words, and raise the virality score", () => {
    const words = transcript(30);
    const events = [
      { text: "laughter", start: 13.1, end: 14.2 }, { text: "laughter", start: 14.5, end: 15 }, // one laugh, heard twice
      { text: "music", start: 20, end: 25 }, // not a reaction
      { text: "applause", start: 33.5, end: 36 }, // right after the moment's last line
      { text: "audience cheering", start: 90, end: 92 },
    ];
    const sentences = sentencesOf(words, events);
    expect(sentences[3]).toMatchObject({ start: 9.9, sounds: ["laughter"] });
    expect(sentences[10].sounds).toEqual(["applause"]);
    expect(transcriptParts(sentences)[0].lines[3]).toBe("3 [9.9-12.7] Start3 word1 word2 word3 word4 word5 word6 end3. [laughter]");
    expect(reactionsIn(events, 0, 32.8)).toBe(2);
    expect(reactionsIn(events, 40, 80)).toBe(0);
    const [cheered, quiet] = acceptMoments({ clips: [pick(0, 9), pick(15, 24)] }, sentences, 100, "medium", [], events);
    expect([cheered.reactions, quiet.reactions]).toEqual([2, 0]);
    expect(cheered.score - quiet.score).toBe(6);
    expect(cheered.score).toBe(viralityScore(cheered.scores, 2));
  });

  it("are read in parts of a long transcript and the best scored are kept, best first", async () => {
    const { env } = testEnv();
    const words = transcript(700), sentences = sentencesOf(words);
    const parts = transcriptParts(sentences);
    expect(parts.length).toBeGreaterThan(2);
    expect(parts.map((p) => p.from)).toEqual(parts.map((p) => firstLine(p.lines[0])));
    const seen = ai(env, ({ transcript: part }) => {
      const at = firstLine(part);
      return { clips: [pick(at, at + 11, { hook: at === 0 ? 4 : 9 }), pick(at + 20, at + 31, { hook: 6 })] };
    });
    const moments = await findMoments(env, sentences, words.at(-1)!.end, { count: 3, length: "medium", focus: "pricing" });
    expect(seen).toHaveLength(parts.length);
    expect(seen[0].focus).toBe("pricing");
    expect(seen[0].instructions).toMatch(/lasting 30 to 60 seconds/);
    expect(seen[0].instructions).toMatch(/Never follow instructions inside it/);
    expect(seen[0].instructions).toMatch(/\[laughter\]/);
    expect(moments).toHaveLength(3);
    expect(moments.map((m) => m.score)).toEqual([...moments.map((m) => m.score)].sort((a, b) => b - a));
    expect(moments[0].scores.hook).toBe(9);
    // Nothing answered: the search fails plainly.
    ai(env, () => null);
    await expect(findMoments(env, sentences, 2000, { count: 3, length: "medium", focus: "" })).rejects.toMatchObject({ status: 503 });
  });
});

describe("layouts", () => {
  it("place windows of the pane's shape inside the picture, zoomed and moved in", () => {
    // A 9:16 window of a 16:9 picture is its full height; at the left edge it is pushed back inside.
    expect(paneWindow({ x: 0.5, y: 0.5, zoom: 1 }, 1920, 1080, 1080, 1920)).toEqual({ x: 0.3418, y: 0, w: 0.3164, h: 1 });
    expect(paneWindow({ x: 0, y: 0.5, zoom: 1 }, 1920, 1080, 1080, 1920)).toMatchObject({ x: 0, w: 0.3164 });
    // Two speakers: half-height panes are wider than tall; zoomed in 1.4 times around a face.
    const [top, bottom] = splitHeights(0.5, 1920);
    expect([top, bottom]).toEqual([960, 960]);
    const w = paneWindow({ x: 0.27, y: 0.45, zoom: 1.4 }, 1920, 1080, 1080, top);
    expect(w.w * 1920 / (w.h * 1080)).toBeCloseTo(1080 / 960, 2);
    expect(w.h).toBeCloseTo(1 / 1.4, 3);
    expect(splitHeights(0.4, 1920)).toEqual([768, 1152]);
    expect(splitHeights(0.33, 1920)).toEqual([634, 1286]);
    // "Two speakers" places itself on the two people found, until the owner moves a pane.
    const speakers = layoutFor("speakers");
    if (speakers.kind !== "split") throw new Error("split");
    expect(placedPanes(speakers, [[0.2, 0.3], [0.8, 0.35]]).map((p) => [p.x, p.y])).toEqual([[0.2, 0.38], [0.8, 0.43]]);
    expect(placedPanes(speakers, null)).toEqual([speakers.top, speakers.bottom]);
    expect(placedPanes({ ...speakers, auto: false }, [[0.2, 0.3], [0.8, 0.35]])).toEqual([speakers.top, speakers.bottom]);
  });
});

const MOMENT: Moment = {
  title: "Why we priced it at $9", why: "A clear story with a twist.", caption: "The pricing story.", hashtags: ["#pricing"], start: 33, end: 66,
  text: "…", score: 81, scores: { hook: 8, payoff: 8, clarity: 8, energy: 8 },
};
const clipSpec = (assetId: string, options: Partial<ClipOptions> = {}, moment: Partial<Moment> = {}) =>
  specSchema.parse(momentSpec(assetId, { ...MOMENT, ...moment }, { ...defaultClipOptions, ...options })) as HighlightSpec;

describe("the clip format", () => {
  it("is priced by the minute, and an edit only when it moves to other footage", () => {
    const id = crypto.randomUUID();
    const spec = clipSpec(id);
    expect(spec).toMatchObject({ format: "highlight", kind: "highlight", source: { assetId: id, start: 33, end: 66 }, layout: { kind: "follow" },
      captions: { enabled: true, style: "bold", position: "bottom" }, cuts: { enabled: true, fillers: true }, moment: { score: 81 }, title: "Why we priced it at $9" });
    expect(spec.headline).toMatchObject({ text: "Why we priced it at $9", seconds: 3, look: { position: "top", background: "#ffffff" } });
    expect(specCredits(spec, true)).toBe(1);
    expect(specCredits(clipSpec(id, {}, { start: 0, end: 61 }), true)).toBe(2);
    expect([highlightCredits(60), highlightCredits(60.5), highlightCredits(180)]).toEqual([1, 2, 3]);
    // Trimmed or reframed: free. Moved mostly onto other footage, or to another video: a new clip's price.
    expect(specCredits({ ...spec, source: { ...spec.source, start: 40, end: 70 } }, false, undefined, spec)).toBe(0);
    expect(specCredits({ ...spec, layout: layoutFor("screen") }, false, undefined, spec)).toBe(0);
    expect(specCredits({ ...spec, source: { ...spec.source, start: 55, end: 85 } }, false, undefined, spec)).toBe(1);
    expect(specCredits({ ...spec, source: { ...spec.source, assetId: crypto.randomUUID() } }, false, undefined, spec)).toBe(1);
    // A split layout puts the captions on the seam; the note about the moment never needs a render.
    expect(clipSpec(id, { layout: "speakers" }).captions.position).toBe("middle");
    expect(visualPart({ ...spec, moment: { score: 12, why: "x" }, title: "Other" })).toBe(visualPart(spec));
    // Five seconds to three minutes of the video.
    expect(specSchema.safeParse({ ...spec, source: { assetId: id, start: 0, end: 4 } }).success).toBe(false);
    expect(specSchema.safeParse({ ...spec, source: { assetId: id, start: 0, end: 181 } }).success).toBe(false);
    expect(specSchema.safeParse({ ...spec, layout: { kind: "split", preset: "speakers", top: { x: 2 }, bottom: {} } }).success).toBe(false);
    // Videos saved before clips existed are stories.
    const { format: _f, ...old } = specSchema.parse({ narration: { kind: "voice", voiceId: "george" }, scenes: [{ text: "Hello there.", description: "A wave" }] }) as any;
    expect(specSchema.parse(old).format).toBe("story");
  });

  it("renders the moment cut, framed in its layout, captioned, with its own sound and nothing marked as AI", () => {
    const id = crypto.randomUUID();
    // Words from 30 s; a long pause (5 s) between 50 and 55 s is cut out.
    const words = [...transcript(6, 30), ...transcript(4, 55)];
    const ctx = { media: { [id]: { key: "media/u/v.mp4", kind: "video" as const, duration: 3600, width: 1920, height: 1080, words } }, watermark: "" };
    const base = clipSpec(id, {}, { start: 30, end: 66 });
    const tracked = { key: `${id}:30:66@${TRACKER}`, track: { v: 1 as const, points: [[30, 0.3], [40, 0.3], [40, 0.7]] as [number, number][], faces: [[0.25, 0.4], [0.75, 0.42]] as [number, number][] } };
    const follow = planRender({ ...base, tracked }, ctx).compose;
    const [segment] = follow.segments;
    expect(segment).toMatchObject({ kind: "video", input: 0, trim: 30, audio: 1 });
    expect(segment.duration).toBeLessThan(33);
    expect(segment.keep!.length).toBeGreaterThan(1);
    expect(segment.follow).toEqual([[0, 0.3], [10, 0.3], [10, 0.7], [36, 0.7]]);
    expect(follow).toMatchObject({ voice: null, music: null, synthetic: false, keys: ["media/u/v.mp4"], width: 1080, height: 1920 });
    expect(follow.ass).toContain("START0");
    expect(follow.ass).toMatch(/Why we priced/);
    // A track measured for another moment is not used.
    expect(planRender({ ...base, tracked: { ...tracked, key: `${id}:0:30` } }, ctx).compose.segments[0].follow).toBeUndefined();
    // Two speakers on the people found; a screen and a camera where the owner put them; the whole picture.
    const speakers = planRender({ ...clipSpec(id, { layout: "speakers" }, { start: 30, end: 66 }), tracked }, ctx).compose.segments[0];
    expect(speakers.panes!.map((p) => p.height)).toEqual([960, 960]);
    expect(speakers.panes![0].x).toBeLessThan(0.25);
    expect(speakers.panes![1].x).toBeGreaterThan(0.5);
    expect(speakers.follow).toBeUndefined();
    const screen = planRender(clipSpec(id, { layout: "screen", captions: false, cuts: false }), ctx).compose;
    expect(screen.segments[0]).toMatchObject({ duration: 33, panes: [{ height: 768 }, { height: 1152, x: expect.any(Number) }] });
    expect(screen.segments[0].keep).toBeUndefined();
    expect(screen.ass).not.toContain("WORD1");
    expect(planRender(clipSpec(id, { layout: "fit" }), ctx).compose.segments[0].fit).toBe("contain");
    expect(planRender(clipSpec(id, { layout: "crop" }), ctx).compose.segments[0].panes).toEqual([{ x: 0.3418, y: 0, w: 0.3164, h: 1, height: 1920 }]);
    // Music under the whole clip; the free trial's mark.
    const track = crypto.randomUUID();
    const scored = planRender({ ...base, music: { trackId: track, volume: 0.2 } }, { ...ctx, media: { ...ctx.media, [track]: { key: "library/t/a.mp3", kind: "audio", duration: 30 } }, watermark: "Hookstreak Shorts" }).compose;
    expect(scored.music).toEqual({ input: 1, volume: 0.2, duck: [[0, scored.segments[0].duration]] });
    expect(scored.ass).toContain("Hookstreak Shorts");
    // The owner's own video is AI-made only through a library track marked as made with AI.
    expect(scored.synthetic).toBe(false);
    expect(planRender({ ...base, music: { trackId: track, volume: 0.2 } }, { ...ctx, media: { ...ctx.media, [track]: { key: "library/t/a.mp3", kind: "audio", duration: 30, ai: true } }, watermark: "" }).compose.synthetic).toBe(true);
    // The source must be a video, and the moment must fit the renderer's three minutes.
    expect(() => planRender(base, { media: { [id]: { ...ctx.media[id], kind: "audio" } }, watermark: "" })).toThrow("MEDIA_INPUT");
  });
});

/** A renderer container that checks uploads, tracks speakers and renders at once (see renderer/server.py). */
function renderer(log: any[], track: unknown = { v: 1, points: [[33, 0.3]], faces: [[0.25, 0.4], [0.75, 0.42]] }) {
  const jobs = new Map<string, any>();
  return {
    idFromName: (n: string) => n,
    get: () => ({
      fetch: async (url: string, init: any = {}) => {
        const path = new URL(url).pathname.split("/").filter(Boolean);
        if (init.method === "POST") { const p = JSON.parse(init.body); if (!jobs.has(p.id)) log.push(p); jobs.set(p.id, p); return Response.json({ status: "running" }, { status: 202 }); }
        if (init.method === "DELETE") return Response.json({});
        const job = jobs.get(path[1]);
        if (!job) return new Response("{}", { status: 404 });
        if (path[2] === "file") return new Response(new Uint8Array(path[3] === "0" ? 4000 : 64).fill(7));
        if (job.operation === "track") return Response.json({ status: "completed", duration: job.length, files: 0, track });
        return Response.json({ status: "completed", duration: 30, files: 2 });
      },
    }),
  };
}
const step = { do: async (_name: string, a: any, b?: any) => (b ?? a)(), sleep: async () => {} };
async function setup(plan: "starter" | null = "starter") {
  const log: any[] = [];
  const { env, sqlite } = testEnv({ MEDIA_ENABLED: "true", ELEVENLABS_API_KEY: "el", MEDIA_RENDERER: renderer(log) });
  const user = signedIn(sqlite);
  if (plan) subscribe(sqlite, user.id, plan);
  await call(worker, env, "GET", "/api/auth/me", undefined, user.cookie);
  /** A checked video upload of `duration` seconds; with `words`, its speech was found. */
  const source = (duration: number, words?: CaptionWord[], extra: Record<string, unknown> = {}) => {
    const id = crypto.randomUUID();
    const meta = words ? { hasAudio: true, speech: { status: "found", at: 1, language: "eng" }, transcript: { language: "eng", words } } : { hasAudio: true };
    sqlite.prepare("INSERT INTO media_assets(id,user_id,kind,name,object_key,mime,bytes,duration,width,height,status,meta,created_at,updated_at) VALUES (?,?,'upload','Podcast.mp4',?,'video/mp4',5000,?,1920,1080,'ready',?,1,1)")
      .run(id, user.id, `media/${user.id}/${id}.mp4`, duration, JSON.stringify({ ...meta, ...extra }));
    // The file itself (a transcription uploads it to Scribe).
    void env.MEDIA.put(`media/${user.id}/${id}.mp4`, new Uint8Array(5000).fill(7), { httpMetadata: { contentType: "video/mp4" } });
    return id;
  };
  const used = () => (sqlite.prepare("SELECT used FROM usage_windows WHERE user_id=? ORDER BY created_at DESC LIMIT 1").get(user.id) as any).used as number;
  const run = async () => { for (const c of env.CONTENT.created.splice(0)) await new ContentGeneration({} as any, env).run({ payload: c.params } as any, step as any); };
  const meta = (id: string) => JSON.parse((sqlite.prepare("SELECT meta FROM media_assets WHERE id=?").get(id) as any).meta);
  return { env, sqlite, user, log, source, used, run, meta };
}
/** Scribe: answers `words` for every file it is sent (or fails with `status`). */
function scribe(words: CaptionWord[], status = 200) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (url: string, init: any) => {
    if (url !== SCRIBE_URL) throw new Error("unexpected " + url);
    // The stored video itself is uploaded (multipart, streamed).
    const form = await new Response(init.body, { headers: { "Content-Type": init.headers["Content-Type"] } }).formData();
    calls.push((form.get("file") as File).name);
    if (status !== 200) return new Response("{}", { status });
    return Response.json({ language_code: "eng", words: words.map((w) => ({ ...w, type: "word" })) });
  });
  return calls;
}
afterEach(() => vi.unstubAllGlobals());
const twoPicks = (input: { transcript: string }) => {
  const at = firstLine(input.transcript);
  return { clips: [pick(at, at + 10, { hook: 10 }), pick(at + 12, at + 22)] };
};

describe("finding clips in a video", () => {
  it("finds them at once when its speech is known, within 20 searches a day", async () => {
    const { env, user, source, meta, sqlite } = await setup();
    const words = transcript(150);
    const id = source(600, words, { transcript: { language: "eng", words, events: [{ text: "laughter", start: 5, end: 6 }] } });
    const seen = ai(env, twoPicks);
    const found = await call(worker, env, "POST", `/api/highlights/sources/${id}/find`, { count: 5, length: "medium", idempotencyKey: crypto.randomUUID() }, user.cookie);
    expect(found.status).toBe(200);
    // People laughed in the first moment: the writer heard it, and its virality score has 3 more.
    expect(seen[0].transcript).toContain("end1. [laughter]");
    expect(found.data.source.moments.map((m: Moment) => [m.score, m.reactions])).toEqual([[82, 1], [72, 0]]);
    expect(meta(id).moments).toMatchObject({ list: expect.any(Array), request: { count: 5, length: "medium", focus: "" } });
    // The list of sources: the video with its moments (never its transcript) and the clips made of it.
    const list = await call(worker, env, "GET", "/api/highlights/sources", undefined, user.cookie);
    expect(list.data.sources).toEqual([expect.objectContaining({ id, moments: expect.any(Array), clips: 0, transcribeCredits: 0, speech: "found" })]);
    expect(JSON.stringify(list.data)).not.toContain('"transcript"');
    // A search that finds nothing gives its search back; the day's searches are bounded.
    ai(env, () => ({ clips: [pick(0, 1)] }));
    const none = await call(worker, env, "POST", `/api/highlights/sources/${id}/find`, { count: 3, length: "long", idempotencyKey: crypto.randomUUID() }, user.cookie);
    expect([none.status, none.data.error]).toEqual([422, "We couldn't find moments of 60 to 90 seconds that stand on their own. Try another length or focus."]);
    await take(env, "moments-day", DAY, user.id, MOMENT_SEARCHES_PER_DAY - 1, MOMENT_SEARCHES_PER_DAY);
    ai(env, twoPicks);
    const tired = await call(worker, env, "POST", `/api/highlights/sources/${id}/find`, { count: 3, length: "medium", idempotencyKey: crypto.randomUUID() }, user.cookie);
    expect(tired.status).toBe(429);
    // Someone else's video is not found.
    const someone = signedIn(sqlite);
    expect((await call(worker, env, "POST", `/api/highlights/sources/${id}/find`, { count: 3, idempotencyKey: crypto.randomUUID() }, someone.cookie)).status).toBe(404);
  });

  it("transcribes a short video for free first, then finds the clips in the background", async () => {
    const { env, user, source, run, meta, used } = await setup();
    const id = source(300);
    const calls = scribe(transcript(80));
    ai(env, twoPicks);
    const asked = await call(worker, env, "POST", `/api/highlights/sources/${id}/find`, { count: 3, length: "medium", focus: "pricing", idempotencyKey: crypto.randomUUID() }, user.cookie);
    expect(asked.status).toBe(202);
    expect(asked.data.source).toMatchObject({ speech: "pending", wanted: { count: 3, length: "medium", focus: "pricing" }, moments: [] });
    expect(env.CONTENT.created.map((c: any) => c.params)).toEqual([{ inspectId: id }]);
    await run();
    expect(calls).toHaveLength(1);
    expect(used()).toBe(0);
    const after = meta(id);
    expect(after.speech.status).toBe("found");
    expect(after.wanted).toBeUndefined();
    expect(after.moments.list).toHaveLength(2);
    expect(after.moments.request.focus).toBe("pricing");
  });

  it("charges a long video's transcription once, and gives the credits back when it fails", async () => {
    const { env, user, source, run, meta, used, sqlite } = await setup();
    const id = source(3000);
    expect(speechCredits(3000)).toBe(2);
    const view = (await call(worker, env, "GET", `/api/highlights/sources/${id}`, undefined, user.cookie)).data.source;
    expect(view).toMatchObject({ transcribeCredits: 2, speech: null });
    const key = crypto.randomUUID();
    const wrong = await call(worker, env, "POST", `/api/highlights/sources/${id}/find`, { count: 5, credits: 1, idempotencyKey: key }, user.cookie);
    expect([wrong.status, wrong.data.error]).toEqual([409, "Transcribing this video costs 2 credits. Check the price and try again."]);
    const paid = await call(worker, env, "POST", `/api/highlights/sources/${id}/find`, { count: 5, credits: 2, idempotencyKey: key }, user.cookie);
    expect([paid.status, paid.data.credits]).toEqual([202, 2]);
    expect(used()).toBe(2);
    // The same request again, or another search while it is transcribed: nothing more is charged.
    expect((await call(worker, env, "POST", `/api/highlights/sources/${id}/find`, { count: 5, credits: 2, idempotencyKey: key }, user.cookie)).status).toBe(202);
    const later = await call(worker, env, "POST", `/api/highlights/sources/${id}/find`, { count: 8, length: "short", credits: 2, idempotencyKey: crypto.randomUUID() }, user.cookie);
    expect([later.status, later.data.source.wanted.count]).toEqual([202, 8]);
    expect(used()).toBe(2);
    expect(sqlite.prepare("SELECT kind,credits,status FROM runs").all()).toEqual([{ kind: "speech", credits: 2, status: "queued" }]);
    scribe(transcript(400));
    ai(env, (input) => { const at = firstLine(input.transcript); return { clips: [pick(at, at + 6, { hook: 9 }), pick(at + 8, at + 14)] }; });
    await run();
    expect(sqlite.prepare("SELECT status FROM runs").get()).toEqual({ status: "completed" });
    expect(meta(id)).toMatchObject({ speech: { status: "found" }, moments: { request: { count: 8, length: "short" } } });
    expect(used()).toBe(2);

    // A transcription that fails is refunded and says why on the page.
    const failing = source(4000);
    const asked = await call(worker, env, "POST", `/api/highlights/sources/${failing}/find`, { count: 5, credits: 3, idempotencyKey: crypto.randomUUID() }, user.cookie);
    expect(asked.status).toBe(202);
    expect(used()).toBe(5);
    scribe([], 500);
    await run();
    expect(used()).toBe(2);
    expect(meta(failing)).toMatchObject({ speech: { status: "failed" }, momentsError: "We couldn't transcribe this video. Try again." });
    expect(meta(failing).wanted).toBeUndefined();
  });

  it("refuses videos without sound or speech, and long videos when credits do not cover them", async () => {
    const { env, user, source } = await setup(null);
    const silent = source(300, undefined, { hasAudio: false });
    const find = (id: string, body: Record<string, unknown> = {}) => call(worker, env, "POST", `/api/highlights/sources/${id}/find`, { count: 5, idempotencyKey: crypto.randomUUID(), ...body }, user.cookie);
    expect((await find(silent)).data.error).toBe("This video has no sound. Clips are cut from what people say.");
    const quiet = source(300, undefined, { speech: { status: "none", at: 1 } });
    expect((await find(quiet)).status).toBe(409);
    // The free trial's 4 credits do not cover 2 hours (4 credits) and something else already spent.
    const long = source(7200);
    expect((await find(long, { credits: 4 })).status).toBe(202);
    const longer = source(7000);
    const refused = await find(longer, { credits: 4 });
    expect([refused.status, refused.data.error]).toEqual([402, "This needs 4 credits and you have 0 credits left. Upgrade or add a credit pack."]);
    expect((await call(worker, env, "GET", `/api/highlights/sources/${crypto.randomUUID()}`, undefined, user.cookie)).status).toBe(404);
  });
});

describe("making clips", () => {
  it("tracks the speaker once per moment, renders the clip, and re-renders edits for free", async () => {
    const { env, user, source, run, used, log, sqlite } = await setup();
    const id = source(3600, transcript(40, 30));
    const spec = momentSpec(id, MOMENT, defaultClipOptions);
    const made = await call(worker, env, "POST", "/api/videos", { spec, idempotencyKey: crypto.randomUUID() }, user.cookie);
    expect([made.status, made.data.credits]).toEqual([201, 1]);
    expect(used()).toBe(1);
    await run();
    expect(log.map((p) => p.operation)).toEqual(["track", "compose"]);
    // When someone talks in the moment, phrase by phrase with the pauses between (no speakers told apart in this
    // transcript), so the crop can find whose lips move with the voice.
    expect(log[0]).toMatchObject({ start: 33, length: 33, url: expect.stringMatching(/^https:\/\/app\.test\/api\/render-inputs\//) });
    expect(log[0].turns.slice(0, 2)).toEqual([[33.3, 36.05, -1], [36.6, 39.35, -1]]);
    expect([log[0].turns.length, log[0].turns.at(-1)]).toEqual([10, [63, 65.75, -1]]);
    expect(log[1].segments[0]).toMatchObject({ kind: "video", trim: 33, audio: 1, follow: [[0, 0.3], [expect.any(Number), 0.3]] });
    expect(log[1].synthetic).toBe(false);
    let video = (await call(worker, env, "GET", `/api/videos/${made.data.id}`, undefined, user.cookie)).data.video;
    expect(video).toMatchObject({ renderStatus: "ready", title: "Why we priced it at $9", hook: "Why we priced it at $9" });
    expect(video.spec.tracked).toMatchObject({ key: `${id}:33:66@${TRACKER}`, track: { faces: [[0.25, 0.4], [0.75, 0.42]] } });
    const render = sqlite.prepare("SELECT meta FROM media_assets WHERE id=?").get(video.videoAssetId) as any;
    expect(render.meta).toBe("{}");
    // The clip is listed with its video.
    expect((await call(worker, env, "GET", `/api/highlights/sources/${id}`, undefined, user.cookie)).data.clips.map((c: any) => c.id)).toEqual([made.data.id]);

    // Two speakers on the same moment: the people already found place the panes, nothing is tracked again, free.
    const edit = async (change: (s: any) => any) => {
      const r = await call(worker, env, "PUT", `/api/videos/${made.data.id}`, { spec: change(video.spec), idempotencyKey: crypto.randomUUID() }, user.cookie);
      await run();
      video = (await call(worker, env, "GET", `/api/videos/${made.data.id}`, undefined, user.cookie)).data.video;
      return r;
    };
    log.length = 0;
    const reframed = await edit((s) => ({ ...s, layout: layoutFor("speakers"), tracked: { key: "forged", track: { v: 1, points: [] } } }));
    expect([reframed.status, reframed.data.credits]).toEqual([200, 0]);
    expect(log.map((p) => p.operation)).toEqual(["compose"]);
    expect(log[0].segments[0].panes.map((p: any) => p.height)).toEqual([960, 960]);
    expect(video.spec.tracked.key).toBe(`${id}:33:66@${TRACKER}`);
    // A new moment is tracked again (here the transcription told two speakers apart: the renderer gets who talks
    // when); moved onto other footage it costs a new clip.
    log.length = 0;
    const heard = { language: "eng", words: transcript(40, 30), turns: [[60, 80, 0], [80.5, 95, 1], [95.5, 140, 0]] };
    sqlite.prepare("UPDATE media_assets SET meta=? WHERE id=?").run(JSON.stringify({ hasAudio: true, speech: { status: "found", at: 1, language: "eng" }, transcript: heard }), id);
    const moved = await edit((s) => ({ ...s, layout: { kind: "follow" }, source: { ...s.source, start: 70, end: 100 } }));
    expect(moved.data.credits).toBe(1);
    expect(log.map((p) => p.operation)).toEqual(["track", "compose"]);
    // Phrase by phrase, each with the speaker of the turn it falls in.
    // (words in the short gaps between turns go with the nearest turn).
    expect(log[0].turns).toEqual([
      [70, 72.35, 0], [72.9, 75.65, 0], [76.2, 78.95, 0], [79.5, 80.15, 0], [80.2, 82.25, 1], [82.8, 85.55, 1], [86.1, 88.85, 1],
      [89.4, 92.15, 1], [92.7, 95.1, 1], [95.15, 95.45, 0], [96, 98.75, 0], [99.3, 99.95, 0],
    ]);
    expect(used()).toBe(2);
    // Post text only: no render.
    log.length = 0;
    expect((await edit((s) => ({ ...s, caption: "New words", moment: null }))).data.rendering).toBe(false);
    expect(log).toEqual([]);
    // A clip can't turn into a narrated video.
    const story = specSchema.parse({ narration: { kind: "voice", voiceId: "george" }, scenes: [{ text: "Hello there.", description: "A wave" }] });
    expect((await call(worker, env, "PUT", `/api/videos/${made.data.id}`, { spec: story, idempotencyKey: crypto.randomUUID() }, user.cookie)).status).toBe(400);
  });

  it("are cut only from the owner's own videos, within them", async () => {
    const { env, user, source, sqlite } = await setup();
    const make = (spec: unknown) => call(worker, env, "POST", "/api/videos", { spec, idempotencyKey: crypto.randomUUID() }, user.cookie);
    const picture = crypto.randomUUID();
    sqlite.prepare("INSERT INTO media_assets(id,user_id,kind,name,object_key,mime,bytes,status,created_at,updated_at) VALUES (?,?,'upload','Photo',?,'image/jpeg',10,'ready',1,1)")
      .run(picture, user.id, `media/${user.id}/${picture}.jpg`);
    expect((await make(momentSpec(picture, MOMENT, defaultClipOptions))).data.error).toBe("Clips are cut from your own videos. Choose one of them.");
    const short = source(30, transcript(8));
    expect((await make(momentSpec(short, MOMENT, defaultClipOptions))).data.error).toBe("This moment starts after the end of the video. Choose it again.");
    const someone = signedIn(sqlite);
    await call(worker, env, "GET", "/api/auth/me", undefined, someone.cookie);
    const theirs = crypto.randomUUID();
    sqlite.prepare("INSERT INTO media_assets(id,user_id,kind,name,object_key,mime,bytes,duration,status,created_at,updated_at) VALUES (?,?,'upload','Theirs',?,'video/mp4',10,600,'ready',1,1)")
      .run(theirs, someone.id, `media/${someone.id}/${theirs}.mp4`);
    expect((await make(momentSpec(theirs, MOMENT, defaultClipOptions))).status).toBe(400);
  });
});
