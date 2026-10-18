import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { App } from "../types";
import { now, uid } from "../types";
import { accountVoices, importVoice, voiceUsage, voiceView, type VoiceRow } from "../voices";
import { speakSample } from "../providers/elevenlabs";
import { ProviderError } from "../providers/http";
import { SAMPLE_MAX_CHARS, sampleText } from "../../shared/voices";

// Admin → Voices: the narration voices people can choose (server/voices.ts). Import from the ElevenLabs account, then
// rename, describe, order, hide or make the default; make each one's sample (what people play before choosing it); a
// voice no video or series uses can be deleted.
export const adminVoices = new Hono<App>();

adminVoices.get("/", async (c) => {
  const rows = (await c.env.DB.prepare("SELECT * FROM voices ORDER BY active DESC, sort, name").all<VoiceRow>()).results;
  const usage = await voiceUsage(c.env);
  return c.json({
    voices: rows.map((r) => ({ ...voiceView(r), providerId: r.provider_id, active: !!r.active, sort: r.sort, usage: usage.get(r.id) ?? { series: 0, videos: 0 } })),
  });
});
/** The voices of the ElevenLabs account, to pick one to import. */
adminVoices.get("/elevenlabs", async (c) => {
  const q = z.object({ search: z.string().max(100).default("") }).parse(c.req.query());
  return c.json({ voices: await accountVoices(c.env, q.search) });
});
adminVoices.post("/", async (c) => {
  const d = z.object({ providerId: z.string().trim().min(1).max(60), id: z.string().trim().max(40).optional() }).parse(await c.req.json());
  return c.json({ voice: await importVoice(c.env, d.providerId, d.id || undefined) }, 201);
});
const changes = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  description: z.string().trim().max(120).optional(),
  gender: z.enum(["female", "male", "neutral", ""]).optional(),
  accent: z.string().trim().max(40).optional(),
  age: z.string().trim().max(30).optional(),
  sort: z.number().int().min(0).max(100000).optional(),
  active: z.boolean().optional(),
  /** Only `true`: another voice becomes the default by being made the default. */
  default: z.literal(true).optional(),
  /** Another ElevenLabs voice behind the same public ID (for one ElevenLabs removed); videos keep their recordings. */
  providerId: z.string().trim().regex(/^[A-Za-z0-9]{10,40}$/, "Paste an ElevenLabs voice ID (letters and digits).").optional(),
});
adminVoices.patch("/:id", async (c) => {
  const d = changes.parse(await c.req.json());
  const v = await c.env.DB.prepare("SELECT * FROM voices WHERE id=?").bind(c.req.param("id")).first<VoiceRow>();
  if (!v) throw new HTTPException(404, { message: "Voice not found." });
  if (d.active === false && (v.is_default || d.default)) throw new HTTPException(409, { message: "This is the default voice. Make another voice the default first." });
  if (d.providerId && d.providerId !== v.provider_id && await c.env.DB.prepare("SELECT 1 FROM voices WHERE provider_id=?").bind(d.providerId).first())
    throw new HTTPException(409, { message: "Another voice already uses this ElevenLabs voice." });
  const update = c.env.DB.prepare(
    "UPDATE voices SET name=?,description=?,gender=?,accent=?,age=?,sort=?,active=?,provider_id=?,is_default=?,updated_at=? WHERE id=?",
  ).bind(
    d.name ?? v.name, d.description ?? v.description, d.gender ?? v.gender, d.accent ?? v.accent, d.age ?? v.age, d.sort ?? v.sort,
    d.default ? 1 : d.active === undefined ? v.active : d.active ? 1 : 0, d.providerId ?? v.provider_id, d.default ? 1 : v.is_default, now(), v.id,
  );
  // The default voice is always offered; making one the default takes it from the other.
  await c.env.DB.batch(d.default ? [c.env.DB.prepare("UPDATE voices SET is_default=0,updated_at=? WHERE is_default=1 AND id<>?").bind(now(), v.id), update] : [update]);
  return c.json({ voice: voiceView((await c.env.DB.prepare("SELECT * FROM voices WHERE id=?").bind(v.id).first<VoiceRow>())!) });
});
const sampleFailures: Record<string, string> = {
  VOICE_UNAVAILABLE: "ElevenLabs refused: check ELEVENLABS_API_KEY and the account's credits.",
  VOICE_BUSY: "ElevenLabs is busy. Try again in a minute.",
};
/**
 * Makes a voice's sample with ElevenLabs in place of the one it had: `text`, else the standard text (sampleText). It
 * is spoken by the narration's model, so it sounds as the videos will; ElevenLabs bills its characters.
 */
adminVoices.post("/:id/sample", async (c) => {
  const d = z.object({ text: z.string().trim().min(1).max(SAMPLE_MAX_CHARS).optional() }).parse(await c.req.json().catch(() => ({})));
  const v = await c.env.DB.prepare("SELECT * FROM voices WHERE id=?").bind(c.req.param("id")).first<VoiceRow>();
  if (!v) throw new HTTPException(404, { message: "Voice not found." });
  if (!c.env.ELEVENLABS_API_KEY?.trim()) throw new HTTPException(503, { message: "Set ELEVENLABS_API_KEY first: samples are made with your ElevenLabs account." });
  let audio: Uint8Array;
  try {
    audio = await speakSample(c.env, v.provider_id, d.text || sampleText(v.name));
  } catch (e) {
    const code = e instanceof ProviderError ? e.code : "";
    throw new HTTPException(502, { message: sampleFailures[code] || "ElevenLabs couldn't make this sample. Try again, or change the text." });
  }
  // A key of its own: its address changes, and a sample made at the same moment never deletes this one.
  const key = `voices/${v.id}/sample-${uid().slice(0, 8)}.mp3`;
  await c.env.MEDIA.put(key, audio, { httpMetadata: { contentType: "audio/mpeg" } });
  const saved = await c.env.DB.prepare("UPDATE voices SET preview_key=?,updated_at=? WHERE id=? AND preview_key IS ?").bind(key, now(), v.id, v.preview_key).run();
  if (!saved.meta.changes) {
    await c.env.MEDIA.delete(key);
    throw new HTTPException(409, { message: "Another sample of this voice was just made. Reload to hear it." });
  }
  if (v.preview_key) await c.env.MEDIA.delete(v.preview_key);
  return c.json({ voice: voiceView((await c.env.DB.prepare("SELECT * FROM voices WHERE id=?").bind(v.id).first<VoiceRow>())!) });
});
adminVoices.delete("/:id", async (c) => {
  const v = await c.env.DB.prepare("SELECT * FROM voices WHERE id=?").bind(c.req.param("id")).first<VoiceRow>();
  if (!v) throw new HTTPException(404, { message: "Voice not found." });
  if (v.is_default) throw new HTTPException(409, { message: "This is the default voice. Make another voice the default first." });
  const used = (await voiceUsage(c.env)).get(v.id);
  if (used && (used.series || used.videos))
    throw new HTTPException(409, { message: `${used.series} series and ${used.videos} videos use this voice. Hide it instead: they keep it, and nobody new can choose it.` });
  await c.env.DB.prepare("DELETE FROM voices WHERE id=?").bind(v.id).run();
  if (v.preview_key) await c.env.MEDIA.delete(v.preview_key);
  return c.json({ ok: true });
});
