import { z } from "zod";

// Narration voices. Administrators choose and describe them in Admin → Voices (server/voices.ts, table `voices`); the
// app reads the offered ones from /api/public/voices. Public IDs only: the speech provider's voice stays on the server.

/** A voice as people see it; `preview` is a short sample to play (made in Admin → Voices, or ElevenLabs' own). */
export type Voice = {
  id: string; name: string; description: string; gender: "female" | "male" | "neutral" | ""; accent: string; age: string;
  preview: string | null; default: boolean;
  /** The person's own cloned voice (shown to them alone). */
  own?: boolean;
};
/** A voice's public ID: lowercase letters, digits and dashes. It never changes once videos and series use it. */
export const VOICE_ID = /^[a-z0-9][a-z0-9-]{1,39}$/;
export const voiceIdSchema = z.string().regex(VOICE_ID, "Choose a voice.");
/** The voice used when none is given and the administrators' default can't be read. */
export const FALLBACK_VOICE = "george";
/** "George — Warm storyteller (British)" */
export const voiceLabel = (v: Pick<Voice, "name" | "description" | "accent">) =>
  `${v.name}${v.description ? ` — ${v.description}` : ""}${v.accent ? ` (${v.accent})` : ""}`;
/** The longest text of a voice sample (Admin → Voices, "Make a sample"). */
export const SAMPLE_MAX_CHARS = 400;
/** What a voice's sample says unless an administrator writes something else: about ten seconds of a story. */
export const sampleText = (name: string) =>
  `Hi, I'm ${name}. It started as an ordinary night. Then the lights went out, and somewhere downstairs, a door slowly opened. This is how your next story could sound.`;

// Cloned voices (server/voice-clones.ts): a person's own voice, made from a sample they upload and offered to them alone.

/** A cloned voice's public ID: never one an administrator's voice can have (server/voices.ts refuses it). */
export const CLONE_ID = /^clone-[0-9a-f]{12}$/;
export const isCloneId = (id: string) => CLONE_ID.test(id);
/** The sample a voice is cloned from: one recording of clear speech, this long and at most this large. */
export const CLONE_SAMPLE = { minSeconds: 30, maxSeconds: 300, maxBytes: 10 * 1024 * 1024 } as const;
export const CLONE_NAME_MAX = 40;
/**
 * What the owner states before a voice is cloned. The version is stored with the statement's time (voice_consents):
 * change it whenever the text changes.
 */
export const CLONE_CONSENT_VERSION = "2026-11-10";
export const CLONE_CONSENT_TEXT =
  "This is my own voice, or I have the speaker's permission to clone it and use it in my videos. I won't use it to impersonate or mislead anyone.";
/** What a new clone's sample says. */
export const cloneSampleText = "This is how your videos will sound in this voice. It started as an ordinary night. Then the lights went out, and somewhere downstairs, a door slowly opened.";
