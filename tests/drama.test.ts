import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../server/index";
import { runEpisode } from "../server/series";
import { joinSpeech, speakDialogue, TURN_PAUSE } from "../server/providers/elevenlabs";
import { call, signedIn, subscribe, testEnv } from "./helpers";
import { castSubject, dramaSchema } from "../shared/drama";
import { narrationKey, narrationVoice, voicedScript, voiceRuns } from "../shared/story";
import { narrationCurrent, storySpec } from "../shared/formats";
import { seriesSettingsSchema, seriesSubject } from "../shared/series";

// Drama series (a test, for administrators): a series with a cast and a premise whose episodes continue one story.
// Each episode's writer reads what happened before, cast members speak in their own voices, the cast is the series'
// recurring characters, and the series stops when the season's last episode is made.

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => {}); });

const cast = [
  { name: "Mara", role: "A night nurse hiding a debt", look: "a woman of 30, short black hair, a red coat", voiceId: "sarah" },
  { name: "Ilya", role: "Her missing brother", look: "a thin man of 25 in a grey hoodie", voiceId: "liam" },
];
const drama = { premise: "A night nurse finds a patient who knows a secret about her missing brother.", episodes: 3, cast };
/** What the text model answers when asked for an episode: two cast members talk, the narrator bridges. */
const written = (n: number) => ({
  status: "completed",
  output_text: JSON.stringify({
    title: `The letter ${n}`, topic: "Night ward", caption: "She should not have opened it.", hashtags: ["#drama"], headline: `The letter ${n}`, subject: "ignored", look: "", places: [], music: "",
    summary: `In episode ${n} Mara opens the letter and Ilya runs.`,
    scenes: [
      { text: "Where were you last night?", picture: "Mara stands in the corridor, arms crossed", keys: [], tone: "", place: "", speaker: "Mara" },
      { text: "I can't tell you. Not yet.", picture: "Ilya looks away by the window", keys: [], tone: "", place: "", speaker: "ilya" },
      { text: "The lights go out across the ward.", picture: "A dark hospital corridor", keys: [], tone: "", place: "", speaker: "narrator" },
      { text: "Then who is that at the door?", picture: "Mara turns towards a door", keys: [], tone: "", place: "", speaker: "Mara" },
    ],
  }),
});
function setup() {
  const { env, sqlite } = testEnv({ MEDIA_ENABLED: "true", FAL_KEY: "fal", ELEVENLABS_API_KEY: "el" });
  const admin = signedIn(sqlite, "admin@example.com"), user = signedIn(sqlite);
  subscribe(sqlite, admin.id, "studio");
  subscribe(sqlite, user.id, "studio");
  const asked: { instructions: string; input: any }[] = [];
  env.AI.run = async (_model: string, request: any) => {
    asked.push({ instructions: request.instructions, input: JSON.parse(request.input) });
    return written(asked.length);
  };
  const settings = (more: Record<string, unknown> = {}) => ({ schedule: { timezone: "UTC", times: ["09:00"], days: [0, 1, 2, 3, 4, 5, 6] }, voiceId: "george", style: "cinematic", drama, ...more });
  const create = (who: { cookie: string }, body: Record<string, unknown> = {}) =>
    call(worker, env, "POST", "/api/series", { name: "Night ward", template: "story", first: false, settings: settings(), ...body }, who.cookie);
  const row = (id: string) => sqlite.prepare("SELECT * FROM series WHERE id=?").get(id) as any;
  const videos = (id: string) => (sqlite.prepare("SELECT * FROM videos WHERE series_id=? ORDER BY created_at, rowid").all(id) as any[]).map((v) => ({ ...v, spec: JSON.parse(v.spec) }));
  return { env, sqlite, admin, user, asked, settings, create, row, videos };
}

describe("drama series", () => {
  it("are for administrators, on story styles, with a cast whose voices are offered", async () => {
    const s = setup();
    expect(await s.create(s.user)).toMatchObject({ status: 403, data: { error: expect.stringContaining("still being tested") } });
    expect((await s.create(s.admin, { template: "pov" })).status).toBe(400);
    expect((await s.create(s.admin, { settings: s.settings({ drama: { ...drama, cast: [{ ...cast[0], voiceId: "nobody" }] } }) })).status).toBe(400);
    // A premise, and a name and a look for everyone; no two characters of one name, none called Narrator, at most three.
    for (const bad of [
      { ...drama, premise: "Short" }, { ...drama, cast: [] }, { ...drama, cast: [cast[0], { ...cast[1], name: "mara" }] }, { ...drama, cast: [{ ...cast[0], name: "Narrator" }] },
      { ...drama, cast: [...cast, { ...cast[0], name: "Ana" }, { ...cast[0], name: "Bo" }] }, { ...drama, cast: [{ ...cast[0], look: "" }] },
    ]) expect(dramaSchema.safeParse(bad).success).toBe(false);
    const made = await s.create(s.admin);
    expect(made.status).toBe(201);
    expect(made.data.series.settings.drama).toEqual(drama);
    // The cast is the series' recurring characters, each called by name in every picture.
    expect(seriesSubject(seriesSettingsSchema.parse(s.settings()))).toBe("Mara: a woman of 30, short black hair, a red coat; Ilya: a thin man of 25 in a grey hoodie");
    expect(castSubject(cast).length).toBeLessThanOrEqual(300);
  });

  it("write each episode from the premise, the cast and what happened before, in the cast's voices, and stop when the season is told", async () => {
    const s = setup();
    const id = (await s.create(s.admin)).data.series.id as string;
    const next = async () => runEpisode(s.env, id, s.row(id).next_slot);
    // Episode 1: nothing has happened yet.
    expect(await next()).toMatchObject({ state: "made" });
    expect(s.asked[0].instructions).toContain("This is episode 1 of 3 of a serial drama");
    expect(s.asked[0].instructions).toContain("the last scene ends on a cliffhanger");
    expect(s.asked[0].input).toMatchObject({
      premise: drama.premise, storySoFar: [], subject: castSubject(cast), ownerRequest: "",
      cast: [{ name: "Mara", role: cast[0].role, look: cast[0].look }, { name: "Ilya", role: cast[1].role, look: cast[1].look }],
    });
    const [first] = s.videos(id);
    expect(first.title).toBe("Ep. 1: The letter 1");
    expect(first.spec.episode).toEqual({ n: 1, of: 3, summary: "In episode 1 Mara opens the letter and Ilya runs." });
    // Mara and Ilya speak in their own voices (whatever the writer's spelling of a name); the narrator in the series'.
    expect(first.spec.narration).toEqual({ kind: "voice", voiceId: "george" });
    expect(first.spec.scenes.map((x: any) => [x.speaker ?? null, x.voiceId ?? null])).toEqual([["Mara", "sarah"], ["Ilya", "liam"], [null, null], ["Mara", "sarah"]]);
    expect(first.spec.subject).toBe(castSubject(cast));

    // Episode 2 reads episode 1. A rejected episode leaves the story: the next one takes its number.
    expect(await next()).toMatchObject({ state: "made" });
    expect(s.asked[1].instructions).toContain("This is episode 2 of 3");
    expect(s.asked[1].instructions).toContain("Continue the story exactly where the story so far ends");
    expect(s.asked[1].input.storySoFar).toEqual([{ episode: 1, title: "The letter 1", summary: "In episode 1 Mara opens the letter and Ilya runs." }]);
    s.sqlite.prepare("UPDATE videos SET status='rejected' WHERE id=?").run(s.videos(id)[1].id);
    expect(await next()).toMatchObject({ state: "made" });
    expect(s.asked[2].input.storySoFar.map((e: any) => e.episode)).toEqual([1]);
    expect(s.videos(id)[2].spec.episode.n).toBe(2);
    // The last episode ends the story.
    expect(await next()).toMatchObject({ state: "made" });
    expect(s.asked[3].instructions).toContain("This is the final episode");
    expect(s.asked[3].instructions).not.toContain("ends on a cliffhanger");
    expect(s.videos(id)[3]).toMatchObject({ title: "Ep. 3: The letter 4", spec: { episode: { n: 3, of: 3 } } });

    // The page shows the story so far, in order.
    const page = (await call(worker, s.env, "GET", `/api/series/${id}`, undefined, s.admin.cookie)).data;
    expect(page.story.map((e: any) => [e.n, e.title])).toEqual([[1, "The letter 1"], [2, "The letter 3"], [3, "The letter 4"]]);
    expect(page.story[0].summary).toBe("In episode 1 Mara opens the letter and Ilya runs.");

    // The season is told: the series stops, its owner is told once, and nothing more is written or charged.
    const mails = s.env.EMAIL.sent.length, writes = s.asked.length;
    expect(await next()).toEqual({ state: "stopped" });
    expect(s.row(id)).toMatchObject({ status: "paused", blocked: "finished", next_slot: null });
    expect(s.env.EMAIL.sent.slice(mails).map((m: any) => m.subject)).toEqual(["“Night ward” is complete"]);
    expect(s.asked).toHaveLength(writes);
    const view = (await call(worker, s.env, "GET", `/api/series/${id}`, undefined, s.admin.cookie)).data.series;
    expect(view).toMatchObject({ status: "paused", blockedBy: "finished", blocked: expect.stringContaining("The season is complete") });
    const extra = await call(worker, s.env, "POST", `/api/series/${id}/episodes`, { idempotencyKey: crypto.randomUUID() }, s.admin.cookie);
    expect(extra).toMatchObject({ status: 409, data: { error: expect.stringContaining("The season is complete") } });
    // More episodes, and resumed: the story goes on from episode 4.
    const longer = await call(worker, s.env, "PATCH", `/api/series/${id}`, { status: "active", settings: { drama: { ...drama, episodes: 5 } } }, s.admin.cookie);
    expect(longer.data.series).toMatchObject({ status: "active", blocked: null });
    expect(await next()).toMatchObject({ state: "made" });
    expect(s.asked.at(-1)!.instructions).toContain("This is episode 4 of 5");
  });

  it("say a dialogue in its speakers' voices, one stretch after another, as one recording", async () => {
    const scenes = [{ voiceId: "sarah" }, { voiceId: "sarah" }, {}, { voiceId: "liam" }, { voiceId: "george" }, {}];
    // Neighbouring scenes of one voice are one stretch; a scene without a voice is the narrator's.
    expect(voiceRuns("george", scenes)).toEqual([{ voiceId: "sarah", from: 0, to: 2 }, { voiceId: "george", from: 2, to: 3 }, { voiceId: "liam", from: 3, to: 4 }, { voiceId: "george", from: 4, to: 6 }]);
    expect(voiceRuns("george", [{}, {}])).toEqual([{ voiceId: "george", from: 0, to: 2 }]);
    // The recording's key: unchanged while the narrator says everything, new when a scene goes to another voice.
    expect(narrationVoice("george", [{}, { voiceId: "george" }])).toBe("george");
    expect(narrationVoice("george", scenes)).not.toBe(narrationVoice("george", [{ voiceId: "liam" }, ...scenes.slice(1)]));
    const spec = storySpec.parse({
      narration: { kind: "voice", voiceId: "george" },
      scenes: [{ text: "Where were you?", description: "Mara waits", voiceId: "sarah", speaker: "Mara" }, { text: "The lights go out.", description: "A dark ward" }],
    });
    const recorded = { ...spec, generated: { key: narrationKey(narrationVoice("george", spec.scenes), voicedScript(spec.scenes)), voiceAssetId: crypto.randomUUID(), words: [] } };
    expect(narrationCurrent(recorded)).toBe(true);
    expect(narrationCurrent({ ...recorded, scenes: recorded.scenes.map((x) => ({ ...x, voiceId: undefined })) })).toBe(false);

    // Each stretch is spoken by its own ElevenLabs voice; the audio is joined with a breath between speakers.
    const said: { voice: string; text: string }[] = [];
    vi.stubGlobal("fetch", async (input: any, init: any = {}) => {
      const text = JSON.parse(init.body).text as string, chars = [...text];
      said.push({ voice: String(input).split("/")[5], text });
      return Response.json({
        audio_base64: Buffer.from(new Uint8Array(48000)).toString("base64"),
        alignment: { characters: chars, character_start_times_seconds: chars.map((_, i) => i / chars.length), character_end_times_seconds: chars.map((_, i) => (i + 1) / chars.length) },
      });
    });
    const env = testEnv({ ELEVENLABS_API_KEY: "el" }).env;
    const spoken = await speakDialogue(env, [{ voiceId: "sarah", text: "Where were you?" }, { voiceId: "liam", text: "Not yet." }, { voiceId: "george", text: "The lights go out." }]);
    expect(said).toEqual([
      { voice: "EXAVITQu4vr4xnSDxMaL", text: "Where were you?" }, { voice: "TX3LPaxmHKxFdv7VOQHJ", text: "Not yet." }, { voice: "JBFqnCBsd6RMkjVDRZzb", text: "The lights go out." },
    ]);
    expect(spoken.seconds).toBeCloseTo(3 + 2 * TURN_PAUSE, 5);
    expect(spoken.audio.length).toBe(44 + Math.round(spoken.seconds * 48000));
    expect(spoken.words.map((w) => w.text)).toEqual(["Where", "were", "you?", "Not", "yet.", "The", "lights", "go", "out."]);
    // The second speaker's words start after the first recording and the pause.
    expect(spoken.words[3].start).toBeCloseTo(1 + TURN_PAUSE, 2);
    expect(spoken.words.at(-1)!.end).toBeCloseTo(spoken.seconds, 2);
    expect(joinSpeech([]).seconds).toBe(0);
  });
});
