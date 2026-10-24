import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../server/index";
import { ContentGeneration } from "../server/content-workflow";
import { planRender, type PlanContext } from "../server/render-plan";
import { acceptScenePlan, acceptStory, conceptToSpec, storyShape } from "../server/story";
import { alignedWords, ALIGNMENT_URL, forcedAlignment, speak, SPEECH_MODEL } from "../server/providers/elevenlabs";
import { adminClipModels, clipModelFor, falRequest, referenceModel, referencePrompt, submitFal } from "../server/providers/fal";
import { call, signedIn, subscribe, testEnv } from "./helpers";
import { estimatedSeconds, narrationCurrent, pendingMedia, specCredits, specSchema, storySpec, type StorySpec } from "../shared/formats";
import {
  AUTO_TRANSITIONS, clipFor, estimatedTimings, mergeScenes, moveEdge, narrationKey, placeOf, splitScene, toggleKey, resolveTransition, scenePrompt, scenesFromCounts, splitScenes, storyScript, storySegments,
  storyStyleIds, storyStyles, storyTiming, textWords, timedScript, transitionInfo, transitionKinds, voicedScript, FPS, STORY_MAX_SCENES,
} from "../shared/story";
import { captionTimeline } from "../shared/caption-scene";
import { alignmentWords, keyWordIndex, styledCaptions, titleCase, type CaptionWord } from "../shared/captions";
import { CLIP_CREDITS, pictureCredits, videoCredits, voiceCredits } from "../shared/credits";

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
    expect(specCredits(spec, true, 61)).toBe(3 + CLIP_CREDITS.regular * 3);
    // An edit: the voice again, the two missing pictures (1 credit per 5), the clips.
    expect(specCredits(spec, false)).toBe(voice + pictureCredits(2) + CLIP_CREDITS.regular * 3);
    // High quality: 2 credits per 5 s instead of 1, clip by clip.
    expect([CLIP_CREDITS.regular, CLIP_CREDITS.high]).toEqual([1, 2]);
    const high = story({ ...spec, scenes: spec.scenes.map((s, i) => (i === 2 ? { ...s, clipQuality: "high" } : s)) });
    expect(specCredits(high, true, 61)).toBe(3 + CLIP_CREDITS.regular + CLIP_CREDITS.high * 2);
    expect(pendingMedia(high).filter((m) => m.kind === "clip").map((m) => [m.seconds, m.quality])).toEqual([[5, "regular"], [10, "high"]]);
    // The advertised price: a minute of speech is two credits (the finished video's padding is never charged).
    const minute = (n: number) => ({ text: `${"word ".repeat(Math.floor(n / 5))}`.trim().padEnd(n, "x") + ".", description: "A doodle" });
    const sixty = story({ scenes: [minute(447), minute(450)] });
    expect(storyScript(sixty.scenes)).toHaveLength(900);
    expect(specCredits(sixty, true)).toBe(2);
    expect(specCredits(story({ scenes: [minute(448), minute(450)] }), true)).toBe(3);
    expect(pictureCredits(5)).toBe(1);
    expect(pictureCredits(6)).toBe(2);
    // Pictures first, then the clips made from them.
    expect(pendingMedia(spec).map((m) => [m.kind, m.path.join("."), m.key, m.from, m.seconds])).toEqual([
      ["image", "scenes.0", "imageId", undefined, undefined], ["image", "scenes.1", "imageId", undefined, undefined],
      ["clip", "scenes.1", "clipId", "imageId", 5], ["clip", "scenes.2", "clipId", "imageId", 10],
    ]);
    // One subject and one style in every picture prompt.
    expect(pendingMedia(spec)[0].prompt).toBe(scenePrompt("Doodle of sentence 1", spec.subject, "doodle"));
    expect(pendingMedia(spec)[0].prompt).toContain("Recurring main character, the same in every scene: a small orange octopus with big eyes.");
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
    expect(falRequest("image", "A wave.", { model: "fal-ai/nano-banana-2" })).toMatchObject({ model: "fal-ai/nano-banana-2", body: { aspect_ratio: "9:16", resolution: "1K" } });
    expect(falRequest("image", "A wave.", { model: "fal-ai/flux/schnell" })).toMatchObject({ model: "fal-ai/flux/schnell", body: { image_size: { width: 1088, height: 1920 } } });
    expect(falRequest("image", "A wave.", { model: "someone/else" }).model).toBe("openai/gpt-image-2.5/flare/text-to-image");
    // A later picture of a video, drawn from its first: Nano Banana 2's edit endpoint, the reference for the look only.
    const drawn = falRequest("image", "A wave.", { references: [{ url: image, role: "look" }] });
    expect(drawn).toEqual({
      model: "fal-ai/nano-banana-2/edit",
      body: { prompt: expect.stringMatching(/^The reference picture shows how this video looks: .*not a copy of the reference: A wave\. No text/), image_urls: [image], num_images: 1, aspect_ratio: "9:16", resolution: "1K", output_format: "jpeg", limit_generations: true },
    });
    expect(falRequest("image", "A wave.", { references: [{ url: image, role: "look" }], referenceModel: "fal-ai/nano-banana-pro/edit" }).model).toBe("fal-ai/nano-banana-pro/edit");
    // A scene in a place already drawn: that picture first, kept for the place; the video's first one for the look.
    const place = "https://app.test/api/render-inputs/r/3?token=t";
    const both = falRequest("image", "A wave.", { references: [{ url: place, role: "place" }, { url: image, role: "elsewhere" }] }).body as any;
    expect(both.image_urls).toEqual([place, image]);
    expect(both.prompt).toMatch(/^Reference picture 1 shows the place this scene is set in: keep the place exactly the same .*Reference picture 2 shows how this video looks, in another place: .*but not its background\. Draw a new picture with its own composition, not a copy of either reference: A wave\./);
    expect(referencePrompt([{ url: place, role: "both" }])).toMatch(/^The reference picture shows the place this scene is set in and how this video looks: keep the place exactly the same .*; keep its art style/);
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
    const references = [{ url: "https://app.test/api/render-inputs/r/0?token=t", role: "look" as const }];
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
      .toMatch(/^An octopus waves\. Recurring main character, the same in every scene: a small orange octopus\. The same world in every scene: A sunlit coral reef, turquoise and coral pink\. Style: /);
    // Over the length, the script ends at the last whole scene that fits; fewer than two is no script.
    expect(acceptStory(answer, 82)!.scenes.map((x) => x.text)).toEqual(["Octopuses have three hearts and blue blood.", "Two hearts pump blood to the gills."]);
    expect(acceptStory(answer, 60)).toBeNull();
    expect(acceptStory({ scenes: "x" })).toBeNull();
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
/** ElevenLabs (speech, forced alignment) and fal; `refuseClip` makes the clip model refuse; `timings` false drops them. */
function providers({ refuseClip = false, timings = true } = {}) {
  const calls: { method: string; url: string; body?: any }[] = [];
  let n = 0;
  vi.stubGlobal("fetch", async (input: any, init: any = {}) => {
    const url = String(input?.url ?? input), method = init.method || input?.method || "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body instanceof FormData ? Object.fromEntries([...init.body.entries()].map(([k, v]) => [k, typeof v === "string" ? v : `file:${(v as File).size}`])) : undefined;
    calls.push({ method, url, body });
    if (url === ALIGNMENT_URL) return Response.json({ words: words.map((w) => ({ ...w, loss: 0.1 })), characters: [], loss: 0.1 });
    if (url.includes("api.elevenlabs.io")) return Response.json({ audio_base64: Buffer.from(new Uint8Array(DURATION * 48000)).toString("base64"), ...(timings && { alignment: alignment() }) });
    const fal = url.match(/^https:\/\/queue\.fal\.run\/(.+?)(\/requests\/.*)?$/);
    if (fal && method === "POST") {
      if (refuseClip && fal[1].includes("kling")) return Response.json({ detail: [{ type: "content_policy_violation" }] }, { status: 422 });
      const r = `r${++n}`;
      return Response.json({ request_id: r, status_url: `https://queue.fal.run/${fal[1]}/requests/${r}/status`, response_url: `https://queue.fal.run/${fal[1]}/requests/${r}` });
    }
    if (fal && url.endsWith("/status")) return Response.json({ status: "COMPLETED" });
    if (fal) return Response.json(/kling|minimax\/h3|flux-3-max/.test(fal[1]) ? { video: { url: "https://v3.fal.media/files/clip.mp4" } } : { images: [{ url: "https://v3.fal.media/files/shot.jpg" }] });
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

  it("draws a scene in a place already drawn from that place's picture, and the video's first one for its look", async () => {
    const { env, sqlite, user, spec, run } = await setup();
    const calls = providers();
    const placed = {
      ...spec,
      places: [{ label: "the reef", description: "A bright coral reef, pink corals on the left, a sandy slope" }, { label: "the cave", description: "A low rock cave, purple sponges, blue light" }],
      scenes: spec.scenes.map((s, i) => ({ ...s, place: ["the reef", "the cave", "", "", "The Cave"][i] })),
    };
    const created = await call(worker, env, "POST", "/api/videos", { spec: placed, idempotencyKey: crypto.randomUUID() }, user.cookie);
    expect(created.status).toBe(201);
    await run();
    const video = (await call(worker, env, "GET", `/api/videos/${created.data.id}`, undefined, user.cookie)).data.video;
    const state = JSON.parse((sqlite.prepare("SELECT provider FROM runs WHERE video_id=?").get(video.id) as any).provider);
    const link = (scene: number) => {
      const key = (sqlite.prepare("SELECT object_key FROM media_assets WHERE id=?").get(video.spec.scenes[scene].imageId) as any).object_key;
      return expect.stringMatching(new RegExp(`/api/render-inputs/[0-9a-f-]{36}/${state.inputs.indexOf(key)}\\?token=`));
    };
    const pictures = calls.filter((c) => c.method === "POST" && c.url.startsWith("https://queue.fal.run/") && !c.url.includes("/kling-video/"));
    // Scenes 1, 2, 3 and 5 in order: the reef from its text; the cave's first picture and a scene set nowhere in
    // particular keep the reef picture's style and characters but not its background; the cave again, from its picture.
    expect(pictures.map((c) => c.body.image_urls ?? null)).toEqual([null, [link(0)], [link(0)], [link(1), link(0)]]);
    expect(pictures[1].body.prompt).toMatch(/^The reference picture shows how this video looks, in another place: .*but not its background\./);
    expect(pictures[2].body.prompt).toMatch(/^The reference picture shows how this video looks, in another place: .*not a copy of the reference: Doodle of sentence 3\. Recurring main character, the same in every scene: a small orange octopus\. Style: /);
    expect(pictures[3].body.prompt).toMatch(/^Reference picture 1 shows the place this scene is set in: .*Reference picture 2 shows how this video looks, in another place: /);
    expect(pictures[3].body.prompt).toContain("The place, the cave, the same in every scene set there: A low rock cave, purple sponges, blue light.");
    // Scene 1 moved into the cave: a redone cave picture is drawn from it alone, the place's first and the video's first.
    const redo = { ...video.spec, scenes: video.spec.scenes.map((s: any, i: number) => (i === 0 ? { ...s, place: "the cave" } : i === 4 ? { ...s, imageId: undefined } : s)) };
    const edited = await call(worker, env, "PUT", `/api/videos/${video.id}`, { spec: redo, idempotencyKey: crypto.randomUUID() }, user.cookie);
    expect(edited.data).toMatchObject({ rendering: true, credits: pictureCredits(1) });
    await run();
    const again = calls.filter((c) => c.method === "POST" && c.url.startsWith("https://queue.fal.run/")).at(-1)!;
    expect(again.body.image_urls).toHaveLength(1);
    expect(again.body.prompt).toMatch(/^The reference picture shows the place this scene is set in and how this video looks: /);
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
    // The first picture from its text; the others drawn from it, so the scenes look alike.
    expect(submits().map((c) => c.url.split("/").slice(3).join("/"))).toEqual([
      "openai/gpt-image-2.5/flare/text-to-image", ...Array(3).fill("fal-ai/nano-banana-2/edit"), "fal-ai/kling-video/v2.5-turbo/standard/image-to-video",
    ]);
    let post = (await call(worker, env, "GET", `/api/videos/${created.data.id}`, undefined, user.cookie)).data.video;
    expect(post.renderStatus).toBe("ready");
    // The clip starts from scene 2's own picture, read through the run's capability link.
    const state = JSON.parse((sqlite.prepare("SELECT provider FROM runs WHERE video_id=?").get(post.id) as any).provider);
    const pictureKey = (sqlite.prepare("SELECT object_key FROM media_assets WHERE id=?").get(post.spec.scenes[1].imageId) as any).object_key;
    expect(submits()[4].body.image_url).toMatch(new RegExp(`/api/render-inputs/[0-9a-f-]{36}/${state.inputs.indexOf(pictureKey)}\\?token=`));
    expect(submits()[0].body.prompt).toContain("a small orange octopus");
    // Every later picture is drawn from scene 1's, read through the run's capability link, with the subject in its text.
    const firstKey = (sqlite.prepare("SELECT object_key FROM media_assets WHERE id=?").get(post.spec.scenes[0].imageId) as any).object_key;
    for (const c of submits().slice(1, 4)) {
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
    expect(submits()).toHaveLength(6);
    expect(calls.filter((c) => c.url.includes("api.elevenlabs.io"))).toHaveLength(1);
    expect(used()).toBe(price + pictureCredits(1));
    // Older pictures were cleaned up; the voice, the pictures, the clip and the latest render stay.
    const left = (sqlite.prepare("SELECT kind FROM media_assets WHERE video_id=? ORDER BY kind").all(post.id) as any[]).map((r) => r.kind);
    expect(left).toEqual(["ai_clip", "ai_image", "ai_image", "ai_image", "ai_image", "cover", "render", "voice"]);
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
});
