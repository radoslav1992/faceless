import { z } from "zod";

// Narration voices. Administrators choose and describe them in Admin → Voices (server/voices.ts, table `voices`); the
// app reads the offered ones from /api/public/voices. Public IDs only: the speech provider's voice stays on the server.

/** A voice as people see it; `preview` is a short sample to play, when ElevenLabs had one. */
export type Voice = {
  id: string; name: string; description: string; gender: "female" | "male" | "neutral" | ""; accent: string; age: string;
  preview: string | null; default: boolean;
};
/** A voice's public ID: lowercase letters, digits and dashes. It never changes once videos and series use it. */
export const VOICE_ID = /^[a-z0-9][a-z0-9-]{1,39}$/;
export const voiceIdSchema = z.string().regex(VOICE_ID, "Choose a voice.");
/** The voice used when none is given and the administrators' default can't be read. */
export const FALLBACK_VOICE = "george";
/** "George — Warm storyteller (British)" */
export const voiceLabel = (v: Pick<Voice, "name" | "description" | "accent">) =>
  `${v.name}${v.description ? ` — ${v.description}` : ""}${v.accent ? ` (${v.accent})` : ""}`;
