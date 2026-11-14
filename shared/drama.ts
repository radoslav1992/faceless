import { z } from "zod";
import { voiceIdSchema } from "./voices";
import { CLIP_CREDITS, CLIP_SECONDS } from "./credits";
import { clipFor, estimatedTimings, storyScript, storyTiming, textWords, type StoryScene } from "./story";

// Drama series (a test, for administrators only): a series that tells one continuing story in episodes, like the
// vertical micro-dramas people follow day by day. It is a series like any other (schedule, channels, review), with
// three things more in its settings:
//   - a cast of up to three characters, each with a name, a look and a voice of their own;
//   - a premise, which every episode's writer reads with what happened so far (each episode's summary, kept in its
//     video: `episode` in the spec), so the story goes on and each episode ends on a cliffhanger;
//   - a number of episodes: the last one ends the story, and the series then stops.
// The characters speak: a scene is said by a cast member in their own voice (the scene's `voiceId`) or by the
// narrator, the series' voice. The cast is drawn once, together, on the series' character sheet (server/characters.ts),
// so everyone looks the same in every episode.
//
// Lip-sync (an option of a drama): a scene a cast member says becomes a clip of its picture with the lips moving to
// that scene's words. It is made after the voice, from the picture and the scene's stretch of the recording (fal's
// MiniMax H3 Max Lip Sync, which wants at least five seconds of sound and returns a video as long as it), and plays
// silent over the one recording, in time with it. Charged as a high-quality clip of the scene's length: two credits
// per five seconds, for about $0.08 a second at 768p. Without it, scenes are pictures (or clips) under the voices.

export const DRAMA_CAST_MAX = 3;
/** Who says a scene that no cast member says. */
export const NARRATOR = "narrator";
const name = z.string().trim().min(1).max(24).regex(/^[\p{L}\p{N}][\p{L}\p{N} .'-]*$/u, "Use letters for a character's name.")
  .refine((n) => n.toLowerCase() !== NARRATOR, "A character can't be called Narrator.");
export const castMemberSchema = z.object({
  name,
  /** Who they are in the story: "a night nurse hiding a debt". */
  role: z.string().trim().max(80).default(""),
  /** What they look like, for the pictures (short: the whole cast shares one character sheet). */
  look: z.string().trim().min(3).max(70),
  voiceId: voiceIdSchema,
});
export type CastMember = z.infer<typeof castMemberSchema>;
export const dramaSchema = z.object({
  /** What the story is about: the situation, the conflict, the tone. */
  premise: z.string().trim().min(10).max(600),
  /** How many episodes the season has (the last one ends the story). */
  episodes: z.number().int().min(2).max(60).default(10),
  cast: z.array(castMemberSchema).min(1).max(DRAMA_CAST_MAX)
    .refine((cast) => new Set(cast.map((c) => c.name.toLowerCase())).size === cast.length, "Give each character their own name."),
  /** The cast's lips move with their lines (see above): every scene a cast member says is a lip-synced clip. */
  lipSync: z.boolean().default(false),
});
export type Drama = z.infer<typeof dramaSchema>;

/** The cast as the pictures' recurring characters, each called by name: "Mara: a tall woman in a red coat; Ilya: …". */
export const castSubject = (cast: Pick<CastMember, "name" | "look">[]) => cast.map((c) => `${c.name}: ${c.look.replace(/[.;]+$/, "")}`).join("; ").slice(0, 300);
/** The cast member a writer's `speaker` names (as written in the cast), or null for the narrator and anyone else. */
export const castMember = <T extends Pick<CastMember, "name">>(cast: T[], speaker: string | undefined): T | null =>
  cast.find((c) => c.name.toLowerCase() === (speaker || "").trim().toLowerCase()) ?? null;
/** "Ep. 3: The letter", at most a title's length. */
export const episodeTitle = (n: number, title: string) => `Ep. ${n}: ${title}`.slice(0, 100);

/** The shortest sound the lip-sync model takes (seconds): a shorter line is followed by silence up to it. */
export const LIP_SYNC_MIN_SECONDS = 5.1;
/** What a lip-synced clip is named by (its file's name, never sent to the model: it gets the picture and the sound). */
export const lipSyncPrompt = (speaker: string | undefined, text: string) => `Lip-sync: ${speaker || "the speaker"} says: ${text}`.slice(0, 900);
/**
 * A written episode with its cast lip-synced: every scene a cast member says (and that shows an AI picture) becomes a
 * clip as long as the scene needs (5 or 10 s by the script's estimated timing), cut in hard, so the lips start with
 * the line.
 */
export function lipSyncSpec<T extends { scenes: StoryScene[]; backdrop?: unknown }>(spec: T): T {
  if (spec.backdrop) return spec;
  const said = estimatedTimings(textWords(storyScript(spec.scenes)));
  const timing = storyTiming(spec.scenes, said, (said.at(-1)?.end ?? 1) + 0.5);
  return {
    ...spec,
    scenes: spec.scenes.map((s, i) => {
      if (!s.speaker || s.source !== "image") return s;
      const on = timing.scenes[i];
      return { ...s, source: "clip" as const, lipSync: true as const, clipSeconds: clipFor(on ? on.end - on.start : 5), clipQuality: "high" as const, transition: "cut" as const };
    }),
  };
}
/**
 * What an episode's lip-synced scenes may cost, before it is written (the cast says most of a drama): credits for
 * seven tenths of its length as high-quality clips.
 */
export const lipSyncCredits = (seconds: number) => Math.ceil((seconds * 0.7) / CLIP_SECONDS) * CLIP_CREDITS.high;
