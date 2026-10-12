import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../server/index";
import { defaultVoice, elevenVoice, offeredVoice, providerVoiceId, voiceUsable } from "../server/voices";
import { call, signedIn, subscribe, testEnv } from "./helpers";

// Narration voices managed in Admin → Voices: the twelve voices offered before are in the table, administrators import
// voices from their ElevenLabs account (with ElevenLabs' details and sample), rename, describe, order, hide them and
// choose the default; hidden voices stay with the videos and series that have them.

afterEach(() => vi.unstubAllGlobals());
const SAMPLE = "https://storage.googleapis.com/eleven-public-prod/premade/voices/abc/sample.mp3";
/** The ElevenLabs API as the Worker sees it: the account's voices, one voice, its sample; `seen` lists the calls. */
function elevenlabs() {
  const seen: string[] = [];
  const rachel = {
    voice_id: "21m00Tcm4TlvDq8ikWAM", name: "Rachel - Calm, Clear Narrator", category: "premade", description: "A calm voice.",
    labels: { accent: "american", gender: "female", age: "young", use_case: "narration" }, preview_url: SAMPLE,
  };
  const plain = { voice_id: "pNInz6obpgDQGcFmaJgB", name: "Adam", category: "premade", labels: { accent: "american", gender: "male", age: "middle_aged", descriptive: "deep", use_case: "narrative_story" } };
  vi.stubGlobal("fetch", async (url: string, init: any = {}) => {
    seen.push(url);
    if (url === SAMPLE) return new Response(new Uint8Array(900).fill(5), { headers: { "Content-Type": "audio/mpeg" } });
    expect(init.headers["xi-api-key"]).toBe("el");
    if (url.startsWith("https://api.elevenlabs.io/v2/voices?")) return Response.json({ voices: [rachel, plain, { voice_id: "JBFqnCBsd6RMkjVDRZzb", name: "George - Warm Storyteller" }], has_more: false });
    if (url === `https://api.elevenlabs.io/v1/voices/${rachel.voice_id}`) return Response.json(rachel);
    if (url === `https://api.elevenlabs.io/v1/voices/${plain.voice_id}`) return Response.json(plain);
    return Response.json({ detail: { status: "voice_not_found" } }, { status: 404 });
  });
  return seen;
}
async function setup() {
  const { env, sqlite } = testEnv({ MEDIA_ENABLED: "true", ELEVENLABS_API_KEY: "el" });
  const admin = signedIn(sqlite, "admin@example.com"), user = signedIn(sqlite);
  subscribe(sqlite, user.id, "daily");
  for (const u of [admin, user]) await call(worker, env, "GET", "/api/auth/me", undefined, u.cookie);
  const as = (who: { cookie: string }) => (method: string, path: string, body?: unknown) => call(worker, env, method, path, body, who.cookie);
  const offered = async () => (await call(worker, env, "GET", "/api/public/voices")).data.voices as any[];
  return { env, sqlite, admin: as(admin), user: as(user), offered };
}

describe("voices", () => {
  it("start with the twelve voices offered before, George the default, in order", async () => {
    const { env, offered } = await setup();
    const voices = await offered();
    expect(voices.map((v) => v.id)).toEqual(["aria", "sarah", "jessica", "laura", "matilda", "alice", "liam", "chris", "eric", "brian", "will", "george"]);
    expect(voices.at(-1)).toEqual({ id: "george", name: "George", description: "Warm storyteller", gender: "male", accent: "British", age: "", preview: null, default: true });
    expect(await providerVoiceId(env, "george")).toBe("JBFqnCBsd6RMkjVDRZzb");
    expect(await providerVoiceId(env, "nobody")).toBeNull();
    expect(await defaultVoice(env)).toBe("george");
  });

  it("are imported from the ElevenLabs account with its details and sample", async () => {
    const { env, admin, user, offered } = await setup();
    const seen = elevenlabs();
    const account = (await admin("GET", "/api/admin/voices/elevenlabs?search=calm")).data.voices;
    expect(seen[0]).toBe("https://api.elevenlabs.io/v2/voices?page_size=100&search=calm");
    expect(account.map((v: any) => [v.name, v.description, v.gender, v.accent, v.age, v.imported])).toEqual([
      ["Rachel", "Calm, Clear Narrator", "female", "American", "Young", null],
      ["Adam", "Deep, narrative story", "male", "American", "Middle-aged", null],
      ["George", "Warm Storyteller", "", "", "", "george"],
    ]);
    const added = await admin("POST", "/api/admin/voices", { providerId: "21m00Tcm4TlvDq8ikWAM" });
    expect(added.status).toBe(201);
    expect(added.data.voice).toEqual({ id: "rachel", name: "Rachel", description: "Calm, Clear Narrator", gender: "female", accent: "American", age: "Young", preview: "/api/public/voices/rachel/preview", default: false });
    // Offered at once, last; its sample plays from our storage.
    expect((await offered()).at(-1).id).toBe("rachel");
    const sample = await call(worker, env, "GET", "/api/public/voices/rachel/preview");
    expect([sample.status, sample.headers.get("Content-Type")]).toEqual([200, "audio/mpeg"]);
    expect(await providerVoiceId(env, "rachel")).toBe("21m00Tcm4TlvDq8ikWAM");
    // The same ElevenLabs voice twice, a voice the account doesn't have, a chosen ID that is taken.
    expect((await admin("POST", "/api/admin/voices", { providerId: "21m00Tcm4TlvDq8ikWAM" })).status).toBe(409);
    expect((await admin("POST", "/api/admin/voices", { providerId: "zzzzzzzzzzzzzzzzzzzz" })).data.error).toMatch(/Add it to My Voices in ElevenLabs first/);
    expect((await admin("POST", "/api/admin/voices", { providerId: "pNInz6obpgDQGcFmaJgB", id: "george" })).status).toBe(409);
    expect((await admin("POST", "/api/admin/voices", { providerId: "pNInz6obpgDQGcFmaJgB", id: "deep-adam" })).data.voice.id).toBe("deep-adam");
    // Only administrators.
    expect((await user("GET", "/api/admin/voices")).status).toBe(404);
    expect((await user("POST", "/api/admin/voices", { providerId: "21m00Tcm4TlvDq8ikWAM" })).status).toBe(404);
    expect(elevenVoice({ voice_id: "bad id" })).toBeNull();
  });

  it("are renamed, described, ordered, hidden and made the default by administrators", async () => {
    const { env, admin, offered } = await setup();
    const changed = await admin("PATCH", "/api/admin/voices/aria", { name: "Ari", description: "Bright morning voice", accent: "Canadian", age: "Young", gender: "female", sort: 500 });
    expect(changed.data.voice).toMatchObject({ id: "aria", name: "Ari", description: "Bright morning voice", accent: "Canadian", age: "Young" });
    expect((await offered()).at(-1).id).toBe("aria");
    // One default, always offered.
    expect((await admin("PATCH", "/api/admin/voices/george", { active: false })).data.error).toBe("This is the default voice. Make another voice the default first.");
    await admin("PATCH", "/api/admin/voices/brian", { default: true });
    expect((await offered()).filter((v) => v.default).map((v) => v.id)).toEqual(["brian"]);
    expect(await defaultVoice(env)).toBe("brian");
    await admin("PATCH", "/api/admin/voices/george", { active: false });
    expect((await offered()).map((v) => v.id)).not.toContain("george");
    // Hidden: a template's voice gives way to the default; it still speaks for what has it.
    expect(await offeredVoice(env, "george")).toBe("brian");
    expect(await voiceUsable(env, "george")).toBe(false);
    expect(await voiceUsable(env, "george", "george")).toBe(true);
    expect(await providerVoiceId(env, "george")).toBe("JBFqnCBsd6RMkjVDRZzb");
    // Another ElevenLabs voice behind the same public ID.
    await admin("PATCH", "/api/admin/voices/will", { providerId: "pNInz6obpgDQGcFmaJgB" });
    expect(await providerVoiceId(env, "will")).toBe("pNInz6obpgDQGcFmaJgB");
    expect((await admin("PATCH", "/api/admin/voices/eric", { providerId: "pNInz6obpgDQGcFmaJgB" })).status).toBe(409);
    expect((await admin("PATCH", "/api/admin/voices/nobody", { name: "X" })).status).toBe(404);
  });

  it("hidden are refused for new videos and series, kept by the ones that have them, and deleted only when unused", async () => {
    const { admin, user } = await setup();
    const series = (voiceId: string) => user("POST", "/api/series", {
      name: "Ocean facts", template: "facts", first: false, settings: { voiceId, schedule: { timezone: "UTC", times: ["09:00"], days: [1] } },
    });
    const made = await series("eric");
    expect(made.status).toBe(201);
    await admin("PATCH", "/api/admin/voices/eric", { active: false });
    expect((await series("eric")).data.error).toBe("Choose one of the voices offered.");
    // The series that has it keeps it through other changes; it can't switch to another hidden voice.
    expect((await user("PATCH", `/api/series/${made.data.series.id}`, { settings: { prompt: "Deep sea animals" } })).status).toBe(200);
    await admin("PATCH", "/api/admin/voices/chris", { active: false });
    expect((await user("PATCH", `/api/series/${made.data.series.id}`, { settings: { voiceId: "chris" } })).data.error).toBe("Choose one of the voices offered.");
    const video = await user("POST", "/api/videos", { spec: { format: "story", narration: { kind: "voice", voiceId: "eric" }, scenes: [{ text: "Hello there.", description: "A wave" }] }, idempotencyKey: crypto.randomUUID() });
    expect([video.status, video.data.error]).toEqual([400, "Choose one of the voices offered."]);
    // Used voices are hidden, not deleted; unused ones go (with their sample); the default stays.
    expect((await admin("DELETE", "/api/admin/voices/eric")).data.error).toMatch(/^1 series and 0 videos use this voice\. Hide it instead/);
    expect((await admin("DELETE", "/api/admin/voices/george")).status).toBe(409);
    expect((await admin("DELETE", "/api/admin/voices/chris")).status).toBe(200);
    const list = (await admin("GET", "/api/admin/voices")).data.voices;
    expect(list.find((v: any) => v.id === "eric")).toMatchObject({ active: false, usage: { series: 1, videos: 0 } });
    expect(list.map((v: any) => v.id)).not.toContain("chris");
  });
});
