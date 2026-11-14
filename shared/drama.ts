import { z } from "zod";
import { voiceIdSchema } from "./voices";

// Drama series (a test, for administrators only): a series that tells one continuing story in episodes, like the
// vertical micro-dramas people follow day by day. It is a series like any other (schedule, channels, review), with
// three things more in its settings:
//   - a cast of up to three characters, each with a name, a look and a voice of their own;
//   - a premise, which every episode's writer reads with what happened so far (each episode's summary, kept in its
//     video: `episode` in the spec), so the story goes on and each episode ends on a cliffhanger;
//   - a number of episodes: the last one ends the story, and the series then stops.
// The characters speak: a scene is said by a cast member in their own voice (the scene's `voiceId`) or by the
// narrator, the series' voice. The cast is drawn once, together, on the series' character sheet (server/characters.ts),
// so everyone looks the same in every episode. Lips do not move in time with the words: scenes are pictures (or
// clips) under the voices.

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
});
export type Drama = z.infer<typeof dramaSchema>;

/** The cast as the pictures' recurring characters, each called by name: "Mara: a tall woman in a red coat; Ilya: …". */
export const castSubject = (cast: Pick<CastMember, "name" | "look">[]) => cast.map((c) => `${c.name}: ${c.look.replace(/[.;]+$/, "")}`).join("; ").slice(0, 300);
/** The cast member a writer's `speaker` names (as written in the cast), or null for the narrator and anyone else. */
export const castMember = <T extends Pick<CastMember, "name">>(cast: T[], speaker: string | undefined): T | null =>
  cast.find((c) => c.name.toLowerCase() === (speaker || "").trim().toLowerCase()) ?? null;
/** "Ep. 3: The letter", at most a title's length. */
export const episodeTitle = (n: number, title: string) => `Ep. ${n}: ${title}`.slice(0, 100);
