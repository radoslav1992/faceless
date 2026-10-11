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
export type Transcript = { language: string; words: CaptionWord[] };

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
