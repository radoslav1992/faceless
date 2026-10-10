import type { CaptionWord } from "./captions";

// Speech in uploaded videos and tracks: transcribed once by ElevenLabs Scribe (server/speech.ts) and kept with word
// timings in the file's `meta`, so an owner's own voiceover times its scenes and subtitles. Files up to 10 minutes
// are transcribed for free after the upload is checked.

/** Longest file whose speech is transcribed (automatically after the upload, or "Find speech"), and longest upload. */
export const SPEECH_MAX_SECONDS = 600;
/** Words kept per file: ten minutes of very fast speech. */
export const TRANSCRIPT_MAX_WORDS = 4000;
/** "pending": being transcribed; "found": words were heard; "none": no speech; "failed": could not be checked. */
export type SpeechStatus = "pending" | "found" | "none" | "failed";
export type Transcript = { language: string; words: CaptionWord[] };
