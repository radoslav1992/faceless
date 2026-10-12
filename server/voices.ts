import { HTTPException } from "hono/http-exception";
import type { Env } from "./types";
import { MB, now } from "./types";
import { providerFetch } from "./providers/http";
import { FALLBACK_VOICE, VOICE_ID, type Voice } from "../shared/voices";

// Narration voices (table `voices`, migrations/0003_voices.sql), chosen by administrators in Admin → Voices: imported
// from the ElevenLabs account by voice ID with ElevenLabs' own name, description, labels and sample, then renamed,
// described, ordered, hidden or made the default. Videos and series keep a voice's public ID; the ElevenLabs voice ID
// stays on the server. A hidden voice is no longer offered, but the videos and series that have it keep it.

const ELEVENLABS = "https://api.elevenlabs.io";
/** Hosts ElevenLabs serves voice samples from. */
const SAMPLE_HOSTS = ["storage.googleapis.com", "elevenlabs.io"];
const SAMPLE_MAX = 5 * MB;

export type VoiceRow = {
  id: string; provider_id: string; name: string; description: string; gender: Voice["gender"]; accent: string; age: string; preview_key: string | null;
  active: number; is_default: number; sort: number; created_at: number; updated_at: number;
};
export const voiceView = (r: VoiceRow): Voice => ({
  id: r.id, name: r.name, description: r.description, gender: r.gender, accent: r.accent, age: r.age,
  preview: r.preview_key ? `/api/public/voices/${r.id}/preview` : null, default: !!r.is_default,
});

/** The voices people can choose, in the administrators' order. */
export async function activeVoices(env: Env): Promise<Voice[]> {
  return (await env.DB.prepare("SELECT * FROM voices WHERE active=1 ORDER BY sort, name").all<VoiceRow>()).results.map(voiceView);
}
/** The ElevenLabs voice behind a public voice ID (offered or hidden: videos and series keep theirs), or null. */
export async function providerVoiceId(env: Env, id: string): Promise<string | null> {
  if (!VOICE_ID.test(id)) return null;
  return (await env.DB.prepare("SELECT provider_id FROM voices WHERE id=?").bind(id).first<{ provider_id: string }>())?.provider_id ?? null;
}
/**
 * Whether a voice may be used: one offered to everyone, or `kept`, the voice a video or series already has (a voice
 * hidden since keeps working for them).
 */
export async function voiceUsable(env: Env, id: string, kept?: string | null) {
  if (!VOICE_ID.test(id)) return false;
  const r = await env.DB.prepare("SELECT active FROM voices WHERE id=?").bind(id).first<{ active: number }>();
  return !!r && (r.active === 1 || id === kept);
}
/** The default voice: the administrators' choice, else the first offered, else George. */
export async function defaultVoice(env: Env): Promise<string> {
  const r = await env.DB.prepare("SELECT id FROM voices WHERE active=1 ORDER BY is_default DESC, sort, name LIMIT 1").first<{ id: string }>();
  return r?.id ?? FALLBACK_VOICE;
}
/** `wanted` when it is offered, else the default voice (a template's voice that was hidden since). */
export async function offeredVoice(env: Env, wanted: string) {
  return (await voiceUsable(env, wanted)) ? wanted : defaultVoice(env);
}

// ElevenLabs ----------------------------------------------------------------------------------------------------------

/** A voice of the ElevenLabs account, with what it would be imported as. */
export type ElevenVoice = {
  providerId: string; category: string; name: string; description: string; gender: Voice["gender"]; accent: string; age: string; sample: string | null;
};
const words = (s: unknown) => (typeof s === "string" ? s.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim() : "");
const capital = (s: string) => s.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
const clean = (s: unknown, max: number) => (typeof s === "string" ? s.replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, max) : ""); // eslint-disable-line no-control-regex
/**
 * What an ElevenLabs voice is imported as: its name ("George - Warm, Captivating Storyteller" becomes George, and the
 * rest its description), else its labels or description; gender, accent and age from its labels.
 */
export function elevenVoice(v: any): ElevenVoice | null {
  if (typeof v?.voice_id !== "string" || !/^[A-Za-z0-9]{10,40}$/.test(v.voice_id)) return null;
  const labels = v.labels && typeof v.labels === "object" ? v.labels : {};
  const full = clean(v.name, 120) || "Voice";
  const [head, ...rest] = full.split(/\s+[-–—|]\s+/);
  const described = clean(rest.join(" - "), 120)
    || capital(words(labels.descriptive) || words(labels.description)) + (labels.use_case ? `${labels.descriptive || labels.description ? ", " : ""}${words(labels.use_case)}` : "")
    || clean(v.description, 120);
  const gender = ["female", "male", "neutral"].includes(String(labels.gender).toLowerCase()) ? String(labels.gender).toLowerCase() as Voice["gender"] : "";
  const sample = typeof v.preview_url === "string" ? v.preview_url : null;
  return {
    providerId: v.voice_id, category: clean(v.category, 30), name: clean(head, 60) || "Voice", description: clean(described, 120),
    gender, accent: capital(words(labels.accent)).slice(0, 40), age: capital(words(labels.age)).replace(/^Middle Aged$/, "Middle-aged").slice(0, 30), sample,
  };
}
async function eleven(env: Env, path: string) {
  const key = env.ELEVENLABS_API_KEY?.trim();
  if (!key) throw new HTTPException(503, { message: "Set ELEVENLABS_API_KEY first: voices come from your ElevenLabs account." });
  let r: Response;
  try {
    r = await providerFetch(`${ELEVENLABS}${path}`, { headers: { "xi-api-key": key }, signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new HTTPException(502, { message: "ElevenLabs didn't answer. Try again in a minute." });
  }
  if (r.status === 401 || r.status === 403) throw new HTTPException(502, { message: "ElevenLabs refused the API key (it needs the Voices read permission)." });
  if (r.status === 400 || r.status === 404 || r.status === 422) throw new HTTPException(404, { message: "Your ElevenLabs account has no voice with this ID. Add it to My Voices in ElevenLabs first." });
  if (!r.ok) throw new HTTPException(502, { message: "ElevenLabs didn't answer. Try again in a minute." });
  return r.json() as Promise<any>;
}
/** The voices of the ElevenLabs account (up to 100 matching `search`), each with the public ID it was imported as. */
export async function accountVoices(env: Env, search = "") {
  const q = new URLSearchParams({ page_size: "100", ...(search.trim() && { search: search.trim().slice(0, 100) }) });
  // https://elevenlabs.io/docs/api-reference/voices/search
  const found = await eleven(env, `/v2/voices?${q}`);
  const voices = (Array.isArray(found?.voices) ? found.voices : []).map(elevenVoice).filter(Boolean) as ElevenVoice[];
  const imported = new Map(voices.length
    ? (await env.DB.prepare(`SELECT id,provider_id FROM voices WHERE provider_id IN (${voices.map(() => "?").join(",")})`).bind(...voices.map((v) => v.providerId)).all<{ id: string; provider_id: string }>())
      .results.map((r) => [r.provider_id, r.id] as const)
    : []);
  return voices.map((v) => ({ ...v, imported: imported.get(v.providerId) ?? null }));
}
/** A free public ID made of the voice's name ("george", "george-2"…). */
async function freeId(env: Env, name: string) {
  const base = (name.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "voice").padEnd(2, "0");
  for (let n = 1; n < 100; n++) {
    const id = n === 1 ? base : `${base}-${n}`;
    if (!(await env.DB.prepare("SELECT 1 FROM voices WHERE id=?").bind(id).first())) return id;
  }
  throw new HTTPException(409, { message: "Choose another ID for this voice." });
}
/** Keeps a voice's ElevenLabs sample (a short MP3) in storage, so people can play it; null when there is none. */
async function keepSample(env: Env, id: string, url: string | null) {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" || !SAMPLE_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`))) return null;
    const r = await providerFetch(u.href, { signal: AbortSignal.timeout(20_000) });
    const type = (r.headers.get("Content-Type") || "audio/mpeg").split(";")[0].toLowerCase();
    if (!r.ok || !type.startsWith("audio/")) return null;
    const bytes = new Uint8Array(await r.arrayBuffer());
    if (!bytes.length || bytes.length > SAMPLE_MAX) return null;
    const key = `voices/${id}/sample.mp3`;
    await env.MEDIA.put(key, bytes, { httpMetadata: { contentType: type } });
    return key;
  } catch {
    // A voice without a sample still speaks.
    return null;
  }
}
/**
 * Imports a voice of the ElevenLabs account with ElevenLabs' details (name, description, gender, accent, age) and its
 * sample, offered at once at the end of the list. `id` is its public ID (made of its name when not given).
 */
export async function importVoice(env: Env, providerId: string, id?: string): Promise<Voice> {
  if (!/^[A-Za-z0-9]{10,40}$/.test(providerId)) throw new HTTPException(400, { message: "Paste an ElevenLabs voice ID (letters and digits)." });
  if (await env.DB.prepare("SELECT 1 FROM voices WHERE provider_id=?").bind(providerId).first())
    throw new HTTPException(409, { message: "This ElevenLabs voice is already in the list." });
  // https://elevenlabs.io/docs/api-reference/voices/get
  const v = elevenVoice(await eleven(env, `/v1/voices/${providerId}`));
  if (!v) throw new HTTPException(502, { message: "ElevenLabs answered with something that isn't a voice." });
  if (id !== undefined) {
    if (!VOICE_ID.test(id)) throw new HTTPException(400, { message: "Use lowercase letters, digits and dashes for the ID (2 to 40 characters)." });
    if (await env.DB.prepare("SELECT 1 FROM voices WHERE id=?").bind(id).first()) throw new HTTPException(409, { message: "Another voice already has this ID." });
  }
  const publicId = id ?? (await freeId(env, v.name));
  const sample = await keepSample(env, publicId, v.sample);
  const last = await env.DB.prepare("SELECT COALESCE(MAX(sort),0) AS n FROM voices").first<{ n: number }>();
  await env.DB.prepare("INSERT INTO voices(id,provider_id,name,description,gender,accent,age,preview_key,active,is_default,sort,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,1,0,?,?,?)")
    .bind(publicId, v.providerId, v.name, v.description, v.gender, v.accent, v.age, sample, (last?.n || 0) + 10, now(), now()).run();
  return voiceView((await env.DB.prepare("SELECT * FROM voices WHERE id=?").bind(publicId).first<VoiceRow>())!);
}

/** How many series and videos use each voice (a used voice can be hidden, not deleted). */
export async function voiceUsage(env: Env) {
  const usage = new Map<string, { series: number; videos: number }>();
  const add = (rows: { voice: string | null; n: number }[], field: "series" | "videos") => {
    for (const r of rows) if (r.voice) usage.set(r.voice, { series: 0, videos: 0, ...usage.get(r.voice), [field]: r.n });
  };
  add((await env.DB.prepare("SELECT json_extract(settings,'$.voiceId') AS voice,COUNT(*) AS n FROM series GROUP BY voice").all<any>()).results, "series");
  add((await env.DB.prepare("SELECT json_extract(spec,'$.narration.voiceId') AS voice,COUNT(*) AS n FROM videos GROUP BY voice").all<any>()).results, "videos");
  return usage;
}
