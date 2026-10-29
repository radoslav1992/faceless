import { z } from "zod";
import type { Env } from "../types";
import { alignmentWords, type CaptionWord } from "../../shared/captions";
import { providerVoiceId } from "../voices";
import { failureCode, providerFetch, ProviderError } from "./http";

// Speech for narrated videos, with per-character timings that become word-by-word captions;
// forced alignment (rech-bg's fallback for missing timings, server/studio-speech.ts): known words timed on a
// recording, for a voice without timings and for an owner's voiceover whose exact script they gave; and sound effects
// from a description, for the shared library (Admin → Library).
export const SPEECH_MODEL = "eleven_v4";
export const ALIGNMENT_URL = "https://api.elevenlabs.io/v1/forced-alignment";
const SPEECH_URL = "https://api.elevenlabs.io/v1/text-to-speech";
export const SOUND_URL = "https://api.elevenlabs.io/v1/sound-generation";
/** Lengths ElevenLabs makes sound effects of (seconds). */
export const SOUND_EFFECT_SECONDS = { min: 0.5, max: 30 } as const;
// The text-to-speech-with-timestamps answer: the audio and the timing of each character, as written and as spoken.
const timings = z.object({ characters: z.array(z.string()), character_start_times_seconds: z.array(z.number()), character_end_times_seconds: z.array(z.number()) });
const speechAnswer = z.object({ audio_base64: z.string().min(1), alignment: timings.nullish(), normalized_alignment: timings.nullish() });

/** 16-bit mono PCM as a WAV file. */
export function wav(pcm: Uint8Array, rate: number) {
  const out = new Uint8Array(44 + pcm.length), v = new DataView(out.buffer);
  const text = (at: number, s: string) => [...s].forEach((ch, i) => (out[at + i] = ch.charCodeAt(0)));
  text(0, "RIFF"); v.setUint32(4, 36 + pcm.length, true); text(8, "WAVE"); text(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); text(36, "data"); v.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}

/**
 * Speaks `text` once (no automatic retries: each call is billed). Returns a WAV, its length and word timings: of the
 * normalized text (numbers read out; captions of what is heard), or of the `original` text (a narrated video's scenes
 * are counted in the words as written).
 */
export async function speak(e: Env, voiceId: string, text: string, language = "en", timing: "normalized" | "original" = "normalized"): Promise<{ audio: Uint8Array; seconds: number; words: CaptionWord[] }> {
  const voice = await providerVoiceId(e, voiceId);
  if (!e.ELEVENLABS_API_KEY?.trim() || !voice) throw new ProviderError("VOICE_UNAVAILABLE");
  // The REST call itself (not ElevenLabs' SDK: its thousands of modules made the Worker too slow to start).
  const url = `${SPEECH_URL}/${encodeURIComponent(voice)}/with-timestamps?output_format=pcm_24000`;
  const r = await providerFetch(url, {
    method: "POST", headers: { "xi-api-key": e.ELEVENLABS_API_KEY.trim(), "Content-Type": "application/json" },
    body: JSON.stringify({ text, model_id: SPEECH_MODEL, language_code: language.slice(0, 2) }), signal: AbortSignal.timeout(240000),
  }).catch((error) => { throw error instanceof ProviderError ? error : new ProviderError("VOICE_FAILED"); });
  if (!r.ok) {
    await r.body?.cancel();
    throw new ProviderError(r.status === 401 || r.status === 402 ? "VOICE_UNAVAILABLE" : r.status === 429 ? "VOICE_BUSY" : "VOICE_FAILED");
  }
  const result = speechAnswer.safeParse(await r.json().catch(() => null));
  if (!result.success || result.data.audio_base64.length > 20_000_000) throw new ProviderError("VOICE_FAILED");
  const { audio_base64: audioBase64, alignment: spoken, normalized_alignment: normalized } = result.data;
  const pcm = Uint8Array.from(atob(audioBase64), (c) => c.charCodeAt(0));
  if (!pcm.length || pcm.length % 2) throw new ProviderError("VOICE_FAILED");
  const chosen = timing === "original" ? spoken || normalized : normalized || spoken;
  const alignment = chosen ? { characters: chosen.characters, characterStartTimesSeconds: chosen.character_start_times_seconds, characterEndTimesSeconds: chosen.character_end_times_seconds } : undefined;
  const seconds = pcm.length / 48000;
  // The model's timings can run a little past the audio (tens of milliseconds): words never end after the voice does.
  const words = alignmentWords(alignment).map((w) => ({ ...w, start: Math.min(w.start, seconds), end: Math.min(w.end, seconds) }));
  return { audio: wav(pcm, 24000), seconds, words };
}

/**
 * A voice's sample (Admin → Voices): `text` spoken as an MP3 by the narration's model, so it sounds as the videos will.
 * Billed by ElevenLabs like any speech (a character per character).
 */
export async function speakSample(e: Env, providerVoice: string, text: string) {
  const key = e.ELEVENLABS_API_KEY?.trim();
  if (!key) throw new ProviderError("VOICE_UNAVAILABLE");
  const r = await providerFetch(`${SPEECH_URL}/${encodeURIComponent(providerVoice)}?output_format=mp3_44100_128`, {
    method: "POST", headers: { "xi-api-key": key, "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify({ text, model_id: SPEECH_MODEL }), signal: AbortSignal.timeout(60000),
  }).catch((error) => { throw error instanceof ProviderError ? error : new ProviderError("VOICE_FAILED"); });
  if (!r.ok) {
    await r.body?.cancel();
    throw new ProviderError(r.status === 401 || r.status === 402 ? "VOICE_UNAVAILABLE" : r.status === 429 ? "VOICE_BUSY" : "VOICE_FAILED");
  }
  const audio = new Uint8Array(await r.arrayBuffer());
  if (audio.length < 1000 || audio.length > 5 * 1024 * 1024 || !isMp3(audio)) throw new ProviderError("VOICE_FAILED");
  return audio;
}
/** An MP3 starts with an ID3 tag or a frame sync; anything else (an error page) is not one. */
const isMp3 = (b: Uint8Array) => (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0);

/**
 * A sound effect made from `text` (ElevenLabs Sound Effects), `seconds` long, as an MP3. Once: no automatic retries,
 * each call is billed.
 */
export async function soundEffect(e: Env, text: string, seconds: number) {
  const key = e.ELEVENLABS_API_KEY?.trim();
  if (!key) throw new ProviderError("SOUND_UNAVAILABLE");
  const r = await providerFetch(`${SOUND_URL}?output_format=mp3_44100_128`, {
    method: "POST", headers: { "xi-api-key": key, "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify({ text, duration_seconds: seconds, prompt_influence: 0.5 }), signal: AbortSignal.timeout(120000),
  }).catch((error) => { throw error instanceof ProviderError ? error : new ProviderError("SOUND_FAILED"); });
  if (!r.ok) {
    await r.body?.cancel();
    throw new ProviderError(r.status === 401 || r.status === 402 ? "SOUND_UNAVAILABLE" : r.status === 429 ? "SOUND_BUSY" : "SOUND_FAILED");
  }
  const audio = new Uint8Array(await r.arrayBuffer());
  if (audio.length < 500 || audio.length > 5 * 1024 * 1024 || !isMp3(audio)) throw new ProviderError("SOUND_FAILED");
  return audio;
}

// The forced-alignment answer (ElevenLabs ForcedAlignmentResponseModel): characters and words, each {text, start, end}.
const alignmentOutput = z.object({ words: z.array(z.object({ text: z.unknown(), start: z.unknown(), end: z.unknown() }).partial()) });
const round = (n: number) => Math.round(n * 100) / 100;
/**
 * The timed words of a forced alignment: spaces and empty tokens dropped, times only going forward, within the
 * recording, each at least 20 ms, without brackets or control characters.
 */
export function alignedWords(result: unknown, duration: number): CaptionWord[] {
  const r = alignmentOutput.safeParse(result);
  if (!r.success) return [];
  const limit = duration > 0 ? duration : Infinity, out: CaptionWord[] = [];
  let end = 0;
  for (const w of r.data.words) {
    if (typeof w.text !== "string" || typeof w.start !== "number" || typeof w.end !== "number" || !Number.isFinite(w.start) || !Number.isFinite(w.end)) continue;
    // eslint-disable-next-line no-control-regex -- control characters never belong in a caption
    const text = w.text.replace(/[[\]<>\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, 80);
    if (!text) continue;
    const start = round(Math.min(limit, Math.max(end, 0, w.start))), finish = round(Math.min(limit, Math.max(w.end, start + 0.02)));
    if (finish <= start) continue;
    out.push({ text, start, end: finish });
    end = finish;
  }
  return out;
}
/**
 * Times `text` on the recording `file` (forced alignment), once: no automatic retries, each call is billed. The words
 * come back in the order of the text.
 */
export async function forcedAlignment(e: Env, file: Blob, text: string, duration: number): Promise<CaptionWord[]> {
  const key = e.ELEVENLABS_API_KEY?.trim();
  if (!key) throw new ProviderError("ALIGN_UNAVAILABLE");
  const body = new FormData();
  body.set("file", file, "recording");
  body.set("text", text);
  const r = await providerFetch(ALIGNMENT_URL, { method: "POST", headers: { "xi-api-key": key }, body, signal: AbortSignal.timeout(120000) });
  if (!r.ok) throw new ProviderError(await failureCode(r, "ALIGN"));
  const words = alignedWords(await r.json().catch(() => null), duration);
  if (!words.length) throw new ProviderError("ALIGN_FAILED");
  return words;
}
