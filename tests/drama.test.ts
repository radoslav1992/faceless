import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../server/index";
import { runEpisode } from "../server/series";
import { joinSpeech, speakDialogue, TURN_PAUSE } from "../server/providers/elevenlabs";
import { call, signedIn, subscribe, testEnv } from "./helpers";
import { castSubject, cutawayPrompt, dramaSchema, filmCredits, filmPlaces, filmShots, lipSyncCredits, SHOT_MAX_WORDS, shotPrompt, shotSeconds, shotsSpec, shotStill, takeKey, takeOf, voiceSampleText } from "../shared/drama";
import { CLIP_CREDITS, videoCredits } from "../shared/credits";
import { FPS, narrationKey, narrationVoice, splitScene, storySegments, storyTiming, textWords, voicedScript, voiceRuns } from "../shared/story";
import { filmClock, isFilm, isShotFilm, narrationCurrent, pendingMedia, specCredits, storySpec } from "../shared/formats";
import { episodeCredits, seriesSettingsSchema, seriesSubject } from "../shared/series";

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
  it("run on story styles, with a cast whose voices are offered", async () => {
    const s = setup();
    // Anyone's: an ordinary account starts one.
    expect((await s.create(s.user)).status).toBe(201);
    expect((await s.create(s.admin, { template: "pov" })).status).toBe(400);
    expect((await s.create(s.admin, { settings: s.settings({ drama: { ...drama, cast: [{ ...cast[0], voiceId: "nobody" }] } }) })).status).toBe(400);
    // A premise, and a name and a look for everyone; no two characters of one name, none called Narrator, at most three.
    for (const bad of [
      { ...drama, premise: "Short" }, { ...drama, cast: [] }, { ...drama, cast: [cast[0], { ...cast[1], name: "mara" }] }, { ...drama, cast: [{ ...cast[0], name: "Narrator" }] },
      { ...drama, cast: [...cast, { ...cast[0], name: "Ana" }, { ...cast[0], name: "Bo" }] }, { ...drama, cast: [{ ...cast[0], look: "" }] },
    ]) expect(dramaSchema.safeParse(bad).success).toBe(false);
    const made = await s.create(s.admin);
    expect(made.status).toBe(201);
    expect(made.data.series.settings.drama).toEqual({ ...drama, lipSync: false, film: false, filmVoices: "exact" });
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

  it("lip-sync the cast's scenes when asked, and count their clips in an episode's price", async () => {
    const s = setup();
    const plain = seriesSettingsSchema.parse(s.settings()), synced = seriesSettingsSchema.parse(s.settings({ drama: { ...drama, lipSync: true } }));
    // Seven tenths of a 45-second episode as high-quality clips, on top of the episode.
    expect(episodeCredits(synced)).toBe(episodeCredits(plain) + lipSyncCredits(45));
    expect(lipSyncCredits(45)).toBe(Math.ceil(45 * 0.7 / 5) * CLIP_CREDITS.high);
    const id = (await s.create(s.admin, { settings: s.settings({ drama: { ...drama, lipSync: true } }) })).data.series.id as string;
    expect(await runEpisode(s.env, id, s.row(id).next_slot)).toMatchObject({ state: "made" });
    const [first] = s.videos(id);
    // Mara's and Ilya's scenes are lip-synced clips, cut in hard; the narrator's stays a picture.
    expect(first.spec.scenes.map((x: any) => [x.source, x.lipSync ?? null, x.clipQuality, x.transition])).toEqual([
      ["clip", true, "high", "cut"], ["clip", true, "high", "cut"], ["image", null, "regular", "auto"], ["clip", true, "high", "cut"],
    ]);
    const run = s.sqlite.prepare("SELECT credits FROM runs WHERE video_id=?").get(first.id) as any;
    expect(run.credits).toBe(specCredits(first.spec, true));
    expect(run.credits).toBeLessThanOrEqual(episodeCredits(synced));
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

  it("shoot an episode as a film in the cast's exact voices: the dialogue recorded, speakers lip-synced, cutaways under the line", async () => {
    const s = setup();
    // A film speaks in the cast's own voices unless it is set to the video model's.
    const filmed = seriesSettingsSchema.parse(s.settings({ drama: { ...drama, film: true } }));
    expect(filmed.drama!.filmVoices).toBe("exact");
    expect(episodeCredits(filmed)).toBe(videoCredits(45) + filmCredits(45));
    const id = (await s.create(s.admin, { settings: s.settings({ drama: { ...drama, film: true } }) })).data.series.id as string;
    expect(await runEpisode(s.env, id, s.row(id).next_slot)).toMatchObject({ state: "made" });
    // Written as a film all the same.
    expect(s.asked.at(-1)!.instructions).toContain("You write the shooting script of an episode of a short vertical drama");
    const [first] = s.videos(id);
    expect(first.spec.film).toBe(true);
    expect(isShotFilm(first.spec)).toBe(true);
    expect(isFilm(first.spec)).toBe(false);
    // A shot that shows its speaker is lip-synced to their line; the narrator's line plays over a cutaway. None is acted.
    expect(first.spec.scenes.map((x: any) => [x.source, x.lipSync ?? null, x.cutaway ?? null, x.acted ?? null, x.clipQuality, x.transition, x.speaker ?? null, x.voiceId ?? null])).toEqual([
      ["clip", true, null, null, "high", "cut", "Mara", "sarah"], ["clip", true, null, null, "high", "cut", "Ilya", "liam"],
      ["clip", null, true, null, "high", "cut", null, null], ["clip", true, null, null, "high", "cut", "Mara", "sarah"],
    ]);
    // The dialogue is recorded (part of the video's price); every shot is a high-quality clip.
    const media = pendingMedia(first.spec);
    expect(media.filter((m) => m.kind === "clip").map((m) => [!!m.lipSync, !!m.cutaway, !!m.acted, m.quality])).toEqual([[true, false, false, "high"], [true, false, false, "high"], [false, true, false, "high"], [true, false, false, "high"]]);
    const run = s.sqlite.prepare("SELECT credits FROM runs WHERE video_id=?").get(first.id) as any;
    expect(run.credits).toBe(specCredits(first.spec, true));
    expect(run.credits).toBe(videoCredits(8) + 4 * CLIP_CREDITS.high);
    expect(first.spec.sounds).toBeUndefined();
    // A cutaway's prompt: the picture brought to life, nobody speaking.
    expect(cutawayPrompt({ description: "A sealed letter on a steel tray" }, 1)).toBe(
      "A sealed letter on a steel tray. A locked-off camera. Natural, physically plausible motion at real speed. Nobody speaks: mouths stay closed or still, people listen, look, react or work. "
      + "Keep the characters, their clothes, the place and the look exactly as in the image. No subtitles or text on screen. Sound: the quiet ambience of the place only, no speech, no voices and no music.",
    );
  });

  it("shoot an episode as a film spoken by the video model: written in shots, every one an acted clip, priced by its shots", async () => {
    const s = setup();
    const plain = seriesSettingsSchema.parse(s.settings()), filmed = seriesSettingsSchema.parse(s.settings({ drama: { ...drama, film: true, lipSync: true, filmVoices: "model" }, animate: 2 }));
    // A shot per three and a half seconds, each a high-quality clip; nothing else is animated or lip-synced in a film.
    expect(filmShots(45)).toBe(13);
    expect(filmCredits(45)).toBe(13 * CLIP_CREDITS.high);
    expect(episodeCredits(filmed)).toBe(videoCredits(45) + filmCredits(45));
    expect(episodeCredits(plain)).toBe(videoCredits(45));
    const id = (await s.create(s.admin, { settings: s.settings({ drama: { ...drama, film: true, lipSync: true, filmVoices: "model" }, animate: 2 }) })).data.series.id as string;
    expect(await runEpisode(s.env, id, s.row(id).next_slot)).toMatchObject({ state: "made" });
    // The writer is asked for shots: one short line each, no narrator, the camera on the speaker or cutting away.
    const { instructions } = s.asked.at(-1)!;
    expect(instructions).toContain("You write the shooting script of an episode of a short vertical drama");
    expect(instructions).toContain("split into exactly 13 scenes");
    expect(instructions).toContain(`at most ${SHOT_MAX_WORDS} words`);
    expect(instructions).toContain("There is no narrator");
    expect(instructions).toContain("cut away instead while the line is heard off screen");
    expect(instructions).not.toContain("the narrator only bridges time and place");
    // And for scenes that hold together: one place per scene, lines that fit who is there, a place for every shot.
    expect(instructions).toContain("The episode plays as scenes. A scene is a run of shots that follow each other in one place at one moment");
    expect(instructions).toContain("Whoever a line is kept from (the guests, the boss, a rival) is somewhere else for the whole scene");
    expect(instructions).toContain("at most 2 of them (one is often enough), and every shot's `place` is the label of the place its scene is set in");
    expect(filmPlaces(30)).toBe(2);
    expect(filmPlaces(60)).toBe(3);
    expect(filmPlaces(120)).toBe(4);
    const [first] = s.videos(id);
    // Every scene is an acted shot from its picture, cut in hard, with the film look; its speaker's voice goes with it.
    expect(first.spec.film).toBe(true);
    expect(isFilm(first.spec)).toBe(true);
    expect(first.spec.scenes.map((x: any) => [x.source, x.acted, x.clipQuality, x.transition, x.lipSync ?? null, x.speaker ?? null, x.voiceId ?? null])).toEqual([
      ["clip", true, "high", "cut", null, "Mara", "sarah"], ["clip", true, "high", "cut", null, "Ilya", "liam"], ["clip", true, "high", "cut", null, null, null], ["clip", true, "high", "cut", null, "Mara", "sarah"],
    ]);
    // Its shots bring their own sound: no sound effects were chosen, and no narration will be recorded or charged.
    expect(first.spec.sounds).toBeUndefined();
    expect(first.spec.scenes.every((x: any) => !x.soundId)).toBe(true);
    const run = s.sqlite.prepare("SELECT credits FROM runs WHERE video_id=?").get(first.id) as any;
    expect(run.credits).toBe(specCredits(first.spec, true));
    expect(run.credits).toBe(videoCredits(8) + 4 * CLIP_CREDITS.high);
    expect(run.credits).toBeLessThanOrEqual(episodeCredits(filmed));
    expect(pendingMedia(first.spec).filter((m) => m.acted).map((m) => m.acted!.voiceId)).toEqual(["sarah", "liam", "george", "sarah"]);
  });

  it("describe a shot to the video model: the line said on screen by the speaker it shows, off screen otherwise, in the speaker's voice", () => {
    const seen = { description: "Close-up of Mara in the corridor, arms crossed", text: 'Where were you  last "night"?', speaker: "Mara", tone: "whispers" as const };
    expect(shotPrompt(seen, 0, "English")).toBe(
      "Close-up of Mara in the corridor, arms crossed. Mara says in a whisper, \"Where were you last 'night'?\" A slow push-in. Natural acting at real speed, Mara's lips moving with the words; "
      + "keep the characters, their clothes, the place and the look exactly as in the image. No subtitles or text on screen. Sound: the voice is the voice of Audio 1, close and clear, speaking English; the quiet ambience of the place; no music.",
    );
    // A cutaway (the picture does not show the speaker) and a line nobody of the cast says are heard off screen.
    expect(shotPrompt({ ...seen, description: "A sealed letter on a steel tray", tone: "" }, 1)).toContain("Off screen, Mara's voice says, \"Where were you last 'night'?\" Nobody on screen speaks. A locked-off camera.");
    expect(shotPrompt({ description: "A dark hospital corridor", text: "The lights go out.", tone: "" }, 2)).toContain("Off screen, a narrator's voice says, \"The lights go out.\"");
    // The picture a shot starts from shows the speaker's face when they are in it.
    expect(shotStill(seen)).toContain("Mara's face is clearly visible");
    expect(shotStill({ description: "A sealed letter", speaker: "Mara" })).not.toContain("face");
    // The clip is asked for the line's length and a moment around it, in half seconds, from 3 up.
    expect(shotSeconds("No.")).toBe(3);
    expect(shotSeconds("Where were you last night? I waited until the morning.")).toBe(5);
    expect(shotSeconds("x".repeat(400))).toBe(14);
    // The voice's sample reads its own lines of the episode, then others' when those are few.
    const lines = [{ text: "Where were you?", voiceId: "sarah" }, { text: "The lights go out across the whole ward, one room after another, until the corridor is dark." }, { text: "Not yet.", voiceId: "liam" }];
    expect(voiceSampleText(lines, "liam", "george")).toBe("Not yet. Where were you? The lights go out across the whole ward, one room after another, until the corridor is dark.");
    expect(voiceSampleText(lines, "george", "george").startsWith("The lights go out")).toBe(true);
    expect(voiceSampleText([{ text: "word ".repeat(80) }], "george", "george").length).toBeLessThanOrEqual(180);
  });

  it("take a shot from what is heard in its clip, and put the film on its takes' clock", () => {
    const text = "Where were you last night?";
    const heard = (from: number, list = textWords(text)) => list.map((w, i) => ({ text: w, start: from + i * 0.3, end: from + i * 0.3 + 0.25 }));
    // The line was heard: the shot starts a moment before its first word and ends a moment after its last.
    const take = takeOf(text, heard(1), 5);
    expect(take.score).toBe(1);
    // (On the frame grid: a quarter of a second before the first word, to the nearest frame.)
    expect(take.trim).toBeCloseTo(0.75, 1);
    expect(take.seconds).toBeCloseTo(1 + 4 * 0.3 + 0.25 + 0.45 - take.trim, 1);
    expect(take.words.map((w) => w.text)).toEqual(textWords(text));
    expect(take.words[0].start).toBeCloseTo(1 - take.trim, 2);
    expect(Math.abs(take.trim * FPS - Math.round(take.trim * FPS))).toBeLessThan(1e-6);
    expect(Math.abs(take.seconds * FPS - Math.round(take.seconds * FPS))).toBeLessThan(1e-6);
    // A word said differently still counts as heard; a line starting at once is not trimmed below zero.
    expect(takeOf(text, heard(0.1, ["Where", "were", "you", "last", "evening"]), 5)).toMatchObject({ score: 0.8, trim: 0 });
    // Something else was said (or nothing): the whole clip, the words spread over it, and a score that asks for another take.
    const missed = takeOf(text, heard(1, ["I", "have", "no", "idea"]), 5);
    expect(missed).toMatchObject({ score: 0, trim: 0, seconds: 5 });
    expect(missed.words.map((w) => w.text)).toEqual(textWords(text));
    expect(missed.words.at(-1)!.end).toBeLessThanOrEqual(5);
    expect(takeOf(text, [], 4.2)).toMatchObject({ score: 0, trim: 0 });

    // A film: every scene an acted shot. Its clock is its takes one after another.
    const spec = shotsSpec(storySpec.parse({
      narration: { kind: "voice", voiceId: "george" },
      scenes: [{ text, description: "Mara waits", voiceId: "sarah", speaker: "Mara" }, { text: "Not yet.", description: "Ilya by the window", voiceId: "liam", speaker: "Ilya" }, { text: "The lights go out.", description: "A dark ward" }],
    }));
    expect(spec.film).toBe(true);
    expect(filmClock(spec)).toBeNull();
    expect(pendingMedia(spec).filter((m) => m.kind === "clip")).toHaveLength(3);
    const taken = { ...spec, scenes: spec.scenes.map((x, i) => ({ ...x, imageId: crypto.randomUUID(), clipId: crypto.randomUUID(), take: { key: takeKey(x, "george"), ...(({ score: _s, ...t }) => t)(takeOf(x.text, heard(0.5 + i, textWords(x.text)), 5)) } })) };
    const clock = filmClock(taken)!;
    expect(clock.cuts).toHaveLength(3);
    expect(clock.cuts[0]).toBe(0);
    expect(clock.cuts[1]).toBeCloseTo(taken.scenes[0].take.seconds, 5);
    expect(clock.duration).toBeCloseTo(taken.scenes.reduce((n, x) => n + x.take.seconds, 0), 5);
    expect(clock.words.map((w) => w.text)).toEqual(taken.scenes.flatMap((x) => textWords(x.text)));
    // Each shot's words lie inside it, and the scenes cut exactly where the clips do (never between two words).
    const timing = storyTiming(taken.scenes, clock.words, clock.duration, clock.cuts);
    expect(timing.scenes.map((x) => x.startFrame)).toEqual(clock.cuts.map((c) => Math.round(c * FPS)));
    timing.scenes.forEach((x) => { expect(timing.words[x.first].start).toBeGreaterThanOrEqual(x.start - 0.01); expect(timing.words[x.last].end).toBeLessThanOrEqual(x.end + 0.01); });
    expect(storySegments(timing, taken.scenes.map((x) => x.transition)).every((p) => !p.transition)).toBe(true);
    expect(pendingMedia(taken)).toHaveLength(0);
    // A made film is priced by what an edit asks for again: nothing; never a narration, which it has none of.
    expect(specCredits(taken, false)).toBe(0);
    expect(narrationCurrent(taken)).toBe(false);
    // Other words, another tone or another voice need a new take of that shot alone; a new take of the same words too.
    for (const change of [{ text: "Where were you?" }, { tone: "sad" as const }, { voiceId: "liam" }, { clipId: undefined, take: undefined }]) {
      const edited = { ...taken, scenes: taken.scenes.map((x, i) => (i === 0 ? { ...x, ...change } : x)) };
      expect(pendingMedia(edited).map((m) => [m.kind, m.path[1], !!m.acted])).toEqual([["clip", 0, true]]);
      expect(specCredits(edited, false)).toBe(CLIP_CREDITS.high);
      expect(filmClock(edited)).toBeNull();
    }
    // A split shot keeps the film whole: both halves are shots, the new one without a picture or a take.
    const split = splitScene(taken.scenes, 0, 2);
    expect(split[1]).toMatchObject({ acted: true, text: "you last night?", transition: "cut" });
    expect([split[1].imageId, split[1].clipId, split[1].take]).toEqual([undefined, undefined, undefined]);
    // A film is acted from its first shot to its last.
    expect(storySpec.safeParse({ ...taken, scenes: taken.scenes.map((x, i) => (i === 1 ? { ...x, acted: undefined } : x)) }).success).toBe(false);
    expect(storySpec.safeParse({ ...taken, scenes: taken.scenes.map((x, i) => (i === 1 ? { ...x, source: "image" } : x)) }).success).toBe(false);
  });
});
