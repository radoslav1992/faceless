import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { App, Env } from "./types";
import { DAY, now } from "./types";
import { rate } from "./security";
import { allowance } from "./billing";
import { serveObject } from "./storage";
import { cloneVoice, deleteVoice, speakSample } from "./providers/elevenlabs";
import { ProviderError } from "./providers/http";
import { planById } from "../shared/plans";
import { PRODUCT } from "../shared/brand";
import { CLONE_CONSENT_VERSION, CLONE_NAME_MAX, CLONE_SAMPLE, cloneSampleText, isCloneId, type Voice } from "../shared/voices";

// Cloned voices: a customer's own voice for their narration (table `voice_clones`, migrations/0016). They upload one
// recording of clear speech, state that the voice is theirs to use, and ElevenLabs makes a voice from it (Instant
// Voice Cloning) in the operator's account; it is offered to its owner alone, beside the voices everyone can choose,
// and speaks only in their videos (server/voices.ts providerVoiceId).
//
// Off unless the operator sets VOICE_CLONES: every clone takes one of the ElevenLabs account's voice slots, so the
// operator says how many there is room for, for all customers together. Plans say how many each customer can have
// (`voices` in shared/plans.ts; none on the free trial).
//
// A person's voice is personal data of a sensitive kind: the recording they upload stays their file (the app deletes
// it once the voice is made), the ElevenLabs voice is deleted when they delete the clone or their account (at once,
// and retried hourly until ElevenLabs confirms: `voice_removals`), and their statement is kept as evidence
// (`voice_consents`) with nothing of the voice in it.

type CloneRow = { id: string; user_id: string; provider_id: string; name: string; preview_key: string | null; created_at: number };
export const cloneView = (r: CloneRow): Voice => {
  const version = r.preview_key?.match(/-([a-f0-9]{8})\.mp3$/)?.[1];
  return {
    id: r.id, name: r.name, description: "Your cloned voice", gender: "", accent: "", age: "",
    preview: r.preview_key ? `/api/voices/${r.id}/preview${version ? `?v=${version}` : ""}` : null, default: false, own: true,
  };
};
/** How many cloned voices the ElevenLabs account has room for (0: voice cloning is off). */
const capacity = (env: Env) => {
  const n = Number(env.VOICE_CLONES);
  return Number.isInteger(n) && n > 0 && env.ELEVENLABS_API_KEY?.trim() ? n : 0;
};
const hex = (bytes: number) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim(); // eslint-disable-line no-control-regex
const ownClones = async (env: Env, userId: string) =>
  (await env.DB.prepare("SELECT * FROM voice_clones WHERE user_id=? ORDER BY created_at").bind(userId).all<CloneRow>().catch(() => ({ results: [] as CloneRow[] }))).results;
async function ownedClone(env: Env, userId: string, id: string) {
  const row = isCloneId(id) ? await env.DB.prepare("SELECT * FROM voice_clones WHERE id=? AND user_id=?").bind(id, userId).first<CloneRow>() : null;
  if (!row) throw new HTTPException(404, { message: "Voice not found." });
  return row;
}

export const voiceClones = new Hono<App>();

/** The person's cloned voices, whether they can clone one, and how many their plan has room for. */
voiceClones.get("/", async (c) => {
  const user = c.get("user");
  const enabled = capacity(c.env) > 0;
  const limit = enabled ? planById((await allowance(c.env, user)).plan).voices : 0;
  return c.json({ enabled, limit, voices: (await ownClones(c.env, user.id)).map(cloneView) });
});

const refusals: Record<string, [status: 422 | 502 | 503, message: string]> = {
  VOICE_REJECTED: [422, "This recording couldn't be cloned. Use one to three minutes of one person speaking clearly, without music or other voices."],
  VOICE_BUSY: [503, "The voice service is busy. Try again in a minute."],
  VOICE_UNAVAILABLE: [503, "Voice cloning isn't available right now. Please try again later."],
};
/**
 * Clones a voice from an uploaded recording. The statement (shared/voices.ts CLONE_CONSENT_TEXT) must be agreed to in
 * its current version; the recording is one of the person's own uploads, of speech between 30 seconds and 5 minutes.
 */
voiceClones.post("/", async (c) => {
  const user = c.get("user");
  if (!user.verified) throw new HTTPException(403, { message: "Confirm your email first. We sent you a link when you signed up." });
  // Room for a few wrong files; how many voices are made is the plan's limit, not this.
  await rate(c, "voice-clone", 20, 3600, user.id);
  const d = z.object({
    name: z.string().trim().min(1).max(CLONE_NAME_MAX),
    assetId: z.uuid(),
    consent: z.literal(true, { error: "Confirm that this voice is yours to use." }),
    version: z.literal(CLONE_CONSENT_VERSION, { error: "The statement has changed. Reload the page and confirm it again." }),
  }).parse(await c.req.json());
  const room = capacity(c.env);
  if (!room) throw new HTTPException(503, { message: "Voice cloning isn't available yet." });
  const limit = planById((await allowance(c.env, user)).plan).voices;
  if (!limit) throw new HTTPException(402, { message: "Cloning your voice is part of the paid plans. Choose a plan to add your own voice." });
  if ((await ownClones(c.env, user.id)).length >= limit)
    throw new HTTPException(409, { message: `Your plan has room for ${limit} cloned voice${limit === 1 ? "" : "s"}. Delete one first, or upgrade.` });
  // Voices waiting to be deleted at ElevenLabs still hold their slots there.
  const taken = await c.env.DB.prepare("SELECT (SELECT COUNT(*) FROM voice_clones)+(SELECT COUNT(*) FROM voice_removals) AS n").first<{ n: number }>();
  if ((taken?.n ?? 0) >= room) {
    console.error("Voice cloning is full: raise VOICE_CLONES if the ElevenLabs account has more voice slots", { taken: taken?.n, room });
    throw new HTTPException(503, { message: "Voice cloning is full right now. Please try again later." });
  }
  const name = clean(d.name);
  if (!name) throw new HTTPException(400, { message: "Give the voice a name." });
  const sample = await c.env.DB.prepare("SELECT object_key,name,mime,bytes,duration,kind,status FROM media_assets WHERE id=? AND user_id=?")
    .bind(d.assetId, user.id).first<{ object_key: string; name: string; mime: string; bytes: number; duration: number; kind: string; status: string }>();
  if (!sample || sample.kind !== "upload" || sample.status !== "ready" || !sample.mime.startsWith("audio/"))
    throw new HTTPException(400, { message: "Upload a recording of the voice (MP3, M4A or WAV)." });
  if (sample.bytes > CLONE_SAMPLE.maxBytes) throw new HTTPException(400, { message: `The recording can be up to ${CLONE_SAMPLE.maxBytes / 1024 / 1024} MB. An MP3 or M4A of a few minutes is well below that.` });
  if (!(sample.duration >= CLONE_SAMPLE.minSeconds)) throw new HTTPException(400, { message: `The recording is too short: at least ${CLONE_SAMPLE.minSeconds} seconds of speech, better one to three minutes.` });
  if (sample.duration > CLONE_SAMPLE.maxSeconds) throw new HTTPException(400, { message: `The recording is too long: at most ${CLONE_SAMPLE.maxSeconds / 60} minutes. One to three minutes of clear speech is enough.` });
  const file = await c.env.MEDIA.get(sample.object_key);
  if (!file) throw new HTTPException(404, { message: "This recording is no longer available. Upload it again." });

  let provider: string;
  try {
    // Named so the operator can tell whose it is in the ElevenLabs account (never the person's email).
    provider = await cloneVoice(c.env, `${PRODUCT.slug} ${user.id.slice(0, 8)} ${name}`.slice(0, 100), {
      bytes: await file.arrayBuffer(), mime: sample.mime, filename: (sample.name.replace(/[^\w.-]+/g, "_").slice(0, 60) || "voice"),
    });
  } catch (e) {
    const [status, message] = refusals[e instanceof ProviderError ? e.code : ""] ?? [502, "This voice couldn't be cloned. Please try again."];
    throw new HTTPException(status, { message });
  }
  const id = `clone-${hex(6)}`, t = now();
  // Saved only while the plan still has room (two requests at once can't both pass the check above), with the statement.
  const saved = await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO voice_clones(id,user_id,provider_id,name,preview_key,created_at) SELECT ?1,?2,?3,?4,NULL,?5 WHERE (SELECT COUNT(*) FROM voice_clones WHERE user_id=?2)<?6")
      .bind(id, user.id, provider, name, t, limit),
    c.env.DB.prepare("INSERT INTO voice_consents(voice_id,user_id,version,created_at) SELECT ?1,?2,?3,?4 WHERE EXISTS(SELECT 1 FROM voice_clones WHERE id=?1)")
      .bind(id, user.id, d.version, t),
  ]).then((r) => !!r[0].meta.changes).catch((error) => {
    console.error("Cloned voice not saved", { error: (error as Error)?.name });
    return false;
  });
  if (!saved) {
    // The ElevenLabs voice belongs to no clone: it goes, now or with the next hourly pass.
    await forgetProviderVoice(c.env, provider);
    throw new HTTPException(409, { message: "This voice couldn't be saved. Check how many voices your plan has room for, then try again." });
  }
  await makeSample(c.env, user.id, id, provider);
  return c.json({ voice: cloneView(await ownedClone(c.env, user.id, id)) }, 201);
});

/**
 * A short sample spoken by the new clone, so its owner hears it before using it. Best effort: a voice just made is
 * sometimes not ready for a moment (tried twice), and a clone without a sample still speaks.
 */
async function makeSample(env: Env, userId: string, id: string, provider: string) {
  for (const wait of [0, 2500]) {
    if (wait) await new Promise((done) => setTimeout(done, wait));
    try {
      const audio = await speakSample(env, provider, cloneSampleText);
      // In the owner's folder, so it goes with the account; its own key, named in its address.
      const key = `media/${userId}/voice-${id}-${hex(4)}.mp3`;
      await env.MEDIA.put(key, audio, { httpMetadata: { contentType: "audio/mpeg" } });
      const kept = await env.DB.prepare("UPDATE voice_clones SET preview_key=? WHERE id=? AND user_id=?").bind(key, id, userId).run();
      if (!kept.meta.changes) await env.MEDIA.delete(key);
      return;
    } catch (e) {
      console.warn("Cloned voice sample not made", { code: e instanceof ProviderError ? e.code : (e as Error)?.name });
    }
  }
}

/** The clone's sample, for its owner. */
voiceClones.get("/:id/preview", async (c) => {
  const row = await ownedClone(c.env, c.get("user").id, c.req.param("id"));
  if (!row.preview_key) throw new HTTPException(404, { message: "Not found." });
  return serveObject(c.env, row.preview_key, c.req.header("Range"));
});

/**
 * Deletes a cloned voice, and its ElevenLabs voice with it. Videos narrated in it keep their recordings; a series
 * that still uses it must get another voice first, and a video being narrated in it right now finishes first.
 */
voiceClones.delete("/:id", async (c) => {
  const user = c.get("user");
  const row = await ownedClone(c.env, user.id, c.req.param("id"));
  const series = (await c.env.DB.prepare("SELECT name FROM series WHERE user_id=? AND json_extract(settings,'$.voiceId')=? LIMIT 5").bind(user.id, row.id).all<{ name: string }>()).results;
  if (series.length)
    throw new HTTPException(409, { message: `Your series ${series.map((s) => `“${s.name}”`).join(", ")} ${series.length === 1 ? "uses" : "use"} this voice. Choose another voice for ${series.length === 1 ? "it" : "them"} first.` });
  const busy = await c.env.DB.prepare(
    "SELECT 1 FROM runs r JOIN videos v ON v.id=r.video_id WHERE r.user_id=? AND r.status IN ('queued','running') AND json_extract(v.spec,'$.narration.voiceId')=? LIMIT 1",
  ).bind(user.id, row.id).first();
  if (busy) throw new HTTPException(409, { message: "A video is being made with this voice. Try again when it's ready." });
  // The trigger queues the ElevenLabs voice and the sample for deletion and closes the statement's record.
  await c.env.DB.prepare("DELETE FROM voice_clones WHERE id=? AND user_id=?").bind(row.id, user.id).run();
  await forgetProviderVoice(c.env, row.provider_id);
  return c.json({ ok: true });
});

/** Deletes an ElevenLabs voice no clone has any more: queued first, so a failed delete is retried (removeClonedVoices). */
async function forgetProviderVoice(env: Env, provider: string) {
  await env.DB.prepare("INSERT OR IGNORE INTO voice_removals(provider_id,created_at) VALUES (?,?)").bind(provider, now()).run();
  try {
    await deleteVoice(env, provider);
    await env.DB.prepare("DELETE FROM voice_removals WHERE provider_id=?").bind(provider).run();
  } catch {
    console.warn("Cloned voice will be deleted at ElevenLabs later");
  }
}
/**
 * Hourly: deletes at ElevenLabs the voices of clones that are gone (a deleted clone whose delete failed, a deleted
 * account). Never given up: a person's voice must not stay in the account, so one that still can't be deleted after
 * a week is reported every pass until an operator removes it by hand (and its row here).
 */
export async function removeClonedVoices(env: Env) {
  if (!env.ELEVENLABS_API_KEY?.trim()) return;
  const tasks = (await env.DB.prepare("SELECT provider_id,created_at FROM voice_removals ORDER BY created_at LIMIT 50")
    .all<{ provider_id: string; created_at: number }>().catch(() => ({ results: [] as { provider_id: string; created_at: number }[] }))).results;
  for (const t of tasks) {
    try {
      await deleteVoice(env, t.provider_id);
      await env.DB.prepare("DELETE FROM voice_removals WHERE provider_id=?").bind(t.provider_id).run();
    } catch {
      if (t.created_at < now() - 7 * DAY) console.error("Cloned voice could not be deleted for a week; delete it in ElevenLabs", { voice: t.provider_id });
    }
  }
}
