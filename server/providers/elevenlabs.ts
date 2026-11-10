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
const VOICES_URL = "https://api.elevenlabs.io/v1/voices";
export const SOUND_URL = "https://api.elevenlabs.io/v1/sound-generation";
/** Lengths ElevenLabs makes sound effects of (seconds). */
export const SOUND_EFFECT_SECONDS = { min: 0.5, max: 30 } as const;
/**
 * Sound Effects models, best first. v3 is in limited access: ElevenLabs refuses it to accounts without it (a 4xx), and v2
 * makes the take instead; v3 is asked again an hour later, in case the account got it.
 */
export const SOUND_MODELS = ["eleven_text_to_sound_v3", "eleven_text_to_sound_v2"] as const;
export type SoundModel = (typeof SOUND_MODELS)[number];
const SOUND_MODEL_RETRY = 3600_000;
let bestRefusedAt = -Infinity;
/** Forgets that v3 was refused (tests). */
export const resetSoundModels = () => { bestRefusedAt = -Infinity; };
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

/** Seconds waited before asking a busy ElevenLabs again (plus up to half as much, so waiting runs spread out). */
const BUSY_WAITS = [5, 15, 30, 60];
/** ElevenLabs' language codes are ours: two letters, except Filipino ("fil": cut to two it would be Finnish). */
export const languageCode = (language: string) => (language === "fil" ? "fil" : language.slice(0, 2));

/**
 * Speaks `text` once (no automatic retries of a call that may have been billed; only a busy refusal is asked again). Returns a WAV, its length and word timings: of the
 * normalized text (numbers read out; captions of what is heard), or of the `original` text (a narrated video's scenes
 * are counted in the words as written).
 */
export async function speak(
  e: Env, voiceId: string, text: string, language = "en", timing: "normalized" | "original" = "normalized", busyWaits = BUSY_WAITS, userId?: string,
): Promise<{ audio: Uint8Array; seconds: number; words: CaptionWord[] }> {
  // `userId`: whose video it is; a cloned voice speaks only for its owner.
  const voice = await providerVoiceId(e, voiceId, userId);
  if (!e.ELEVENLABS_API_KEY?.trim() || !voice) throw new ProviderError("VOICE_UNAVAILABLE");
  // The REST call itself (not ElevenLabs' SDK: its thousands of modules made the Worker too slow to start).
  const url = `${SPEECH_URL}/${encodeURIComponent(voice)}/with-timestamps?output_format=pcm_24000`;
  const key = e.ELEVENLABS_API_KEY.trim();
  const ask = () => providerFetch(url, {
    method: "POST", headers: { "xi-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({ text, model_id: SPEECH_MODEL, language_code: languageCode(language) }), signal: AbortSignal.timeout(240000),
  }).catch((error) => { throw error instanceof ProviderError ? error : new ProviderError("VOICE_FAILED"); });
  // Too many requests at once (429) is refused before anything is spoken or billed, so it alone is asked again, a
  // little later each time: episodes of many series reach the voice in the same minute.
  let r = await ask();
  for (const seconds of busyWaits) {
    if (r.status !== 429) break;
    await r.body?.cancel();
    await new Promise((done) => setTimeout(done, (seconds + Math.random() * seconds / 2) * 1000));
    r = await ask();
  }
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
 * A sound effect made from `text` (ElevenLabs Sound Effects), `seconds` long, as an MP3, and the model that made it:
 * v3, or v2 when the account can't use v3 (a refused request makes nothing and costs nothing). Once: no automatic
 * retries of a take that failed, each take made is billed.
 */
export async function soundEffect(e: Env, text: string, seconds: number, ms = 120000): Promise<{ audio: Uint8Array; model: SoundModel }> {
  const key = e.ELEVENLABS_API_KEY?.trim();
  if (!key) throw new ProviderError("SOUND_UNAVAILABLE");
  const [best, fallback] = SOUND_MODELS;
  const ask = (model: SoundModel) => providerFetch(`${SOUND_URL}?output_format=mp3_44100_128`, {
    method: "POST", headers: { "xi-api-key": key, "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify({ text, model_id: model, duration_seconds: seconds, prompt_influence: 0.5 }), signal: AbortSignal.timeout(ms),
  }).catch((error) => { throw error instanceof ProviderError ? error : new ProviderError("SOUND_FAILED"); });
  let model: SoundModel = Date.now() - bestRefusedAt < SOUND_MODEL_RETRY ? fallback : best;
  let r = await ask(model);
  if (model === best && [400, 403, 404, 422].includes(r.status)) {
    await r.body?.cancel();
    bestRefusedAt = Date.now();
    console.warn("Sound Effects v3 refused, making the take with v2", { status: r.status });
    r = await ask(model = fallback);
  }
  if (!r.ok) {
    await r.body?.cancel();
    throw new ProviderError(r.status === 401 || r.status === 402 ? "SOUND_UNAVAILABLE" : r.status === 429 ? "SOUND_BUSY" : "SOUND_FAILED");
  }
  const audio = new Uint8Array(await r.arrayBuffer());
  if (audio.length < 500 || audio.length > 5 * 1024 * 1024 || !isMp3(audio)) throw new ProviderError("SOUND_FAILED");
  return { audio, model };
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

/** What ElevenLabs says went wrong, as its short status word ("voice_limit_reached"); never its message. */
async function refusal(r: Response) {
  const body = (await r.json().catch(() => null)) as any;
  const status = typeof body?.detail?.status === "string" ? body.detail.status : typeof body?.detail?.code === "string" ? body.detail.code : "";
  return /^[a-z0-9_]{1,60}$/.test(status) ? status : "";
}
/**
 * Clones a voice from one recording (ElevenLabs Instant Voice Cloning, POST /v1/voices/add) and returns the new
 * voice's ElevenLabs ID. Making the voice is not billed, but it takes one of the account's voice slots.
 * VOICE_UNAVAILABLE: the key, the plan (no instant cloning) or the slots; VOICE_REJECTED: ElevenLabs won't clone this
 * recording (too short or unclear, or a voice it asks the speaker to verify, which the API cannot do).
 */
export async function cloneVoice(e: Env, name: string, sample: { bytes: ArrayBuffer; mime: string; filename: string }): Promise<string> {
  const key = e.ELEVENLABS_API_KEY?.trim();
  if (!key) throw new ProviderError("VOICE_UNAVAILABLE");
  const form = new FormData();
  form.append("name", name);
  form.append("files", new Blob([sample.bytes], { type: sample.mime }), sample.filename);
  const r = await providerFetch(VOICES_URL + "/add", { method: "POST", headers: { "xi-api-key": key }, body: form, signal: AbortSignal.timeout(120000) })
    .catch((error) => { throw error instanceof ProviderError ? error : new ProviderError("VOICE_FAILED"); });
  if (!r.ok) {
    const status = await refusal(r);
    console.warn("Voice not cloned", { http: r.status, status });
    if (r.status === 429) throw new ProviderError("VOICE_BUSY");
    if ([401, 402, 403].includes(r.status) || /limit|subscription|can_not_use|permission|quota/.test(status)) throw new ProviderError("VOICE_UNAVAILABLE");
    throw new ProviderError(r.status === 400 || r.status === 422 ? "VOICE_REJECTED" : "VOICE_FAILED");
  }
  const made = (await r.json().catch(() => null)) as any;
  const id = typeof made?.voice_id === "string" && /^[A-Za-z0-9]{10,40}$/.test(made.voice_id) ? made.voice_id as string : null;
  if (!id) throw new ProviderError("VOICE_FAILED");
  if (made.requires_verification === true) {
    // A voice ElevenLabs wants its speaker to verify cannot be used through the API: it goes again.
    await deleteVoice(e, id).catch(() => {});
    throw new ProviderError("VOICE_REJECTED");
  }
  return id;
}
/** Deletes a voice of the ElevenLabs account (one already gone counts as deleted). */
export async function deleteVoice(e: Env, providerVoice: string) {
  const key = e.ELEVENLABS_API_KEY?.trim();
  if (!key || !/^[A-Za-z0-9]{10,40}$/.test(providerVoice)) throw new ProviderError("VOICE_UNAVAILABLE");
  const r = await providerFetch(`${VOICES_URL}/${providerVoice}`, { method: "DELETE", headers: { "xi-api-key": key }, signal: AbortSignal.timeout(20000) })
    .catch((error) => { throw error instanceof ProviderError ? error : new ProviderError("VOICE_FAILED"); });
  if (r.ok || r.status === 404) {
    await r.body?.cancel();
    return;
  }
  // ElevenLabs also answers 400 "voice_does_not_exist" (or "voice_not_found") for a voice that is gone.
  if ((r.status === 400 || r.status === 422) && /not_found|does_not_exist/.test(await refusal(r))) return;
  throw new ProviderError("VOICE_FAILED");
}
