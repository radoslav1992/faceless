import { z } from "zod";
import type { Env } from "./types";
import { clean } from "./ai";
import { musicMoods } from "../shared/series";
import { CATEGORY_MAX, categoriesFor, type LibraryKind } from "../shared/library";

// Admin → Library, "Fill in with AI": a multimodal model (Gemini, through the Workers AI binding) looks at a picture,
// at frames of a clip or listens to part of a track and suggests its name, description, genre or category and tags.
// It judges the file alone: nothing already filled in (the name, the details) is sent. The administrator's browser
// makes the samples (a picture or frames as JPEGs, a minute of the track as a small WAV), so any format and size works
// and the request stays small. Nothing is saved: the suggestions fill the form.

export const DEFAULT_DESCRIBE_MODEL = "google/gemini-4-argon";
export type Samples = { kind: LibraryKind; duration: number; frames: Uint8Array[]; audio: Uint8Array | null };
export type Suggestion = { name: string; description: string; category: string; tags: string[] };

const answer = z.object({
  name: z.string(), description: z.string(), category: z.string(), tags: z.array(z.string()),
});
/** What each mood means, so a scary track is tagged dark (the scary styles pick dark music). */
const moodMeanings: Partial<Record<(typeof musicMoods)[number], string>> = {
  dark: "scary, horror, tense, menacing", mysterious: "eerie, curious, the unknown", epic: "big, heroic, powerful",
  inspiring: "hopeful, uplifting, emotional", calm: "gentle, relaxed, soft", upbeat: "energetic, happy, driving",
  playful: "fun, quirky, light", ambient: "atmospheric, unobtrusive background",
};
const what: Record<LibraryKind, string> = {
  music: "a background music track (you hear a part of it)",
  clip: "a short video clip (you see frames taken across it, in order)",
  image: "a picture",
  sfx: "a short sound effect (you hear all of it)",
};
function instructions(kind: LibraryKind) {
  const heard = kind === "music" || kind === "sfx";
  const tags = kind === "music"
    ? `tags: 1 to 3 moods from this list that fit (${musicMoods.filter((m) => m !== "auto" && m !== "none").join(", ")}), then up to 3 words for what is heard (lead instruments, tempo), lowercase. The moods mean: ${Object.entries(moodMeanings).map(([m, d]) => `${m} = ${d}`).join("; ")}.`
    : kind === "sfx"
      ? "tags: 3 to 6 lowercase search words for what is heard (what makes the sound, the action, how it feels)."
      : "tags: 3 to 6 lowercase search words for what is shown (subjects, setting, colours, motion).";
  return [
    `You describe ${what[kind]} in a library of background music, clips, pictures and sound effects that people choose for short vertical videos (TikTok, Reels, Shorts).`,
    "Describe only what you see or hear. Never name real people, brands, songs, artists or places you are not sure of, and never claim who made it or who owns it.",
    `The JSON input gives its length in seconds. Judge only by what you ${heard ? "hear" : "see"}.`,
    "Answer with JSON only, with these fields:",
    `name: 2 to 5 words in Title Case that say what it is${kind === "music" ? " and the feeling it gives" : ""}.`,
    `description: one or two plain sentences, at most 300 characters, of what it ${kind === "music" ? "sounds like and the feeling it gives" : kind === "sfx" ? "sounds like" : "shows"}; people search by it.`,
    `category: the ${kind === "music" ? "genre" : "category"} that fits best, exactly one of: ${categoriesFor(kind).join(", ")}.`,
    tags,
  ].join("\n");
}
/** Base64 of bytes, in chunks (spreading a large array into one call would overflow the stack). */
function base64(bytes: Uint8Array) {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}
/** The model's text: Gemini's candidates, or the Responses shape. */
function answerText(result: unknown) {
  const r = result as { candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[]; output_text?: string; response?: string } | null;
  const parts = r?.candidates?.[0]?.content?.parts?.filter((p) => !p.thought && typeof p.text === "string").map((p) => p.text) ?? [];
  return parts.join("") || r?.output_text || (typeof r?.response === "string" ? r.response : "") || "";
}
/** What the model suggested, cleaned and fitted to the library's fields; null when it had nothing usable. */
export function fitSuggestion(kind: LibraryKind, value: unknown): Suggestion | null {
  const a = answer.safeParse(value);
  if (!a.success) return null;
  const listed = categoriesFor(kind).find((c) => c.toLowerCase() === a.data.category.trim().toLowerCase()) ?? "";
  const moods: readonly string[] = musicMoods;
  const tags = [...new Set(a.data.tags.map((t) => clean(t, 30).toLowerCase().replace(/[,#]/g, "").trim()).filter(Boolean))]
    // Music moods first: the writer picks tracks by them.
    .sort((x, y) => (kind === "music" ? Number(moods.includes(y)) - Number(moods.includes(x)) : 0))
    .filter((t) => !["auto", "none"].includes(t))
    .slice(0, 6);
  const s = { name: clean(a.data.name, 120), description: clean(a.data.description, 500), category: listed.slice(0, CATEGORY_MAX), tags };
  return s.name || s.description ? s : null;
}
/** Suggestions for one library file from its samples, or null when the model failed or answered nothing usable. */
export async function describeMedia(env: Env, s: Samples): Promise<Suggestion | null> {
  const parts: object[] = [{ text: JSON.stringify({ seconds: Math.round(s.duration) }) }];
  for (const frame of s.frames) parts.push({ inlineData: { mimeType: "image/jpeg", data: base64(frame) } });
  if (s.audio) parts.push({ inlineData: { mimeType: "audio/wav", data: base64(s.audio) } });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      env.AI.run(env.DESCRIBE_MODEL?.trim() || DEFAULT_DESCRIBE_MODEL, {
        contents: [{ role: "user", parts }],
        systemInstruction: { parts: [{ text: instructions(s.kind) }] },
        // Room for the model's thinking as well as the short answer.
        generationConfig: { responseMimeType: "application/json", temperature: 0.4, maxOutputTokens: 8192 },
      }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("AI_TIMEOUT")), 90_000); }),
    ]);
    const text = answerText(result).trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, "$1");
    return fitSuggestion(s.kind, JSON.parse(text));
  } catch (e) {
    // Never log the samples or the provider's message.
    console.error("Describe model failed", { name: e instanceof Error ? e.name : "UnknownError", timeout: e instanceof Error && e.message === "AI_TIMEOUT" });
    return null;
  } finally {
    clearTimeout(timer);
  }
}
