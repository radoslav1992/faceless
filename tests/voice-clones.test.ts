import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../server/index";
import { providerVoiceId, voiceUsable } from "../server/voices";
import { removeClonedVoices } from "../server/voice-clones";
import { applyRetention, EVIDENCE_DAYS } from "../server/retention";
import { speak } from "../server/providers/elevenlabs";
import { now, DAY } from "../server/types";
import { CLONE_CONSENT_VERSION, CLONE_ID, CLONE_SAMPLE, cloneSampleText } from "../shared/voices";
import { plans } from "../shared/plans";
import { call, signedIn, subscribe, testEnv } from "./helpers";

// Cloned voices: a customer's own voice, made by ElevenLabs from a recording they upload, with their statement that
// the voice is theirs to use; offered to them alone, limited by their plan and by the room the operator set, and
// deleted at ElevenLabs when they delete it or their account.

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
const mp3 = () => { const b = new Uint8Array(1200).fill(7); b.set([0x49, 0x44, 0x33]); return b; };
/** ElevenLabs as the Worker sees it: voices made and deleted, samples spoken; `o` makes it refuse. */
function elevenlabs(o: { add?: () => Response; deleteFails?: boolean; account?: () => any[]; subscription?: (ours: number) => Response } = {}) {
  const made: { id: string; name: string; file: File }[] = [], deleted: string[] = [], spoken: { voice: string; text: string }[] = [];
  const state = { ...o };
  vi.stubGlobal("fetch", async (input: any, init: any = {}) => {
    const url = String(input?.url ?? input), method = init.method || "GET";
    expect(new Headers(init.headers).get("xi-api-key")).toBe("el");
    if (url === "https://api.elevenlabs.io/v1/voices/add" && method === "POST") {
      if (state.add) return state.add();
      const form = init.body as FormData;
      const id = `Clone${String(made.length + 1).padStart(15, "0")}`;
      made.push({ id, name: String(form.get("name")), file: form.get("files") as File });
      return Response.json({ voice_id: id, requires_verification: false });
    }
    const voice = /^https:\/\/api\.elevenlabs\.io\/v1\/voices\/([A-Za-z0-9]+)$/.exec(url)?.[1];
    if (voice && method === "GET") return Response.json({ voice_id: voice, name: "Adam", category: "premade" });
    if (voice && method === "DELETE") {
      if (state.deleteFails) return new Response("down", { status: 503 });
      deleted.push(voice);
      return Response.json({ status: "ok" });
    }
    const speech = /^https:\/\/api\.elevenlabs\.io\/v1\/text-to-speech\/([A-Za-z0-9]+)\?output_format=mp3/.exec(url)?.[1];
    if (speech && method === "POST") {
      spoken.push({ voice: speech, text: JSON.parse(init.body).text });
      return new Response(mp3(), { headers: { "Content-Type": "audio/mpeg" } });
    }
    // The account's plan: unless a test says otherwise, the key can't read it (the operator's setting then stands).
    if (url === "https://api.elevenlabs.io/v1/user/subscription") return state.subscription ? state.subscription(made.length - deleted.length) : Response.json({ detail: { status: "missing_permissions" } }, { status: 401 });
    if (url.startsWith("https://api.elevenlabs.io/v2/voices?")) return Response.json({ voices: state.account?.() ?? [], has_more: false });
    return Response.json({ detail: { status: "voice_not_found" } }, { status: 404 });
  });
  return { made, deleted, spoken, state };
}
async function setup(overrides: Record<string, string> = {}) {
  const { env, sqlite } = testEnv({ MEDIA_ENABLED: "true", ELEVENLABS_API_KEY: "el", VOICE_CLONES: "10", ...overrides });
  const admin = signedIn(sqlite, "admin@example.com"), owner = signedIn(sqlite, "owner@example.com"), other = signedIn(sqlite, "other@example.com");
  const trial = signedIn(sqlite, "trial@example.com"), small = signedIn(sqlite, "small@example.com"), third = signedIn(sqlite, "third@example.com");
  // Pro and Studio have room for one cloned voice each; Starter and Creator, like the trial, for none.
  subscribe(sqlite, owner.id, "double");
  subscribe(sqlite, other.id, "studio");
  subscribe(sqlite, small.id, "daily");
  subscribe(sqlite, third.id, "double");
  for (const u of [admin, owner, other, trial, small, third]) await call(worker, env, "GET", "/api/auth/me", undefined, u.cookie);
  const as = (who: { cookie: string }) => (method: string, path: string, body?: unknown) => call(worker, env, method, path, body, who.cookie);
  /** An uploaded recording of `who` (two minutes of MP3 unless said). */
  const recording = async (who: { id: string }, o: { seconds?: number; bytes?: number; mime?: string; kind?: string } = {}) => {
    const id = crypto.randomUUID(), key = `media/${who.id}/${id}.mp3`, bytes = o.bytes ?? 4000;
    await env.MEDIA.put(key, new Uint8Array(Math.min(bytes, 4000)).fill(1), { httpMetadata: { contentType: o.mime ?? "audio/mpeg" } });
    sqlite.prepare("INSERT INTO media_assets(id,user_id,kind,name,object_key,mime,bytes,duration,status,created_at,updated_at) VALUES (?,?,?,'My voice.mp3',?,?,?,?,'ready',1,1)")
      .run(id, who.id, o.kind ?? "upload", key, o.mime ?? "audio/mpeg", bytes, o.seconds ?? 120);
    return id;
  };
  const clone = async (who: { id: string; cookie: string }, body: Record<string, unknown> = {}) =>
    as(who)("POST", "/api/voices", { name: "Mira", assetId: await recording(who), consent: true, version: CLONE_CONSENT_VERSION, ...body });
  return { env, sqlite, admin, owner, other, trial, small, third, as, recording, clone };
}

describe("cloned voices", () => {
  it("are off unless the operator says how many the ElevenLabs account has room for", async () => {
    const s = await setup({ VOICE_CLONES: "" });
    const api = elevenlabs();
    expect((await s.as(s.owner)("GET", "/api/voices")).data).toEqual({ enabled: false, limit: 0, plans: "Pro and Studio", voices: [] });
    expect((await s.clone(s.owner)).status).toBe(503);
    expect(api.made).toEqual([]);
  });

  it("are made from the owner's recording with their statement, and are theirs alone", async () => {
    const s = await setup();
    const api = elevenlabs();
    expect(plans.map((p) => p.voices)).toEqual([0, 0, 0, 1, 1]);
    expect((await s.as(s.owner)("GET", "/api/voices")).data).toEqual({ enabled: true, limit: 1, plans: "Pro and Studio", voices: [] });
    // Never without the statement, in its current wording.
    expect((await s.clone(s.owner, { consent: false })).status).toBe(400);
    expect((await s.clone(s.owner, { version: "2020-01-01" })).status).toBe(400);
    // The recording: the owner's own upload, of sound, long enough, not too long or large.
    for (const [recording, message] of [
      [await s.recording(s.owner, { seconds: CLONE_SAMPLE.minSeconds - 1 }), /too short/],
      [await s.recording(s.owner, { seconds: CLONE_SAMPLE.maxSeconds + 1 }), /too long/],
      [await s.recording(s.owner, { bytes: CLONE_SAMPLE.maxBytes + 1 }), /up to 10 MB/],
      [await s.recording(s.owner, { mime: "video/mp4" }), /Upload a recording/],
      [await s.recording(s.owner, { kind: "voice" }), /Upload a recording/],
      [await s.recording(s.other), /Upload a recording/],
    ] as const) {
      const refused = await s.clone(s.owner, { assetId: recording });
      expect(refused.status).toBe(400);
      expect(refused.data.error).toMatch(message);
    }
    expect(api.made).toEqual([]);

    const made = await s.clone(s.owner, { name: "  Mira <b> " });
    expect(made.status).toBe(201);
    const voice = made.data.voice;
    expect(voice).toMatchObject({ name: "Mira b", own: true, default: false, description: "Your cloned voice" });
    expect(voice.id).toMatch(CLONE_ID);
    // ElevenLabs got the recording, named for the operator by product and account (never the email).
    expect(api.made).toHaveLength(1);
    expect(api.made[0].name).toBe(`hookstreak-shorts ${s.owner.id.slice(0, 8)} Mira b`);
    expect(api.made[0].file.type).toBe("audio/mpeg");
    expect(api.made[0].file.size).toBe(4000);
    // A sample spoken by the clone, for its owner only.
    expect(api.spoken).toEqual([{ voice: api.made[0].id, text: cloneSampleText }]);
    expect(voice.preview).toMatch(new RegExp(`^/api/voices/${voice.id}/preview\\?v=[0-9a-f]{8}$`));
    expect((await s.as(s.owner)("GET", voice.preview)).status).toBe(200);
    expect((await s.as(s.other)("GET", voice.preview)).status).toBe(404);
    expect((await call(worker, s.env, "GET", `/api/public/voices/${voice.id}/preview`)).status).toBe(404);
    // The statement is recorded with its version, and nothing of the voice.
    expect(s.sqlite.prepare("SELECT * FROM voice_consents").all()).toEqual([{ voice_id: voice.id, user_id: s.owner.id, version: CLONE_CONSENT_VERSION, created_at: expect.any(Number), ended_at: null }]);

    // Listed for its owner, never for anyone else or among the voices everyone has.
    expect((await s.as(s.owner)("GET", "/api/voices")).data.voices).toEqual([voice]);
    expect((await s.as(s.other)("GET", "/api/voices")).data.voices).toEqual([]);
    expect((await call(worker, s.env, "GET", "/api/public/voices")).data.voices.map((v: any) => v.id)).not.toContain(voice.id);
    // It speaks for its owner only.
    expect(await voiceUsable(s.env, voice.id, null, s.owner.id)).toBe(true);
    expect(await voiceUsable(s.env, voice.id, voice.id, s.other.id)).toBe(false);
    expect(await voiceUsable(s.env, voice.id)).toBe(false);
    expect(await providerVoiceId(s.env, voice.id, s.owner.id)).toBe(api.made[0].id);
    expect(await providerVoiceId(s.env, voice.id, s.other.id)).toBeNull();
    expect(await providerVoiceId(s.env, voice.id)).toBeNull();
    await expect(speak(s.env, voice.id, "Hi there.", "en", "original", [], s.other.id)).rejects.toThrow("VOICE_UNAVAILABLE");
    const series = { name: "In my voice", template: "facts", first: false, settings: { voiceId: voice.id } };
    expect((await s.as(s.owner)("POST", "/api/series", series)).status).toBe(201);
    const stolen = await s.as(s.other)("POST", "/api/series", series);
    expect(stolen).toMatchObject({ status: 400, data: { error: "Choose one of the voices offered." } });
  });

  it("are for the Pro and Studio plans, one voice each, within the room the operator set", async () => {
    const s = await setup({ VOICE_CLONES: "2" });
    const api = elevenlabs();
    for (const who of [s.trial, s.small]) {
      expect(await s.clone(who)).toMatchObject({ status: 402, data: { error: "Cloning your voice is part of the Pro and Studio plans. Upgrade to add your own voice." } });
      expect((await s.as(who)("GET", "/api/voices")).data).toMatchObject({ enabled: true, limit: 0 });
    }
    expect((await s.clone(s.owner)).status).toBe(201);
    expect(await s.clone(s.owner)).toMatchObject({ status: 409, data: { error: expect.stringContaining("room for 1 cloned voice.") } });
    expect((await s.clone(s.other)).status).toBe(201);
    // The operator set room for two.
    expect(await s.clone(s.third)).toMatchObject({ status: 503, data: { error: "Voice cloning is full right now. Please try again later." } });
    expect(api.made).toHaveLength(2);
  });

  it("never promise more voices than the ElevenLabs account has slots free, whatever the operator set", async () => {
    const s = await setup({ VOICE_CLONES: "10" });
    const api = elevenlabs();
    // A Creator account: 30 slots, 29 of them held by the operator's own cloned and designed voices.
    const plan = { tier: "creator", character_count: 81_000, character_limit: 100_000, next_character_count_reset_unix: 1_800_000_000, voice_limit: 30, can_use_instant_voice_cloning: true };
    api.state.subscription = (ours) => Response.json({ ...plan, voice_slots_used: 29 + ours });
    const status = async () => (await s.as(s.admin)("GET", "/api/admin/voices/account")).data;
    expect(await status()).toMatchObject({
      setting: 10, clones: 0, removals: 0, problem: null, others: 29, slots: 1, room: 1, left: 1,
      account: { tier: "creator", creditsUsed: 81_000, creditsLimit: 100_000, creditsReset: 1_800_000_000, voiceSlotsUsed: 29, voiceSlots: 30, canClone: true },
    });
    expect((await s.as(s.owner)("GET", "/api/admin/voices/account")).status).toBe(404);
    expect((await s.clone(s.owner)).status).toBe(201);
    expect(await status()).toMatchObject({ clones: 1, others: 29, slots: 1, room: 1, left: 0 });
    expect(await s.clone(s.other)).toMatchObject({ status: 503, data: { error: "Voice cloning is full right now. Please try again later." } });
    expect(api.made).toHaveLength(1);
    // A plan without instant voice cloning: nobody is sent to ElevenLabs to be refused there.
    api.state.subscription = () => Response.json({ ...plan, voice_slots_used: 1, can_use_instant_voice_cloning: false });
    expect(await status()).toMatchObject({ room: 0, left: 0, account: { canClone: false } });
    expect((await s.clone(s.other)).status).toBe(503);
    expect(api.made).toHaveLength(1);
    // A key that can't read the account: the operator's setting stands, and the page says why nothing is shown.
    api.state.subscription = undefined;
    expect(await status()).toMatchObject({ account: null, problem: "VOICE_PERMISSION", slots: null, room: 10, left: 9 });
    expect((await s.clone(s.other)).status).toBe(201);
  });

  it("save nothing when ElevenLabs refuses the recording, wants the speaker verified, or is not set up for cloning", async () => {
    const s = await setup();
    const api = elevenlabs();
    api.state.add = () => Response.json({ detail: { status: "voice_too_short", message: "secret words" } }, { status: 400 });
    expect(await s.clone(s.owner)).toMatchObject({ status: 422, data: { error: expect.stringContaining("couldn't be cloned") } });
    // A voice ElevenLabs asks its speaker to verify can't be used through the API: it is deleted there again.
    api.state.add = () => Response.json({ voice_id: "VerifyMe00000000001", requires_verification: true });
    expect((await s.clone(s.owner)).status).toBe(422);
    expect(api.deleted).toEqual(["VerifyMe00000000001"]);
    api.state.add = () => Response.json({ detail: { status: "can_not_use_instant_voice_cloning" } }, { status: 400 });
    expect(await s.clone(s.owner)).toMatchObject({ status: 503, data: { error: "Voice cloning isn't available right now. Please try again later." } });
    api.state.add = () => Response.json({ detail: { status: "too_many_concurrent_requests" } }, { status: 429 });
    expect((await s.clone(s.owner)).status).toBe(503);
    expect(s.sqlite.prepare("SELECT COUNT(*) AS n FROM voice_clones").get()).toEqual({ n: 0 });
    expect(s.sqlite.prepare("SELECT COUNT(*) AS n FROM voice_consents").get()).toEqual({ n: 0 });
    expect(s.sqlite.prepare("SELECT COUNT(*) AS n FROM voice_removals").get()).toEqual({ n: 0 });
  });

  it("are deleted at ElevenLabs with the clone or the account, retried until it confirms, and never while a series uses one", async () => {
    const s = await setup();
    const api = elevenlabs();
    const voice = (await s.clone(s.owner)).data.voice;
    const sample = (s.sqlite.prepare("SELECT preview_key FROM voice_clones WHERE id=?").get(voice.id) as any).preview_key as string;
    expect(sample).toMatch(new RegExp(`^media/${s.owner.id}/voice-${voice.id}-[0-9a-f]{8}\\.mp3$`));
    const series = (await s.as(s.owner)("POST", "/api/series", { name: "In my voice", template: "facts", first: false, settings: { voiceId: voice.id } })).data.series;
    expect((await s.as(s.other)("DELETE", `/api/voices/${voice.id}`)).status).toBe(404);
    expect(await s.as(s.owner)("DELETE", `/api/voices/${voice.id}`)).toMatchObject({ status: 409, data: { error: expect.stringContaining("“In my voice” uses this voice") } });
    expect((await s.as(s.owner)("DELETE", `/api/series/${series.id}`)).status).toBe(200);
    // ElevenLabs is down: the clone goes at once, its ElevenLabs voice stays queued.
    api.state.deleteFails = true;
    expect((await s.as(s.owner)("DELETE", `/api/voices/${voice.id}`)).status).toBe(200);
    expect((await s.as(s.owner)("GET", "/api/voices")).data.voices).toEqual([]);
    expect(await voiceUsable(s.env, voice.id, null, s.owner.id)).toBe(false);
    expect(s.sqlite.prepare("SELECT provider_id FROM voice_removals").all()).toEqual([{ provider_id: api.made[0].id }]);
    expect(s.sqlite.prepare("SELECT prefix FROM cleanup_tasks").all()).toEqual([{ prefix: sample }]);
    expect((s.sqlite.prepare("SELECT ended_at FROM voice_consents WHERE voice_id=?").get(voice.id) as any).ended_at).toEqual(expect.any(Number));
    await removeClonedVoices(s.env);
    expect(api.deleted).toEqual([]);
    // Its slot is still taken there, so it still counts against the room.
    api.state.deleteFails = false;
    await removeClonedVoices(s.env);
    expect(api.deleted).toEqual([api.made[0].id]);
    expect(s.sqlite.prepare("SELECT COUNT(*) AS n FROM voice_removals").get()).toEqual({ n: 0 });

    // A deleted account takes its clones' ElevenLabs voices with it.
    const second = (await s.clone(s.other)).data.voice;
    s.sqlite.prepare("DELETE FROM users WHERE id=?").run(s.other.id);
    expect(s.sqlite.prepare("SELECT COUNT(*) AS n FROM voice_clones").get()).toEqual({ n: 0 });
    expect(s.sqlite.prepare("SELECT provider_id FROM voice_removals").all()).toEqual([{ provider_id: api.made[1].id }]);
    expect((s.sqlite.prepare("SELECT ended_at FROM voice_consents WHERE voice_id=?").get(second.id) as any).ended_at).toEqual(expect.any(Number));
    await removeClonedVoices(s.env);
    expect(api.deleted).toEqual([api.made[0].id, api.made[1].id]);
    // The statements stay as evidence for five years after the voice is gone, then go.
    await applyRetention(s.env, now() + (EVIDENCE_DAYS - 1) * DAY);
    expect(s.sqlite.prepare("SELECT COUNT(*) AS n FROM voice_consents").get()).toEqual({ n: 2 });
    await applyRetention(s.env, now() + (EVIDENCE_DAYS + 1) * DAY);
    expect(s.sqlite.prepare("SELECT COUNT(*) AS n FROM voice_consents").get()).toEqual({ n: 0 });
  });

  it("are never shown to administrators for import, or offered to everyone", async () => {
    const s = await setup();
    const api = elevenlabs();
    const voice = (await s.clone(s.owner)).data.voice;
    const provider = api.made[0].id;
    api.state.account = () => [{ voice_id: provider, name: "hookstreak-shorts Mira", category: "cloned" }, { voice_id: "pNInz6obpgDQGcFmaJgB", name: "Adam", category: "premade" }];
    const listed = await s.as(s.admin)("GET", "/api/admin/voices/elevenlabs");
    expect(listed.data.voices.map((v: any) => v.providerId)).toEqual(["pNInz6obpgDQGcFmaJgB"]);
    expect(await s.as(s.admin)("POST", "/api/admin/voices", { providerId: provider })).toMatchObject({ status: 409, data: { error: expect.stringContaining("customer's cloned voice") } });
    expect((await s.as(s.admin)("POST", "/api/admin/voices", { providerId: "pNInz6obpgDQGcFmaJgB", id: voice.id })).status).toBe(400);
    expect((await s.as(s.admin)("GET", "/api/admin/voices")).data.voices.map((v: any) => v.id)).not.toContain(voice.id);
  });
});
