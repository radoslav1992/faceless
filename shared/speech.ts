import type { CaptionWord } from "./captions";

// Speech in uploaded videos and tracks: transcribed once by ElevenLabs Scribe (server/speech.ts) and kept with word
// timings in the file's `meta`, so an owner's own voiceover times its scenes and subtitles, and a long video can be cut
// into clips (shared/highlights.ts). Files up to 10 minutes are transcribed for free after the upload is checked;
// longer videos (paid plans, up to 2 hours) on request, for credits.

/** Longest file whose speech is transcribed for free (automatically after the upload, or "Find speech"). */
export const SPEECH_MAX_SECONDS = 600;
/** Longest video at all (paid plans, for clips); its speech is transcribed on request (speechCredits). */
export const LONG_VIDEO_SECONDS = 7200;
/** Words kept per file: two hours of fast speech. */
export const TRANSCRIPT_MAX_WORDS = 30000;
/** "pending": being transcribed; "found": words were heard; "none": no speech; "failed": could not be checked. */
export type SpeechStatus = "pending" | "found" | "none" | "failed";
/** Who speaks when: [start, end, speaker] in seconds, the speaker numbered in the order they first spoke. */
export type Turn = [number, number, number];
/** A sound that is not speech, as Scribe tags it ("laughter", "applause"…), with its time. */
export type SoundEvent = { text: string; start: number; end: number };
/**
 * What was heard in a file: its language, its words with their times, and (transcriptions made since speakers are
 * told apart) who spoke when and the sounds that were not speech.
 */
export type Transcript = { language: string; words: CaptionWord[]; turns?: Turn[]; events?: SoundEvent[] };
/** Turns and events kept per file. */
export const TRANSCRIPT_MAX_TURNS = 4000, TRANSCRIPT_MAX_EVENTS = 1000;

const round = (n: number) => Math.round(n * 100) / 100;
/**
 * The words heard in [trim, trim + length) of a recording, moved so that `trim` lands on `at` of the video's clock. A
 * word belongs to the part that holds its middle (the others are dropped); its ends are cut to that part.
 */
export function clipWords(words: CaptionWord[], trim: number, length: number, at: number): CaptionWord[] {
  const end = trim + length, out: CaptionWord[] = [];
  for (const w of words) {
    const mid = (w.start + w.end) / 2;
    if (mid < trim || mid >= end) continue;
    out.push({ text: w.text, start: round(at + Math.max(w.start, trim) - trim), end: round(at + Math.min(w.end, end) - trim) });
  }
  return out;
}

/**
 * Stretches of speech in [from, to) of a recording, on its own clock, as [start, end, speaker]: its speaker turns when
 * the transcript has them (speaker 0, 1…), else its words grouped where they pause for more than 0.7 s (speaker -1:
 * unknown). The renderer cuts to whoever talks in each.
 */
export function speechTurns(t: Pick<Transcript, "words" | "turns"> | null | undefined, from: number, to: number): Turn[] {
  if (!t) return [];
  const clip = (turns: Turn[]) => turns.filter(([a, b]) => b > from && a < to).map(([a, b, s]): Turn => [round(Math.max(a, from)), round(Math.min(b, to)), s]).filter(([a, b]) => b > a);
  if (t.turns?.length) return clip(t.turns);
  const out: Turn[] = [];
  for (const w of t.words) {
    if (w.end <= from || w.start >= to) continue;
    const last = out.at(-1);
    if (last && w.start - last[1] <= 0.7) last[1] = w.end;
    else out.push([w.start, w.end, -1]);
  }
  return clip(out);
}
