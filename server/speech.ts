import { z } from "zod";
import type { Env } from "./types";
import { DAY, now } from "./types";
import { json } from "./db";
import { take } from "./security";
import { failureCode, providerFetch, ProviderError } from "./providers/http";
import {
  LONG_VIDEO_SECONDS, SPEECH_MAX_SECONDS, TRANSCRIPT_MAX_EVENTS, TRANSCRIPT_MAX_TURNS, TRANSCRIPT_MAX_WORDS, type SoundEvent, type SpeechStatus, type Transcript, type Turn,
} from "../shared/speech";
import type { CaptionWord } from "../shared/captions";

// Speech in uploaded videos and tracks: an owner's own voiceover is timed by its words for subtitles and scenes.
// ElevenLabs Scribe v2 (the pipeline rech-bg runs in production) gets the file uploaded from storage (streamed, never
// held in memory, so nothing depends on ElevenLabs reaching this site) and returns word timings in the language it
// detects. The words are kept in the file's meta
// (bounded); failures only mean "no subtitles", never a failed upload. Files up to 10 minutes are transcribed for
// free, bounded per person and day (files and minutes); longer videos (for clips) on request, for credits (a run of
// kind "speech").

export const SCRIBE_MODEL = "scribe_v2";
export const SCRIBE_URL = "https://api.elevenlabs.io/v1/speech-to-text";
/** Free transcriptions per person and day (automatic ones after uploads and "Find speech" together): files… */
export const SPEECH_FILES_PER_DAY = 20;
/** …and minutes of sound (Scribe costs about $0.40 an hour). */
export const SPEECH_MINUTES_PER_DAY = 30;
/** How long a transcription may stay pending; a run never lives longer (maintenance fails it). */
const LISTEN_SECONDS = 3 * 3600;
/** A transcription that has not finished by then is reported as failed (it can be tried again). */
const PENDING_SECONDS = 3600;

// The Scribe answer (ElevenLabs speech-to-text, as in @elevenlabs/elevenlabs-js SpeechToTextChunkResponseModel):
// language_code (ISO 639-3, e.g. "eng"), text, and words [{ text, start, end, type: word|spacing|audio_event,
// speaker_id }] — speaker_id ("speaker_0"…) with diarization on.
const scribeOutput = z.object({
  language_code: z.string().optional(),
  words: z.array(z.object({ text: z.unknown(), start: z.unknown(), end: z.unknown(), type: z.unknown(), speaker_id: z.unknown() }).partial()).optional(),
});
const round = (n: number) => Math.round(n * 100) / 100;
/** A word's speaker turn ends when another speaker talks, or after a pause this long. */
const TURN_GAP = 1.5;
/**
 * The words of a Scribe answer, as rech-bg keeps them: only real words with times, never before the previous word's
 * end (times only go forward), cut to the file's length, without brackets or control characters. With diarization,
 * who spoke when (`turns`, speakers numbered in the order they first spoke); the sounds Scribe tagged that are not
 * speech (`events`: laughter, applause…).
 */
export function scribeWords(result: unknown, duration: number): Transcript {
  const r = scribeOutput.safeParse(result);
  if (!r.success) return { language: "", words: [] };
  const limit = duration > 0 ? duration : Infinity, words: CaptionWord[] = [], turns: Turn[] = [], events: SoundEvent[] = [];
  const speakers = new Map<string, number>();
  let end = 0;
  for (const w of r.data.words || []) {
    if (typeof w.text !== "string" || typeof w.start !== "number" || typeof w.end !== "number" || !Number.isFinite(w.start) || !Number.isFinite(w.end)) continue;
    if (w.type === "audio_event") {
      const text = w.text.toLowerCase().replace(/[^\p{L} ]/gu, "").replace(/\s+/g, " ").trim().slice(0, 40);
      const start = round(Math.max(0, w.start)), finish = round(Math.min(limit, w.end));
      if (text && finish > start && events.length < TRANSCRIPT_MAX_EVENTS) events.push({ text, start, end: finish });
      continue;
    }
    if (w.type !== "word" || words.length >= TRANSCRIPT_MAX_WORDS) continue;
    const start = round(Math.max(end, 0, w.start)), finish = round(Math.min(limit, w.end));
    end = finish;
    // eslint-disable-next-line no-control-regex -- control characters never belong in a caption
    const text = w.text.replace(/[[\]<>\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, 80);
    if (!text || finish <= start) continue;
    words.push({ text, start, end: finish });
    if (typeof w.speaker_id !== "string" || !w.speaker_id) continue;
    if (!speakers.has(w.speaker_id) && speakers.size < 64) speakers.set(w.speaker_id, speakers.size);
    const speaker = speakers.get(w.speaker_id);
    if (speaker === undefined) continue;
    const last = turns.at(-1);
    if (last && last[2] === speaker && start - last[1] <= TURN_GAP) last[1] = finish;
    else if (turns.length < TRANSCRIPT_MAX_TURNS) turns.push([start, finish, speaker]);
  }
  const language = (r.data.language_code || "").toLowerCase().replace(/[^a-z-]/g, "").slice(0, 12);
  return { language, words, ...(turns.length && { turns }), ...(events.length && { events }) };
}

/** A stored file to transcribe: its bytes as a stream, their exact count, its type and a file name. */
export type SpeechFile = { body: ReadableStream<Uint8Array>; size: number; type: string; name: string };
/**
 * A multipart/form-data body of `fields` and then `file`, streamed (a two-hour video is never held in memory), with its
 * exact length: workerd's FixedLengthStream sends it as Content-Length; elsewhere (tests) a plain pass-through.
 */
export function multipart(fields: Record<string, string>, file: SpeechFile) {
  const boundary = `hookstreak-${crypto.randomUUID()}`;
  const safe = (s: string) => s.replace(/["\\\r\n]/g, "_");
  const encode = (s: string) => new TextEncoder().encode(s);
  const head = encode(Object.entries(fields).map(([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`).join("")
    + `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safe(file.name)}"\r\nContent-Type: ${safe(file.type)}\r\n\r\n`);
  const tail = encode(`\r\n--${boundary}--\r\n`);
  const length = head.length + file.size + tail.length;
  const { readable, writable } = typeof FixedLengthStream === "function" ? new FixedLengthStream(length) : new TransformStream<Uint8Array, Uint8Array>();
  void (async () => {
    const writer = writable.getWriter();
    try {
      await writer.write(head);
      const reader = file.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await writer.write(value);
      }
      await writer.write(tail);
      await writer.close();
    } catch (error) {
      await writer.abort(error).catch(() => {});
    }
  })();
  return { body: readable as ReadableStream<Uint8Array>, type: `multipart/form-data; boundary=${boundary}`, length };
}
/**
 * Transcribes a stored file once, uploading it to Scribe: no automatic retries, each call is billed. No language is
 * given, so Scribe detects it.
 */
export async function transcribe(e: Env, file: SpeechFile, duration: number): Promise<Transcript> {
  const key = e.ELEVENLABS_API_KEY?.trim();
  if (!key) throw new ProviderError("SPEECH_UNAVAILABLE");
  const form = multipart({
    model_id: SCRIBE_MODEL, timestamps_granularity: "word",
    // Who speaks when (the crop of a clip cuts to whoever talks) and laughter or applause (a clip's virality score).
    diarize: "true", tag_audio_events: "true",
  }, file);
  // About ten minutes, and more for long videos (Scribe answers when the whole file is done).
  const r = await providerFetch(SCRIBE_URL, {
    method: "POST", headers: { "xi-api-key": key, "Content-Type": form.type }, body: form.body,
    signal: AbortSignal.timeout((10 + Math.min(duration, LONG_VIDEO_SECONDS) / 240) * 60000),
  });
  if (!r.ok) throw new ProviderError(await speechFailure(r));
  return scribeWords(await r.json(), duration);
}
/**
 * Why Scribe refused, as a code: SPEECH_PERMISSION (the API key lacks Speech to Text), SPEECH_CREDITS (the account's
 * credits or quota are used up), SPEECH_UNAVAILABLE (a bad key), SPEECH_BUSY, SPEECH_FILE (the file can't be read as
 * sound), else SPEECH_FAILED. ElevenLabs' own reason (a short status word such as "quota_exceeded", never its message)
 * is logged with the HTTP status, so a refusal can be told apart in the Worker's logs.
 */
export async function speechFailure(r: Response) {
  const body = await r.clone().json().catch(() => null) as any;
  const status = String(body?.detail?.status || body?.detail?.code || "").toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 60);
  console.warn("Scribe refused", { status: r.status, reason: status || null });
  if (status === "missing_permissions") return "SPEECH_PERMISSION";
  if (/quota|credit|balance|limit_reached|payment|subscription/.test(status)) return "SPEECH_CREDITS";
  if (r.status === 400 || r.status === 422) {
    if (/invalid_(file|audio|content)|unsupported|corrupt|too_short|no_audio/.test(status)) return "SPEECH_FILE";
  }
  return failureCode(r, "SPEECH");
}

/** What the API tells about a file's speech: its status (null: never checked) and language. */
export function speechView(a: { kind?: string; mime: string; meta: string | null }) {
  const meta = json<any>(a.meta, {});
  const s = meta.speech as { status?: SpeechStatus; at?: number; language?: string } | undefined;
  if (!s?.status) return { speech: null, speechLanguage: null };
  const status: SpeechStatus = s.status === "pending" && (s.at || 0) < now() - PENDING_SECONDS ? "failed" : s.status;
  return { speech: status, speechLanguage: status === "found" ? s.language || null : null };
}
/**
 * The stored transcript of a file, if speech was found; only what lies in [from, to] when a range is given (its words,
 * speaker turns and sound events).
 */
export function storedTranscript(meta: string | null, from = 0, to = Infinity): Transcript | null {
  const t = json<any>(meta, {}).transcript;
  if (!t || !Array.isArray(t.words) || !t.words.length) return null;
  const ranged = from > 0 || to < Infinity;
  const words = ranged ? t.words.filter((w: CaptionWord) => w.end >= from && w.start <= to) : t.words;
  const turns: Turn[] | undefined = Array.isArray(t.turns) ? (ranged ? t.turns.filter((x: Turn) => x[1] >= from && x[0] <= to) : t.turns) : undefined;
  const events: SoundEvent[] | undefined = Array.isArray(t.events) ? (ranged ? t.events.filter((x: SoundEvent) => x.end >= from && x.start <= to) : t.events) : undefined;
  return { language: String(t.language || ""), words, ...(turns && { turns }), ...(events && { events }) };
}
const ownSound = (a: { kind: string; mime: string; duration: number }, hasAudio: boolean | null | undefined) =>
  a.kind === "upload" && /^(video|audio)\//.test(a.mime) && hasAudio !== false && a.duration >= 1;
/** Whether a file's speech is transcribed for free: an own video or track with sound, up to 10 minutes. */
export function mayHaveSpeech(a: { kind: string; mime: string; duration: number }, hasAudio: boolean | null | undefined) {
  return ownSound(a, hasAudio) && a.duration <= SPEECH_MAX_SECONDS;
}
/** Whether a longer file can be transcribed on request (for credits): an own video or track with sound, up to 2 hours. */
export function mayTranscribe(a: { kind: string; mime: string; duration: number }, hasAudio: boolean | null | undefined) {
  return ownSound(a, hasAudio) && a.duration > SPEECH_MAX_SECONDS && a.duration <= LONG_VIDEO_SECONDS + 1;
}
/** Meta for a file whose speech is about to be transcribed: pending, until when it may be. */
export function listening(meta: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { ...meta, speech: { status: "pending", at: now(), ...extra }, listen: { until: now() + LISTEN_SECONDS } };
}
/**
 * Meta for a free transcription of a file `seconds` long, or null when the person's daily allowance (files or
 * minutes) is used up.
 */
export async function claimSpeech(env: Env, userId: string, meta: Record<string, unknown>, seconds: number) {
  return (await spendSpeech(env, userId, seconds)) ? listening(meta) : null;
}
/**
 * Takes one file of `seconds` from the person's free daily allowance (transcriptions and forced alignments share it);
 * false when it is used up. `giveBack` returns it when the work could not be done.
 */
export async function spendSpeech(env: Env, userId: string, seconds: number, giveBack = false) {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  if (giveBack) {
    await take(env, "speech-minutes", DAY, userId, -minutes, SPEECH_MINUTES_PER_DAY);
    await take(env, "speech-files", DAY, userId, -1, SPEECH_FILES_PER_DAY);
    return true;
  }
  if (!(await take(env, "speech-minutes", DAY, userId, minutes, SPEECH_MINUTES_PER_DAY))) return false;
  if (!(await take(env, "speech-files", DAY, userId, 1, SPEECH_FILES_PER_DAY))) {
    await take(env, "speech-minutes", DAY, userId, -minutes, SPEECH_MINUTES_PER_DAY);
    return false;
  }
  return true;
}
