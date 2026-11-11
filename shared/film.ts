import type { ClipModel, ClipQuality } from "./credits";
import type { StorySpec } from "./formats";
import { clipFor, estimatedTimings, storyScript, storyTiming, textWords } from "./story";

// Cinematic videos (a test, for administrators only): a narrated video made the way AI short films are. The same
// script, voice and consistent pictures as any story, but
//   - every scene is a short AI clip made from its picture (never a still), with a camera move of its own;
//   - scenes change on hard cuts, with no transition and no whoosh;
//   - the clips' own ambient sound plays quietly under the voice (from models that make sound);
//   - the render adds one film look over all of it: a grade, a vignette and grain (the renderer's `look`).
// It is a flag on the video (`film` in its spec), not a video type: any story style can be made this way. Its price
// is the usual one: the video by its length, plus every clip by its length and quality (shared/credits.ts).

/** How loud a clip's own sound plays under the voice (0–1). */
export const FILM_AMBIENCE = 0.22;
/** How each scene is framed, in turn: the pictures of a film vary their distance and angle. */
const SHOTS = [
  "a wide establishing shot", "a medium shot", "a close-up", "a low-angle shot", "a medium close-up", "a wide shot with deep perspective",
  "an over-the-shoulder shot", "a detail insert shot",
];
/** How the camera moves in each scene's clip, in turn: slow moves hold up best. */
const MOVES = [
  "A slow push-in", "A slow sideways tracking move", "A gentle handheld drift", "A slow pull-back", "A locked-off camera, only the subject moves",
  "A slow tilt up", "A slow pan",
];
/** Added to scene `n`'s picture description: the framing of a film still. */
export const filmStill = (n: number) => ` Composed as ${SHOTS[n % SHOTS.length]} from a film: depth in the frame, motivated light, nothing posed for the camera.`;
/** The description sent to the clip model with scene `n`'s picture: what happens, the camera's move, and the scene's sound. */
export const filmClipPrompt = (description: string, n: number) =>
  `${description.trim().replace(/([^.!?])$/, "$1.")} ${MOVES[n % MOVES.length]}. Natural, physically plausible motion at real speed; keep the characters, the look and the colours exactly as in the image. Sound: the ambience of the scene only, no speech, no voices and no music.`.slice(0, 900);

/**
 * A drafted story as a cinematic one: every AI picture becomes a clip as long as its scene needs (5 or 10 s, by the
 * script's estimated timing), of one quality and, for the administrators who may choose, one model; every scene
 * changes on a cut. A video over a background clip has no scenes to film and stays as it is.
 */
export function filmSpec(spec: StorySpec, choice: { quality?: ClipQuality; model?: ClipModel } = {}): StorySpec {
  if (spec.backdrop) return spec;
  const said = estimatedTimings(textWords(storyScript(spec.scenes)));
  const timing = storyTiming(spec.scenes, said, (said.at(-1)?.end ?? 1) + 0.5);
  return {
    ...spec, film: true,
    scenes: spec.scenes.map((s, i) => {
      const scene = { ...s, transition: "cut" as const };
      if (s.source !== "image" && s.source !== "clip") return scene;
      const on = timing.scenes[i];
      return { ...scene, source: "clip" as const, clipSeconds: clipFor(on ? on.end - on.start : 5), clipQuality: choice.quality ?? "regular", ...(choice.model && { clipModel: choice.model }) };
    }),
  };
}
