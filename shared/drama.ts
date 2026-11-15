import { z } from "zod";
import { voiceIdSchema } from "./voices";
import type { CaptionWord } from "./captions";
import { CLIP_CREDITS, CLIP_SECONDS, SPEECH_CHARS_PER_SECOND } from "./credits";
import { clipFor, estimatedTimings, fingerprint, FPS, normWord, STORY_MAX_SCENES, storyScript, storyTiming, textWords, timedScript, type StoryScene, type VoiceTone } from "./story";

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
//
// Film (an option of a drama, in place of lip-sync): the episode is shot like a film. The writer writes shots, not
// scenes: one short line each, with what the camera shows while it is said (the speaker, the one who listens, or the
// thing the line is about). Every shot is one acted clip (`acted` on its scene): the video model (fal's MiniMax H3
// Max, from the shot's picture) plays the moment and says the line itself, in a voice like the speaker's (a short
// sample of that voice goes with the request), with the place's own sound. No narration is recorded: the episode's
// sound is its clips', its shots change on hard cuts where the clips do, and the subtitles are timed by listening to
// each clip (its `take`: when the line starts, how long the shot lasts, when each word is said). A clip in which the
// line was not heard is made once more. Charged as high-quality clips: two credits per shot of up to five seconds,
// for about $0.08 a second of clip.

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
  /** Shot like a film (see above): every scene is an acted clip that says its own line. Instead of lip-sync. */
  film: z.boolean().default(false),
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

// Film.

/** A shot's usual length (seconds): the writer is asked for one shot per this much of the episode. */
export const SHOT_SECONDS = 3.5;
/** The longest line of one shot (words): about six seconds of speech. */
export const SHOT_MAX_WORDS = 16;
/** How many shots an episode of `seconds` is written in. */
export const filmShots = (seconds: number) => Math.min(STORY_MAX_SCENES, Math.max(4, Math.round(seconds / SHOT_SECONDS)));
/**
 * How long a shot's clip is asked for (seconds, in halves): its line at the usual pace of speech and a moment around
 * it, from 3 up to the model's longest take.
 */
export const shotSeconds = (text: string) => Math.min(14, Math.max(3, Math.round((textWords(text).join(" ").length / SPEECH_CHARS_PER_SECOND + 1.2) * 2) / 2));
/** What an episode's shots may cost, before it is written: each a high-quality clip of up to five seconds. */
export const filmCredits = (seconds: number) => filmShots(seconds) * CLIP_CREDITS.high;
/** Whether a video is a film: every scene of it an acted shot. */
export const acted = (scenes: Pick<StoryScene, "acted">[]) => scenes.length > 0 && scenes.every((s) => !!s.acted);
/** What a shot's clip was made for: the voice, the speaker, the way it is said and the words. Another needs a new take. */
export const takeKey = (scene: Pick<StoryScene, "text" | "voiceId" | "speaker" | "tone">, narrator: string) =>
  `take:${fingerprint(`${scene.voiceId || narrator}|${scene.speaker || ""}|${scene.tone}|${textWords(scene.text).join(" ")}`)}`;

/** A written episode as a film: every scene an acted shot made from its picture, cut in hard, with the film look. */
export function shotsSpec<T extends { scenes: StoryScene[]; backdrop?: unknown; presenter?: unknown }>(spec: T): T {
  if (spec.backdrop || spec.presenter) return spec;
  return {
    ...spec, film: true as const,
    scenes: spec.scenes.map((s) => ({
      ...s, source: "clip" as const, acted: true as const, clipSeconds: clipFor(shotSeconds(s.text)), clipQuality: "high" as const, transition: "cut" as const,
      assetId: undefined, libraryId: undefined, soundId: undefined, lipSync: undefined,
    })),
  };
}

/** How a line is said, in a shot's description (the tones of shared/story.ts). */
const DELIVERY: Record<VoiceTone, string> = {
  calm: "calmly", curious: "curiously", excited: "excitedly", cheerful: "cheerfully", playful: "playfully", thoughtful: "thoughtfully", serious: "seriously",
  mysterious: "in a low, mysterious voice", nervous: "nervously", fearful: "fearfully", whispers: "in a whisper", softly: "softly", sad: "sadly",
  sarcastic: "sarcastically", surprised: "in surprise", sighs: "with a sigh", laughs: "with a small laugh", pause: "after a pause",
};
/** How the camera moves in a shot, in turn: small moves, so a face stays readable while it speaks. */
const SHOT_MOVES = ["A slow push-in", "A locked-off camera", "A gentle handheld drift", "A slow sideways tracking move", "A locked-off camera", "A slow pull-back"];
/** Whether a shot shows whoever says its line (its picture names them), so their lips are seen moving. */
export const speakerSeen = (scene: Pick<StoryScene, "description" | "speaker">) =>
  !!scene.speaker?.trim() && scene.description.toLowerCase().includes(scene.speaker.trim().toLowerCase());
/** Added to a shot's picture description: a frame of a film, with the speaker's face in view when they are in it. */
export const shotStill = (scene: Pick<StoryScene, "description" | "speaker">) =>
  ` A frame from a film: depth in the frame, motivated light, nothing posed for the camera.${speakerSeen(scene) ? ` ${scene.speaker!.trim()}'s face is clearly visible, about to speak.` : ""}`;
/**
 * What the video model is asked for shot `n`, with the shot's picture as its first frame and a sample of the
 * speaker's voice as "Audio 1": what happens, the line (said on screen by the speaker the picture shows, else off
 * screen), the camera's move, and the sound. `language`: the name of the language the line is in.
 */
export function shotPrompt(scene: Pick<StoryScene, "description" | "text" | "speaker" | "tone">, n: number, language = "") {
  const line = textWords(scene.text).join(" ").replace(/["\u201c\u201d\u00ab\u00bb]/g, "'");
  const who = scene.speaker?.trim(), seen = speakerSeen(scene), how = scene.tone ? ` ${DELIVERY[scene.tone]}` : "";
  const speech = seen ? `${who} says${how}, "${line}"` : `Off screen, ${who ? `${who}'s voice` : "a narrator's voice"} says${how}, "${line}" Nobody on screen speaks.`;
  return [
    scene.description.trim().replace(/([^.!?])$/, "$1."), speech, `${SHOT_MOVES[n % SHOT_MOVES.length]}.`,
    `Natural acting at real speed${seen ? `, ${who}'s lips moving with the words` : ""}; keep the characters, their clothes, the place and the look exactly as in the image.`,
    "No subtitles or text on screen.",
    `Sound: the voice is the voice of Audio 1, close and clear${language ? `, speaking ${language}` : ""}; the quiet ambience of the place; no music.`,
  ].join(" ").slice(0, 1500);
}

/** A take in which at least this share of the line's words was heard is kept; a worse one is made once more. */
export const TAKE_HEARD = 0.6;
const TAKE_LEAD = 0.25, TAKE_TAIL = 0.45, TAKE_MIN_SECONDS = 1.5;
const onGrid = (seconds: number) => Math.round(seconds * FPS) / FPS;
const ms = (seconds: number) => Math.round(seconds * 1000) / 1000;
/**
 * A clip as a take of its shot, from the words heard in it (`said`, on the clip's clock): how much of the line was
 * heard (`score`, 0–1), and the shot it gives. A line that was heard starts a moment before its first word (`trim`)
 * and lasts until a moment after its last one; one that was not shows the whole clip, its words spread over it.
 */
export function takeOf(text: string, said: CaptionWord[], clipSeconds: number): { score: number; trim: number; seconds: number; words: CaptionWord[] } {
  const written = textWords(text), length = Math.max(TAKE_MIN_SECONDS, clipSeconds);
  const heard: CaptionWord[] = [];
  let next = 0, wanted = 0;
  for (const w of written) {
    const target = normWord(w);
    if (!target) continue;
    wanted++;
    for (let k = next; k < Math.min(said.length, next + 8); k++) if (normWord(said[k].text) === target) { heard.push(said[k]); next = k + 1; break; }
  }
  const score = wanted ? heard.length / wanted : 1;
  const timed = (from: CaptionWord[], seconds: number) => timedScript(written, from, seconds).map((w) => ({ text: w.text, start: ms(w.start), end: ms(w.end) }));
  if (!heard.length || score < TAKE_HEARD) return { score, trim: 0, seconds: onGrid(length), words: timed([], onGrid(length)) };
  const trim = onGrid(Math.max(0, Math.min(heard[0].start - TAKE_LEAD, length - TAKE_MIN_SECONDS)));
  const seconds = onGrid(Math.min(length - trim, Math.max(TAKE_MIN_SECONDS, heard.at(-1)!.end + TAKE_TAIL - trim)));
  const shifted = said.filter((w) => w.end > trim).map((w) => ({ ...w, start: Math.max(0, w.start - trim), end: w.end - trim }));
  return { score, trim, seconds, words: timed(shifted, seconds) };
}

/** A film on its own clock: its words, where each shot starts (seconds) and how long it all is. */
export type FilmTiming = { words: CaptionWord[]; cuts: number[]; duration: number };
/**
 * The film's clock from its takes: the shots one after another, each as long as its take, with its words where they
 * are said. Null while a shot has no take for its words (it is still to be made, or made again).
 */
export function filmTiming(scenes: StoryScene[], narrator: string): FilmTiming | null {
  if (!acted(scenes)) return null;
  const words: CaptionWord[] = [], cuts: number[] = [];
  let frames = 0;
  for (const s of scenes) {
    if (!s.clipId || !s.take || s.take.key !== takeKey(s, narrator)) return null;
    const length = Math.max(15, Math.round(s.take.seconds * FPS)), at = frames / FPS, seconds = length / FPS;
    cuts.push(at);
    for (const w of timedScript(textWords(s.text), s.take.words, seconds))
      words.push({ text: w.text, start: Math.round((at + Math.min(w.start, seconds)) * 100) / 100, end: Math.round((at + Math.min(w.end, seconds)) * 100) / 100 });
    frames += length;
  }
  return { words, cuts, duration: frames / FPS };
}

/** A voice sample's length (seconds): what the video model takes as a reference for a voice. */
export const VOICE_SAMPLE_SECONDS = { min: 2.2, max: 14 } as const;
/**
 * What a voice says in its sample: the lines of the episode said in it (so the sample is in the episode's language
 * and manner), then other lines when those are few, about ten seconds in all.
 */
export function voiceSampleText(scenes: Pick<StoryScene, "text" | "voiceId">[], voiceId: string, narrator: string) {
  const own = scenes.filter((s) => (s.voiceId || narrator) === voiceId), others = scenes.filter((s) => (s.voiceId || narrator) !== voiceId);
  let text = "";
  for (const s of [...own, ...others]) {
    if (text.length >= 110) break;
    text = `${text} ${textWords(s.text).join(" ")}`.trim();
  }
  return text.length > 180 ? text.slice(0, 180).replace(/\s+\S*$/, "") : text;
}
