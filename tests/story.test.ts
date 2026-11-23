import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../server/index";
import { ContentGeneration } from "../server/content-workflow";
import { planRender, type PlanContext } from "../server/render-plan";
import { acceptScenePlan, acceptStory, conceptToSpec, OWNER_RULE, storyShape, VARIETY_RULE } from "../server/story";
import { acceptNewSounds, acceptSounds, rankSounds } from "../server/sounds";
import { alignedWords, ALIGNMENT_URL, forcedAlignment, languageCode, speak, SPEECH_MODEL } from "../server/providers/elevenlabs";
import { adminClipModels, clipModelFor, falRequest, ONE_SHOT_25_MODEL, ONE_SHOT_MODEL, oneShotModel, oneShotRequest, PRODUCT_TEXT, referenceModel, referencePrompt, submitFal } from "../server/providers/fal";
import { heygenClipRequest, heygenRetry } from "../server/providers/heygen";
import { attention } from "../server/operations";
import { call, signedIn, subscribe, testEnv } from "./helpers";
import { languages, seriesSettingsSchema } from "../shared/series";
import { FILM_AMBIENCE, filmSpec } from "../shared/film";
import { AD_CLIP_QUALITY, adCredits, adSpec, ONE_SHOT_SOUND, oneShotModels, oneShotSeconds } from "../shared/ad";
import { PEOPLE_PHOTOS_OPEN, PEOPLE_RULE } from "../shared/people";
import { lipSyncSpec, shotSeconds, shotsSpec, takeKey, takeOf, voiceSampleText } from "../shared/drama";
import { SCRIBE_URL } from "../server/speech";
import { filmClock, estimatedSeconds, narrationCurrent, pendingMedia, pictureSheets, referencedAssets, specCredits, specSchema, storySpec, type StorySpec } from "../shared/formats";
import {
  AUTO_TRANSITIONS, characterSheetKey, clipFor, estimatedTimings, mergeScenes, moveEdge, narrationKey, placeOf, splitScene, toggleKey, resolveTransition, scenePrompt, scenesFromCounts, splitScenes, storyScript, storySegments,
  storyStyleIds, storyStyles, storyTiming, textWords, timedScript, transitionInfo, transitionKinds, voicedScript, FPS, STORY_MAX_SCENES,
} from "../shared/story";
import { captionTimeline } from "../shared/caption-scene";
import { alignmentWords, keyWordIndex, styledCaptions, titleCase, type CaptionWord } from "../shared/captions";
import { CLIP_CREDITS, pictureCredits, videoCredits, voiceCredits } from "../shared/credits";
import { SCENE_SOUND_TAIL, SOUND_VOLUME, WHOOSH_LEAD } from "../shared/sounds";

// Narrated videos (shared/story.ts): scenes on the voiceover's clock, their pictures, transitions centred on scene
// edges, the "keyword" subtitles, prices, the run that makes them, the timing of an owner's voiceover, and the writer.

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
/** The voiceover, sentence by sentence, with when each one is said (seconds). */
const said: [string, number, number][] = [
  ["Octopuses have three hearts and blue blood.", 0.2, 2.6],
  ["Two hearts pump blood to the gills, while the third one feeds the rest of the body.", 3.0, 7.8],
  ["When an octopus swims, that third heart stops beating.", 8.2, 10.9],
  ["That is why they would rather crawl than swim.", 11.3, 13.6],
  ["Nature found a strange answer to a simple problem.", 14.0, 16.5],
];
const DURATION = 17;
/** Words spread evenly over each sentence. */
const words: CaptionWord[] = said.flatMap(([text, start, end]) => {
  const parts = text.split(" "), step = (end - start) / parts.length;
  return parts.map((w, i) => ({ text: w, start: r3(start + i * step), end: r3(start + (i + 1) * step - 0.02) }));
});
const scene = (n: number, extra: Record<string, unknown> = {}) => ({ text: said[n][0], description: `Doodle of sentence ${n + 1}`, keys: [], ...extra });
const story = (extra: Record<string, unknown> = {}) =>
  specSchema.parse({ format: "story", narration: { kind: "voice", voiceId: "george" }, scenes: said.map((_, n) => scene(n)), ...extra }) as StorySpec;

describe("scenes on the voice's clock", () => {
  it("splits timed words into scenes of one or two sentences, 2–8 s, always on word boundaries", () => {
    const counts = splitScenes(words);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(words.length);
    const texts = scenesFromCounts(words, counts);
    // Every scene ends a sentence and starts on a word: the edges are word boundaries.
    expect(texts.join(" ")).toBe(said.map((s) => s[0]).join(" "));
    expect(texts).toEqual([said[0][0], said[1][0], `${said[2][0]} ${said[3][0]}`, said[4][0]]);
    let at = 0;
    for (const n of counts) {
      const span = words[at + n - 1].end - words[at].start;
      expect(span).toBeGreaterThanOrEqual(2);
      expect(span).toBeLessThanOrEqual(8);
      at += n;
    }
    // A sentence over 8 s is split where the speaker pauses (at its comma here), never inside a word.
    const long = "This sentence keeps going and going for a very long time, until it finally ends after many many words.".split(" ");
    const slow = long.map((text, i) => ({ text, start: i * 0.6, end: i * 0.6 + 0.5 + (text.endsWith(",") ? 0.3 : 0) }));
    expect(scenesFromCounts(slow, splitScenes(slow))).toEqual([
      "This sentence keeps going and going for a very long time,", "until it finally ends after many many words.",
    ]);
    // A long voice never makes more than the scene limit; one word is one scene.
    const many = Array.from({ length: 300 }, (_, i) => ({ text: i % 3 === 2 ? "end." : "word", start: i * 0.55, end: i * 0.55 + 0.5 }));
    const capped = splitScenes(many);
    expect(capped.length).toBeLessThanOrEqual(STORY_MAX_SCENES);
    expect(capped.reduce((a, b) => a + b, 0)).toBe(300);
    expect(splitScenes([{ text: "Hi.", start: 0, end: 0.4 }])).toEqual([1]);
    expect(splitScenes([])).toEqual([]);
  });

  it("times the written words by the voice's words: by position, else by their letters", () => {
    const written = ["It", "costs", "$29.", "Wow."];
    const spoken = [{ text: "It", start: 3, end: 3.2 }, { text: "costs", start: 3.2, end: 3.5 }, { text: "twenty-nine", start: 3.5, end: 4 }, { text: "dollars.", start: 4, end: 4.5 }, { text: "Wow.", start: 5, end: 5.4 }];
    const timed = timedScript(written, spoken, 6);
    expect(timed.map((w) => w.text)).toEqual(written);
    expect(timed[0]).toEqual({ text: "It", start: 3, end: 3.2 });
    // The number read out gets the time between its neighbours.
    expect(timed[2].start).toBeCloseTo(3.5, 5);
    expect(timed[2].end).toBeLessThanOrEqual(5);
    expect(timed[3]).toEqual({ text: "Wow.", start: 5, end: 5.4 });
    // As many words: by position (the voice may write them differently).
    expect(timedScript(["a", "b"], [{ text: "A!", start: 1, end: 2 }, { text: "bee", start: 2, end: 3 }], 4)).toEqual([{ text: "a", start: 1, end: 2 }, { text: "b", start: 2, end: 3 }]);
    // Before a voice is made: estimated from the script, a pause after each sentence.
    const estimate = estimatedTimings(["Hi.", "Big", "news."]);
    expect(estimate[1].start - estimate[0].end).toBeCloseTo(0.35, 5);
    expect(estimate[2].start).toBe(estimate[1].end);
    // No timings at all: spread over the voice by length (never shown as subtitles).
    const spread = timedScript(["one", "three"], [], 4);
    expect(spread[0].start).toBe(0);
    expect(spread[1].end).toBeLessThanOrEqual(4);
  });

  it("starts every scene in the pause before its first word, on the frame grid, with its key words marked", () => {
    const spec = story({ scenes: said.map((_, n) => scene(n, n === 1 ? { keys: ["gills,", "third"] } : {})) });
    const timing = storyTiming(spec.scenes, words, DURATION);
    expect(timing.frames).toBe(510);
    expect(timing.scenes.map((s) => [s.first, s.startFrame])).toEqual([[0, 0], [7, 84], [24, 240], [33, 333], [42, 414]]);
    // 84 frames = 2.8 s: the middle of the pause from 2.58 s to 3.0 s.
    expect(timing.scenes[1].start).toBeCloseTo(2.8, 5);
    expect(timing.scenes.at(-1)!.endFrame).toBe(510);
    for (const s of timing.scenes) expect(timing.words[s.first].start).toBeGreaterThanOrEqual(s.start - 1e-9);
    // The scene's keys, by their letters, the first match each.
    expect(timing.words.filter((w) => w.emphasis).map((w) => w.text)).toEqual(["gills,", "third"]);
    // Scenes are at least half a second even when edges would crowd.
    const crowded = storyTiming([{ text: "One.", keys: [] }, { text: "Two.", keys: [] }, { text: "Three.", keys: [] }], [{ text: "One.", start: 0, end: 0.1 }, { text: "Two.", start: 0.12, end: 0.2 }, { text: "Three.", start: 0.22, end: 3 }], 3);
    expect(crowded.scenes.map((s) => s.endFrame - s.startFrame).every((n) => n >= 15)).toBe(true);
  });

  it("overlaps the pictures so each transition is centred on its scene edge and the total is the voice", () => {
    const spec = story({ scenes: said.map((_, n) => scene(n, { transition: ["auto", "fade", "cut", "slideup", "auto"][n] })) });
    const timing = storyTiming(spec.scenes, words, DURATION);
    const parts = storySegments(timing, spec.scenes.map((s) => s.transition));
    expect(parts.map((p) => p.transition && [p.transition.kind, p.transition.frames])).toEqual([null, ["fade", 18], null, ["slideup", 12], [AUTO_TRANSITIONS[3], transitionInfo[AUTO_TRANSITIONS[3]].frames]]);
    // Segments less their overlaps are exactly the voice; each starts half its transition before its scene's edge.
    expect(parts.reduce((n, p) => n + p.frames - (p.transition?.frames ?? 0), 0)).toBe(timing.frames);
    parts.forEach((p, k) => {
      expect(p.from + (p.transition?.frames ?? 0) / 2).toBe(timing.scenes[k].startFrame);
      expect(Number.isInteger(p.frames) && Number.isInteger(p.from)).toBe(true);
      const out = parts[k + 1]?.transition?.frames ?? 0;
      expect(p.from + p.frames - out / 2).toBe(timing.scenes[k].endFrame);
    });
    // Every transition is a whole, even number of frames, so half of it falls on each side of its edge.
    for (const k of transitionKinds) expect(transitionInfo[k].frames % 2).toBe(0);
    // "auto" varies along the video; a short scene shortens its transitions (40% of it), a tiny one has none.
    expect(resolveTransition("auto", 1)).toBe(AUTO_TRANSITIONS[0]);
    expect(new Set(Array.from({ length: 8 }, (_, i) => resolveTransition("auto", i + 1))).size).toBeGreaterThan(4);
    const short = storySegments({ words: [], frames: 100, scenes: [{ index: 0, first: 0, last: 0, start: 0, end: 2, startFrame: 0, endFrame: 60 }, { index: 1, first: 1, last: 1, start: 2, end: 100 / 30, startFrame: 60, endFrame: 100 }] }, ["auto", "fadeblack"]);
    expect(short[1].transition).toEqual({ kind: "fadeblack", frames: 16 });
  });
});

describe("timeline edits", () => {
  it("moves edges word by word, splits and merges without changing the script", () => {
    const scenes = story({ scenes: said.map((_, n) => scene(n, { keys: n === 1 ? ["gills,"] : [], imageId: id(n + 1) })) }).scenes;
    const script = storyScript(scenes);
    // Scene 2 now starts at word 5 of the script: four words of sentence 2 go to scene 1... and back.
    const moved = moveEdge(scenes, 1, 7 + 3);
    expect(moved[0].text).toBe(`${said[0][0]} Two hearts pump`);
    expect(moved[1].text).toBe("blood to the gills, while the third one feeds the rest of the body.");
    expect(storyScript(moved)).toBe(script);
    expect(moveEdge(moved, 1, 7)).toEqual(scenes);
    // Never empties a scene; the first scene has no edge before it.
    expect(moveEdge(scenes, 1, 0)[0].text).toBe("Octopuses");
    expect(moveEdge(scenes, 1, 999)[1].text).toBe("body.");
    expect(moveEdge(scenes, 0, 3)).toBe(scenes);
    // A split keeps the picture with the first part; the new scene needs its own; key words follow their words.
    const split = splitScene(scenes, 1, 5);
    expect(split).toHaveLength(6);
    expect([split[1].text, split[2].text]).toEqual(["Two hearts pump blood to", "the gills, while the third one feeds the rest of the body."]);
    expect([split[1].imageId, split[2].imageId, split[1].keys, split[2].keys]).toEqual([id(2), undefined, [], ["gills,"]]);
    expect(storyScript(split)).toBe(script);
    expect(splitScene(scenes, 1, 0)).toBe(scenes);
    expect(mergeScenes(split, 1)[1]).toMatchObject({ text: said[1][0], keys: ["gills,"], imageId: id(2) });
    expect(mergeScenes(scenes, 4)).toBe(scenes);
    // Key words by their letters, on and off.
    expect(toggleKey(scenes[0], "Blood.").keys).toEqual(["Blood"]);
    expect(toggleKey({ ...scenes[0], keys: ["blood"] }, "Blood.").keys).toEqual([]);
  });
});

describe("the format", () => {
  it("validates scenes, sources and the narration", () => {
    expect(story().scenes[0]).toMatchObject({ source: "image", transition: "auto", clipSeconds: 5, clipQuality: "regular", keys: [] });
    const bad = (s: Record<string, unknown>) => specSchema.safeParse({ format: "story", narration: { kind: "voice", voiceId: "george" }, scenes: [{ text: "Hello there.", ...s }] }).success;
    expect(bad({ description: "A dog" })).toBe(true);
    expect(bad({ description: "" })).toBe(false); // an AI picture needs a description
    expect(bad({ source: "own" })).toBe(false); // own media needs its file
    expect(bad({ source: "own", assetId: id(1) })).toBe(true);
    expect(bad({ source: "library" })).toBe(false);
    expect(bad({ source: "clip", description: "A dog", clipSeconds: 7 })).toBe(false);
    expect(bad({ source: "clip", description: "A dog", clipQuality: "high" })).toBe(true);
    expect(bad({ source: "clip", description: "A dog", clipQuality: "ultra" })).toBe(false);
    expect(bad({ description: "A dog", transition: "spin" })).toBe(false);
    expect(specSchema.safeParse({ format: "story", narration: { kind: "upload" }, scenes: [scene(0)] }).success).toBe(false);
    expect(specSchema.safeParse({ format: "story", narration: { kind: "voice", voiceId: "george" }, scenes: Array.from({ length: 41 }, () => scene(0)) }).success).toBe(false);
    expect(story().captions).toEqual({ enabled: true, style: "keyword" });
    expect(story().style).toBe("doodle");
  });

  it("prices a new video by its length and an edit by what it makes again, each clip by its seconds and quality", () => {
    const spec = story({ subject: "a small orange octopus with big eyes", style: "doodle", scenes: [
      scene(0), scene(1, { source: "clip" }), scene(2, { source: "clip", clipSeconds: 10, imageId: id(5) }),
      scene(3, { source: "own", assetId: id(6) }), scene(4, { source: "library", libraryId: id(7) }),
    ] });
    const voice = voiceCredits(storyScript(spec.scenes));
    expect(voice).toBe(1);
    // New: its length (voice and every picture included) and the clips; 17 s of speech is one credit.
    expect(specCredits(spec, true)).toBe(videoCredits(estimatedSeconds(spec)) + CLIP_CREDITS.regular + CLIP_CREDITS.regular * 2);
    expect([videoCredits(20), videoCredits(21), videoCredits(30), videoCredits(60), videoCredits(61)]).toEqual([1, 2, 2, 3, 4]);
    expect(specCredits(spec, true, 61)).toBe(videoCredits(61) + CLIP_CREDITS.regular * 3);
    // An edit: the voice again, the two missing pictures (1 credit per 5), the clips.
    expect(specCredits(spec, false)).toBe(voice + pictureCredits(2) + CLIP_CREDITS.regular * 3);
    // High quality: 2 credits per 5 s instead of 1, clip by clip.
    expect([CLIP_CREDITS.regular, CLIP_CREDITS.high]).toEqual([1, 2]);
    const high = story({ ...spec, scenes: spec.scenes.map((s, i) => (i === 2 ? { ...s, clipQuality: "high" } : s)) });
    expect(specCredits(high, true, 61)).toBe(videoCredits(61) + CLIP_CREDITS.regular + CLIP_CREDITS.high * 2);
    expect(pendingMedia(high).filter((m) => m.kind === "clip").map((m) => [m.seconds, m.quality])).toEqual([[5, "regular"], [10, "high"]]);
    // The advertised price: 30 seconds of speech is two credits and a minute three (the finished video's padding is
    // never charged).
    const minute = (n: number) => ({ text: `${"word ".repeat(Math.floor(n / 5))}`.trim().padEnd(n, "x") + ".", description: "A doodle" });
    const sixty = story({ scenes: [minute(447), minute(450)] });
    expect(storyScript(sixty.scenes)).toHaveLength(900);
    expect(specCredits(sixty, true)).toBe(3);
    expect(specCredits(story({ scenes: [minute(448), minute(450)] }), true)).toBe(4);
    expect(specCredits(story({ scenes: [minute(222), minute(225)] }), true)).toBe(2);
    expect(pictureCredits(5)).toBe(1);
    expect(pictureCredits(6)).toBe(2);
    // Pictures first, then the clips made from them.
    expect(pendingMedia(spec).map((m) => [m.kind, m.path.join("."), m.key, m.from, m.seconds])).toEqual([
      ["image", "scenes.0", "imageId", undefined, undefined], ["image", "scenes.1", "imageId", undefined, undefined],
      ["clip", "scenes.1", "clipId", "imageId", 5], ["clip", "scenes.2", "clipId", "imageId", 10],
    ]);
    // One subject and one style in every picture prompt.
    expect(pendingMedia(spec)[0].prompt).toBe(scenePrompt("Doodle of sentence 1", spec.subject, "doodle"));
    expect(pendingMedia(spec)[0].prompt).toContain("Recurring characters, drawn the same whenever they appear, only in the scenes that show them: a small orange octopus with big eyes.");
    expect(pendingMedia(spec)[0].prompt).toContain(storyStyles.doodle.prompt);
    // Recorded for these words and this voice: no voice charge; another voice or new words cost it again.
    const recorded = { ...spec, generated: { key: narrationKey("george", storyScript(spec.scenes)), voiceAssetId: id(8), words } };
    expect(narrationCurrent(recorded)).toBe(true);
    expect(specCredits(recorded, false)).toBe(specCredits(spec, false) - voice);
    expect(narrationCurrent({ ...recorded, narration: { kind: "voice", voiceId: "aria" } })).toBe(false);
    expect(narrationCurrent({ ...recorded, scenes: recorded.scenes.map((s, n) => (n ? s : { ...s, text: "Octopuses have three hearts." })) })).toBe(false);
    // Moving a scene edge moves words between scenes, not the script: the voice stays paid.
    const moved = recorded.scenes.map((s, n) => (n === 0 ? { ...s, text: `${s.text} ${said[1][0].split(" ")[0]}` } : n === 1 ? { ...s, text: said[1][0].split(" ").slice(1).join(" ") } : s));
    expect(narrationCurrent({ ...recorded, scenes: moved })).toBe(true);
    // Editing a video with an own voiceover and made pictures and clips is free; making it new costs its length.
    const own = { ...spec, narration: { kind: "upload" as const, assetId: id(9), script: "" }, scenes: spec.scenes.map((s) => ({ ...s, imageId: id(10), clipId: id(11) })) };
    expect(specCredits(own, false)).toBe(0);
    expect(specCredits(own, true, 40)).toBe(2);
    // A background clip replaces every picture: nothing to draw.
    expect(pendingMedia({ ...spec, backdrop: { libraryId: id(12) } })).toEqual([]);
    expect(clipFor(4.9)).toBe(5);
    expect(clipFor(7)).toBe(10);
  });

  it("asks the image model for 9:16 pictures and the clip model of its quality to start from the scene's picture", () => {
    // Regular quality (and any clip that doesn't say): Kling 2.5 Turbo Standard; high quality: the Pro model.
    const image = "https://app.test/api/render-inputs/r/0?token=t";
    expect(falRequest("clip", "A wave.", { image }).model).toBe("fal-ai/kling-video/v2.5-turbo/standard/image-to-video");
    expect(falRequest("clip", "A wave.", { image, clipQuality: "regular" }).body).toEqual(falRequest("clip", "A wave.", { image, clipQuality: "high" }).body);
    expect(falRequest("clip", "A doodle octopus waves.", { image, seconds: 10, clipQuality: "high" })).toEqual({
      model: "fal-ai/kling-video/v2.5-turbo/pro/image-to-video",
      body: {
        prompt: "A doodle octopus waves. No text, captions, logos or watermarks in the picture.", duration: "10",
        negative_prompt: "blur, distortion, low quality, text, captions, subtitles, watermark, logo", cfg_scale: 0.5, image_url: "https://app.test/api/render-inputs/r/0?token=t",
      },
    });
    // The other clip models an operator can choose, each from the scene's picture in its own request shape: MiniMax H3
    // at 768P (its 2K is an upscale), FLUX 3 Max at 720p or 1080p by quality and without its sound.
    expect(falRequest("clip", "A wave.", { image, seconds: 10, clipModel: "minimax-h3", clipQuality: "high" })).toEqual({
      model: "minimax/h3/image-to-video",
      body: { prompt: "A wave. No text, captions, logos or watermarks in the picture.", image_url: image, duration: 10, resolution: "768P" },
    });
    expect(falRequest("clip", "A wave.", { image, clipModel: "flux-3-max" })).toEqual({
      model: "blackforestlabs/flux-3-max/image-to-video",
      body: { prompt: "A wave. No text, captions, logos or watermarks in the picture.", image_url: image, duration: 5, resolution: "720p", generate_audio: false },
    });
    expect(falRequest("clip", "A wave.", { image, clipModel: "flux-3-max", clipQuality: "high" }).body).toMatchObject({ resolution: "1080p" });
    expect(falRequest("clip", "A wave.", { image, clipModel: "kling", clipQuality: "high" }).model).toBe("fal-ai/kling-video/v2.5-turbo/pro/image-to-video");
    // Everyone's model: Kling unless set (anything unknown is Kling). Administrators may choose per scene among Kling,
    // everyone's model and FAL_CLIP_MODEL_ADMIN's list; anyone else's choice, or one not on the list, is ignored.
    expect(clipModelFor({} as any, true)).toBe("kling");
    expect(clipModelFor({ FAL_CLIP_MODEL: " MiniMax-H3 " } as any, false)).toBe("minimax-h3");
    expect(clipModelFor({ FAL_CLIP_MODEL: "veo-9" } as any, false)).toBe("kling");
    const trial = { FAL_CLIP_MODEL_ADMIN: " minimax-h3, FLUX-3-Max , veo-9" } as any;
    expect(adminClipModels(trial)).toEqual(["kling", "minimax-h3", "flux-3-max"]);
    expect(adminClipModels({ FAL_CLIP_MODEL: "flux-3-max" } as any)).toEqual(["kling", "flux-3-max"]);
    expect(clipModelFor(trial, true, "flux-3-max")).toBe("flux-3-max");
    expect(clipModelFor(trial, false, "flux-3-max")).toBe("kling");
    expect(clipModelFor({ FAL_CLIP_MODEL_ADMIN: "minimax-h3" } as any, true, "flux-3-max")).toBe("kling");
    expect(clipModelFor({ FAL_CLIP_MODEL: "minimax-h3" } as any, true, "kling")).toBe("kling");
    // HeyGen Video 1 (with the HeyGen key only): the scene's picture as the clip's first frame, 768p or 1080p by quality.
    expect(heygenClipRequest("A wave.", image, undefined)).toEqual({
      model: "heygen-video-1", mode: "image_to_video", prompt: "A wave. No text, captions, logos or watermarks in the picture.",
      image: { type: "url", url: image }, duration: 5, resolution: "768p",
    });
    expect(heygenClipRequest("A wave.", image, 10, "high")).toMatchObject({ duration: 10, resolution: "1080p" });
    // Any whole number of seconds HeyGen takes (5 to 30), rounded up.
    expect([4, 6, 6.2, 40].map((n) => heygenClipRequest("A wave.", image, n).duration)).toEqual([5, 6, 7, 30]);
    expect(adminClipModels({ FAL_CLIP_MODEL_ADMIN: "heygen-video-1" } as any)).toEqual(["kling"]);
    expect(adminClipModels({ FAL_CLIP_MODEL_ADMIN: "heygen-video-1", HEYGEN_API_KEY: "hg" } as any)).toEqual(["kling", "heygen-video-1"]);
    expect(clipModelFor({ FAL_CLIP_MODEL: "heygen-video-1" } as any, false)).toBe("kling");
    expect(clipModelFor({ FAL_CLIP_MODEL: "heygen-video-1", HEYGEN_API_KEY: "hg" } as any, false)).toBe("heygen-video-1");
    // Without a picture: the text-to-video model, 5 s, as before.
    expect(falRequest("clip", "A wave.")).toMatchObject({ model: "fal-ai/kling-video/v2.5-turbo/pro/text-to-video", body: { duration: "5", aspect_ratio: "9:16" } });
    // Pictures: GPT Image 2.5 Flare at high quality by default, exactly 9:16 in multiples of 16.
    expect(falRequest("image", "A wave.")).toEqual({
      model: "openai/gpt-image-2.5/flare/text-to-image",
      body: { prompt: "A wave. No text, captions, logos or watermarks in the picture.", num_images: 1, image_size: { width: 864, height: 1536 }, quality: "high", output_format: "jpeg" },
    });
    expect(864 / 1536).toBe(9 / 16);
    expect(falRequest("image", "A wave.", { model: "openai/gpt-image-2.5/sunburst/text-to-image", quality: "medium" })).toMatchObject({ model: "openai/gpt-image-2.5/sunburst/text-to-image", body: { quality: "medium" } });
    // The others an operator can choose, each in its own request shape; anything unknown is the default.
    expect(falRequest("image", "A wave.", { model: "fal-ai/nano-banana-2" })).toMatchObject({ model: "fal-ai/nano-banana-2", body: { aspect_ratio: "9:16", resolution: "1K", limit_generations: true } });
    // Nano Banana 2.1 lives in Google's namespace on fal, with the same input.
    expect(falRequest("image", "A wave.", { model: "google/nano-banana-2.1" })).toEqual({
      model: "google/nano-banana-2.1",
      body: { prompt: "A wave. No text, captions, logos or watermarks in the picture.", num_images: 1, aspect_ratio: "9:16", resolution: "1K", output_format: "jpeg", limit_generations: true, safety_tolerance: "5" },
    });
    const edited = falRequest("image", "A wave.", { references: [{ url: image, role: "character" }], referenceModel: "google/nano-banana-2.1/edit" });
    expect(edited).toMatchObject({ model: "google/nano-banana-2.1/edit", body: { image_urls: [image], aspect_ratio: "9:16", resolution: "1K", limit_generations: true } });
    // Nano Banana 2.1's filter is one step less strict than fal's default; Nano Banana 2 keeps fal's.
    expect([falRequest("image", "A wave.", { model: "google/nano-banana-2.1" }).body, edited.body].map((b: any) => b.safety_tolerance)).toEqual(["5", "5"]);
    expect(falRequest("image", "A wave.", { model: "fal-ai/nano-banana-2" }).body).not.toHaveProperty("safety_tolerance");
    expect(falRequest("image", "A wave.", { model: "fal-ai/flux/schnell" })).toMatchObject({ model: "fal-ai/flux/schnell", body: { image_size: { width: 1088, height: 1920 } } });
    expect(falRequest("image", "A wave.", { model: "someone/else" }).model).toBe("openai/gpt-image-2.5/flare/text-to-image");
    // A scene picture, drawn from the video's reference sheets: Nano Banana 2's edit endpoint; the scene comes first,
    // then what each sheet is for (never the picture to draw).
    const drawn = falRequest("image", "A wave.", { references: [{ url: image, role: "character" }] });
    expect(drawn).toEqual({
      model: "fal-ai/nano-banana-2/edit",
      body: {
        prompt: expect.stringMatching(/^Draw a new picture of this scene: A wave\. No text, captions, logos or watermarks in the picture\. The reference picture shows only what the recurring characters look like: draw the ones this scene shows .*never standing as in the reference; leave out any it does not mention\. Match the art style and colours of the reference\.$/),
        image_urls: [image], num_images: 1, aspect_ratio: "9:16", resolution: "1K", output_format: "jpeg", limit_generations: true,
      },
    });
    expect(falRequest("image", "A wave.", { references: [{ url: image, role: "character" }], referenceModel: "fal-ai/nano-banana-pro/edit" }).model).toBe("fal-ai/nano-banana-pro/edit");
    const place = "https://app.test/api/render-inputs/r/3?token=t";
    const both = falRequest("image", "A wave.", { references: [{ url: image, role: "character" }, { url: place, role: "place" }] }).body as any;
    expect(both.image_urls).toEqual([image, place]);
    expect(both.prompt).toMatch(/A wave\. .*Reference picture 1 shows only what the recurring characters look like: .*Reference picture 2 shows only how the place is built: .*never copy the reference's view\. Match the art style and colours of the references\.$/);
    expect(referencePrompt([{ url: place, role: "place" }])).toMatch(/^The reference picture shows only how the place is built: keep its layout/);
    for (const s of storyStyleIds) expect(storyStyles[s].prompt.length).toBeGreaterThan(60);
  });
});

describe("the picture model an operator chooses", () => {
  it("reads FAL_IMAGE_MODEL and FAL_IMAGE_QUALITY, ignoring a quality GPT Image doesn't know", async () => {
    const sent: { url: string; body: any }[] = [];
    vi.stubGlobal("fetch", async (input: any, init: any = {}) => {
      sent.push({ url: String(input?.url ?? input), body: JSON.parse(init.body) });
      return Response.json({ request_id: "r1", status_url: "https://queue.fal.run/x/requests/r1/status", response_url: "https://queue.fal.run/x/requests/r1" });
    });
    await submitFal({ FAL_KEY: "k" } as any, "image", "A fox.");
    await submitFal({ FAL_KEY: "k", FAL_IMAGE_QUALITY: " Medium " } as any, "image", "A fox.");
    await submitFal({ FAL_KEY: "k", FAL_IMAGE_QUALITY: "ultra" } as any, "image", "A fox.");
    await submitFal({ FAL_KEY: "k", FAL_IMAGE_MODEL: "fal-ai/nano-banana-2", FAL_IMAGE_QUALITY: "medium" } as any, "image", "A fox.");
    // A picture drawn from a reference: FAL_REFERENCE_MODEL's endpoint, Nano Banana 2's edit by default.
    const references = [{ url: "https://app.test/api/render-inputs/r/0?token=t", role: "character" as const }];
    await submitFal({ FAL_KEY: "k" } as any, "image", "A fox.", { references });
    await submitFal({ FAL_KEY: "k", FAL_REFERENCE_MODEL: " fal-ai/nano-banana-pro/edit " } as any, "image", "A fox.", { references });
    expect(sent.map((r) => [r.url, r.body.quality ?? null])).toEqual([
      ["https://queue.fal.run/openai/gpt-image-2.5/flare/text-to-image", "high"],
      ["https://queue.fal.run/openai/gpt-image-2.5/flare/text-to-image", "medium"],
      ["https://queue.fal.run/openai/gpt-image-2.5/flare/text-to-image", "high"],
      ["https://queue.fal.run/fal-ai/nano-banana-2", null],
      ["https://queue.fal.run/fal-ai/nano-banana-2/edit", null],
      ["https://queue.fal.run/fal-ai/nano-banana-pro/edit", null],
    ]);
    expect(sent[4].body.image_urls).toEqual([references[0].url]);
    expect(referenceModel({ FAL_REFERENCE_MODEL: "OFF" } as any)).toBeNull();
    // Nano Banana 2.1 for the first pictures draws the later ones too, unless FAL_REFERENCE_MODEL says otherwise.
    expect(referenceModel({ FAL_IMAGE_MODEL: " google/nano-banana-2.1 " } as any)).toBe("google/nano-banana-2.1/edit");
    expect(referenceModel({ FAL_IMAGE_MODEL: "google/nano-banana-2.1", FAL_REFERENCE_MODEL: "fal-ai/nano-banana-2/edit" } as any)).toBe("fal-ai/nano-banana-2/edit");
    expect(referenceModel({ FAL_IMAGE_MODEL: "fal-ai/nano-banana-2" } as any)).toBe("fal-ai/nano-banana-2/edit");
    expect(referenceModel({ FAL_IMAGE_MODEL: "google/nano-banana-2.1", FAL_REFERENCE_MODEL: "off" } as any)).toBeNull();
  });
});

describe("the render plan", () => {
  const ctx = (extra: Partial<PlanContext> = {}): PlanContext => ({
    media: {
      [id(1)]: { key: "media/u/s1.jpg", kind: "image", duration: 0, ai: true },
      [id(2)]: { key: "media/u/s2.jpg", kind: "image", duration: 0, ai: true },
      [id(3)]: { key: "media/u/s2.mp4", kind: "video", duration: 5, ai: true },
      [id(4)]: { key: "media/u/mine.jpg", kind: "image", duration: 0 },
      [id(5)]: { key: "library/clip.mp4", kind: "video", duration: 2 },
      [id(6)]: { key: "media/u/s5.jpg", kind: "image", duration: 0, ai: true },
    },
    narration: { key: "media/u/voice.wav", duration: DURATION, words }, watermark: "", ...extra,
  });
  const made = () => story({ scenes: [
    scene(0, { imageId: id(1) }), scene(1, { source: "clip", imageId: id(2), clipId: id(3), transition: "fade" }),
    scene(2, { source: "own", assetId: id(4), transition: "cut" }), scene(3, { source: "library", libraryId: id(5), transition: "circleopen" }),
    scene(4, { imageId: id(6), keys: ["strange"], transition: "zoomin" }),
  ] });

  it("covers the voice exactly, centres every transition on its edge and plays the voice as one track", () => {
    const { compose } = planRender(made(), ctx());
    const at = (key: string) => compose.keys.indexOf(key);
    expect(compose.segments.map((s) => [s.kind, s.input, Math.round(s.duration * FPS), s.transition?.kind ?? null, s.transition ? Math.round(s.transition.duration * FPS) : 0])).toEqual([
      ["image", at("media/u/s1.jpg"), 84 + 9, null, 0],
      ["video", at("media/u/s2.mp4"), 156 + 9, "fade", 18],
      ["image", at("media/u/mine.jpg"), 93 + 8, null, 0],
      ["video", at("library/clip.mp4"), 81 + 8 + 8, "circleopen", 16],
      ["image", at("media/u/s5.jpg"), 96 + 8, "zoomin", 16],
    ]);
    // Whole frames; the segments less their overlaps are the voice's 17 s.
    for (const s of compose.segments) expect(Math.abs(s.duration * FPS - Math.round(s.duration * FPS))).toBeLessThan(1e-6);
    expect(compose.segments.reduce((n, s) => n + Math.round(s.duration * FPS) - Math.round((s.transition?.duration ?? 0) * FPS), 0)).toBe(510);
    // Every picture is silent; the voice is one track from 0 under all of them, music ducked under it.
    expect(compose.segments.every((s) => !s.audio)).toBe(true);
    expect(compose.voice).toEqual({ input: at("media/u/voice.wav"), start: 0, volume: 1 });
    // Stills move, each differently; the AI clip holds its last frame, the short library clip loops.
    expect(compose.segments.filter((s) => s.kind === "image").map((s) => s.motion)).toEqual(["zoom-in", "pan-left", "zoom-in"]); // scenes 1, 3, 5
    expect(compose.segments[1].loop).toBeUndefined();
    expect(compose.segments[3].loop).toBe(true);
    // Subtitles in Title Case with the key word coloured; marked AI-made (AI voice and pictures).
    expect(compose.ass).toContain("Strange");
    expect(compose.ass).toContain("\\1c&H3af5b8&");
    expect(compose.synthetic).toBe(true);
    expect(compose.coverAt).toBeGreaterThan(0.3);
    expect(compose.coverAt).toBeLessThan(2.8);
  });

  it("keeps three minutes of key word subtitles well within the renderer's 2 MB payload", () => {
    const long: CaptionWord[] = Array.from({ length: 480 }, (_, i) => ({ text: ["Octopuses", "have", "three", "hearts.", "Nature", "found", "a", "strange", "answer."][i % 9], start: i * 0.37, end: i * 0.37 + 0.33 }));
    const texts = scenesFromCounts(long, splitScenes(long));
    const spec = story({ scenes: texts.map((text, n) => ({ text, description: "A doodle", imageId: id(1), keys: n % 2 ? ["strange"] : [] })) });
    const { compose } = planRender(spec, ctx({ narration: { key: "media/u/voice.wav", duration: 178, words: long } }));
    expect(compose.segments.length).toBeLessThanOrEqual(STORY_MAX_SCENES);
    expect(compose.segments.reduce((n, s) => n + Math.round(s.duration * FPS) - Math.round((s.transition?.duration ?? 0) * FPS), 0)).toBe(178 * FPS);
    expect(JSON.stringify(compose).length).toBeLessThan(1.5 * 1024 * 1024);
  });

  it("plays a whoosh before every scene change and each scene's own sound from its start, only while sound effects are on", () => {
    const media = {
      ...ctx().media,
      [id(7)]: { key: "library/whoosh.mp3", kind: "audio" as const, duration: 1.2, ai: true },
      [id(8)]: { key: "library/fire.mp3", kind: "audio" as const, duration: 10 },
      [id(9)]: { key: "library/pop.mp3", kind: "audio" as const, duration: 0.4 },
    };
    const base = made();
    const spec: StorySpec = {
      ...base, sounds: { enabled: true, volume: 0.5, transitionId: id(7) },
      scenes: base.scenes.map((x, n) => (n === 1 ? { ...x, soundId: id(8) } : n === 4 ? { ...x, soundId: id(9) } : x)),
    };
    const { compose } = planRender(spec, ctx({ media }));
    const at = (key: string) => compose.keys.indexOf(key);
    // Scene changes on the output clock: where each scene starts (the middle of its transition).
    const edges = storyTiming(spec.scenes, words, DURATION).scenes.map((x) => x.startFrame / FPS);
    const r2 = (n: number) => Math.round(n * 100) / 100;
    const whoosh = (k: number) => ({ input: at("library/whoosh.mp3"), start: r2(edges[k] - WHOOSH_LEAD), duration: 1.2, volume: 0.5 });
    expect(compose.sounds).toEqual([
      whoosh(1), { input: at("library/fire.mp3"), start: r2(edges[1]), duration: r2(edges[2] - edges[1] + SCENE_SOUND_TAIL), volume: 0.5 },
      whoosh(2), whoosh(3), whoosh(4), { input: at("library/pop.mp3"), start: r2(edges[4]), duration: 0.4, volume: 0.5 },
    ]);
    // One input per file, however often it plays.
    expect(compose.keys.filter((k) => k === "library/whoosh.mp3")).toHaveLength(1);
    // Switched off (or never on, or silent): nothing is played or downloaded; the scenes keep their sounds.
    for (const off of [{ ...spec, sounds: { ...spec.sounds!, enabled: false } }, { ...spec, sounds: undefined }, { ...spec, sounds: { ...spec.sounds!, volume: 0 } }]) {
      const plan = planRender(off, ctx({ media })).compose;
      expect(plan.sounds).toBeUndefined();
      expect(plan.keys.some((k) => k.startsWith("library/") && k.endsWith(".mp3"))).toBe(false);
    }
    // Over one background clip the picture never changes: no whoosh, the scenes' sounds still play.
    const told = planRender({ ...spec, backdrop: { libraryId: id(5) } }, ctx({ media })).compose;
    expect(told.sounds!.map((x) => told.keys[x.input])).toEqual(["library/fire.mp3", "library/pop.mp3"]);
    // A sound that is missing, or isn't a sound, stops the render.
    expect(() => planRender({ ...spec, sounds: { ...spec.sounds!, transitionId: id(1) } }, ctx({ media }))).toThrow("MEDIA_INPUT");
    expect(() => planRender({ ...spec, sounds: { ...spec.sounds!, transitionId: id(10) } }, ctx({ media }))).toThrow("MEDIA_INPUT");
  });

  it("shows no subtitles without real timings, refuses a missing picture and a voice over three minutes", () => {
    const quiet = planRender(made(), ctx({ narration: { key: "media/u/voice.wav", duration: DURATION, words: [] } }));
    expect(quiet.compose.ass).not.toContain("Octopuses");
    expect(quiet.compose.segments).toHaveLength(5);
    const off = planRender({ ...made(), captions: { enabled: false, style: "keyword" } }, ctx());
    expect(off.compose.ass).not.toContain("Octopuses");
    expect(() => planRender(story(), ctx())).toThrow("MEDIA_INPUT"); // pictures not made yet
    expect(() => planRender(made(), ctx({ narration: { key: "v", duration: 181, words } }))).toThrow("MEDIA_TOO_LONG");
    expect(() => planRender(made(), { ...ctx(), narration: undefined })).toThrow("MEDIA_INPUT");
  });
});

describe("the key word subtitles", () => {
  it("writes Title Case, reveals each word as it is said with a small pop, and colours one key word per group", () => {
    const group = [{ text: "fiber-optic", start: 1, end: 1.5, emphasis: true }, { text: "cable", start: 1.5, end: 1.9 }, { text: "into", start: 1.9, end: 2.1 }, { text: "the", start: 2.1, end: 2.2 }, { text: "skull.", start: 2.2, end: 2.8 }];
    const timeline = captionTimeline(styledCaptions(group, "keyword"), 1080, 1920);
    const texts = (t: number) => timeline.find((i) => t >= i.start && t < i.end)!.items.filter((i) => i.kind === "text" && i.layer === 2) as any[];
    expect(texts(1.2).map((i) => i.text)).toEqual(["Fiber-Optic"]);
    expect(texts(2.0).map((i) => [i.text, i.fill])).toEqual([["Fiber-Optic", "#b8f53a"], ["Cable", "#ffffff"], ["Into", "#ffffff"]]);
    // Words keep their place as the others appear; thick black outline, big letters, low in the frame.
    expect(texts(1.2)[0].x).toBe(texts(2.0)[0].x);
    expect(texts(2.0)[0].border).toMatchObject({ color: "#000000" });
    expect(texts(2.0)[0].border.width).toBeGreaterThan(texts(2.0)[0].size * 0.1);
    expect(texts(2.0)[0].y).toBeGreaterThan(1920 * 0.7);
    // A word pops in when said: 70% → 108% → 100% over 0.16 s.
    expect(texts(1.2)[0].anim).toEqual([{ t: 1, scale: 0.7 }, { t: 1.08, scale: 1.08 }, { t: 1.16, scale: 1 }]);
    // Without marks the longest word that is not a little one is the key word.
    expect(keyWordIndex([{ text: "Stop", start: 0, end: 1 }, { text: "scrolling.", start: 1, end: 2 }])).toBe(1);
    expect(keyWordIndex([{ text: "and", start: 0, end: 1 }, { text: "the", start: 1, end: 2 }])).toBe(-1);
    expect(keyWordIndex([{ text: "it's", start: 0, end: 1 }, { text: "big", start: 1, end: 2 }])).toBe(1);
    expect(titleCase("“fiber-optic cable/wire”")).toBe("“Fiber-Optic Cable/Wire”");
    expect(titleCase("don't")).toBe("Don't");
  });
});

describe("the AI voice", () => {
  it("speaks with Eleven v4 and never times a word past the end of the audio", async () => {
    const seen: any[] = [];
    vi.stubGlobal("fetch", async (input: any, init: any = {}) => {
      seen.push({ url: String(input?.url ?? input), body: JSON.parse(String(init.body ?? "{}")) });
      // One second of audio; the timings of "there." run 80 ms past it.
      const characters = [..."Hi there."], starts = characters.map((_, i) => i * 0.12), ends = characters.map((_, i) => Math.min(1.08, (i + 1) * 0.12));
      return Response.json({ audio_base64: Buffer.from(new Uint8Array(48000)).toString("base64"), alignment: { characters, character_start_times_seconds: starts, character_end_times_seconds: ends } });
    });
    // George is one of the voices offered (migrations/0003_voices.sql): his ElevenLabs voice speaks.
    const r = await speak(testEnv({ ELEVENLABS_API_KEY: "el" }).env, "george", "Hi there.", "en", "original");
    expect(SPEECH_MODEL).toBe("eleven_v4");
    expect(seen[0].url).toContain("/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb/with-timestamps");
    expect(seen[0].body).toMatchObject({ text: "Hi there.", model_id: "eleven_v4", language_code: "en" });
    expect(r.seconds).toBe(1);
    expect(r.words.map((w) => w.text)).toEqual(["Hi", "there."]);
    expect(r.words.at(-1)!.end).toBe(1);
  });

  it("asks a busy ElevenLabs again (nothing was spoken or billed), and gives up with VOICE_BUSY when it stays busy", async () => {
    let asked = 0, busy = 2;
    vi.stubGlobal("fetch", async () => {
      asked++;
      if (asked <= busy) return Response.json({ detail: { status: "too_many_concurrent_requests" } }, { status: 429 });
      const characters = [..."Hi there."];
      return Response.json({ audio_base64: Buffer.from(new Uint8Array(48000)).toString("base64"),
        alignment: { characters, character_start_times_seconds: characters.map((_, i) => i * 0.1), character_end_times_seconds: characters.map((_, i) => (i + 1) * 0.1) } });
    });
    const env = testEnv({ ELEVENLABS_API_KEY: "el" }).env;
    expect((await speak(env, "george", "Hi there.", "en", "original", [0, 0, 0])).seconds).toBe(1);
    expect(asked).toBe(3);
    asked = 0; busy = 99;
    await expect(speak(env, "george", "Hi there.", "en", "original", [0, 0])).rejects.toThrow("VOICE_BUSY");
    expect(asked).toBe(3);
  });

  it("names Filipino to ElevenLabs as Filipino, not Finnish", () => {
    expect(languageCode("fil")).toBe("fil");
    expect(languages.map((l) => languageCode(l[0]))).toEqual(languages.map((l) => l[0]));
  });
});

describe("forced alignment", () => {
  it("keeps the words of the answer in order, within the recording", () => {
    const answer = { loss: 0.1, characters: [], words: [
      { text: "Hello", start: 0.5, end: 0.9, loss: 0.1 }, { text: " ", start: 0.9, end: 0.9 },
      { text: "there.", start: 0.85, end: 1.4 }, { text: "<b>x", start: 2, end: 2 }, { text: "late", start: 9.5, end: 12 }, { text: 3, start: 1, end: 2 },
    ] };
    expect(alignedWords(answer, 10)).toEqual([
      { text: "Hello", start: 0.5, end: 0.9 }, { text: "there.", start: 0.9, end: 1.4 }, { text: "bx", start: 2, end: 2.02 }, { text: "late", start: 9.5, end: 10 },
    ]);
    expect(alignedWords({ detail: "x" }, 10)).toEqual([]);
  });

  it("sends the recording and the exact script once, as multipart, and turns failures into codes", async () => {
    const seen: any[] = [];
    vi.stubGlobal("fetch", async (url: string, init: any) => {
      const form = init.body as FormData, file = form.get("file") as File;
      seen.push({ url, method: init.method, key: init.headers["xi-api-key"], redirect: init.redirect, text: form.get("text"), file: [file.name, file.type, file.size] });
      return Response.json({ words: [{ text: "Hi", start: 0.1, end: 0.3 }, { text: "there.", start: 0.3, end: 0.8 }], characters: [], loss: 0.2 });
    });
    const env: any = { ELEVENLABS_API_KEY: " el " };
    expect(await forcedAlignment(env, new Blob([new Uint8Array(100)], { type: "audio/wav" }), "Hi there.", 1)).toEqual([{ text: "Hi", start: 0.1, end: 0.3 }, { text: "there.", start: 0.3, end: 0.8 }]);
    expect(seen).toEqual([{ url: ALIGNMENT_URL, method: "POST", key: "el", redirect: "manual", text: "Hi there.", file: ["recording", "audio/wav", 100] }]);
    expect(ALIGNMENT_URL).toBe("https://api.elevenlabs.io/v1/forced-alignment");
    vi.stubGlobal("fetch", async () => Response.json({ detail: { status: "quota_exceeded" } }, { status: 401 }));
    await expect(forcedAlignment(env, new Blob(["x"]), "Hi", 1)).rejects.toMatchObject({ code: "ALIGN_UNAVAILABLE" });
    vi.stubGlobal("fetch", async () => Response.json({ words: [] }));
    await expect(forcedAlignment(env, new Blob(["x"]), "Hi", 1)).rejects.toMatchObject({ code: "ALIGN_FAILED" });
    await expect(forcedAlignment({} as any, new Blob(["x"]), "Hi", 1)).rejects.toMatchObject({ code: "ALIGN_UNAVAILABLE" });
  });
});

describe("the writer", () => {
  const answer = {
    topic: "Octopus hearts", caption: "Nature is weird.", hashtags: ["#ocean", "#facts!!"], title: "Three hearts", headline: "Three hearts 🐙 and blue blood",
    subject: "a small orange octopus with big round eyes", music: "music2",
    scenes: [
      { text: "Octopuses have [excited] three hearts 🐙 and **blue** blood.", picture: "An orange octopus pointing at three hearts", keys: ["hearts", "purple", "blue"], tone: " [Excited] " },
      { text: "Two hearts pump blood to the gills.", picture: "x", keys: ["Gills"], tone: "angry and loud" },
      { text: "   ", picture: "Nothing", keys: [] },
      { text: "When it swims, the third heart stops.", picture: "The octopus swimming, one heart greyed out", keys: ["stops"] },
    ],
  };

  it("keeps plain spoken scenes, real key words and a picture for each; drops what does not fit", () => {
    const k = acceptStory(answer)!;
    expect(k.scenes).toEqual([
      // A tone the voice knows is kept (as a plain word); anything else is no tone.
      { text: "Octopuses have three hearts and blue blood.", picture: "An orange octopus pointing at three hearts", keys: ["hearts", "blue"], tone: "excited", place: "" },
      { text: "Two hearts pump blood to the gills.", picture: "An illustration of: Two hearts pump blood to the gills.", keys: ["gills"], tone: "", place: "" },
      { text: "When it swims, the third heart stops.", picture: "The octopus swimming, one heart greyed out", keys: ["stops"], tone: "", place: "" },
    ]);
    expect(k).toMatchObject({ subject: "a small orange octopus with big round eyes", look: "", music: "music2", headline: "Three hearts and blue blood", title: "Three hearts" });
    expect(acceptStory({ ...answer, music: "Lo-fi beats" })!.music).toBe("");
    // The video's look, kept for every picture's prompt.
    expect(acceptStory({ ...answer, look: "  A sunlit coral reef, turquoise water, orange and coral pink " })!.look).toBe("A sunlit coral reef, turquoise water, orange and coral pink");
    expect(scenePrompt("An octopus waves", "a small orange octopus", "doodle", "A sunlit coral reef, turquoise and coral pink."))
      .toMatch(/^An octopus waves\. Recurring characters, drawn the same whenever they appear, only in the scenes that show them: a small orange octopus\. The same world in every scene: A sunlit coral reef, turquoise and coral pink\. Style: /);
    // Over the length, the script ends at the last whole scene that fits; fewer than two is no script.
    expect(acceptStory(answer, 82)!.scenes.map((x) => x.text)).toEqual(["Octopuses have three hearts and blue blood.", "Two hearts pump blood to the gills."]);
    expect(acceptStory(answer, 60)).toBeNull();
    expect(acceptStory({ scenes: "x" })).toBeNull();
  });

  it("keeps the sounds picked from the lists, never the same one twice in a row and on at most half the scenes", () => {
    expect(acceptSounds(["sound1", "sound1", " sound3 ", "a crackling fire"])).toEqual(["sound1", "", "", ""]);
    expect(acceptSounds(["sound1", "", "sound3", "a crackling fire"])).toEqual(["sound1", "", "sound3", ""]);
    expect(acceptSounds(["sound1", "new1", "sound3", "sound4"])).toEqual(["sound1", "new1", "", ""]);
    // A sound the library lacks: named and described in a few words, of a scene category, 1 to 8 seconds, at most two.
    const bells = { code: "new1", name: "Camel Caravan Bells", description: "Brass bells on camels swaying as a caravan walks slowly past", category: "animals", seconds: 12.3 };
    expect(acceptNewSounds([
      bells, { ...bells, name: "The same code again" }, { ...bells, code: "new2", name: "Hi" }, { ...bells, code: "sound4", name: "Not a new code" },
      { ...bells, code: "new3", description: "Too few words" }, { code: "new2", name: "Low Drone", description: "A low hum that slowly rises and falls", category: "Transition", seconds: "x" },
      { ...bells, code: "new4", name: "One too many" },
    ])).toEqual([
      { ...bells, category: "Animals", seconds: 8 }, { code: "new2", name: "Low Drone", description: "A low hum that slowly rises and falls", category: "", seconds: 3 },
    ]);
    expect(acceptNewSounds("bells")).toEqual([]);
    // In the spec: sound effects on with the whoosh, each scene's sound; without them, none.
    const k = acceptStory(answer)!;
    const spec = conceptToSpec(k, { kind: "story", voiceId: "aria", style: "clay", language: "en", sounds: { transitionId: id(7), scenes: [id(8), null, id(9)] } })!;
    expect(spec.sounds).toEqual({ enabled: true, volume: SOUND_VOLUME, transitionId: id(7) });
    expect(spec.scenes.map((x) => x.soundId)).toEqual([id(8), undefined, id(9)]);
    const noWhoosh = conceptToSpec(k, { kind: "story", voiceId: "aria", style: "clay", language: "en", sounds: { transitionId: null, scenes: [null, null, null] } })!;
    expect(noWhoosh.sounds).toEqual({ enabled: true, volume: SOUND_VOLUME });
    const plain = conceptToSpec(k, { kind: "story", voiceId: "aria", style: "clay", language: "en" })!;
    expect(plain.sounds).toBeUndefined();
    expect(plain.scenes.some((x) => "soundId" in x)).toBe(false);
  });

  it("gives the writer the library sounds that match the scenes first, then some of every kind", () => {
    const sound = (id: string, name: string, category: string, tags = "", description = "") => ({ id, name, category, tags, description });
    const rows = [
      sound("1", "Ocean Waves", "Water", "ocean, waves, sea", "Waves crashing on rocks"), sound("2", "Campfire", "Fire", "fire, crackle"),
      sound("3", "Crowd Cheer", "Crowd", "crowd, cheering"), sound("4", "Rain", "Weather", "rain"), sound("5", "Storm", "Weather", "", "Thunder over the ocean"),
    ];
    // Name, category and tags count most; "waves" finds "wave", "cheered" finds "cheering".
    expect(rankSounds(rows, "The waves hit the ship as the crowd cheered", 3).map((r) => r.id)).toEqual(["3", "1", "2"]);
    expect(rankSounds(rows, "The waves hit the ship as the crowd cheered").map((r) => r.id)).toEqual(["3", "1", "2", "4", "5"]);
    // The description counts too, less; nothing matching: every kind in turn, in the library's order.
    expect(rankSounds(rows, "A crackling fire, then thunder", 2).map((r) => r.id)).toEqual(["2", "5"]);
    expect(rankSounds(rows, "Octopuses have three hearts").map((r) => r.id)).toEqual(["1", "2", "3", "4", "5"]);
  });

  it("names each place once and sets every scene in one of them, or none", () => {
    const k = acceptStory({
      ...answer,
      places: [
        { label: " The Reef Cave ", description: " A low rock cave, purple sponges on the walls, a sandy floor, blue light from the opening " },
        { label: "the reef cave", description: "A second description of the same place" },
        { label: "", description: "No label" },
        { label: "the open sea", description: "" },
        "a shipwreck",
      ],
      scenes: answer.scenes.map((s, i) => ({ ...s, place: ["the reef cave", "THE  REEF CAVE", "", "the kitchen"][i] })),
    })!;
    expect(k.places).toEqual([
      { label: "The Reef Cave", description: "A low rock cave, purple sponges on the walls, a sandy floor, blue light from the opening" },
      { label: "the open sea", description: "" },
    ]);
    // A scene's place is the place's own label; a place the writer did not name is none.
    expect(k.scenes.map((s) => s.place)).toEqual(["The Reef Cave", "The Reef Cave", ""]);
    const spec = conceptToSpec(k, { kind: "story", voiceId: "aria", style: "clay", language: "en" })!;
    expect(spec.places).toEqual(k.places);
    expect(spec.scenes.map((s) => s.place)).toEqual(["The Reef Cave", "The Reef Cave", ""]);
    // Each picture set there carries the place's description.
    expect(pendingMedia(spec).map((m) => m.prompt.includes("The place, The Reef Cave, the same in every scene set there: A low rock cave, purple sponges"))).toEqual([true, true, false]);
    expect(scenePrompt("An octopus waves", "", "doodle", "", { label: "the cave", description: "A low rock cave." }))
      .toMatch(/^An octopus waves\. The place, the cave, the same in every scene set there: A low rock cave\. Style: /);
    // Labels are names: two places of the same name are refused, and older videos have none.
    expect(storySpec.safeParse({ ...spec, places: [...spec.places, { label: "the REEF cave", description: "" }] }).success).toBe(false);
    expect(placeOf(undefined, "the cave")).toBeUndefined();
    expect(placeOf(spec.places, undefined)).toBeUndefined();
    // Reference sheets: the main character, and the reef (two pictures there); none without two AI pictures or with a
    // background clip; no character sheet without a main character.
    expect(pictureSheets(spec).map((x) => [x.kind, x.place ?? null])).toEqual([["character", null], ["place", "the reef cave"]]);
    expect(pictureSheets({ ...spec, subject: "" }).map((x) => x.kind)).toEqual(["place"]);
    expect(pictureSheets({ ...spec, scenes: spec.scenes.map((s, i) => (i ? { ...s, source: "own" as const, assetId: id(1) } : s)) })).toEqual([]);
    expect(pictureSheets({ ...spec, backdrop: { libraryId: id(4) } })).toEqual([]);
    expect(pictureSheets(spec)[0].key).toBe(pictureSheets({ ...spec, places: [] })[0].key);
  });

  it("turns a script into a video of the chosen type, voice, style and language", () => {
    const k = acceptStory(answer)!;
    const spec = conceptToSpec(k, { kind: "story", voiceId: "aria", style: "clay", language: "es", music: { trackId: id(3), volume: 0.25 } })!;
    expect(spec).toMatchObject({
      format: "story", kind: "story", language: "es", narration: { kind: "voice", voiceId: "aria" }, style: "clay", subject: "a small orange octopus with big round eyes",
      captions: { enabled: true, style: "keyword" }, music: { trackId: id(3), volume: 0.25 }, hashtags: ["#ocean", "#facts"], backdrop: null, title: "Three hearts",
    });
    // A title card for the first seconds.
    expect(spec.headline).toMatchObject({ text: "Three hearts and blue blood", seconds: 3 });
    expect(spec.scenes.map((s) => [s.source, s.keys])).toEqual([["image", ["hearts", "blue"]], ["image", ["gills"]], ["image", ["stops"]]]);
    // The first scenes animated when asked; a POV line stays on screen; the owner's subject wins.
    const pov = conceptToSpec(k, { kind: "pov", voiceId: "aria", style: "clay", language: "en", animate: 2, subject: "a red fox" })!;
    expect(pov.scenes.map((s) => s.source)).toEqual(["clip", "clip", "image"]);
    expect(pov.headline).toMatchObject({ text: "POV: Three hearts and blue blood", seconds: 0 });
    expect(pov.subject).toBe("a red fox");
    // Storytime: one background clip under the whole voice, bold subtitles, nothing animated.
    const told = conceptToSpec(k, { kind: "backdrop", voiceId: "aria", style: "clay", language: "en", animate: 2, backdropId: id(4) })!;
    expect(told).toMatchObject({ backdrop: { libraryId: id(4) }, captions: { style: "bold" } });
    expect(told.scenes.every((s) => s.source === "image")).toBe(true);
    expect(storyShape(30)).toEqual({ chars: 450, count: 7 });
    expect(storyShape(160).count).toBe(36);
  });

  it("plans pictures by scene ID", () => {
    expect(acceptScenePlan({ subject: "a fox", look: " A snowy pine forest at dusk, blue and amber ", title: "  The night fox ", scenes: [{ id: "s2", picture: "A fox at night", keys: ["night"] }, { id: "s9", picture: "Nope" }] }, ["Hello.", "It was night."]))
      .toEqual({ subject: "a fox", look: "A snowy pine forest at dusk, blue and amber", places: [], title: "The night fox", scenes: [{ description: "", keys: [], tone: "", place: "" }, { description: "A fox at night", keys: ["night"], tone: "", place: "" }] });
    expect(acceptScenePlan({ places: [{ label: "the den", description: "A burrow under pine roots" }], scenes: [{ id: "s1", picture: "A fox sleeps", place: "The Den" }, { id: "s2", picture: "A fox at night", place: "the den" }] }, ["Hello.", "It was night."]))
      .toMatchObject({ places: [{ label: "the den", description: "A burrow under pine roots" }], scenes: [{ place: "the den" }, { place: "the den" }] });
    expect(acceptScenePlan({ scenes: [] }, ["Hi."])).toBeNull();
  });
});

/** A JPEG header declaring width×height (enough for imageInfo). */
function jpeg(width = 1080, height = 1920) {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9, ...new Array(40).fill(0)]);
}
/**
 * A fake renderer container: accepts jobs, completes them at once, serves small files. `outdated`: one from before
 * sound effects, which finishes a video without mixing them (and doesn't say how many it mixed).
 */
function renderer(log: any[] = []) {
  const jobs = new Map<string, any>();
  const fake = {
    log, jobs, outdated: false,
    idFromName: (n: string) => n,
    get: () => ({
      fetch: async (url: string, init: any = {}) => {
        const path = new URL(url).pathname.split("/").filter(Boolean);
        if (init.method === "POST") { const p = JSON.parse(init.body); log.push(p); jobs.set(p.id, p); return Response.json({ status: "running" }, { status: 202 }); }
        if (init.method === "DELETE") return Response.json({});
        const job = jobs.get(path[1]);
        if (!job) return new Response("{}", { status: 404 });
        if (path[2] === "file") return new Response(path[3] === "0" ? new Uint8Array(4000).fill(7) : jpeg());
        return Response.json({ status: "completed", duration: DURATION, files: 2, ...(!fake.outdated && job.operation === "compose" && { sounds: job.sounds?.length ?? 0 }) });
      },
    }),
  };
  return fake;
}
/** ElevenLabs character timings of the original text (`alignment`), saying `said`. */
function alignment() {
  const characters: string[] = [], starts: number[] = [], ends: number[] = [];
  said.forEach(([text, start, end], i) => {
    if (i) { characters.push(" "); starts.push(start - 0.1); ends.push(start); }
    const step = (end - start) / text.length;
    [...text].forEach((ch, k) => { characters.push(ch); starts.push(start + k * step); ends.push(start + (k + 1) * step); });
  });
  return { characters, character_start_times_seconds: starts, character_end_times_seconds: ends };
}
/**
 * ElevenLabs (speech, forced alignment) and fal; `refuseClip` makes the clip model refuse, `refuse` the models it
 * names when their result is read (as Nano Banana does); `timings` false drops them.
 */
function providers({ refuseClip = false, refuseHeyGen = false, heygenFails = 0, heygenDown = false, heygenHiccups = false, timings = true, refuse = (() => false) as (model: string) => boolean } = {}) {
  const calls: { method: string; url: string; body?: any; headers?: Headers }[] = [];
  const failing = new Set<string>();
  let n = 0;
  vi.stubGlobal("fetch", async (input: any, init: any = {}) => {
    const url = String(input?.url ?? input), method = init.method || input?.method || "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body instanceof FormData ? Object.fromEntries([...init.body.entries()].map(([k, v]) => [k, typeof v === "string" ? v : `file:${(v as File).size}`])) : undefined;
    calls.push({ method, url, body, headers: new Headers(init.headers || input?.headers) });
    if (url === ALIGNMENT_URL) return Response.json({ words: words.map((w) => ({ ...w, loss: 0.1 })), characters: [], loss: 0.1 });
    if (url.includes("api.elevenlabs.io")) return Response.json({ audio_base64: Buffer.from(new Uint8Array(DURATION * 48000)).toString("base64"), ...(timings && { alignment: alignment() }) });
    const fal = url.match(/^https:\/\/queue\.fal\.run\/(.+?)(\/requests\/.*)?$/);
    if (fal && method === "POST") {
      if (refuseClip && fal[1].includes("kling")) return Response.json({ detail: [{ type: "content_policy_violation" }] }, { status: 422 });
      const r = `r${++n}`;
      return Response.json({ request_id: r, status_url: `https://queue.fal.run/${fal[1]}/requests/${r}/status`, response_url: `https://queue.fal.run/${fal[1]}/requests/${r}` });
    }
    if (fal && url.endsWith("/status")) return Response.json({ status: "COMPLETED" });
    if (fal && refuse(fal[1])) return Response.json({ detail: [{ type: "content_policy_violation" }] }, { status: 422 });
    if (fal) return Response.json(/kling|minimax\/h3|flux-3-max|seedance/.test(fal[1]) ? { video: { url: "https://v3.fal.media/files/clip.mp4" } } : { images: [{ url: "https://v3.fal.media/files/shot.jpg" }] });
    // HeyGen Video 1: a job, then "processing" once, then done (or refused when `refuseHeyGen`); its copy deleted.
    if (url === "https://api.heygen.com/v3/models/videos" && method === "POST") {
      // Out of API credits: HeyGen answers 400.
      if (heygenDown) return Response.json({ error: { code: "insufficient_credits", message: "Insufficient credits" } }, { status: 400 });
      // A gateway error on the first try (HeyGen may or may not have the job: the same Idempotency-Key finds it).
      if (heygenHiccups && calls.filter((c) => c.url === url).length === 1) return new Response("bad gateway", { status: 502 });
      const id = `hv${++n}`;
      // The first `heygenFails` jobs fail at HeyGen.
      if (calls.filter((c) => c.url === url).length <= heygenFails) failing.add(id);
      return Response.json({ data: { status: "pending", video_id: id } }, { status: 202 });
    }
    const hv = url.match(/^https:\/\/api\.heygen\.com\/v3\/models\/videos\/(hv\d+)$/);
    if (hv) {
      const polls = calls.filter((c) => c.url === url).length;
      if (polls === 1) return Response.json({ data: { video_id: hv[1], status: "processing" } });
      // HeyGen can't answer for a moment: the job is still fine.
      if (heygenHiccups && (polls === 2 || polls === 4)) return new Response("unavailable", { status: 503 });
      if (refuseHeyGen) return Response.json({ data: { video_id: hv[1], status: "failed", failure_code: "generation_failed", failure_message: "Content moderation" } });
      if (failing.has(hv[1])) return Response.json({ data: { video_id: hv[1], status: "failed", failure_code: "generation_failed", failure_message: "Internal error" } });
      return Response.json({ data: { video_id: hv[1], status: "completed", video_url: `https://resource2.heygen.ai/videos/${hv[1]}.mp4?sig=${polls}` } });
    }
    if (/^https:\/\/resource2\.heygen\.ai\/videos\/hv\d+\.mp4/.test(url)) return new Response(new Uint8Array(2000).fill(3));
    if (/^https:\/\/api\.heygen\.com\/v3\/videos\/hv\d+$/.test(url) && method === "DELETE") return Response.json({ data: {} });
    if (url === "https://v3.fal.media/files/shot.jpg") return new Response(jpeg());
    if (url === "https://v3.fal.media/files/clip.mp4") return new Response(new Uint8Array(3000).fill(2));
    throw new Error("unexpected " + url);
  });
  return calls;
}
const step = { do: async (_name: string, a: any, b?: any) => (b ?? a)(), sleep: async () => {} };
async function setup() {
  const { env, sqlite } = testEnv({ MEDIA_ENABLED: "true", FAL_KEY: "fal", ELEVENLABS_API_KEY: "el", MEDIA_RENDERER: renderer() });
  const user = signedIn(sqlite);
  subscribe(sqlite, user.id, "starter");
  // Signing in sets up the plan's usage window and storage.
  await call(worker, env, "GET", "/api/auth/me", undefined, user.cookie);
  const own = crypto.randomUUID();
  await env.MEDIA.put(`media/${user.id}/${own}.jpg`, jpeg());
  sqlite.prepare("INSERT INTO media_assets(id,user_id,kind,name,object_key,mime,bytes,width,height,status,created_at,updated_at) VALUES (?,?,'upload','Reef',?,'image/jpeg',64,1080,1920,'ready',1,1)")
    .run(own, user.id, `media/${user.id}/${own}.jpg`);
  const spec = story({ subject: "a small orange octopus", scenes: [
    scene(0), scene(1, { source: "clip", transition: "fade" }), scene(2), scene(3, { source: "own", assetId: own }), scene(4, { transition: "circleopen" }),
  ] });
  const used = () => (sqlite.prepare("SELECT used FROM usage_windows WHERE id LIKE ?").get(`${user.id}:sub_%`) as any).used as number;
  const run = async () => { for (const c of env.CONTENT.created.splice(0)) await new ContentGeneration({} as any, env).run({ payload: c.params } as any, step as any); };
  return { env, sqlite, user, spec, own, used, run };
}
afterEach(() => vi.unstubAllGlobals());

describe("narrated videos in the content run", () => {
  it("tells the voice each scene's tone as an audio tag, keeps tags out of the words, and records again for a new tone", async () => {
    const { env, user, spec, run } = await setup();
    const calls = providers();
    const toned = { ...spec, scenes: spec.scenes.map((s, i) => (i === 0 ? { ...s, tone: "whispers" as const } : i === 2 ? { ...s, tone: "excited" as const } : s)) };
    const created = await call(worker, env, "POST", "/api/videos", { spec: toned, idempotencyKey: crypto.randomUUID() }, user.cookie);
    expect(created.status).toBe(201);
    await run();
    // ElevenLabs gets the script with the tones in brackets before their scenes' words.
    const speech = calls.find((c) => c.url.includes("/v1/text-to-speech/"))!;
    expect(speech.body.text).toBe(voicedScript(toned.scenes));
    expect(speech.body.text.startsWith(`[whispers] ${textWords(toned.scenes[0].text).join(" ")} `)).toBe(true);
    expect(speech.body.text).toContain(` [excited] ${textWords(toned.scenes[2].text).join(" ")} `);
    const video = (await call(worker, env, "GET", `/api/videos/${created.data.id}`, undefined, user.cookie)).data.video;
    expect(narrationCurrent(video.spec)).toBe(true);
    // Another tone is a new recording, charged like new words; no tones at all is the plain script (older videos stay current).
    const sad = { ...video.spec, scenes: video.spec.scenes.map((s: any, i: number) => (i === 1 ? { ...s, tone: "sad" } : s)) };
    expect(narrationCurrent(sad)).toBe(false);
    expect(specCredits(sad, false)).toBe(voiceCredits(storyScript(sad.scenes)));
    expect(voicedScript(spec.scenes)).toBe(storyScript(spec.scenes));
    // The voice's timings skip the tags, so the subtitles never show them.
    const chars = [..."[whispers] Hi there"];
    expect(alignmentWords({ characters: chars, characterStartTimesSeconds: chars.map((_, i) => i / 10), characterEndTimesSeconds: chars.map((_, i) => (i + 1) / 10) }).map((w) => w.text))
      .toEqual(["Hi", "there"]);
    expect(specSchema.safeParse({ ...video.spec, scenes: video.spec.scenes.map((s: any) => ({ ...s, tone: "shouting" })) }).success).toBe(false);
  });

  it("keeps the render's plan (its whole subtitle script) out of what a workflow step returns", async () => {
    const { env, user, spec } = await setup();
    providers();
    expect((await call(worker, env, "POST", "/api/videos", { spec, idempotencyKey: crypto.randomUUID() }, user.cookie)).status).toBe(201);
    // Workflows refuse a step result over 1 MiB: a long video's subtitles alone are more.
    const returned: Record<string, unknown> = {};
    const recording = { do: async (name: string, a: any, b?: any) => (returned[name] = await (b ?? a)()), sleep: async () => {} };
    for (const c of env.CONTENT.created.splice(0)) await new ContentGeneration({} as any, env).run({ payload: c.params } as any, recording as any);
    expect(Object.keys(returned["compose-payload"] as object).sort()).toEqual(["id", "urls"]);
    expect(Object.values(returned).some((v) => JSON.stringify(v ?? null).includes("[Script Info]"))).toBe(false);
    expect(Math.max(...Object.values(returned).map((v) => JSON.stringify(v ?? null).length))).toBeLessThan(200_000);
  });

  it("draws a series' main character once, and every later episode from that drawing", async () => {
    const { env, sqlite, user, spec, run } = await setup();
    const calls = providers();
    const seriesId = crypto.randomUUID();
    const save = (settings: Record<string, unknown>) => JSON.stringify(seriesSettingsSchema.parse({ subject: spec.subject, style: spec.style, ...settings }));
    sqlite.prepare("INSERT INTO series(id,user_id,name,template,settings,status,created_at,updated_at) VALUES (?,?,'Reef tales','facts',?,'active',1,1)").run(seriesId, user.id, save({}));
    const series = () => sqlite.prepare("SELECT character_asset,character_key FROM series WHERE id=?").get(seriesId) as any;
    const view = async () => (await call(worker, env, "GET", `/api/series/${seriesId}`, undefined, user.cookie)).data.series;
    const kept = () => sqlite.prepare("SELECT id,object_key FROM media_assets WHERE video_id IS NULL AND json_extract(meta,'$.series')=?").all(seriesId) as any[];
    /** An episode of the series (optionally of another spec), made; the pictures fal was asked for. */
    const episode = async (of: StorySpec = spec, make = true) => {
      const created = await call(worker, env, "POST", "/api/videos", { spec: of, idempotencyKey: crypto.randomUUID() }, user.cookie);
      expect(created.status).toBe(201);
      sqlite.prepare("UPDATE videos SET series_id=? WHERE id=?").run(seriesId, created.data.id);
      const before = calls.length;
      if (make) await run();
      const pictures = calls.slice(before).filter((c) => c.method === "POST" && c.url.startsWith("https://queue.fal.run/") && !c.url.includes("/kling-video/"));
      const inputs: string[] = JSON.parse((sqlite.prepare("SELECT provider FROM runs WHERE video_id=?").get(created.data.id) as any).provider).inputs ?? [];
      return { id: created.data.id as string, inputs, sheets: pictures.filter((c) => String(c.body.prompt).startsWith("Character reference sheet")).length, drawn: pictures.filter((c) => c.body.image_urls) };
    };
    expect((await view()).characterAssetId).toBeNull();
    // The first episode draws the octopus, and the series keeps a copy that belongs to no video.
    const first = await episode();
    expect(first.sheets).toBe(1);
    const look = series();
    expect(look.character_key).toBe(characterSheetKey(spec.subject!, spec.style));
    expect(look.character_key).toBe(pictureSheets(spec)[0].key);
    expect(kept().map((a) => a.id)).toEqual([look.character_asset]);
    expect((await view()).characterAssetId).toBe(look.character_asset);
    expect((await call(worker, env, "GET", `/api/media/${look.character_asset}/file`, undefined, user.cookie)).status).toBe(200);
    // The second draws no sheet: its scenes are drawn from the series' drawing.
    const second = await episode();
    expect(second.sheets).toBe(0);
    expect(second.drawn.length).toBeGreaterThan(0);
    expect(second.inputs).toContain(kept()[0].object_key);
    const link = new RegExp(`/api/render-inputs/[0-9a-f-]{36}/${second.inputs.indexOf(kept()[0].object_key)}\\?token=`);
    expect(second.drawn.every((c) => link.test(c.body.image_urls[0]))).toBe(true);
    expect(series()).toEqual(look);
    // The first episode's own sheet stays its own: deleting that episode leaves the series' drawing.
    expect((await call(worker, env, "DELETE", `/api/videos/${first.id}`, undefined, user.cookie)).status).toBe(200);
    expect(kept().map((a) => a.id)).toEqual([look.character_asset]);
    // An episode whose character was changed in the editor is not the series' character.
    const squid = await episode({ ...spec, subject: "a tall green squid" });
    expect(squid.sheets).toBe(1);
    expect(series()).toEqual(look);
    // A new art style is a new drawing: the page shows none until the next episode draws it, which replaces the old one.
    sqlite.prepare("UPDATE series SET settings=? WHERE id=?").run(save({ style: "anime" }), seriesId);
    expect((await view()).characterAssetId).toBeNull();
    const restyled = await episode({ ...spec, style: "anime" });
    expect(restyled.sheets).toBe(1);
    expect(series().character_key).toBe(characterSheetKey(spec.subject!, "anime"));
    expect(series().character_asset).not.toBe(look.character_asset);
    expect(kept().map((a) => a.id)).toEqual([series().character_asset]);
    // "New look" forgets the drawing (not while an episode is being made from it); the next episode draws another.
    const waiting = await episode({ ...spec, style: "anime" }, false);
    expect((await call(worker, env, "DELETE", `/api/series/${seriesId}/character`, undefined, user.cookie)).status).toBe(409);
    await run();
    expect(waiting.sheets).toBe(0);
    const forgotten = await call(worker, env, "DELETE", `/api/series/${seriesId}/character`, undefined, user.cookie);
    expect(forgotten).toMatchObject({ status: 200, data: { series: { characterAssetId: null } } });
    expect(kept()).toEqual([]);
    expect((await episode({ ...spec, style: "anime" })).sheets).toBe(1);
    expect(kept()).toHaveLength(1);
    // The drawing goes with its series; the episodes stay.
    expect((await call(worker, env, "DELETE", `/api/series/${seriesId}`, undefined, user.cookie)).status).toBe(200);
    expect(kept()).toEqual([]);
    expect((await call(worker, env, "GET", `/api/videos/${second.id}`, undefined, user.cookie)).status).toBe(200);
  });

  it("makes a cinematic video: every scene a clip with film framing and sound, cut hard, with a film look; only an administrator picks the model", async () => {
    const { env, sqlite, user, spec, run } = await setup();
    env.FAL_CLIP_MODEL_ADMIN = "flux-3-max";
    // Anyone can draft one: every scene a clip of the quality asked for. A model is an administrator's choice, so
    // anyone else's is left out of the draft.
    const brief = { template: "script", script: "The reef wakes slowly. A small octopus leaves its den. It finds a silver coin in the sand. Then a shadow passes overhead.", film: { quality: "high", model: "flux-3-max" } };
    const mock = providers();
    env.AI.run = async () => ({ status: "completed", output_text: JSON.stringify({ subject: "", look: "", title: "The reef", places: [], scenes: [] }) });
    const draft = await call(worker, env, "POST", "/api/story/draft", brief, user.cookie);
    expect(draft.status).toBe(200);
    expect(draft.data.spec.film).toBe(true);
    expect(draft.data.spec.scenes.every((s: any) => s.source === "clip" && s.transition === "cut" && s.clipQuality === "high" && s.clipModel === undefined)).toBe(true);
    // And anyone can make one: a model named in the spec all the same is ignored when its clips are made (Kling, everyone's).
    const filmed = filmSpec(spec, { quality: "regular", model: "flux-3-max" });
    const theirs = await call(worker, env, "POST", "/api/videos", { spec: filmed, idempotencyKey: crypto.randomUUID() }, user.cookie);
    expect(theirs.status).toBe(201);
    await run();
    expect((await call(worker, env, "GET", `/api/videos/${theirs.data.id}`, undefined, user.cookie)).data.video).toMatchObject({ renderStatus: "ready", spec: { film: true } });
    expect(mock.filter((c) => c.method === "POST" && c.url.includes("flux-3-max"))).toHaveLength(0);
    expect(mock.filter((c) => c.method === "POST" && c.url.includes("kling-video")).length).toBe(4);
    // An administrator's: the AI pictures become clips as long as their scenes, of the chosen quality and model; the
    // owner's own picture stays; every scene changes on a cut.
    sqlite.prepare("UPDATE users SET email='admin@example.com' WHERE id=?").run(user.id);
    const asAdmin = await call(worker, env, "POST", "/api/story/draft", brief, user.cookie);
    expect(asAdmin.data.spec.scenes.every((s: any) => s.clipModel === "flux-3-max")).toBe(true);
    expect(filmed.film).toBe(true);
    expect(filmed.scenes.map((s) => [s.source, s.transition])).toEqual([["clip", "cut"], ["clip", "cut"], ["clip", "cut"], ["own", "cut"], ["clip", "cut"]]);
    expect(filmed.scenes.filter((s) => s.source === "clip").every((s) => s.clipQuality === "regular" && s.clipModel === "flux-3-max" && [5, 10].includes(s.clipSeconds))).toBe(true);
    expect(filmSpec({ ...spec, backdrop: { libraryId: crypto.randomUUID() } }).film).toBeUndefined();
    // Its price: the video by its length, plus every clip.
    const clips = filmed.scenes.filter((s) => s.source === "clip");
    expect(specCredits(filmed, true)).toBe(videoCredits(estimatedSeconds(filmed)) + clips.reduce((n, s) => n + CLIP_CREDITS.regular * (s.clipSeconds / 5), 0));
    const calls = providers();
    const created = await call(worker, env, "POST", "/api/videos", { spec: filmed, idempotencyKey: crypto.randomUUID() }, user.cookie);
    expect(created.status).toBe(201);
    await run();
    const video = (await call(worker, env, "GET", `/api/videos/${created.data.id}`, undefined, user.cookie)).data.video;
    expect(video.renderStatus).toBe("ready");
    expect(video.spec.film).toBe(true);
    const fal = calls.filter((c) => c.method === "POST" && c.url.startsWith("https://queue.fal.run/"));
    // Pictures framed as film stills, each scene its own shot.
    const stills = fal.filter((c) => /^Draw a new picture of this scene/.test(c.body.prompt));
    expect(stills).toHaveLength(4);
    expect(stills[0].body.prompt).toContain("Composed as a wide establishing shot from a film");
    expect(stills[1].body.prompt).toContain("Composed as a medium shot from a film");
    // Clips from the chosen model, each with a camera move, asked for the scene's ambience and nothing spoken.
    const made = fal.filter((c) => c.url.includes("flux-3-max"));
    expect(made).toHaveLength(4);
    expect(made.every((c) => c.body.generate_audio === true)).toBe(true);
    expect(made[0].body.prompt).toMatch(/^Doodle of sentence 1\. A slow push-in\. .*no speech, no voices and no music\./);
    expect(made[1].body.prompt).toContain("A slow sideways tracking move.");
    // The render: the clips' own sound quietly under the voice, no transitions, and the film look.
    const narration = { key: "media/u/voice.wav", duration: 12, words: video.spec.generated.words };
    const media = Object.fromEntries(video.spec.scenes.flatMap((s: any) => [s.clipId, s.imageId, s.assetId]).filter(Boolean)
      .map((id: string, n: number) => [id, { key: `media/u/${n}`, kind: video.spec.scenes.some((s: any) => s.clipId === id) ? "video" : "image", duration: 5, width: 1080, height: 1920, ai: true }]));
    const { compose } = planRender(video.spec, { media, narration, watermark: "" } as PlanContext);
    expect(compose.look).toBe("film");
    expect(compose.segments.map((s) => [s.kind, s.audio ?? null, s.transition ?? null])).toEqual([
      ["video", FILM_AMBIENCE, null], ["video", FILM_AMBIENCE, null], ["video", FILM_AMBIENCE, null], ["image", null, null], ["video", FILM_AMBIENCE, null],
    ]);
    // The same video without the flag: silent clips, and no look.
    const plain = planRender({ ...video.spec, film: undefined }, { media, narration, watermark: "" } as PlanContext).compose;
    expect(plain.look).toBeUndefined();
    expect(plain.segments.every((s) => !s.audio)).toBe(true);
  });

  it("makes a product ad for an administrator: shots drawn and filmed with the product's photos, their sound under the voice, no film look", async () => {
    const { env, sqlite, user, own, run } = await setup();
    const product = { assets: [own], name: "Aqua Steel", model: "minimax" as const };
    const brief = { template: "ad", prompt: "A steel water bottle that keeps drinks cold for 24 hours", seconds: 15, product };
    const lines = ["Hot day, warm water again?", "Aqua Steel keeps your drink cold for 24 hours.", "Try it today."];
    env.AI.run = async () => ({ status: "completed", output_text: JSON.stringify({
      title: "Aqua Steel", topic: "steel bottle", caption: "Cold for a whole day.", hashtags: ["bottle"], headline: "Aqua Steel", subject: "", look: "A bright kitchen in the morning.", places: [], music: "",
      scenes: lines.map((text, n) => ({ text, picture: `A hand lifts the product from a table, shot ${n + 1}`, keys: [], tone: "", place: "" })),
    }) });
    // A test: nobody but an administrator drafts one, or makes one drafted elsewhere.
    expect((await call(worker, env, "POST", "/api/story/draft", brief, user.cookie)).status).toBe(403);
    const plain = specSchema.parse({ format: "story", narration: { kind: "voice", voiceId: "george" }, scenes: lines.map((text, n) => ({ text, description: `A hand lifts the product, shot ${n + 1}`, keys: [] })) }) as StorySpec;
    const ad = adSpec(plain, product);
    const refused = await call(worker, env, "POST", "/api/videos", { spec: ad, idempotencyKey: crypto.randomUUID() }, user.cookie);
    expect(refused.status).toBe(403);
    expect(refused.data.error).toBe("Product ads are still being tested and aren't available yet.");
    sqlite.prepare("UPDATE users SET email='admin@example.com' WHERE id=?").run(user.id);
    // It needs a photo of the product and what the product is.
    expect((await call(worker, env, "POST", "/api/story/draft", { ...brief, product: undefined }, user.cookie)).data.error).toBe("Add a photo of the product first.");
    expect((await call(worker, env, "POST", "/api/story/draft", { ...brief, prompt: "" }, user.cookie)).data.error).toBe("Say what the product is first.");
    // The draft: an ad with its product, every scene a filmed shot on a cut, no character of the writer's, no library sounds.
    const draft = await call(worker, env, "POST", "/api/story/draft", brief, user.cookie);
    expect(draft.status).toBe(200);
    expect(draft.data.spec).toMatchObject({ kind: "ad", film: true, product, subject: "", backdrop: null, presenter: null, headline: { text: "Aqua Steel" } });
    expect(draft.data.spec.sounds).toBeUndefined();
    expect(draft.data.spec.scenes.map((s: any) => [s.text, s.source, s.transition, s.clipQuality, s.clipSeconds])).toEqual(lines.map((text) => [text, "clip", "cut", AD_CLIP_QUALITY, 5]));
    // An ad is its kind and its photos together, made of filmed shots.
    expect(specSchema.safeParse({ ...ad, product: undefined }).success).toBe(false);
    expect(specSchema.safeParse({ ...ad, kind: "story" }).success).toBe(false);
    expect(specSchema.safeParse({ ...ad, film: undefined }).success).toBe(false);
    expect(specSchema.safeParse({ ...ad, product: { assets: [own, own] } }).success).toBe(false);
    // Drawn from the photos alone (no sheets), which are kept with the video; priced as the video plus its shots.
    expect(pictureSheets(ad)).toEqual([]);
    expect(referencedAssets(ad)).toContain(own);
    expect(specCredits(ad, true)).toBe(videoCredits(estimatedSeconds(ad)) + 3 * CLIP_CREDITS[AD_CLIP_QUALITY]);
    expect(adCredits(15)).toBe(1 + 3 * CLIP_CREDITS[AD_CLIP_QUALITY]);
    // The photos must be the owner's pictures.
    const stranger = await call(worker, env, "POST", "/api/videos", { spec: { ...ad, product: { ...product, assets: [crypto.randomUUID()] } }, idempotencyKey: crypto.randomUUID() }, user.cookie);
    expect(stranger.status).toBe(400);
    const calls = providers();
    const created = await call(worker, env, "POST", "/api/videos", { spec: ad, idempotencyKey: crypto.randomUUID() }, user.cookie);
    expect(created.status).toBe(201);
    await run();
    const video = (await call(worker, env, "GET", `/api/videos/${created.data.id}`, undefined, user.cookie)).data.video;
    expect(video.renderStatus).toBe("ready");
    expect(video.spec).toMatchObject({ kind: "ad", product });
    const fal = calls.filter((c) => c.method === "POST" && c.url.startsWith("https://queue.fal.run/"));
    // Each shot's picture: drawn with the photo as its reference, the product kept as it is, its label allowed.
    const stills = fal.filter((c) => /^Draw a new picture of this scene/.test(c.body.prompt));
    expect(stills).toHaveLength(3);
    for (const c of stills) {
      expect(c.url).toBe(`https://queue.fal.run/${referenceModel(env)}`);
      expect(c.body.image_urls).toHaveLength(1);
      expect(c.body.image_urls[0]).toMatch(/^https:\/\/app\.test\/api\/render-inputs\//);
      expect(c.body.prompt).toContain("The product (Aqua Steel) is the one in the reference photos");
      expect(c.body.prompt).toContain(PRODUCT_TEXT);
      expect(c.body.prompt).toContain("The reference picture is a photo of the product this ad is for");
      expect(c.body.prompt).not.toContain("No text, captions, logos or watermarks in the picture.");
      expect(c.body.prompt).not.toContain("Match the art style");
    }
    expect(stills[0].body.prompt).toContain("Composed as a close-up product shot from an advertisement");
    // Each shot: its picture filmed by the films' model with the photo, asked for its own sound and nothing spoken.
    const shots = fal.filter((c) => c.url === "https://queue.fal.run/minimax/h3-max/reference-to-video");
    expect(shots).toHaveLength(3);
    for (const c of shots) {
      expect(c.body).toMatchObject({ duration: 5, resolution: "768P", prompt_expansion_mode: "balanced" });
      expect(c.body.image_url).toMatch(/^https:\/\/app\.test\/api\/render-inputs\//);
      expect(c.body.reference_image_urls).toEqual(stills[0].body.image_urls);
      expect(c.body.prompt).toContain("Image 1 is a photo of the product (Aqua Steel): keep it looking exactly as in it");
      expect(c.body.prompt).toContain("no speech, no voices and no music.");
    }
    expect(shots[0].body.prompt).toMatch(/^A hand lifts the product, shot 1\. A slow push-in on the product\./);
    expect(fal).toHaveLength(6);
    // The voiceover is recorded as for any video.
    expect(calls.filter((c) => c.url.includes("/v1/text-to-speech/"))).toHaveLength(1);
    // The render: the shots' own sound quietly under the voice on hard cuts, and the product's colours left alone.
    const narration = { key: "media/u/voice.wav", duration: 12, words: video.spec.generated.words };
    const media = Object.fromEntries(video.spec.scenes.flatMap((s: any) => [s.clipId, s.imageId]).filter(Boolean)
      .map((id: string, n: number) => [id, { key: `media/u/${n}`, kind: video.spec.scenes.some((s: any) => s.clipId === id) ? "video" : "image", duration: 5, width: 1080, height: 1920, ai: true }]));
    media[own] = { key: `media/${user.id}/${own}.jpg`, kind: "image", duration: 0, width: 1080, height: 1920, ai: false };
    const { compose } = planRender(video.spec, { media, narration, watermark: "" } as PlanContext);
    expect(compose.look).toBeUndefined();
    expect(compose.segments.map((s) => [s.kind, s.audio ?? null, s.transition ?? null])).toEqual([["video", FILM_AMBIENCE, null], ["video", FILM_AMBIENCE, null], ["video", FILM_AMBIENCE, null]]);
    // The photo is not shown itself: only the shots are.
    expect(compose.keys).not.toContain(`media/${user.id}/${own}.jpg`);
  });

  it("has the writer's own model write the draft, in its shape, and the text model choose the sounds", async () => {
    const { env, user } = await setup();
    // As deployed: the writer's model is the default one (the tests' environment sets the text model for it).
    delete env.WRITER_MODEL;
    const lines = ["Snow fell on the village all night.", "By morning the baker had a plan.", "Nobody went hungry that Christmas."];
    const asked: { model: string; request: any }[] = [];
    env.AI.run = async (model: string, request: any) => {
      asked.push({ model, request });
      const answer = JSON.stringify({
        title: "The baker's plan", topic: "a christmas tale", caption: "A small kindness.", hashtags: ["christmas"], headline: "The baker's plan", subject: "", look: "Warm window light on snow.",
        places: [{ label: "the village square", description: "A small snowy square with a stone fountain, timber houses around it, warm lit windows and a bakery with a green door." }], music: "",
        scenes: lines.map((text, n) => ({ text, picture: `Wide shot of the village square in the snow, moment ${n + 1}`, keys: [], tone: "", place: "the village square" })),
      });
      return model.startsWith("google/") ? { candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ text: answer }] } }] } : { status: "completed", output_text: answer };
    };
    const draft = await call(worker, env, "POST", "/api/story/draft", { template: "christmas", prompt: "A baker in a snowed-in village", seconds: 15 }, user.cookie);
    expect(draft.status).toBe(200);
    expect(draft.data.spec.scenes.map((x: any) => x.text)).toEqual(lines);
    expect(draft.data.spec.places.map((x: any) => x.label)).toEqual(["the village square"]);
    const writer = asked.find((a) => a.model === "google/gemini-4-carbon")!;
    expect(writer.request.systemInstruction.parts[0].text).toMatch(/^You write the script/);
    expect(writer.request.systemInstruction.parts[0].text).toContain(VARIETY_RULE);
    expect(writer.request.systemInstruction.parts[0].text).toContain('"required":["title","topic"');
    expect(JSON.parse(writer.request.contents[0].parts[0].text).ownerRequest).toBe("A baker in a snowed-in village");
    expect(writer.request.generationConfig.responseMimeType).toBe("application/json");
    // Everything else the text model is asked stays on it.
    expect(new Set(asked.filter((a) => a !== writer).map((a) => a.model))).toEqual(new Set(["openai/gpt-6-luna"]));
  });
  it("draws the people of a greeting into its pictures from their photos, with the owner's word that they may use them", async () => {
    const { env, sqlite, user, own, run } = await setup();
    const people = { assets: [own], consent: true as const };
    const brief = { template: "greeting", prompt: "Happy New Year to grandma and grandpa from their grandchildren", seconds: 30, people };
    const lines = ["Dear grandma and grandpa, thank you for this year.", "We wish you health and a warm home.", "Happy New Year from all of us."];
    const seen: string[] = [];
    env.AI.run = async (_model: string, input: any) => {
      seen.push(String(input.instructions));
      return { status: "completed", output_text: JSON.stringify({
        title: "Happy New Year", topic: "a greeting", caption: "With love.", hashtags: [], headline: "Happy New Year", subject: "an old couple", look: "A snowy evening.", places: [], music: "",
        scenes: lines.map((text, n) => ({ text, picture: `Medium shot, the people from the photos by the tree, moment ${n + 1}`, keys: [], tone: "", place: "" })),
      }) };
    };
    // A test: an administrator's, until it is opened.
    expect(PEOPLE_PHOTOS_OPEN).toBe(false);
    const refusedDraft = await call(worker, env, "POST", "/api/story/draft", brief, user.cookie);
    expect([refusedDraft.status, refusedDraft.data.error]).toEqual([403, "Photos of people are still being tested and aren't available yet."]);
    // Without photos the greeting is anyone's, as any style.
    expect((await call(worker, env, "POST", "/api/story/draft", { ...brief, people: undefined }, user.cookie)).status).toBe(200);
    // (The writer's instructions: the sound effects are chosen by a call after it.)
    const written = () => seen.filter((i) => i.startsWith("You write the script")).at(-1)!;
    expect(written()).not.toContain(PEOPLE_RULE);
    sqlite.prepare("UPDATE users SET email='admin@example.com' WHERE id=?").run(user.id);
    // The owner's word is required, and only a style that takes people takes them.
    expect((await call(worker, env, "POST", "/api/story/draft", { ...brief, people: { assets: [own] } }, user.cookie)).status).toBe(400);
    expect((await call(worker, env, "POST", "/api/story/draft", { ...brief, template: "facts" }, user.cookie)).data.error).toBe("This style doesn't take photos of people.");
    const draft = await call(worker, env, "POST", "/api/story/draft", brief, user.cookie);
    expect(draft.status).toBe(200);
    // The writer is told the people are in the pictures and never to describe them; no character of its own is kept.
    expect(written()).toContain(PEOPLE_RULE);
    const spec = specSchema.parse(draft.data.spec) as StorySpec;
    expect(spec).toMatchObject({ kind: "story", people, subject: "" });
    expect(spec.film).toBeUndefined();
    // Its pictures are drawn with the photos (no sheets), which are kept with the video.
    expect(pictureSheets(spec)).toEqual([]);
    expect(referencedAssets(spec)).toContain(own);
    expect(pendingMedia(spec).map((m) => [m.kind, m.people])).toEqual([["image", true], ["image", true], ["image", true]]);
    // Not with an ad's product, nor behind a background clip; and the photos must be the owner's pictures.
    expect(specSchema.safeParse({ ...spec, backdrop: { libraryId: crypto.randomUUID() } }).success).toBe(false);
    expect(specSchema.safeParse({ ...spec, people: { assets: [own] } }).success).toBe(false);
    expect((await call(worker, env, "POST", "/api/videos", { spec: { ...spec, people: { ...people, assets: [crypto.randomUUID()] } }, idempotencyKey: crypto.randomUUID() }, user.cookie)).status).toBe(400);
    const calls = providers();
    const created = await call(worker, env, "POST", "/api/videos", { spec, idempotencyKey: crypto.randomUUID() }, user.cookie);
    expect(created.status).toBe(201);
    await run();
    const video = (await call(worker, env, "GET", `/api/videos/${created.data.id}`, undefined, user.cookie)).data.video;
    expect(video.renderStatus).toBe("ready");
    expect(video.spec.people).toEqual(people);
    // Three pictures, each drawn with the photo as its reference: those very people, in the video's own style.
    const fal = calls.filter((c) => c.method === "POST" && c.url.startsWith("https://queue.fal.run/"));
    expect(fal).toHaveLength(3);
    for (const c of fal) {
      expect(c.url).toBe(`https://queue.fal.run/${referenceModel(env)}`);
      expect(c.body.image_urls).toHaveLength(1);
      expect(c.body.image_urls[0]).toMatch(/^https:\/\/app\.test\/api\/render-inputs\//);
      expect(c.body.prompt).toContain("the people from the photos by the tree");
      expect(c.body.prompt).toContain("they are the ones in the reference photos");
      expect(c.body.prompt).toContain("The reference picture is a photo of the people this video is for");
      expect(c.body.prompt).toContain("never paste the photo in");
      expect(c.body.prompt).toContain("No text, captions, logos or watermarks in the picture.");
      expect(c.body.prompt).not.toContain("Match the art style");
    }
    // The photo is a reference only: the render shows the drawn pictures.
    const narration = { key: "media/u/voice.wav", duration: 12, words: video.spec.generated.words };
    const media = Object.fromEntries(video.spec.scenes.map((sc: any, n: number) => [sc.imageId, { key: `media/u/${n}`, kind: "image", duration: 0, width: 1080, height: 1920, ai: true }]));
    media[own] = { key: `media/${user.id}/${own}.jpg`, kind: "image", duration: 0, width: 1080, height: 1920, ai: false };
    const { compose } = planRender(video.spec, { media, narration, watermark: "" } as unknown as PlanContext);
    expect(compose.keys).not.toContain(`media/${user.id}/${own}.jpg`);
    expect(compose.segments).toHaveLength(3);
  });

  it("films a product ad's shots with HeyGen Video 1: from their pictures alone, as regular clips, only where HeyGen is set up", async () => {
    const { env, sqlite, user, own, run } = await setup();
    sqlite.prepare("UPDATE users SET email='admin@example.com' WHERE id=?").run(user.id);
    const product = { assets: [own], name: "Aqua Steel", model: "heygen" as const };
    const lines = ["Hot day, warm water again?", "Aqua Steel keeps your drink cold for 24 hours.", "Try it today."];
    const plain = specSchema.parse({ format: "story", narration: { kind: "voice", voiceId: "george" }, scenes: lines.map((text, n) => ({ text, description: `A hand lifts the product, shot ${n + 1}`, keys: [] })) }) as StorySpec;
    const ad = adSpec(plain, product);
    // Regular clips (768p), one credit per five seconds: the cheapest of the models.
    expect(ad.scenes.every((s) => s.source === "clip" && s.clipQuality === "regular" && s.transition === "cut")).toBe(true);
    expect(specCredits(ad, true)).toBe(videoCredits(estimatedSeconds(ad)) + 3 * CLIP_CREDITS.regular);
    expect(adCredits(15, "heygen")).toBe(1 + 3);
    const drawn = { ...ad, scenes: ad.scenes.map((s, n) => ({ ...s, imageId: id(n + 1) })) };
    expect(pendingMedia(drawn).map((m) => [m.kind, m.fixedModel, m.product])).toEqual([["clip", "heygen-video-1", true], ["clip", "heygen-video-1", true], ["clip", "heygen-video-1", true]]);
    // MiniMax's shots name no model: they are made by the ad's own request.
    expect(pendingMedia({ ...drawn, product: { ...product, model: "minimax" } }).every((m) => m.fixedModel === undefined)).toBe(true);
    // Without HeyGen's key the model can't be used: said when it is drafted or made, never swapped silently.
    const brief = { template: "ad", prompt: "A steel water bottle", seconds: 15, product };
    expect((await call(worker, env, "POST", "/api/story/draft", brief, user.cookie)).data.error).toBe("HeyGen isn't set up on this site, so this model can't be used.");
    const refused = await call(worker, env, "POST", "/api/videos", { spec: ad, idempotencyKey: crypto.randomUUID() }, user.cookie);
    expect([refused.status, refused.data.error]).toEqual([400, "HeyGen isn't set up on this site, so this model can't be used."]);
    env.HEYGEN_API_KEY = "hg";
    const calls = providers();
    const created = await call(worker, env, "POST", "/api/videos", { spec: ad, idempotencyKey: crypto.randomUUID() }, user.cookie);
    expect(created.status).toBe(201);
    await run();
    const video = (await call(worker, env, "GET", `/api/videos/${created.data.id}`, undefined, user.cookie)).data.video;
    expect(video.renderStatus).toBe("ready");
    // The pictures are drawn with the photo, as for any ad; nothing is filmed on fal.
    const fal = calls.filter((c) => c.method === "POST" && c.url.startsWith("https://queue.fal.run/"));
    expect(fal).toHaveLength(3);
    expect(fal.every((c) => /^Draw a new picture of this scene/.test(c.body.prompt) && c.body.image_urls.length === 1)).toBe(true);
    // Each shot: HeyGen Video 1 from the shot's picture, at 768p, the product's label kept, though the owner listed no model to choose from.
    const asked = calls.filter((c) => c.method === "POST" && c.url === "https://api.heygen.com/v3/models/videos");
    expect(asked).toHaveLength(3);
    for (const c of asked) {
      expect(c.body).toMatchObject({ model: "heygen-video-1", mode: "image_to_video", resolution: "768p", image: { type: "url" } });
      expect(c.body.image.url).toMatch(/^https:\/\/app\.test\/api\/render-inputs\//);
      expect(c.body.reference_image_urls).toBeUndefined();
      expect(c.body.prompt).toContain("The product keeps its own label and logo exactly as in the first frame");
      expect(c.body.prompt).not.toContain("No text, captions, logos or watermarks in the picture.");
      expect(c.body.duration).toBeGreaterThanOrEqual(5);
    }
    expect(asked[0].body.prompt).toMatch(/^A hand lifts the product, shot 1\. A slow push-in on the product\./);
    expect(video.spec.scenes.every((s: any) => s.clipId)).toBe(true);
  });

  it("films a product ad in one shot with Seedance: one clip from the photos after the voice, played behind the whole ad with its sound", async () => {
    const { env, sqlite, user, own, run } = await setup();
    sqlite.prepare("UPDATE users SET email='admin@example.com' WHERE id=?").run(user.id);
    const product = { assets: [own], name: "Aqua Steel", model: "seedance" as const };
    const lines = ["Hot day, warm water again?", "Aqua Steel keeps your drink cold for 24 hours.", "Try it today."];
    env.AI.run = async () => ({ status: "completed", output_text: JSON.stringify({
      title: "Aqua Steel", topic: "steel bottle", caption: "Cold for a whole day.", hashtags: [], headline: "Aqua Steel", subject: "", look: "", places: [], music: "",
      scenes: lines.map((text, n) => ({ text, picture: `A hand lifts the product from a table, shot ${n + 1}`, keys: [], tone: "", place: "" })),
    }) });
    // The draft: the lines and the shots' descriptions, no pictures or clips of their own, and no more than one clip's 15 seconds.
    const draft = await call(worker, env, "POST", "/api/story/draft", { template: "ad", prompt: "A steel water bottle", seconds: 30, product }, user.cookie);
    expect(draft.status).toBe(200);
    const ad = specSchema.parse(draft.data.spec) as StorySpec;
    expect(ad).toMatchObject({ kind: "ad", product, backdrop: null, presenter: null });
    expect(ad.film).toBeUndefined();
    expect(ad.scenes.map((s) => [s.text, s.source])).toEqual(lines.map((text) => [text, "image"]));
    // One clip to make, priced by its length at the one-shot rate; nothing else.
    const pending = pendingMedia(ad);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ kind: "clip", key: "backdrop", product: true, oneShot: oneShotSeconds(estimatedSeconds(ad) - 0.5, "seedance") });
    expect(pending[0].credits).toBe(oneShotModels.seedance!.credits * Math.ceil(pending[0].oneShot! / 5));
    expect(pending[0].prompt).toMatch(/^A vertical advertisement for a product \(Aqua Steel\), 3 shots of about the same length joined by hard cuts\. @Image1 is a photo of the product/);
    expect(pending[0].prompt).toContain("Shot 1: A hand lifts the product from a table, shot 1. Shot 2: A hand lifts the product from a table, shot 2.");
    expect(pending[0].prompt).toContain("no speech, no voice-over and no music.");
    expect(specCredits(ad, true)).toBe(videoCredits(estimatedSeconds(ad)) + pending[0].credits!);
    expect(adCredits(15, "seedance")).toBe(1 + 3 * 6);
    // A library clip is never an ad's film.
    expect(specSchema.safeParse({ ...ad, backdrop: { libraryId: crypto.randomUUID() } }).success).toBe(false);
    // The request, and the operator's other Seedance endpoint.
    expect(oneShotRequest({ prompt: "p", seconds: 40, photos: ["a", "b", "c", "d", "e"] })).toEqual({
      model: "bytedance/seedance-2.0/fast/reference-to-video",
      body: { prompt: "p", image_urls: ["a", "b", "c", "d"], resolution: "720p", duration: "15", aspect_ratio: "9:16", generate_audio: true },
    });
    expect(oneShotRequest({ prompt: "p", seconds: 2, photos: ["a"] }).body.duration).toBe("4");
    expect(oneShotModel({ ...env, FAL_AD_ONE_SHOT_MODEL: "bytedance/seedance-2.5/flash/reference-to-video" })).toBe("bytedance/seedance-2.5/flash/reference-to-video");
    expect(oneShotModel({ ...env, FAL_AD_ONE_SHOT_MODEL: "https://evil.example/x" })).toBe(ONE_SHOT_MODEL);
    const calls = providers();
    const created = await call(worker, env, "POST", "/api/videos", { spec: ad, idempotencyKey: crypto.randomUUID() }, user.cookie);
    expect(created.status).toBe(201);
    await run();
    const video = (await call(worker, env, "GET", `/api/videos/${created.data.id}`, undefined, user.cookie)).data.video;
    expect(video.renderStatus).toBe("ready");
    // One request to fal, after the voice was recorded: the photos, every shot, vertical, with sound, as long as the voice (at most 15 s).
    const fal = calls.filter((c) => c.method === "POST" && c.url.startsWith("https://queue.fal.run/"));
    expect(fal).toHaveLength(1);
    expect(fal[0].url).toBe(`https://queue.fal.run/${ONE_SHOT_MODEL}`);
    expect(fal[0].body).toMatchObject({ resolution: "720p", duration: "15", aspect_ratio: "9:16", generate_audio: true, prompt: pending[0].prompt });
    expect(fal[0].body.image_urls).toHaveLength(1);
    expect(fal[0].body.image_urls[0]).toMatch(/^https:\/\/app\.test\/api\/render-inputs\//);
    expect(calls.findIndex((c) => c.url.includes("/v1/text-to-speech/"))).toBeLessThan(calls.indexOf(fal[0]));
    // The clip is the video's background clip, kept with it; nothing more is asked for.
    const clipId = video.spec.backdrop.assetId;
    expect(clipId).toMatch(/^[0-9a-f-]{36}$/);
    expect(pendingMedia(video.spec)).toEqual([]);
    expect(specCredits(video.spec, false)).toBe(0);
    // Filming it again is new work at the same price.
    expect(specCredits({ ...video.spec, backdrop: null }, false)).toBe(pendingMedia({ ...video.spec, backdrop: null })[0].credits);
    // The render: the one clip behind the whole ad, with its own sound under the voice.
    const narration = { key: "media/u/voice.wav", duration: 12, words: video.spec.generated.words };
    const media = { [clipId]: { key: "media/u/film.mp4", kind: "video", duration: 15, width: 720, height: 1280, ai: true }, [own]: { key: `media/${user.id}/${own}.jpg`, kind: "image", duration: 0, width: 1080, height: 1920, ai: false } };
    const { compose } = planRender(video.spec, { media, narration, watermark: "" } as unknown as PlanContext);
    expect(compose.segments).toHaveLength(1);
    expect(compose.segments[0]).toMatchObject({ kind: "video", audio: ONE_SHOT_SOUND, trim: 0 });
    expect(compose.segments[0].loop).toBeUndefined();
    expect(compose.look).toBeUndefined();
    // Any other background clip stays silent.
    const plain = planRender({ ...video.spec, kind: "story", product: undefined }, { media, narration, watermark: "" } as unknown as PlanContext).compose;
    expect(plain.segments[0].audio).toBe(0);
    // Seedance 2.5, the third model: its own endpoint, up to 30 seconds in one shot, at twice the credits.
    const newer = { ...ad, product: { ...product, model: "seedance-25" as const } };
    expect(specSchema.safeParse(newer).success).toBe(true);
    expect(pendingMedia(newer)[0].credits).toBe(2 * pending[0].credits!);
    expect(adCredits(30, "seedance-25")).toBe(2 + 6 * 12);
    expect(oneShotSeconds(40, "seedance-25")).toBe(30);
    expect(oneShotSeconds(40, "seedance")).toBe(15);
    expect(oneShotModel(env, "seedance-25")).toBe("bytedance/seedance-2.5/reference-to-video");
    // The operator's other endpoint replaces Seedance 2.0 Fast only.
    expect(oneShotModel({ ...env, FAL_AD_ONE_SHOT_MODEL: "bytedance/seedance-2.5/flash/reference-to-video" }, "seedance-25")).toBe(ONE_SHOT_25_MODEL);
    expect(oneShotRequest({ prompt: "p", seconds: 40, photos: ["a"], model: "seedance-25" }, ONE_SHOT_25_MODEL).body.duration).toBe("30");
    const draft25 = await call(worker, env, "POST", "/api/story/draft", { template: "ad", prompt: "A steel water bottle", seconds: 30, product: newer.product }, user.cookie);
    expect(draft25.data.spec.product.model).toBe("seedance-25");
    // (More credits than the test's plan has: this ad is the dearer one.)
    sqlite.prepare("UPDATE usage_windows SET quota=500 WHERE user_id=?").run(user.id);
    const calls25 = providers();
    const made = await call(worker, env, "POST", "/api/videos", { spec: newer, idempotencyKey: crypto.randomUUID() }, user.cookie);
    expect(made.status).toBe(201);
    await run();
    const fal25 = calls25.filter((c) => c.method === "POST" && c.url.startsWith("https://queue.fal.run/"));
    expect(fal25.map((c) => c.url)).toEqual([`https://queue.fal.run/${ONE_SHOT_25_MODEL}`]);
    // As long as the voice (17 seconds here), which Seedance 2.0 Fast would have cut to 15.
    expect(fal25[0].body).toMatchObject({ duration: "18", aspect_ratio: "9:16", resolution: "720p", generate_audio: true });
  });

  it("narrates a dialogue in its scenes' voices: one call per stretch, joined into one recording the video keeps", async () => {
    const { env, user, spec, run } = await setup();
    env.FAL_REFERENCE_MODEL = "off";
    const calls = providers();
    // ElevenLabs times every character it was sent, two seconds a call.
    const others = globalThis.fetch;
    const spoken: { voice: string; text: string }[] = [];
    vi.stubGlobal("fetch", async (input: any, init: any = {}) => {
      const url = String(input?.url ?? input);
      if (!url.includes("/v1/text-to-speech/")) return others(input, init);
      const text = JSON.parse(init.body).text as string, chars = [...text], step = 2 / chars.length;
      spoken.push({ voice: url.split("/")[5], text });
      return Response.json({
        audio_base64: Buffer.from(new Uint8Array(2 * 48000)).toString("base64"),
        alignment: { characters: chars, character_start_times_seconds: chars.map((_, i) => i * step), character_end_times_seconds: chars.map((_, i) => (i + 1) * step) },
      });
    });
    // Scenes 2 and 3 are Sarah's, scene 5 Liam's; the narrator (George) says the rest.
    const talk = { ...spec, scenes: spec.scenes.map((s, i) => ({ ...s, source: "image" as const, assetId: undefined, ...(i === 1 || i === 2 ? { voiceId: "sarah", speaker: "Mara" } : i === 4 ? { voiceId: "liam", speaker: "Ilya" } : {}) })) };
    const created = await call(worker, env, "POST", "/api/videos", { spec: talk, idempotencyKey: crypto.randomUUID() }, user.cookie);
    expect(created.status).toBe(201);
    await run();
    const video = (await call(worker, env, "GET", `/api/videos/${created.data.id}`, undefined, user.cookie)).data.video;
    expect(video.renderStatus).toBe("ready");
    const words = (from: number, to: number) => voicedScript(talk.scenes.slice(from, to));
    expect(spoken).toEqual([
      { voice: "JBFqnCBsd6RMkjVDRZzb", text: words(0, 1) }, { voice: "EXAVITQu4vr4xnSDxMaL", text: words(1, 3) },
      { voice: "JBFqnCBsd6RMkjVDRZzb", text: words(3, 4) }, { voice: "TX3LPaxmHKxFdv7VOQHJ", text: words(4, 5) },
    ]);
    // One recording: every word of the script, in order, the later speakers' after the ones before; no alignment needed.
    expect(calls.some((c) => c.url === ALIGNMENT_URL)).toBe(false);
    expect(video.spec.generated.words.map((w: any) => w.text)).toEqual(textWords(storyScript(talk.scenes)));
    expect(video.spec.generated.words.at(-1).end).toBeCloseTo(4 * 2 + 3 * 0.25, 1);
    expect(narrationCurrent(video.spec)).toBe(true);
    expect(video.spec.scenes.map((s: any) => s.speaker ?? null)).toEqual([null, "Mara", "Mara", null, "Ilya"]);
    // A voice nobody may use is refused before anything is made.
    const stolen = { ...talk, scenes: talk.scenes.map((s, i) => (i === 1 ? { ...s, voiceId: "clone-0123456789ab" } : s)) };
    expect(await call(worker, env, "POST", "/api/videos", { spec: stolen, idempotencyKey: crypto.randomUUID() }, user.cookie)).toMatchObject({ status: 400, data: { error: expect.stringContaining("no longer available") } });
  });

  it("lip-syncs a talking scene: its picture and its stretch of the voice go to the lip-sync model after the voice is recorded", async () => {
    const { env, sqlite, user, spec, run } = await setup();
    env.FAL_REFERENCE_MODEL = "off";
    const calls = providers();
    const others = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: any, init: any = {}) => {
      const url = String(input?.url ?? input);
      if (!url.includes("/v1/text-to-speech/")) return others(input, init);
      calls.push({ method: "POST", url });
      const chars = [...JSON.parse(init.body).text as string], step = 2 / chars.length;
      return Response.json({
        audio_base64: Buffer.from(new Uint8Array(2 * 48000).fill(9)).toString("base64"),
        alignment: { characters: chars, character_start_times_seconds: chars.map((_, i) => i * step), character_end_times_seconds: chars.map((_, i) => (i + 1) * step) },
      });
    });
    // Scene 2 is Mara's line; the cast's scenes become lip-synced clips, charged as high-quality clips of their length.
    const talk = lipSyncSpec({ ...spec, scenes: spec.scenes.map((s, i) => ({ ...s, source: "image" as const, assetId: undefined, ...(i === 1 && { voiceId: "sarah", speaker: "Mara" }) })) });
    expect(talk.scenes.map((s) => [s.source, s.lipSync ?? null, s.transition])).toEqual([["image", null, "auto"], ["clip", true, "cut"], ["image", null, "auto"], ["image", null, "auto"], ["image", null, "circleopen"]]);
    expect(specCredits(talk, true)).toBe(videoCredits(estimatedSeconds(talk)) + CLIP_CREDITS.high * (talk.scenes[1].clipSeconds / 5));
    // A test for administrators.
    expect(await call(worker, env, "POST", "/api/videos", { spec: talk, idempotencyKey: crypto.randomUUID() }, user.cookie)).toMatchObject({ status: 403, data: { error: expect.stringContaining("Lip-synced scenes") } });
    sqlite.prepare("UPDATE users SET email='admin@example.com' WHERE id=?").run(user.id);
    const created = await call(worker, env, "POST", "/api/videos", { spec: talk, idempotencyKey: crypto.randomUUID() }, user.cookie);
    expect(created.status).toBe(201);
    await run();
    const video = (await call(worker, env, "GET", `/api/videos/${created.data.id}`, undefined, user.cookie)).data.video;
    expect(video.renderStatus).toBe("ready");
    // The lip-sync is asked for after the voice, with the scene's picture and its stretch of the recording, at 768P.
    const sync = calls.findIndex((c) => c.method === "POST" && c.url === "https://queue.fal.run/minimax/h3-max/lip-sync/image-to-video");
    expect(sync).toBeGreaterThan(calls.map((c) => c.url.includes("/v1/text-to-speech/")).lastIndexOf(true));
    const state = JSON.parse((sqlite.prepare("SELECT provider FROM runs WHERE video_id=?").get(video.id) as any).provider);
    const file = (link: string) => state.inputs[Number(/\/api\/render-inputs\/[0-9a-f-]{36}\/(\d+)\?token=/.exec(link)![1])] as string;
    const body = calls[sync].body;
    expect(Object.keys(body).sort()).toEqual(["audio_url", "image_url", "resolution"]);
    expect(body.resolution).toBe("768P");
    const picture = (sqlite.prepare("SELECT object_key FROM media_assets WHERE id=?").get(video.spec.scenes[1].imageId) as any).object_key;
    expect(file(body.image_url)).toBe(picture);
    // The line: scene 2's two seconds of the voice (the second call's audio, after the first and a pause), then silence
    // up to the five seconds the model asks for; a 24 kHz WAV like the recording.
    const line = new Uint8Array(await (await env.MEDIA.get(file(body.audio_url)))!.arrayBuffer());
    expect(line.length).toBe(44 + Math.ceil(5.1 * 24000) * 2);
    expect(new DataView(line.buffer).getUint32(24, true)).toBe(24000);
    const sound = line.subarray(44);
    expect(sound[48000]).toBe(9);
    expect(sound.subarray(3 * 48000).every((b) => b === 0)).toBe(true);
    // The scene shows the lip-synced clip, silent (its sound is the voice already playing), cut in hard.
    expect(video.spec.scenes[1].clipId).toBeTruthy();
    const compose = env.MEDIA_RENDERER.log.filter((p: any) => p.operation === "compose").at(-1);
    expect(compose.segments[1]).toMatchObject({ kind: "video", audio: 0 });
    expect(compose.segments[1].transition ?? null).toBeNull();
    // New words are a new voice, and the lips with it: the clip is paid and made again.
    const reworded = { ...video.spec, scenes: video.spec.scenes.map((s: any, i: number) => (i === 1 ? { ...s, text: "Where were you? Tell me now." } : s)) };
    expect(pendingMedia(reworded).filter((m) => m.lipSync)).toHaveLength(1);
    expect(pendingMedia(video.spec).filter((m) => m.lipSync)).toHaveLength(0);
  });

  it("shoots a film: every shot an acted clip that says its line, listened to, retaken when the line is missed, and cut on its takes", async () => {
    const { env, sqlite, user, spec, used, run } = await setup();
    env.FAL_REFERENCE_MODEL = "off";
    const calls = providers();
    // Scribe hears each clip's line from half a second in, five words a second; the second shot's first take says something else.
    const heard = (text: string) => textWords(text).map((w, i) => ({ text: w, start: 0.5 + i * 0.2, end: 0.5 + i * 0.2 + 0.18, type: "word" }));
    const listened: (number | "missed")[] = [0, "missed", 1, 2, 3, 4];
    let listens = 0;
    const others = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: any, init: any = {}) => {
      if (String(input?.url ?? input) !== SCRIBE_URL) return others(input, init);
      const line = listened[listens++];
      return Response.json({ language_code: "eng", words: heard(line === "missed" || line === undefined ? "Something else entirely was said here" : said[line][0]) });
    });
    // Mara says shots 2 and 4: the picture of shot 2 shows her, shot 4 cuts away; the rest is said off screen in the video's voice.
    const film = shotsSpec<StorySpec>({ ...spec, scenes: spec.scenes.map((s, i) => ({
      ...s, source: "image" as const, assetId: undefined, ...(i === 1 && { description: "Close-up of Mara at the reef, looking up" }), ...((i === 1 || i === 3) && { voiceId: "sarah", speaker: "Mara" }),
    })) });
    expect(film.scenes.every((s) => s.acted && s.source === "clip" && s.transition === "cut" && s.clipQuality === "high")).toBe(true);
    // Its price: the video by its length and every shot as a high-quality clip (a long line is a ten-second one); no narration.
    expect(film.scenes.map((s) => s.clipSeconds)).toEqual([5, 10, 5, 5, 5]);
    expect(specCredits(film, true)).toBe(videoCredits(estimatedSeconds(film)) + CLIP_CREDITS.high * 6);
    // A test for administrators.
    expect(await call(worker, env, "POST", "/api/videos", { spec: film, idempotencyKey: crypto.randomUUID() }, user.cookie)).toMatchObject({ status: 403, data: { error: expect.stringContaining("Films of acted shots") } });
    sqlite.prepare("UPDATE users SET email='admin@example.com' WHERE id=?").run(user.id);
    const before = used();
    const created = await call(worker, env, "POST", "/api/videos", { spec: film, idempotencyKey: crypto.randomUUID() }, user.cookie);
    expect(created.status).toBe(201);
    expect(used() - before).toBe(specCredits(film, true));
    await run();
    const video = (await call(worker, env, "GET", `/api/videos/${created.data.id}`, undefined, user.cookie)).data.video;
    expect(video.renderStatus).toBe("ready");
    const state = JSON.parse((sqlite.prepare("SELECT provider FROM runs WHERE video_id=?").get(video.id) as any).provider);
    const file = (link: string) => state.inputs[Number(/\/api\/render-inputs\/[0-9a-f-]{36}\/(\d+)\?token=/.exec(link)![1])] as string;
    // No narration is recorded: the only speech made is a sample of each voice, reading the episode's own lines.
    const spoken = calls.filter((c) => c.url.includes("/v1/text-to-speech/"));
    expect(spoken.map((c) => [c.url.split("/")[5], c.body.text])).toEqual([
      ["JBFqnCBsd6RMkjVDRZzb", voiceSampleText(film.scenes, "george", "george")], ["EXAVITQu4vr4xnSDxMaL", voiceSampleText(film.scenes, "sarah", "george")],
    ]);
    expect(video.spec.generated).toBeUndefined();
    expect(calls.some((c) => c.url === ALIGNMENT_URL)).toBe(false);
    // Every shot goes to the video model with its picture, its line, the length it needs and its voice's sample; the
    // second shot twice, because its line was not heard in the first take.
    const shots = calls.filter((c) => c.method === "POST" && c.url === "https://queue.fal.run/minimax/h3-max/reference-to-video");
    expect(shots).toHaveLength(6);
    expect(listens).toBe(6);
    expect(Object.keys(shots[0].body).sort()).toEqual(["duration", "image_url", "prompt", "prompt_expansion_mode", "reference_audio_urls", "resolution"]);
    expect(shots[0].body).toMatchObject({ duration: shotSeconds(said[0][0]), resolution: "768P", prompt_expansion_mode: "balanced" });
    expect(shots[0].body.prompt).toContain(`Off screen, a narrator's voice says, "${said[0][0]}" Nobody on screen speaks.`);
    expect(shots[1].body.prompt).toContain(`Close-up of Mara at the reef, looking up. Mara says, "${said[1][0]}"`);
    expect(shots[2].body).toEqual(shots[1].body);
    expect(shots[4].body.prompt).toContain(`Off screen, Mara's voice says, "${said[3][0]}"`);
    const picture = (n: number) => (sqlite.prepare("SELECT object_key FROM media_assets WHERE id=?").get(video.spec.scenes[n].imageId) as any).object_key;
    expect(file(shots[0].body.image_url)).toBe(picture(0));
    expect(file(shots[1].body.image_url)).toBe(picture(1));
    // The sample: the speaker's voice, cut to the fourteen seconds the model takes; Mara's shots get hers.
    const [george, sarah] = [shots[0], shots[1]].map((c) => file(c.body.reference_audio_urls[0]));
    expect(george).not.toBe(sarah);
    expect([shots[3], shots[4], shots[5]].map((c) => file(c.body.reference_audio_urls[0]))).toEqual([george, sarah, george]);
    expect((await env.MEDIA.get(george))!.size).toBe(44 + 14 * 48000);
    // The pictures a shot starts from are frames of a film, the speaker's face in view where the shot shows them.
    const stills = calls.filter((c) => c.method === "POST" && c.url.startsWith("https://queue.fal.run/") && !c.url.includes("minimax"));
    expect(stills).toHaveLength(5);
    expect(stills[1].body.prompt).toContain("Mara's face is clearly visible, about to speak.");
    expect(stills[0].body.prompt).toContain("A frame from a film");
    expect(stills[0].body.prompt).not.toContain("face is clearly visible");
    // Each shot keeps its take: its line from a quarter second before the first word to a moment after the last.
    const takes = video.spec.scenes.map((s: any) => s.take);
    video.spec.scenes.forEach((s: any, n: number) => {
      const { score, ...take } = takeOf(s.text, heard(s.text).map((w) => ({ ...w, start: Math.round(w.start * 100) / 100, end: Math.round(w.end * 100) / 100 })), 5);
      expect(score).toBe(1);
      expect(s.take).toEqual({ key: takeKey(s, "george"), ...take });
      expect(s.take.trim).toBeCloseTo(0.25, 1);
      expect(s.clipId).toBeTruthy();
      expect(n).toBeLessThan(5);
    });
    // The missed take is not kept; the samples are, for the shots made again later.
    const files = sqlite.prepare("SELECT kind,json_extract(meta,'$.sample') AS sample FROM media_assets WHERE video_id=?").all(video.id) as any[];
    expect(files.filter((f) => f.kind === "ai_clip")).toHaveLength(5);
    expect(files.filter((f) => f.sample).map((f) => f.sample).sort()).toEqual(["george", "sarah"]);
    // The render: the shots one after another with their own sound, cut where the clips are, no voice track, the film look.
    const clock = filmClock(video.spec)!;
    expect(clock.duration).toBeCloseTo(takes.reduce((n: number, t: any) => n + t.seconds, 0), 5);
    const compose = env.MEDIA_RENDERER.log.filter((p: any) => p.operation === "compose").at(-1);
    expect(compose.voice).toBeNull();
    expect(compose.look).toBe("film");
    expect(compose.sounds).toBeUndefined();
    expect(compose.segments.map((x: any) => [x.kind, x.audio, x.transition ?? null])).toEqual(takes.map(() => ["video", 1, null]));
    compose.segments.forEach((x: any, n: number) => { expect(x.trim).toBeCloseTo(takes[n].trim, 2); expect(x.duration).toBeCloseTo(takes[n].seconds, 5); });
    expect(compose.ass).toContain("Dialogue:");
    expect(video.duration).toBeGreaterThan(0);

    // A shot made again: the same picture and line, a new take, charged as that one clip; nothing else is made.
    listened.push(2);
    const retake = { ...video.spec, scenes: video.spec.scenes.map((s: any, i: number) => (i === 2 ? { ...s, clipId: undefined, take: undefined } : s)) };
    expect(pendingMedia(retake).map((m) => [m.kind, m.path[1]])).toEqual([["clip", 2]]);
    const charged = used();
    const saved = await call(worker, env, "PUT", `/api/videos/${video.id}`, { spec: retake, idempotencyKey: crypto.randomUUID() }, user.cookie);
    expect(saved).toMatchObject({ status: 200, data: { rendering: true, credits: CLIP_CREDITS.high } });
    expect(used() - charged).toBe(CLIP_CREDITS.high);
    await run();
    const again = (await call(worker, env, "GET", `/api/videos/${video.id}`, undefined, user.cookie)).data.video;
    expect(again.renderStatus).toBe("ready");
    expect(calls.filter((c) => c.method === "POST" && c.url === "https://queue.fal.run/minimax/h3-max/reference-to-video")).toHaveLength(7);
    expect(calls.filter((c) => c.url.includes("/v1/text-to-speech/"))).toHaveLength(2);
    expect(calls.filter((c) => c.method === "POST" && c.url.startsWith("https://queue.fal.run/") && !c.url.includes("minimax"))).toHaveLength(5);
    expect(again.spec.scenes[2].clipId).not.toBe(video.spec.scenes[2].clipId);
    expect(again.spec.scenes[2].take).toEqual(video.spec.scenes[2].take);
    expect(again.spec.scenes.map((s: any) => s.clipId).filter((_: any, i: number) => i !== 2)).toEqual(video.spec.scenes.map((s: any) => s.clipId).filter((_: any, i: number) => i !== 2));
    expect((sqlite.prepare("SELECT COUNT(*) AS n FROM media_assets WHERE video_id=? AND kind='ai_clip'").get(video.id) as any).n).toBe(5);
    // New words for a shot are a new take of it, and never a narration to record.
    const reworded = { ...again.spec, scenes: again.spec.scenes.map((s: any, i: number) => (i === 0 ? { ...s, text: "Octopuses have three hearts." } : s)) };
    expect(pendingMedia(reworded).map((m) => [m.kind, m.path[1], m.acted?.voiceId])).toEqual([["clip", 0, "george"]]);
    expect(specCredits(reworded, false)).toBe(CLIP_CREDITS.high);
    // A film's shots speak for themselves: never under the owner's recording.
    const dubbed = { ...film, narration: { kind: "upload" as const, assetId: crypto.randomUUID(), script: "" } };
    expect(specSchema.safeParse(dubbed).success).toBe(true);
    expect(pendingMedia(dubbed as StorySpec).filter((m) => m.acted)).toHaveLength(5);
  });

  it("shoots a film in the cast's exact voices: the dialogue recorded once, speakers lip-synced to it, cutaways silent under it", async () => {
    const { env, sqlite, user, spec, used, run } = await setup();
    sqlite.prepare("UPDATE users SET email='admin@example.com' WHERE id=?").run(user.id);
    const calls = providers();
    // ElevenLabs speaks each stretch in two seconds; nothing is ever transcribed.
    let listens = 0;
    const others = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: any, init: any = {}) => {
      const url = String(input?.url ?? input);
      if (url === SCRIBE_URL) { listens++; return Response.json({ words: [] }); }
      if (!url.includes("/v1/text-to-speech/")) return others(input, init);
      calls.push({ method: "POST", url });
      const chars = [...JSON.parse(init.body).text as string], step = 2 / chars.length;
      return Response.json({
        audio_base64: Buffer.from(new Uint8Array(2 * 48000).fill(9)).toString("base64"),
        alignment: { characters: chars, character_start_times_seconds: chars.map((_, i) => i * step), character_end_times_seconds: chars.map((_, i) => (i + 1) * step) },
      });
    });
    // Mara says shots 2 and 4. Shot 2 shows her (lip-synced); shot 4 does not, shot 3 shows her listening, the rest nobody of the cast.
    const film = shotsSpec<StorySpec>({ ...spec, scenes: spec.scenes.map((s, i) => ({
      ...s, source: "image" as const, assetId: undefined, ...(i === 1 && { description: "Close-up of Mara at the reef, looking up" }), ...(i === 2 && { description: "Mara listens, frowning" }),
      ...((i === 1 || i === 3) && { voiceId: "sarah", speaker: "Mara" }),
    })) }, "exact");
    expect(film.film).toBe(true);
    expect(film.scenes.map((s) => [s.source, s.lipSync ?? null, s.cutaway ?? null, s.acted ?? null, s.transition, s.clipQuality])).toEqual([
      ["clip", null, true, null, "cut", "high"], ["clip", true, null, null, "cut", "high"], ["clip", null, true, null, "cut", "high"], ["clip", null, true, null, "cut", "high"], ["clip", null, true, null, "cut", "high"],
    ]);
    // Its price: the video by its length (the dialogue's recording included) and every shot as a high-quality clip.
    expect(specCredits(film, true)).toBe(videoCredits(estimatedSeconds(film)) + CLIP_CREDITS.high * film.scenes.reduce((n, s) => n + s.clipSeconds / 5, 0));
    const before = used();
    const created = await call(worker, env, "POST", "/api/videos", { spec: film, idempotencyKey: crypto.randomUUID() }, user.cookie);
    expect(created.status).toBe(201);
    expect(used() - before).toBe(specCredits(film, true));
    await run();
    const video = (await call(worker, env, "GET", `/api/videos/${created.data.id}`, undefined, user.cookie)).data.video;
    expect(video.renderStatus).toBe("ready");
    const state = JSON.parse((sqlite.prepare("SELECT provider FROM runs WHERE video_id=?").get(video.id) as any).provider);
    const file = (link: string) => state.inputs[Number(/\/api\/render-inputs\/[0-9a-f-]{36}\/(\d+)\?token=/.exec(link)![1])] as string;
    // The dialogue is recorded in the cast's own voices, one stretch after another: the narrator's, Mara's, and so on.
    const spoken = calls.filter((c) => c.url.includes("/v1/text-to-speech/"));
    expect(spoken.map((c) => c.url.split("/")[5])).toEqual(["JBFqnCBsd6RMkjVDRZzb", "EXAVITQu4vr4xnSDxMaL", "JBFqnCBsd6RMkjVDRZzb", "EXAVITQu4vr4xnSDxMaL", "JBFqnCBsd6RMkjVDRZzb"]);
    expect(narrationCurrent(video.spec)).toBe(true);
    expect(listens).toBe(0);
    // Every clip is made after the voice: the shot that shows Mara speaking is lip-synced to her line...
    const lastWord = calls.map((c) => c.url.includes("/v1/text-to-speech/")).lastIndexOf(true);
    const sync = calls.map((c, n) => ({ c, n })).filter(({ c }) => c.method === "POST" && c.url === "https://queue.fal.run/minimax/h3-max/lip-sync/image-to-video");
    expect(sync).toHaveLength(1);
    expect(sync[0].n).toBeGreaterThan(lastWord);
    expect(Object.keys(sync[0].c.body).sort()).toEqual(["audio_url", "image_url", "resolution"]);
    const picture = (n: number) => (sqlite.prepare("SELECT object_key FROM media_assets WHERE id=?").get(video.spec.scenes[n].imageId) as any).object_key;
    expect(file(sync[0].c.body.image_url)).toBe(picture(1));
    // ...and the others are cutaways: the picture brought to life without speech by the film's shot model, as long as
    // the scene is on screen (two seconds of voice and a breath: three), with no voice sample.
    const cuts = calls.map((c, n) => ({ c, n })).filter(({ c }) => c.method === "POST" && c.url === "https://queue.fal.run/minimax/h3-max/reference-to-video");
    expect(cuts).toHaveLength(4);
    expect(cuts.every(({ n }) => n > lastWord)).toBe(true);
    expect(cuts.map(({ c }) => file(c.body.image_url))).toEqual([0, 2, 3, 4].map(picture));
    expect(cuts.every(({ c }) => c.body.duration === 3 && c.body.resolution === "768P" && c.body.prompt_expansion_mode === "balanced" && !("reference_audio_urls" in c.body))).toBe(true);
    expect(cuts[0].c.body.prompt).toMatch(/^Doodle of sentence 1\. A slow push-in\. .*Nobody speaks: mouths stay closed or still/);
    // The cutaway that shows one of the cast goes with the cast's sheet; a shot of something else does not.
    const sheet = (sqlite.prepare("SELECT object_key FROM media_assets WHERE video_id=? AND json_extract(meta,'$.sheet')=?").get(video.id, pictureSheets(video.spec)[0].key) as any).object_key;
    expect(cuts[1].c.body.reference_image_urls.map(file)).toEqual([sheet]);
    expect(cuts[1].c.body.prompt.endsWith("Image 1 is the cast's reference sheet: keep everyone who appears looking exactly as on it, with the same face, hair and clothes.")).toBe(true);
    expect("reference_image_urls" in cuts[0].c.body).toBe(false);
    expect(cuts[0].c.body.prompt).not.toContain("Image 1");
    // The pictures are frames of a film; the lip-synced one has the speaker's face in view.
    const stills = calls.filter((c) => c.method === "POST" && c.url.startsWith("https://queue.fal.run/") && !c.url.includes("minimax") && /^Draw a new picture of this scene/.test(c.body.prompt));
    expect(stills).toHaveLength(5);
    expect(stills[1].body.prompt).toContain("Mara's face is clearly visible, about to speak.");
    expect(stills.every((c) => c.body.prompt.includes("A frame from a film"))).toBe(true);
    // The render: the recording as the voice, every clip silent under it, hard cuts, the film look.
    const compose = env.MEDIA_RENDERER.log.filter((p: any) => p.operation === "compose").at(-1);
    expect(compose.voice).toMatchObject({ start: 0, volume: 1 });
    expect(compose.look).toBe("film");
    expect(compose.segments.map((x: any) => [x.kind, x.audio ?? 0, x.transition ?? null])).toEqual([0, 1, 2, 3, 4].map(() => ["video", 0, null]));
    // A cutaway made again: that clip alone, from the same picture, with no new recording.
    const retake = { ...video.spec, scenes: video.spec.scenes.map((s: any, i: number) => (i === 0 ? { ...s, clipId: undefined } : s)) };
    expect(pendingMedia(retake).map((m) => [m.kind, m.path[1], !!m.cutaway])).toEqual([["clip", 0, true]]);
    const saved = await call(worker, env, "PUT", `/api/videos/${video.id}`, { spec: retake, idempotencyKey: crypto.randomUUID() }, user.cookie);
    expect(saved).toMatchObject({ status: 200, data: { rendering: true, credits: CLIP_CREDITS.high } });
    await run();
    expect(calls.filter((c) => c.method === "POST" && c.url === "https://queue.fal.run/minimax/h3-max/reference-to-video")).toHaveLength(5);
    expect(calls.filter((c) => c.url.includes("/v1/text-to-speech/"))).toHaveLength(5);
    expect(calls.filter((c) => c.method === "POST" && c.url === "https://queue.fal.run/minimax/h3-max/lip-sync/image-to-video")).toHaveLength(1);
    // The lip-synced shot made again: its lips are synced anew to the same recording.
    const resync = pendingMedia({ ...video.spec, scenes: video.spec.scenes.map((s: any, i: number) => (i === 1 ? { ...s, clipId: undefined } : s)) });
    expect(resync.map((m) => [m.kind, m.path[1], !!m.lipSync])).toEqual([["clip", 1, true]]);
  });

  it("keeps a film's scenes in one room: a master shot of each place, drawn once, from which every shot set there is drawn", async () => {
    const { env, sqlite, user, spec, run } = await setup();
    sqlite.prepare("UPDATE users SET email='admin@example.com' WHERE id=?").run(user.id);
    const calls = providers();
    let listens = 0;
    const others = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: any, init: any = {}) => {
      if (String(input?.url ?? input) !== SCRIBE_URL) return others(input, init);
      return Response.json({ language_code: "eng", words: textWords(said[listens++ % 5][0]).map((w, i) => ({ text: w, start: 0.5 + i * 0.2, end: 0.68 + i * 0.2, type: "word" })) });
    });
    // Two scenes: three shots in the kitchen, two in the dining room. Mara speaks in the kitchen; the third shot names no place.
    const places = [{ label: "the kitchen", description: "A narrow steel kitchen, a stove on the left, a pass window at the back" }, { label: "the dining room", description: "A small candle-lit room with six tables" }];
    const film = shotsSpec<StorySpec>({ ...spec, places, scenes: spec.scenes.map((s, i) => ({
      ...s, source: "image" as const, assetId: undefined, place: i < 2 ? "the kitchen" : i === 2 ? "" : "The Dining Room", ...(i === 1 && { voiceId: "sarah", speaker: "Mara", description: "Close-up of Mara at the stove" }),
    })) });
    // A shot that names no place is in the place of the shot before it.
    expect(film.scenes.map((s) => s.place)).toEqual(["the kitchen", "the kitchen", "the kitchen", "The Dining Room", "The Dining Room"]);
    // Its sheets: the characters, and for each place the empty place and then the master shot with the scene's people in it.
    const sheets = pictureSheets(film);
    expect(sheets.map((x) => [x.kind, x.place ?? null])).toEqual([["character", null], ["place", "the kitchen"], ["scene", "the kitchen"], ["place", "the dining room"], ["scene", "the dining room"]]);
    expect(sheets[2].prompt).toMatch(/^Master shot of a film scene set in the kitchen: A narrow steel kitchen.* with Mara in it, each where they are during the scene/);
    expect(sheets[4].prompt).toContain("as the scene finds it, with nobody in the foreground");
    // Only a film has master shots.
    expect(pictureSheets({ ...film, scenes: film.scenes.map((s) => ({ ...s, acted: undefined, take: undefined, source: "image" as const })) }).some((x) => x.kind === "scene")).toBe(false);
    const created = await call(worker, env, "POST", "/api/videos", { spec: film, idempotencyKey: crypto.randomUUID() }, user.cookie);
    expect(created.status).toBe(201);
    await run();
    const video = (await call(worker, env, "GET", `/api/videos/${created.data.id}`, undefined, user.cookie)).data.video;
    expect(video.renderStatus).toBe("ready");
    const state = JSON.parse((sqlite.prepare("SELECT provider FROM runs WHERE video_id=?").get(video.id) as any).provider);
    const file = (link: string) => state.inputs[Number(/\/api\/render-inputs\/[0-9a-f-]{36}\/(\d+)\?token=/.exec(link)![1])] as string;
    const sheetFile = (key: string) => (sqlite.prepare("SELECT object_key FROM media_assets WHERE video_id=? AND json_extract(meta,'$.sheet')=?").get(video.id, key) as any).object_key as string;
    const drawn = calls.filter((c) => c.method === "POST" && c.url.startsWith("https://queue.fal.run/") && !c.url.includes("minimax"));
    // Five sheets, then five shots.
    expect(drawn).toHaveLength(10);
    // A master shot is drawn from the characters' sheet and its place's.
    const master = drawn.find((c) => c.body.prompt.includes("Master shot of a film scene set in the kitchen"))!;
    expect(master.body.image_urls.map(file)).toEqual([sheetFile(sheets[0].key), sheetFile(sheets[1].key)]);
    // Every shot is drawn from the characters' sheet and the master shot of its place: the same room and people, another camera.
    const stills = drawn.slice(5);
    expect(stills.map((c) => c.body.image_urls.map(file))).toEqual([
      ...[0, 1, 2].map(() => [sheetFile(sheets[0].key), sheetFile(sheets[2].key)]), ...[3, 4].map(() => [sheetFile(sheets[0].key), sheetFile(sheets[4].key)]),
    ]);
    expect(stills[1].body.prompt).toContain("Reference picture 2 is the master shot of this very scene, seen from further back");
    expect(stills[1].body.prompt).toContain("only the camera moves");
    // A new picture for one shot later is drawn from the same master shot: no sheet is drawn again.
    const redo = { ...video.spec, scenes: video.spec.scenes.map((x: any, i: number) => (i === 0 ? { ...x, imageId: undefined, clipId: undefined, take: undefined } : x)) };
    expect((await call(worker, env, "PUT", `/api/videos/${video.id}`, { spec: redo, idempotencyKey: crypto.randomUUID() }, user.cookie)).status).toBe(200);
    await run();
    const after = calls.filter((c) => c.method === "POST" && c.url.startsWith("https://queue.fal.run/") && !c.url.includes("minimax"));
    expect(after).toHaveLength(11);
    const again = JSON.parse((sqlite.prepare("SELECT provider FROM runs WHERE video_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(video.id) as any).provider);
    expect(after[10].body.image_urls.map((link: string) => again.inputs[Number(/\/(\d+)\?token=/.exec(link)![1])])).toEqual([sheetFile(sheets[0].key), sheetFile(sheets[2].key)]);
  });

  it("draws every picture from its own text when FAL_REFERENCE_MODEL is off", async () => {
    const { env, user, spec, run } = await setup();
    env.FAL_REFERENCE_MODEL = "off";
    const calls = providers();
    expect((await call(worker, env, "POST", "/api/videos", { spec, idempotencyKey: crypto.randomUUID() }, user.cookie)).status).toBe(201);
    await run();
    const pictures = calls.filter((c) => c.method === "POST" && c.url.startsWith("https://queue.fal.run/") && !c.url.includes("/kling-video/"));
    expect(pictures.map((c) => c.url.split("/").slice(3).join("/"))).toEqual(Array(4).fill("openai/gpt-image-2.5/flare/text-to-image"));
    expect(pictures.every((c) => !c.body.image_urls)).toBe(true);
  });

  it("draws reference sheets of the characters and of each place shown twice, and every scene from them", async () => {
    const { env, sqlite, user, spec, run } = await setup();
    const calls = providers();
    const placed = {
      ...spec,
      places: [{ label: "the reef", description: "A bright coral reef, pink corals on the left, a sandy slope" }, { label: "the cave", description: "A low rock cave, purple sponges, blue light" }],
      scenes: spec.scenes.map((s, i) => ({ ...s, place: ["the reef", "the cave", "", "", "The Cave"][i] })),
    };
    // Sheets: the octopus, and the cave (two AI pictures there); the reef has one, so its words are enough.
    expect(pictureSheets(storySpec.parse(placed)).map((x) => [x.kind, x.place ?? null])).toEqual([["character", null], ["place", "the cave"]]);
    const created = await call(worker, env, "POST", "/api/videos", { spec: placed, idempotencyKey: crypto.randomUUID() }, user.cookie);
    expect(created).toMatchObject({ status: 201, data: { credits: videoCredits(estimatedSeconds(spec)) + CLIP_CREDITS.regular } });
    await run();
    const video = (await call(worker, env, "GET", `/api/videos/${created.data.id}`, undefined, user.cookie)).data.video;
    expect(video.renderStatus).toBe("ready");
    const state = JSON.parse((sqlite.prepare("SELECT provider FROM runs WHERE video_id=?").get(video.id) as any).provider);
    const sheet = (kind: string) => (sqlite.prepare("SELECT object_key FROM media_assets WHERE video_id=? AND json_extract(meta,'$.sheet') IS NOT NULL AND meta LIKE ?").get(video.id, `%${kind}%`) as any).object_key;
    const link = (key: string) => expect.stringMatching(new RegExp(`/api/render-inputs/[0-9a-f-]{36}/${state.inputs.indexOf(key)}\\?token=`));
    const octopus = link(sheet("Character reference sheet")), cave = link(sheet("Establishing shot of the cave"));
    const pictures = calls.filter((c) => c.method === "POST" && c.url.startsWith("https://queue.fal.run/") && !c.url.includes("/kling-video/"));
    // The two sheets from their text, then scenes 1, 2, 3 and 5, each from the octopus and, in the cave, the cave.
    expect(pictures.map((c) => c.body.image_urls ?? null)).toEqual([null, null, [octopus], [octopus, cave], [octopus], [octopus, cave]]);
    expect(pictures[0].body.prompt).toMatch(/^Character reference sheet: a small orange octopus\. .*plain light grey background/);
    expect(pictures[1].body.prompt).toMatch(/^Establishing shot of the cave: A low rock cave, purple sponges, blue light\. A wide view of the whole place, empty/);
    expect(pictures[5].body.prompt).toMatch(/^Draw a new picture of this scene: Doodle of sentence 5\. .*The place, the cave, the same in every scene set there: A low rock cave, purple sponges, blue light\. .*Reference picture 2 shows only how the place is built/);
    // A redone picture uses the sheets kept with the video (none is drawn again), even after scene 1 moved into the cave.
    const redo = { ...video.spec, scenes: video.spec.scenes.map((s: any, i: number) => (i === 0 ? { ...s, place: "the cave" } : i === 4 ? { ...s, imageId: undefined } : s)) };
    const before = calls.length;
    const edited = await call(worker, env, "PUT", `/api/videos/${video.id}`, { spec: redo, idempotencyKey: crypto.randomUUID() }, user.cookie);
    expect(edited.data).toMatchObject({ rendering: true, credits: pictureCredits(1) });
    await run();
    const again = calls.slice(before).filter((c) => c.method === "POST" && c.url.startsWith("https://queue.fal.run/"));
    expect(again.map((c) => c.body.image_urls.length)).toEqual([2]);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM media_assets WHERE video_id=? AND json_extract(meta,'$.sheet') IS NOT NULL").get(video.id)).toEqual({ n: 2 });
    // A new main character is a new sheet; the old one goes with the next render.
    const redone = (await call(worker, env, "GET", `/api/videos/${video.id}`, undefined, user.cookie)).data.video.spec;
    const renamed = { ...redone, subject: "a tall green squid", scenes: redone.scenes.map((s: any, i: number) => (i === 2 ? { ...s, imageId: undefined } : s)) };
    const next = calls.length;
    await call(worker, env, "PUT", `/api/videos/${video.id}`, { spec: renamed, idempotencyKey: crypto.randomUUID() }, user.cookie);
    await run();
    expect(calls.slice(next).filter((c) => c.method === "POST" && c.url.startsWith("https://queue.fal.run/")).map((c) => (c.body.prompt as string).slice(0, 44)))
      .toEqual(["Character reference sheet: a tall green squi", "Draw a new picture of this scene: Doodle of "]);
    expect((sqlite.prepare("SELECT meta FROM media_assets WHERE video_id=? AND json_extract(meta,'$.sheet') IS NOT NULL ORDER BY json_extract(meta,'$.prompt')").all(video.id) as any[]).map((r) => JSON.parse(r.meta).prompt.slice(0, 30)))
      .toEqual(["Character reference sheet: a t", "Establishing shot of the cave:"]);
  });

  it("draws a picture the model refused once more with Nano Banana 2, and stops when that is refused too", async () => {
    const { env, user, spec, used, run } = await setup();
    env.FAL_IMAGE_MODEL = "google/nano-banana-2.1";
    let refused = ["google/nano-banana-2.1", "google/nano-banana-2.1/edit"];
    const calls = providers({ refuse: (model) => refused.includes(model) });
    const pictures = () => calls.filter((c) => c.method === "POST" && c.url.startsWith("https://queue.fal.run/") && !c.url.includes("/kling-video/")).map((c) => c.url.split("/").slice(3).join("/"));
    const price = videoCredits(estimatedSeconds(spec)) + CLIP_CREDITS.regular;
    const created = await call(worker, env, "POST", "/api/videos", { spec, idempotencyKey: crypto.randomUUID() }, user.cookie);
    await run();
    // Every picture 2.1 refused (the octopus's sheet, then the four scenes) is drawn by Nano Banana 2 (its edit endpoint
    // from the same references), for no more credits.
    expect(pictures()).toEqual([
      "google/nano-banana-2.1", "fal-ai/nano-banana-2",
      ...Array(4).fill(["google/nano-banana-2.1/edit", "fal-ai/nano-banana-2/edit"]).flat(),
    ]);
    const edits = calls.filter((c) => c.method === "POST" && c.url.includes("/edit"));
    expect(edits[1].body.image_urls).toEqual(edits[0].body.image_urls);
    let video = (await call(worker, env, "GET", `/api/videos/${created.data.id}`, undefined, user.cookie)).data.video;
    expect(video.renderStatus).toBe("ready");
    expect(used()).toBe(price);
    // Refused by Nano Banana 2 as well, the video stops and its credits come back; so does a refusal by Nano Banana 2
    // itself, with nothing to fall back on.
    refused = [...refused, "fal-ai/nano-banana-2/edit"];
    const redo = { ...video.spec, scenes: video.spec.scenes.map((s: any, i: number) => (i === 4 ? { ...s, imageId: undefined } : s)) };
    await call(worker, env, "PUT", `/api/videos/${video.id}`, { spec: redo, idempotencyKey: crypto.randomUUID() }, user.cookie);
    await run();
    video = (await call(worker, env, "GET", `/api/videos/${video.id}`, undefined, user.cookie)).data.video;
    expect([video.renderStatus, video.renderError]).toEqual(["failed", expect.stringContaining("refused by the content filter")]);
    expect(pictures().slice(-2)).toEqual(["google/nano-banana-2.1/edit", "fal-ai/nano-banana-2/edit"]);
    expect(used()).toBe(price);
    env.FAL_IMAGE_MODEL = "fal-ai/nano-banana-2";
    const tries = calls.length;
    await call(worker, env, "PUT", `/api/videos/${video.id}`, { spec: redo, idempotencyKey: crypto.randomUUID() }, user.cookie);
    await run();
    expect(calls.slice(tries).filter((c) => c.method === "POST" && c.url.includes("queue.fal.run")).map((c) => c.url.split("/").slice(3).join("/"))).toEqual(["fal-ai/nano-banana-2/edit"]);
  });

  it("lets administrators choose the clip model per scene from FAL_CLIP_MODEL_ADMIN's list, and no one else", async () => {
    const { env, sqlite, user, spec, run } = await setup();
    const calls = providers();
    const clipModels = () => calls.filter((c) => c.method === "POST" && /kling-video|minimax\/h3|flux-3-max/.test(c.url)).map((c) => c.url.split("/").slice(3).join("/"));
    const make = async (clipModel?: string) => {
      const chosen = { ...spec, scenes: spec.scenes.map((s) => (s.source === "clip" ? { ...s, clipModel } : s)) };
      expect((await call(worker, env, "POST", "/api/videos", { spec: chosen, idempotencyKey: crypto.randomUUID() }, user.cookie)).status).toBe(201);
      await run();
      return clipModels().at(-1);
    };
    env.FAL_CLIP_MODEL_ADMIN = "minimax-h3,flux-3-max";
    // A customer's choice is ignored: their clips use everyone's model, and they are offered no models.
    expect(await make("minimax-h3")).toBe("fal-ai/kling-video/v2.5-turbo/standard/image-to-video");
    expect((await call(worker, env, "GET", "/api/auth/me", undefined, user.cookie)).data.user.clipModels).toBeUndefined();
    // An administrator's is used, each model in its own request; no choice is everyone's model.
    sqlite.prepare("UPDATE users SET email='admin@example.com' WHERE id=?").run(user.id);
    expect((await call(worker, env, "GET", "/api/auth/me", undefined, user.cookie)).data.user.clipModels).toEqual(["kling", "minimax-h3", "flux-3-max"]);
    expect(await make("minimax-h3")).toBe("minimax/h3/image-to-video");
    expect(calls.filter((c) => c.url.endsWith("/minimax/h3/image-to-video")).at(-1)!.body).toMatchObject({ resolution: "768P", duration: 5 });
    expect(await make("flux-3-max")).toBe("blackforestlabs/flux-3-max/image-to-video");
    expect(calls.filter((c) => c.url.endsWith("/flux-3-max/image-to-video")).at(-1)!.body).toMatchObject({ generate_audio: false, resolution: "720p" });
    expect(await make()).toBe("fal-ai/kling-video/v2.5-turbo/standard/image-to-video");
    // A model taken off the list is no longer used, even for an administrator.
    env.FAL_CLIP_MODEL_ADMIN = "minimax-h3";
    expect(await make("flux-3-max")).toBe("fal-ai/kling-video/v2.5-turbo/standard/image-to-video");
    // Chosen for everyone, a model is everyone's.
    env.FAL_CLIP_MODEL = "flux-3-max";
    sqlite.prepare("UPDATE users SET email='someone@example.com' WHERE id=?").run(user.id);
    expect(await make()).toBe("blackforestlabs/flux-3-max/image-to-video");
  });

  it("makes an administrator's HeyGen Video 1 clip from the scene's picture, then deletes HeyGen's copy", async () => {
    const { env, sqlite, user, spec, run } = await setup();
    const calls = providers();
    env.HEYGEN_API_KEY = "hg";
    env.FAL_CLIP_MODEL_ADMIN = "heygen-video-1";
    sqlite.prepare("UPDATE users SET email='admin@example.com' WHERE id=?").run(user.id);
    expect((await call(worker, env, "GET", "/api/auth/me", undefined, user.cookie)).data.user.clipModels).toEqual(["kling", "heygen-video-1"]);
    const chosen = { ...spec, scenes: spec.scenes.map((s) => (s.source === "clip" ? { ...s, clipModel: "heygen-video-1" as const, clipQuality: "high" as const } : s)) };
    const created = await call(worker, env, "POST", "/api/videos", { spec: chosen, idempotencyKey: crypto.randomUUID() }, user.cookie);
    expect(created.status).toBe(201);
    await run();
    // One paid request (with an Idempotency-Key), from the scene's picture, at 1080p; nothing for it at fal.
    const asked = calls.filter((c) => c.method === "POST" && c.url === "https://api.heygen.com/v3/models/videos");
    expect(asked).toHaveLength(1);
    expect(asked[0].body).toMatchObject({ model: "heygen-video-1", mode: "image_to_video", duration: 5, resolution: "1080p", image: { type: "url" } });
    expect(asked[0].body.image.url).toMatch(/^https:\/\/app\.test\/api\/render-inputs\//);
    expect(calls.some((c) => c.method === "POST" && /kling-video/.test(c.url))).toBe(false);
    // Saved from a fresh link, then HeyGen's copy deleted.
    expect(calls.some((c) => c.url.startsWith("https://resource2.heygen.ai/videos/hv"))).toBe(true);
    const job = calls.find((c) => /\/models\/videos\/hv\d+$/.test(c.url))!.url.split("/").at(-1);
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toEqual([`https://api.heygen.com/v3/videos/${job}`]);
    const video = (await call(worker, env, "GET", `/api/videos/${created.data.id}`, undefined, user.cookie)).data.video;
    expect(video.renderStatus).not.toBe("failed");
    const clip = sqlite.prepare("SELECT kind,mime,bytes FROM media_assets WHERE video_id=? AND kind='ai_clip'").get(created.data.id) as any;
    expect(clip).toMatchObject({ kind: "ai_clip", mime: "video/mp4", bytes: 2000 });
    expect(sqlite.prepare("SELECT COUNT(*) n FROM cleanup_tasks WHERE prefix LIKE 'heygen/%'").get()).toEqual({ n: 0 });
  });

  it("asks HeyGen for a clip as long as its scene is on screen, after the voice, never longer than chosen", async () => {
    const { env, user, spec, run } = await setup();
    env.HEYGEN_API_KEY = "hg";
    env.FAL_CLIP_MODEL = "heygen-video-1";
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const ask = async (clipSeconds: 5 | 10, options: Parameters<typeof providers>[0] = {}) => {
      const calls = providers(options);
      const chosen = { ...spec, scenes: spec.scenes.map((s) => (s.source === "clip" ? { ...s, clipSeconds } : s)) };
      expect((await call(worker, env, "POST", "/api/videos", { spec: chosen, idempotencyKey: crypto.randomUUID() }, user.cookie)).status).toBe(201);
      await run();
      return calls;
    };
    // The clip's scene (the second sentence, 3.0–7.8 s, faded in) is on screen for about 5.7 s: 6 seconds, not 10.
    let calls = await ask(10);
    const voice = calls.findIndex((c) => c.url.includes("api.elevenlabs.io"));
    const asked = calls.findIndex((c) => c.method === "POST" && c.url === "https://api.heygen.com/v3/models/videos");
    expect(voice).toBeGreaterThanOrEqual(0);
    expect(asked).toBeGreaterThan(voice);
    expect(calls[asked].body).toMatchObject({ duration: 6 });
    // Never longer than the length chosen (what its credits paid for): 5 stays 5.
    calls = await ask(5);
    expect(calls.find((c) => c.method === "POST" && c.url === "https://api.heygen.com/v3/models/videos")!.body).toMatchObject({ duration: 5 });
    // Kling, making a clip HeyGen refused, keeps the length chosen (its clips are 5 or 10 seconds).
    calls = await ask(10, { refuseHeyGen: true });
    expect(calls.find((c) => c.method === "POST" && /kling-video/.test(c.url))!.body).toMatchObject({ duration: "10" });
  });

  it("makes a clip HeyGen's filter refused with Kling instead, and fails the video only when Kling refuses it too", async () => {
    const { env, sqlite, user, spec, used, run } = await setup();
    env.HEYGEN_API_KEY = "hg";
    env.FAL_CLIP_MODEL = "heygen-video-1";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    let calls = providers({ refuseHeyGen: true });
    const made = await call(worker, env, "POST", "/api/videos", { spec, idempotencyKey: crypto.randomUUID() }, user.cookie);
    await run();
    // A refusal is not asked of HeyGen again: Kling makes the clip from the same picture, and HeyGen's copy goes.
    expect(calls.filter((c) => c.method === "POST" && c.url === "https://api.heygen.com/v3/models/videos")).toHaveLength(1);
    expect(calls.filter((c) => c.method === "POST" && c.url.endsWith("/kling-video/v2.5-turbo/standard/image-to-video"))).toHaveLength(1);
    expect(calls.filter((c) => c.method === "DELETE" && c.url.startsWith("https://api.heygen.com/v3/videos/hv"))).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith("HeyGen clip not made, making it with Kling", expect.objectContaining({ code: "GENERATION_REJECTED" }));
    expect((await call(worker, env, "GET", `/api/videos/${made.data.id}`, undefined, user.cookie)).data.video.renderStatus).not.toBe("failed");
    const meta = JSON.parse((sqlite.prepare("SELECT meta FROM media_assets WHERE video_id=? AND kind='ai_clip'").get(made.data.id) as any).meta);
    expect(meta).toMatchObject({ clipModel: "kling", fallback: true });
    // The operator hears about clips made with Kling instead (the hourly summary).
    expect((await attention(env)).counts.clipFallback).toBe(1);
    // Kling refuses it too: the run fails with the refusal, refunded.
    calls = providers({ refuseHeyGen: true, refuseClip: true });
    const charged = used();
    await call(worker, env, "POST", "/api/videos", { spec, idempotencyKey: crypto.randomUUID() }, user.cookie);
    await run();
    expect(used()).toBe(charged);
    expect(sqlite.prepare("SELECT status,error FROM runs ORDER BY created_at DESC, rowid DESC LIMIT 1").get()).toMatchObject({ status: "failed", error: "GENERATION_REJECTED" });
  });

  it("never pays HeyGen twice for a passing problem: a gateway error or no answer is asked again, not counted as a failure", async () => {
    const { env, user, spec, used, run } = await setup();
    env.HEYGEN_API_KEY = "hg";
    env.FAL_CLIP_MODEL = "heygen-video-1";
    heygenRetry.ms = 1;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const calls = providers({ heygenHiccups: true });
    const before = used();
    const made = await call(worker, env, "POST", "/api/videos", { spec, idempotencyKey: crypto.randomUUID() }, user.cookie);
    await run();
    // The submit is sent again with the same Idempotency-Key (HeyGen answers with the job it already has).
    const posts = calls.filter((c) => c.method === "POST" && c.url === "https://api.heygen.com/v3/models/videos");
    expect(posts).toHaveLength(2);
    expect(posts[0].headers!.get("Idempotency-Key")).toBe(posts[1].headers!.get("Idempotency-Key"));
    // A 503 while it is being made, and again when the finished clip's link is fetched: one job, no Kling, no retry.
    const jobs = new Set(calls.filter((c) => /\/models\/videos\/hv\d+$/.test(c.url)).map((c) => c.url));
    expect(jobs.size).toBe(1);
    expect(calls.some((c) => c.method === "POST" && /kling-video/.test(c.url))).toBe(false);
    expect((await call(worker, env, "GET", `/api/videos/${made.data.id}`, undefined, user.cookie)).data.video.renderStatus).not.toBe("failed");
    expect(used()).toBe(before + made.data.credits);
  });

  it("asks HeyGen once more for a clip it failed to make, then makes it with Kling; without credits, with Kling at once", async () => {
    const { env, sqlite, user, spec, used, run } = await setup();
    env.HEYGEN_API_KEY = "hg";
    env.FAL_CLIP_MODEL = "heygen-video-1";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const jobs = (calls: { method: string; url: string }[]) => calls.filter((c) => c.method === "POST" && c.url === "https://api.heygen.com/v3/models/videos").length;
    const kling = (calls: { method: string; url: string }[]) => calls.filter((c) => c.method === "POST" && /kling-video/.test(c.url)).length;
    // The jobs whose copies were deleted (asked more than once is fine: an already deleted one counts as deleted).
    const deleted = (calls: { method: string; url: string }[]) => [...new Set(calls.filter((c) => c.method === "DELETE").map((c) => c.url.split("/").at(-1)))];
    const status = async (id: string) => (await call(worker, env, "GET", `/api/videos/${id}`, undefined, user.cookie)).data.video.renderStatus;
    // Failed once: a second job makes it; both of HeyGen's copies are deleted and the video is made.
    let calls = providers({ heygenFails: 1 });
    const once = await call(worker, env, "POST", "/api/videos", { spec, idempotencyKey: crypto.randomUUID() }, user.cookie);
    await run();
    expect([jobs(calls), kling(calls), deleted(calls).length]).toEqual([2, 0, 2]);
    expect(await status(once.data.id)).not.toBe("failed");
    expect(warn).toHaveBeenCalledWith("HeyGen clip failed", expect.objectContaining({ status: "failed", code: "generation_failed", rejected: false }));
    expect(warn).toHaveBeenCalledWith("HeyGen clip failed, asking for it again", expect.objectContaining({ code: "GENERATION_FAILED" }));
    // Failed twice: Kling makes it, for the same credits; both of HeyGen's copies are deleted.
    calls = providers({ heygenFails: 2 });
    const before = used();
    const twice = await call(worker, env, "POST", "/api/videos", { spec, idempotencyKey: crypto.randomUUID() }, user.cookie);
    await run();
    expect([jobs(calls), kling(calls), deleted(calls).length]).toEqual([2, 1, 2]);
    expect(await status(twice.data.id)).not.toBe("failed");
    expect(used()).toBe(before + twice.data.credits);
    expect(warn).toHaveBeenCalledWith("HeyGen clip not made, making it with Kling", expect.objectContaining({ code: "GENERATION_FAILED" }));
    // HeyGen out of credits: no job, no second ask, Kling at once.
    calls = providers({ heygenDown: true });
    const down = await call(worker, env, "POST", "/api/videos", { spec, idempotencyKey: crypto.randomUUID() }, user.cookie);
    await run();
    expect([jobs(calls), kling(calls), deleted(calls).length]).toEqual([1, 1, 0]);
    expect(await status(down.data.id)).not.toBe("failed");
    expect(warn).toHaveBeenCalledWith("HeyGen clip not made, making it with Kling", expect.objectContaining({ code: "GENERATION_UNAVAILABLE" }));
    expect(sqlite.prepare("SELECT COUNT(*) n FROM runs WHERE status='failed'").get()).toEqual({ n: 0 });
  });

  it("makes a high-quality clip with the finer model, for 2 credits per 5 seconds", async () => {
    const { env, user, spec, used, run } = await setup();
    const calls = providers();
    const high = { ...spec, scenes: spec.scenes.map((s) => (s.source === "clip" ? { ...s, clipQuality: "high" as const } : s)) };
    const price = videoCredits(estimatedSeconds(spec)) + CLIP_CREDITS.high;
    const created = await call(worker, env, "POST", "/api/videos", { spec: high, idempotencyKey: crypto.randomUUID() }, user.cookie);
    expect([created.status, created.data.credits]).toEqual([201, price]);
    await run();
    expect(calls.filter((c) => c.method === "POST" && c.url.includes("/kling-video/")).map((c) => c.url.split("/").slice(3).join("/")))
      .toEqual(["fal-ai/kling-video/v2.5-turbo/pro/image-to-video"]);
    expect(used()).toBe(price);
  });

  it("charges the voice, pictures and clip once, makes the clip from its picture, and re-renders for free", async () => {
    const { env, sqlite, user, spec, own, used, run } = await setup();
    const calls = providers();
    const price = videoCredits(estimatedSeconds(spec)) + CLIP_CREDITS.regular;
    const created = await call(worker, env, "POST", "/api/videos", { spec, idempotencyKey: crypto.randomUUID() }, user.cookie);
    expect(created.status).toBe(201);
    expect(created.data.credits).toBe(price);
    expect(used()).toBe(price);
    await run();
    const submits = () => calls.filter((c) => c.method === "POST" && c.url.startsWith("https://queue.fal.run/"));
    // The octopus's reference sheet from its text; every scene's picture drawn from it, so the scenes look alike.
    expect(submits().map((c) => c.url.split("/").slice(3).join("/"))).toEqual([
      "openai/gpt-image-2.5/flare/text-to-image", ...Array(4).fill("fal-ai/nano-banana-2/edit"), "fal-ai/kling-video/v2.5-turbo/standard/image-to-video",
    ]);
    let post = (await call(worker, env, "GET", `/api/videos/${created.data.id}`, undefined, user.cookie)).data.video;
    expect(post.renderStatus).toBe("ready");
    // The clip starts from scene 2's own picture, read through the run's capability link.
    const state = JSON.parse((sqlite.prepare("SELECT provider FROM runs WHERE video_id=?").get(post.id) as any).provider);
    const pictureKey = (sqlite.prepare("SELECT object_key FROM media_assets WHERE id=?").get(post.spec.scenes[1].imageId) as any).object_key;
    expect(submits()[5].body.image_url).toMatch(new RegExp(`/api/render-inputs/[0-9a-f-]{36}/${state.inputs.indexOf(pictureKey)}\\?token=`));
    expect(submits()[0].body.prompt).toMatch(/^Character reference sheet: a small orange octopus\./);
    // Every scene's picture is drawn from the sheet, read through the run's capability link, with the subject in its text.
    const firstKey = (sqlite.prepare("SELECT object_key FROM media_assets WHERE video_id=? AND json_extract(meta,'$.sheet') IS NOT NULL").get(post.id) as any).object_key;
    for (const c of submits().slice(1, 5)) {
      expect(c.body.image_urls).toEqual([expect.stringMatching(new RegExp(`/api/render-inputs/[0-9a-f-]{36}/${state.inputs.indexOf(firstKey)}\\?token=`))]);
      expect(c.body.prompt).toContain("a small orange octopus");
    }
    // The voice: spoken once, its words timed as written (no forced alignment needed).
    expect(calls.filter((c) => c.url.includes("api.elevenlabs.io")).map((c) => c.url.split("/")[4])).toEqual(["text-to-speech"]);
    expect(post.spec.generated.words).toHaveLength(words.length);
    expect(post.spec.scenes.map((s: any) => [s.source, !!s.imageId, !!s.clipId, s.assetId === own])).toEqual([
      ["image", true, false, false], ["clip", true, true, false], ["image", true, false, false], ["own", false, false, true], ["image", true, false, false],
    ]);
    // The render: five pictures with transitions, the voice as one track.
    const composes = () => env.MEDIA_RENDERER.log.filter((p: any) => p.operation === "compose");
    const first = composes().at(-1);
    expect(first.segments.map((s: any) => [s.kind, s.transition?.kind ?? null])).toEqual([["image", null], ["video", "fade"], ["image", AUTO_TRANSITIONS[1]], ["image", AUTO_TRANSITIONS[2]], ["image", "circleopen"]]);
    expect(first.voice).toMatchObject({ start: 0, volume: 1 });
    expect(first.synthetic).toBe(true);
    expect(used()).toBe(price);

    const edit = async (change: (s: any) => any, credits = 0) => {
      const r = await call(worker, env, "PUT", `/api/videos/${post.id}`, { spec: change(post.spec), idempotencyKey: crypto.randomUUID() }, user.cookie);
      expect(r.data).toMatchObject({ rendering: true, credits });
      await run();
      post = (await call(worker, env, "GET", `/api/videos/${post.id}`, undefined, user.cookie)).data.video;
      expect(post.renderStatus).toBe("ready");
      return composes().at(-1);
    };
    // A transition, a scene edge and the subtitle style change: free (the voice and pictures are kept).
    const moved = await edit((s) => ({ ...s, captions: { enabled: true, style: "bold" }, scenes: s.scenes.map((x: any, n: number) => ({
      ...x, transition: n === 2 ? "slideup" : x.transition,
      text: n === 2 ? `${x.text} ${s.scenes[3].text.split(" ")[0]}` : n === 3 ? s.scenes[3].text.split(" ").slice(1).join(" ") : x.text,
    })) }));
    expect(moved.segments[2].transition.kind).toBe("slideup");
    // A new picture for one scene: only that scene is charged and made.
    await edit((s) => ({ ...s, scenes: s.scenes.map((x: any, n: number) => (n === 4 ? { ...x, imageId: undefined, description: "The octopus crawling" } : x)) }), pictureCredits(1));
    expect(submits()).toHaveLength(7);
    expect(calls.filter((c) => c.url.includes("api.elevenlabs.io"))).toHaveLength(1);
    expect(used()).toBe(price + pictureCredits(1));
    // Older pictures were cleaned up; the voice, the pictures, the octopus's sheet, the clip and the latest render stay.
    const left = (sqlite.prepare("SELECT kind FROM media_assets WHERE video_id=? ORDER BY kind").all(post.id) as any[]).map((r) => r.kind);
    expect(left).toEqual(["ai_clip", ...Array(5).fill("ai_image"), "cover", "render", "voice"]);
  });

  it("refunds everything once when a clip is refused, before the voice is paid for", async () => {
    const { env, sqlite, user, spec, used, run } = await setup();
    const calls = providers({ refuseClip: true });
    const created = await call(worker, env, "POST", "/api/videos", { spec, idempotencyKey: crypto.randomUUID() }, user.cookie);
    expect(used()).toBeGreaterThan(0);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await run();
    expect(used()).toBe(0);
    const post = (await call(worker, env, "GET", `/api/videos/${created.data.id}`, undefined, user.cookie)).data.video;
    expect(post.renderStatus).toBe("failed");
    expect(post.renderError).toMatch(/content filter.*credits were refunded/);
    expect(calls.some((c) => c.url.includes("elevenlabs"))).toBe(false);
    env.CONTENT.created.push({ params: { runId: (sqlite.prepare("SELECT id FROM runs WHERE video_id=?").get(post.id) as any).id } });
    await run();
    expect(used()).toBe(0);
  });

  it("charges a retry of a video that was never made what a new one costs, whatever its failed run made", async () => {
    const { env, user, spec, used, run } = await setup();
    let refusing = true;
    providers({ refuse: (model) => refusing && model === "fal-ai/nano-banana-2/edit" });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const created = await call(worker, env, "POST", "/api/videos", { spec, idempotencyKey: crypto.randomUUID() }, user.cookie);
    await run();
    const get = async () => (await call(worker, env, "GET", `/api/videos/${created.data.id}`, undefined, user.cookie)).data.video;
    const failed = await get();
    expect([failed.renderStatus, used()]).toEqual(["failed", 0]);
    // Priced as an edit it would cost more (the voice, the four pictures and the clip still to make); a retry costs
    // what the new video did.
    expect(specCredits(failed.spec, false, undefined, failed.spec)).toBeGreaterThan(created.data.credits);
    refusing = false;
    const retried = await call(worker, env, "POST", `/api/videos/${failed.id}/render`, { idempotencyKey: crypto.randomUUID() }, user.cookie);
    expect(retried.data.credits).toBe(created.data.credits);
    await run();
    expect([(await get()).renderStatus, used()]).toEqual(["ready", created.data.credits]);
  });

  /** Fills the user's storage up to `free` bytes short of the plan's, with one big upload (deleted to make room again). */
  const fill = (sqlite: any, userId: string, free: number) => {
    const { room } = sqlite.prepare("SELECT (SELECT max_bytes FROM media_limits WHERE user_id=?)-COALESCE(SUM(bytes),0) AS room FROM media_assets WHERE user_id=?").get(userId, userId) as any;
    const big = crypto.randomUUID();
    sqlite.prepare("INSERT INTO media_assets(id,user_id,kind,name,object_key,mime,bytes,status,created_at,updated_at) VALUES (?,?,'upload','Big',?,'video/mp4',?,'ready',1,1)")
      .run(big, userId, `media/${userId}/${big}.mp4`, room - free);
    return () => sqlite.prepare("DELETE FROM media_assets WHERE id=?").run(big);
  };

  it("refuses to start a video or an edit its storage has no room for, before anything is paid", async () => {
    const { env, sqlite, user, spec, used, run } = await setup();
    const calls = providers();
    const created = await call(worker, env, "POST", "/api/videos", { spec, idempotencyKey: crypto.randomUUID() }, user.cookie);
    await run();
    const made = (await call(worker, env, "GET", `/api/videos/${created.data.id}`, undefined, user.cookie)).data.video;
    expect(made.renderStatus).toBe("ready");
    const spent = used(), paid = calls.length;
    const empty = fill(sqlite, user.id, 1000);
    const full = [413, "Your storage is full. Delete some files or videos, or upgrade your plan."];
    // A new video, an edit that makes the video again and a retry are refused at once: no run, no credits, no provider.
    const fresh = await call(worker, env, "POST", "/api/videos", { spec, idempotencyKey: crypto.randomUUID() }, user.cookie);
    expect([fresh.status, fresh.data.error]).toEqual(full);
    const restyled = await call(worker, env, "PUT", `/api/videos/${made.id}`, { spec: { ...made.spec, captions: { enabled: true, style: "bold" } }, idempotencyKey: crypto.randomUUID() }, user.cookie);
    expect([restyled.status, restyled.data.error]).toEqual(full);
    const retried = await call(worker, env, "POST", `/api/videos/${made.id}/render`, { idempotencyKey: crypto.randomUUID() }, user.cookie);
    expect([retried.status, retried.data.error]).toEqual(full);
    expect([env.CONTENT.created.length, used(), calls.length]).toEqual([0, spent, paid]);
    expect((await call(worker, env, "GET", `/api/videos/${made.id}`, undefined, user.cookie)).data.video.renderStatus).toBe("ready");
    // Room again: it is made.
    empty();
    expect((await call(worker, env, "POST", "/api/videos", { spec, idempotencyKey: crypto.randomUUID() }, user.cookie)).status).toBe(201);
  });

  it("stops a run whose files no longer fit, deletes what it stored, refunds it and says why", async () => {
    const { env, sqlite, user, spec, own, used, run } = await setup();
    providers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const created = await call(worker, env, "POST", "/api/videos", { spec, idempotencyKey: crypto.randomUUID() }, user.cookie);
    expect(used()).toBe(created.data.credits);
    // Filled up meanwhile (other uploads): the first AI picture is made and stored, but can't be kept.
    fill(sqlite, user.id, 0);
    await run();
    const post = (await call(worker, env, "GET", `/api/videos/${created.data.id}`, undefined, user.cookie)).data.video;
    expect(post.renderStatus).toBe("failed");
    expect(post.renderError).toBe("Your storage is full, so this video couldn't be kept. Delete some files or videos, or upgrade your plan, then try again. Your credits were refunded.");
    expect(sqlite.prepare("SELECT error FROM runs WHERE video_id=?").get(post.id)).toEqual({ error: "STORAGE_FULL" });
    expect(used()).toBe(0);
    // Nothing it stored is left behind without a record (only the owner's own picture is in storage).
    expect([...env.MEDIA.objects.keys()]).toEqual([`media/${user.id}/${own}.jpg`]);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM media_assets WHERE video_id=?").get(post.id)).toEqual({ n: 0 });
  });

  it("times a voice without timings by forced alignment of the recording, never paying for the voice twice", async () => {
    const { env, user, spec, run } = await setup();
    const calls = providers({ timings: false });
    const simple = { ...spec, scenes: spec.scenes.map((s) => ({ ...s, source: "image" as const, assetId: undefined })) };
    const created = await call(worker, env, "POST", "/api/videos", { spec: simple, idempotencyKey: crypto.randomUUID() }, user.cookie);
    await run();
    const post = (await call(worker, env, "GET", `/api/videos/${created.data.id}`, undefined, user.cookie)).data.video;
    expect(post.renderStatus).toBe("ready");
    const eleven = calls.filter((c) => c.url.includes("api.elevenlabs.io"));
    expect(eleven.map((c) => c.url)).toEqual([expect.stringContaining("/text-to-speech/"), ALIGNMENT_URL]);
    expect(eleven[1].body).toEqual({ file: `file:${44 + DURATION * 48000}`, text: storyScript(simple.scenes) });
    expect(post.spec.generated.words[0]).toMatchObject({ text: "Octopuses", start: words[0].start });
    const compose = env.MEDIA_RENDERER.log.filter((p: any) => p.operation === "compose").at(-1);
    expect(compose.ass).toContain("Octopuses");
  });

  it("keeps a long link in a scene as one word, cut short, so the paid voice is used and the video stays editable", async () => {
    const { env, sqlite, user, spec, used, run } = await setup();
    env.FAL_REFERENCE_MODEL = "off";
    providers();
    // ElevenLabs times every character it was sent: the link is one token of 140 characters.
    const others = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: any, init: any = {}) => {
      if (!String(input?.url ?? input).includes("/v1/text-to-speech/")) return others(input, init);
      const chars = [...JSON.parse(init.body).text as string], step = DURATION / chars.length;
      return Response.json({
        audio_base64: Buffer.from(new Uint8Array(DURATION * 48000)).toString("base64"),
        alignment: { characters: chars, character_start_times_seconds: chars.map((_, i) => i * step), character_end_times_seconds: chars.map((_, i) => (i + 1) * step) },
      });
    });
    const link = `https://example.com/${"a".repeat(120)}`;
    const linked = { ...spec, scenes: spec.scenes.map((s, n) => ({ ...s, source: "image" as const, assetId: undefined, ...(n === 4 && { text: `${s.text} Read more at ${link}` }) })) };
    const created = await call(worker, env, "POST", "/api/videos", { spec: linked, idempotencyKey: crypto.randomUUID() }, user.cookie);
    await run();
    const get = async () => (await call(worker, env, "GET", `/api/videos/${created.data.id}`, undefined, user.cookie)).data.video;
    let post = await get();
    expect([post.renderStatus, post.renderError]).toEqual(["ready", null]);
    // Word for word as written (the count decides the timing), the link cut to the longest word a video keeps.
    expect(post.spec.generated.words).toHaveLength(textWords(storyScript(linked.scenes)).length);
    expect(post.spec.generated.words.at(-1).text).toBe(link.slice(0, 80));
    expect(used()).toBe(created.data.credits);
    // A video saved with the whole link before words were cut is made again from its paid voice, for free.
    const stored = JSON.parse((sqlite.prepare("SELECT spec FROM videos WHERE id=?").get(post.id) as any).spec);
    stored.generated.words.at(-1).text = link;
    sqlite.prepare("UPDATE videos SET spec=? WHERE id=?").run(JSON.stringify(stored), post.id);
    const retried = await call(worker, env, "POST", `/api/videos/${post.id}/render`, { idempotencyKey: crypto.randomUUID() }, user.cookie);
    expect(retried.data.credits).toBe(0);
    await run();
    post = await get();
    expect([post.renderStatus, post.renderError]).toEqual(["ready", null]);
    expect((specSchema.parse(stored) as StorySpec).generated!.words.at(-1)!.text).toBe(link.slice(0, 80));
  });
});

describe("an owner's voiceover", () => {
  async function upload(env: any, sqlite: any, user: any, meta: Record<string, unknown>, extra: { mime?: string; duration?: number; bytes?: number } = {}) {
    const a = crypto.randomUUID(), key = `media/${user.id}/${a}.wav`;
    await env.MEDIA.put(key, new Uint8Array(extra.bytes ?? 2000));
    sqlite.prepare("INSERT INTO media_assets(id,user_id,kind,name,object_key,mime,bytes,duration,status,meta,created_at,updated_at) VALUES (?,?,'upload','Voiceover',?,?,?,?,'ready',?,1,1)")
      .run(a, user.id, key, extra.mime ?? "audio/wav", extra.bytes ?? 2000, extra.duration ?? DURATION, JSON.stringify(meta));
    return a;
  }

  it("is timed by its transcript, or by forced alignment of the exact script (made once, kept with the file)", async () => {
    const { env, sqlite, user } = await setup();
    const calls = providers();
    const transcript = { hasAudio: true, speech: { status: "found", at: 1 }, transcript: { language: "eng", words: words.map((w) => ({ ...w, text: w.text.toLowerCase() })) } };
    const a = await upload(env, sqlite, user, transcript);
    const plain = await call(worker, env, "POST", "/api/story/timing", { assetId: a }, user.cookie);
    expect(plain.status).toBe(200);
    expect(plain.data).toMatchObject({ source: "transcript", speech: "found", duration: DURATION });
    expect(plain.data.words[0].text).toBe("octopuses");
    const script = said.map((s) => s[0]).join("\n\n");
    const aligned = await call(worker, env, "POST", "/api/story/timing", { assetId: a, script }, user.cookie);
    expect(aligned.data.source).toBe("script");
    expect(aligned.data.words[0].text).toBe("Octopuses");
    // Sent once as its plain words; asked again, the stored alignment answers; the list of files never carries it.
    expect(calls.filter((c) => c.url === ALIGNMENT_URL).map((c) => c.body.text)).toEqual([said.map((s) => s[0]).join(" ")]);
    expect((await call(worker, env, "POST", "/api/story/timing", { assetId: a, script: ` ${script} ` }, user.cookie)).data.source).toBe("script");
    expect(calls.filter((c) => c.url === ALIGNMENT_URL)).toHaveLength(1);
    const listed = (await call(worker, env, "GET", "/api/media?type=audio", undefined, user.cookie)).data.assets.find((x: any) => x.id === a);
    expect(JSON.stringify(listed)).not.toContain("alignment");
    // Too long for a video, no sound, someone else's file.
    const long = await upload(env, sqlite, user, { hasAudio: true }, { duration: 200 });
    expect((await call(worker, env, "POST", "/api/story/timing", { assetId: long }, user.cookie)).status).toBe(400);
    const mute = await upload(env, sqlite, user, { hasAudio: false });
    expect((await call(worker, env, "POST", "/api/story/timing", { assetId: mute }, user.cookie)).status).toBe(400);
    const other = signedIn(sqlite);
    expect((await call(worker, env, "POST", "/api/story/timing", { assetId: a }, other.cookie)).status).toBe(404);
  });

  it("renders on the recording's clock with its words, and refuses a voiceover that is not one", async () => {
    const { env, sqlite, user, run, used } = await setup();
    providers();
    const a = await upload(env, sqlite, user, { hasAudio: true, speech: { status: "found", at: 1 }, transcript: { language: "eng", words } });
    const own = (sqlite.prepare("SELECT id FROM media_assets WHERE name='Reef'").get() as any).id;
    const spec = story({ narration: { kind: "upload", assetId: a }, scenes: said.map((_, n) => scene(n, { source: "own", assetId: own })) });
    const created = await call(worker, env, "POST", "/api/videos", { spec, idempotencyKey: crypto.randomUUID() }, user.cookie);
    // A new video costs its length (the recording's), even with the owner's own voice and pictures.
    expect(created.data.credits).toBe(videoCredits(DURATION));
    await run();
    expect(used()).toBe(videoCredits(DURATION));
    const compose = env.MEDIA_RENDERER.log.filter((p: any) => p.operation === "compose").at(-1);
    expect(compose.segments).toHaveLength(5);
    expect(compose.voice).toMatchObject({ start: 0, volume: 1 });
    expect(compose.synthetic).toBe(false);
    const image = (sqlite.prepare("SELECT id FROM media_assets WHERE name='Reef'").get() as any).id;
    const bad = story({ narration: { kind: "upload", assetId: image }, scenes: [scene(0, { source: "own", assetId: own })] });
    expect((await call(worker, env, "POST", "/api/videos", { spec: bad, idempotencyKey: crypto.randomUUID() }, user.cookie)).status).toBe(400);
  });
});

describe("planning and writing through the API", () => {
  const answer = (value: unknown) => ({ status: "completed", output_text: JSON.stringify(value) });

  it("describes pictures for scenes that have their words, and drafts a video from a template for Create", async () => {
    const { env, user } = await setup();
    const seen: any[] = [];
    const models: string[] = [];
    env.AI.run = async (model: string, input: any) => {
      models.push(model);
      seen.push(input);
      if (input.instructions.includes("You plan the pictures"))
        return answer({ subject: "an octopus", scenes: said.map((s, n) => ({ id: `s${n + 1}`, picture: `Picture ${n + 1} of the octopus`, keys: [s[0].split(" ")[1]] })) });
      return answer({
        topic: "Octopus hearts", caption: "Nature is weird.", hashtags: ["#ocean"], title: "Three hearts", headline: "Octopuses are strange",
        subject: "an octopus", music: "",
        scenes: said.map((s, n) => ({ text: s[0], picture: `Picture ${n + 1}`, keys: [] })),
      });
    };
    const plan = await call(worker, env, "POST", "/api/story/plan", { texts: said.map((s) => s[0]), style: "doodle" }, user.cookie);
    expect(plan.status).toBe(200);
    expect(plan.data.scenes[0]).toEqual({ description: "Picture 1 of the octopus", keys: ["have"], tone: "", place: "" });
    expect(JSON.parse(seen[0].input).scenes[0]).toEqual({ id: "s1", text: said[0][0] });
    const draft = await call(worker, env, "POST", "/api/story/draft", { template: "facts", prompt: "octopus facts", seconds: 20, voiceId: "aria", style: "doodle" }, user.cookie);
    expect(draft.status).toBe(200);
    const spec = draft.data.spec;
    expect(spec).toMatchObject({ format: "story", kind: "story", narration: { kind: "voice", voiceId: "aria" }, style: "doodle", subject: "an octopus", headline: { text: "Octopuses are strange" } });
    expect(spec.scenes).toHaveLength(5);
    expect(seen[1].instructions).toMatch(/about 20 seconds of speech, about 300 characters in all, split into exactly 4 scenes/);
    expect(JSON.parse(seen[1].input).ownerRequest).toBe("octopus facts");
    // The owner's request decides what the video is about; a whole story pasted as the topic is retold, not set aside.
    expect(seen[1].instructions).toContain(OWNER_RULE);
    // The pictures follow the text to its other times and places, never seven views of one thing in one room.
    expect(seen[1].instructions).toContain(VARIETY_RULE);
    expect(VARIETY_RULE).toContain("at least three places");
    expect(seen[1].instructions).toMatch(/retell that story in the template's tone/);
    expect(seen[1].instructions).toContain("Never repeat a topic from the recent titles, unless the owner's request asks for it.");
    const story = ["Every night, when the world falls asleep, a hidden library opens its doors.", "Inside, there are millions of books.", "A little boy wanders between the shelves."]
      .join("\n\n").repeat(12).slice(0, 2400);
    const told = await call(worker, env, "POST", "/api/story/draft", { template: "bedtime", prompt: story, seconds: 60 }, user.cookie);
    expect(told.status).toBe(200);
    const wrote = seen.filter((x) => x.instructions.startsWith("You write the script")).at(-1);
    expect(JSON.parse(wrote.input).ownerRequest).toBe(story.trim());
    // Longer than a script may be is refused, not cut.
    expect((await call(worker, env, "POST", "/api/story/draft", { template: "bedtime", prompt: "x".repeat(2401) }, user.cookie)).status).toBe(400);
    expect(new Set(models)).toEqual(new Set(["openai/gpt-6-luna"]));
    // Drafting is free: nothing was charged or made.
    expect(env.CONTENT.created).toHaveLength(0);
    // Text to video splits the owner's script and only describes its pictures; without a script there is nothing to draft.
    const own = await call(worker, env, "POST", "/api/story/draft", { template: "script", script: said.map((s) => s[0]).join(" "), style: "doodle" }, user.cookie);
    expect(own.status).toBe(200);
    expect(own.data.spec.kind).toBe("script");
    expect(own.data.spec.scenes.map((x: any) => x.description)[0]).toBe("Picture 1 of the octopus");
    expect((await call(worker, env, "POST", "/api/story/draft", { template: "script" }, user.cookie)).status).toBe(400);
  });

  it("plays the library track the owner chose in Create, whatever the writer or the mood says", async () => {
    const { env, sqlite, user } = await setup();
    const track = (name: string, tags: string, active = 1) => {
      const id = crypto.randomUUID();
      sqlite.prepare("INSERT INTO library_items(id,kind,name,tags,object_key,mime,bytes,duration,active,created_at) VALUES (?,'music',?,?,?,'audio/mpeg',1000,60,?,1)")
        .run(id, name, tags, `library/${id}/track.mp3`, active);
      return id;
    };
    const calm = track("Still water", "calm"), drums = track("Big drums", "epic"), hidden = track("Old tune", "calm", 0);
    const lists: any[] = [];
    let pick = "music1";
    env.AI.run = async (_model: string, input: any) => {
      if (input.instructions.startsWith("You choose the sound effects")) return answer({ scenes: [], newSounds: [] });
      lists.push(JSON.parse(input.input).music);
      return answer({
        topic: "Octopus hearts", caption: "Nature is weird.", hashtags: [], title: "Three hearts", headline: "", subject: "", music: pick,
        scenes: said.map((x, n) => ({ text: x[0], picture: `Picture ${n + 1}`, keys: [] })),
      });
    };
    const draft = (body: object) => call(worker, env, "POST", "/api/story/draft", { template: "facts", prompt: "octopus facts", seconds: 20, ...body }, user.cookie);
    // A mood: the writer chooses among the tracks of that mood.
    expect((await draft({ music: "calm" })).data.spec.music).toEqual({ trackId: calm, volume: 0.25 });
    expect(lists.at(-1).map((m: any) => m.name)).toEqual(["Still water"]);
    // A chosen track is the writer's only music, and plays even when the writer answers another code or the mood
    // says "No music".
    pick = "music2";
    for (const music of ["auto", "calm", "none"]) {
      const spec = (await draft({ music, musicTrackId: drums })).data.spec;
      expect(spec.music).toEqual({ trackId: drums, volume: 0.25 });
      expect(lists.at(-1).map((m: any) => m.name)).toEqual(["Big drums"]);
    }
    // Only an active library track.
    for (const musicTrackId of [hidden, crypto.randomUUID()]) expect((await draft({ musicTrackId })).data.error).toMatch(/no longer in the library/);
    expect((await draft({ musicTrackId: "drums" })).status).toBe(400);
  });

  it("drafts with sound effects from the library, saves only real ones, and renders them for free", async () => {
    const { env, sqlite, user, spec: base, used, run } = await setup();
    providers();
    const sound = (name: string, category: string, active = 1, kind = "sfx") => {
      const id = crypto.randomUUID();
      sqlite.prepare("INSERT INTO library_items(id,kind,name,category,tags,object_key,mime,bytes,duration,ai,active,created_at) VALUES (?,?,?,?,'',?,'audio/mpeg',1000,1.5,1,?,1)")
        .run(id, kind, name, category, `library/${id}/file.mp3`, active);
      return id;
    };
    const whoosh = sound("Airy whoosh", "Transition"), fire = sound("Crackling fire", "Fire"), off = sound("Old thunder", "Weather", 0), track = sound("Calm piano", "Piano", 1, "music");
    const inputs: any[] = [];
    const choosing = (input: any) => input.instructions.startsWith("You choose the sound effects");
    env.AI.run = async (_model: string, input: any) => {
      inputs.push(input);
      if (choosing(input)) return answer({ scenes: [{ id: "s3", sound: "sound1" }], newSounds: [] });
      return answer({
        topic: "Octopus hearts", caption: "Nature is weird.", hashtags: [], title: "Three hearts", headline: "", subject: "", music: "",
        scenes: said.map((x, n) => ({ text: x[0], picture: `Picture ${n + 1}`, keys: [] })),
      });
    };
    const draft = (body: object) => call(worker, env, "POST", "/api/story/draft", { template: "facts", prompt: "octopus facts", seconds: 20, ...body }, user.cookie);
    // Once the scenes are written, their sounds are chosen from the scene sounds (not the whooshes, not switched-off
    // ones), by the sound rule (sounds the library lacks may be made: ElevenLabs is set up); a whoosh is picked.
    const spec = (await draft({})).data.spec;
    expect(choosing(inputs.at(-2))).toBe(false);
    expect(JSON.parse(inputs.at(-2).input).sounds).toBeUndefined();
    const chose = JSON.parse(inputs.at(-1).input);
    expect(chose.sounds).toEqual([{ code: "sound1", name: "Crackling fire", category: "Fire", tags: "" }]);
    expect(chose.scenes[2]).toEqual({ id: "s3", text: said[2][0], picture: "Picture 3" });
    expect(inputs.at(-1).instructions).toMatch(/sound: a soundN from the sound list.*newSounds: only when a scene clearly needs a sound/);
    expect(spec.sounds).toEqual({ enabled: true, volume: SOUND_VOLUME, transitionId: whoosh });
    expect(spec.scenes.map((x: any) => x.soundId ?? null)).toEqual([null, null, fire, null, null]);
    // Switched off in Create: none, and no sounds are chosen.
    const quiet = (await draft({ sounds: false })).data.spec;
    expect(quiet.sounds).toBeUndefined();
    expect(choosing(inputs.at(-1))).toBe(false);
    // Saving: sound effects (while on) are active library sound effects.
    const save = (sounds: object, soundId?: string) => call(worker, env, "POST", "/api/videos", {
      spec: { ...base, sounds, scenes: base.scenes.map((x, n) => (n === 1 && soundId ? { ...x, soundId } : x)) }, idempotencyKey: crypto.randomUUID(),
    }, user.cookie);
    expect((await save({ enabled: true, transitionId: track })).data.error).toMatch(/library sound effect/);
    expect((await save({ enabled: true }, off)).data.error).toMatch(/no longer in the library/);
    // Switched off, a sound that has gone since doesn't stand in the way.
    expect((await save({ enabled: false }, off)).status).toBe(201);
    const created = await save({ enabled: true, volume: 0.4, transitionId: whoosh }, fire);
    expect(created.status).toBe(201);
    const price = used();
    env.CONTENT.created.splice(0, env.CONTENT.created.length - 1);
    await run();
    const composes = () => env.MEDIA_RENDERER.log.filter((p: any) => p.operation === "compose");
    const first = composes().at(-1);
    // A whoosh before each of the 4 scene changes and the fire from scene 2, each file one input.
    expect(first.sounds).toHaveLength(5);
    expect(new Set(first.sounds.map((x: any) => x.input)).size).toBe(2);
    expect(first.sounds.every((x: any) => x.volume === 0.4)).toBe(true);
    // Removing the scene's sound and changing the volume renders again, for free.
    let post = (await call(worker, env, "GET", `/api/videos/${created.data.id}`, undefined, user.cookie)).data.video;
    expect(post.renderStatus).toBe("ready");
    const edited = { ...post.spec, sounds: { ...post.spec.sounds, volume: 0.8 }, scenes: post.spec.scenes.map((x: any) => ({ ...x, soundId: undefined })) };
    const r = await call(worker, env, "PUT", `/api/videos/${post.id}`, { spec: edited, idempotencyKey: crypto.randomUUID() }, user.cookie);
    expect(r.data).toMatchObject({ rendering: true, credits: 0 });
    await run();
    post = (await call(worker, env, "GET", `/api/videos/${post.id}`, undefined, user.cookie)).data.video;
    expect(post.renderStatus).toBe("ready");
    expect(composes().at(-1).sounds.map((x: any) => x.volume)).toEqual([0.8, 0.8, 0.8, 0.8]);
    expect(used()).toBe(price);
    // A renderer from before sound effects finishes without mixing them: the video isn't kept, the run fails and is
    // refunded, with a message to try again (the old render stays).
    env.MEDIA_RENDERER.outdated = true;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const stale = await call(worker, env, "PUT", `/api/videos/${post.id}`, { spec: { ...post.spec, sounds: { ...post.spec.sounds, volume: 0.5 } }, idempotencyKey: crypto.randomUUID() }, user.cookie);
    expect(stale.data.rendering).toBe(true);
    await run();
    post = (await call(worker, env, "GET", `/api/videos/${post.id}`, undefined, user.cookie)).data.video;
    expect(post.renderStatus).toBe("failed");
    expect(post.renderError).toMatch(/sound effects couldn't be mixed in/);
    expect(used()).toBe(price);
    // Videos without sound effects don't depend on it.
    const quietVideo = await call(worker, env, "POST", "/api/videos", { spec: { ...base }, idempotencyKey: crypto.randomUUID() }, user.cookie);
    expect(quietVideo.status).toBe(201);
    env.CONTENT.created.splice(0, env.CONTENT.created.length - 1);
    await run();
    expect((await call(worker, env, "GET", `/api/videos/${quietVideo.data.id}`, undefined, user.cookie)).data.video.renderStatus).toBe("ready");
  });

  it("chooses sound effects for a made video's scenes: a whoosh and the writer's picks, free", async () => {
    const { env, sqlite, user } = await setup();
    const sound = (name: string, category: string) => {
      const id = crypto.randomUUID();
      sqlite.prepare("INSERT INTO library_items(id,kind,name,category,tags,object_key,mime,bytes,duration,ai,active,created_at) VALUES (?,'sfx',?,?,'',?,'audio/mpeg',1000,1.5,1,1,1)")
        .run(id, name, category, `library/${id}/file.mp3`);
      return id;
    };
    const choose = (scenes: object[]) => call(worker, env, "POST", "/api/story/sounds", { scenes }, user.cookie);
    const scenes = [
      { text: "The crowd roared.", picture: "A packed arena" }, { text: "Then silence.", picture: "An empty seat" },
      { text: "A fire started.", picture: "Flames in a hall" }, { text: "It spread.", picture: "Smoke" },
    ];
    // An empty library and no sounds made (switched off): nothing to choose, and the model isn't asked.
    let asked = 0;
    env.AI.run = async () => { asked++; return answer({ scenes: [], newSounds: [] }); };
    env.SOUND_AUTO_DAILY = "0";
    expect((await choose(scenes)).data).toEqual({ transitionId: null, scenes: [null, null, null, null] });
    expect(asked).toBe(0);
    delete env.SOUND_AUTO_DAILY;
    const whoosh = sound("Airy whoosh", "Transition"), crowd = sound("Crowd cheer", "Crowd"), fire = sound("Crackling fire", "Fire");
    const inputs: any[] = [];
    // The writer gets the scenes and the scene sounds (no whooshes) by code; unknown codes and repeats are dropped.
    env.AI.run = async (_model: string, input: any) => {
      inputs.push(input);
      const code = (name: string) => JSON.parse(input.input).sounds.find((x: any) => x.name === name)?.code;
      return answer({ scenes: [{ id: "s1", sound: code("Crowd cheer") }, { id: "s2", sound: code("Crowd cheer") }, { id: "s3", sound: code("Crackling fire") }, { id: "s4", sound: "sound9" }], newSounds: [] });
    };
    const r = await choose(scenes);
    expect(r.status).toBe(200);
    expect(r.data).toEqual({ transitionId: whoosh, scenes: [crowd, null, fire, null] });
    const sent = JSON.parse(inputs[0].input);
    expect(sent.scenes[0]).toEqual({ id: "s1", text: "The crowd roared.", picture: "A packed arena" });
    expect(sent.sounds.map((x: any) => x.name).sort()).toEqual(["Crackling fire", "Crowd cheer"]);
    expect(inputs[0].instructions).toMatch(/sound: a soundN from the sound list/);
    // Without an answer from the model: the whoosh alone.
    vi.spyOn(console, "error").mockImplementation(() => {});
    env.AI.run = async () => { throw new Error("down"); };
    expect((await choose(scenes)).data).toEqual({ transitionId: whoosh, scenes: [null, null, null, null] });
    // Scenes as the editor has them, signed in only.
    expect((await choose([])).status).toBe(400);
    expect((await call(worker, env, "POST", "/api/story/sounds", { scenes }, "")).status).toBe(401);
  });
});
