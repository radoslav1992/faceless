import { describe, expect, it } from "vitest";
import worker from "../server/index";
import { MCP_PROTOCOL } from "../server/api";
import { call, signedIn, subscribe, testEnv, SITE } from "./helpers";

// API access: personal keys (shown once, stored as a hash), the REST API (/api/v1) and the MCP server (/mcp). Both act
// as the key's owner with the app's own credits and checks, without a session or the browser's Origin.

const written = {
  status: "completed",
  output_text: JSON.stringify({
    title: "Octopus hearts", topic: "Octopuses", caption: "Nature is weird.", hashtags: ["#ocean"], headline: "Three hearts", subject: "", music: "",
    scenes: [
      { text: "Octopuses have three hearts and blue blood.", picture: "An orange octopus pointing at three hearts", keys: ["hearts"] },
      { text: "Two of them stop when it swims, so it would rather crawl.", picture: "An octopus crawling over rocks", keys: ["crawl"] },
    ],
  }),
};
function setup() {
  const { env, sqlite } = testEnv({ MEDIA_ENABLED: "true", FAL_KEY: "fal", ELEVENLABS_API_KEY: "el" });
  env.AI.run = async () => written;
  const user = signedIn(sqlite);
  subscribe(sqlite, user.id, "daily");
  return { env, sqlite, user };
}
/** A request from a script or an assistant: a bearer key, no cookie, no Origin. */
async function bearer(env: any, method: string, path: string, key: string | null, body?: unknown) {
  const headers: Record<string, string> = {};
  if (key) headers.Authorization = `Bearer ${key}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await worker.fetch(new Request(SITE + path, { method, headers, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) }), env,
    { waitUntil: () => {}, passThroughOnException: () => {} } as any);
  const text = await res.text();
  let data: any = text;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, data, headers: res.headers };
}
async function newKey(env: any, cookie: string, name = "Claude") {
  const r = await call(worker, env, "POST", "/api/keys", { name }, cookie);
  expect(r.status).toBe(201);
  return r.data.secret as string;
}

describe("API keys", () => {
  it("are shown once, stored only as a hash, listed by their prefix and deleted by their owner", async () => {
    const { env, sqlite, user } = setup();
    const secret = await newKey(env, user.cookie);
    expect(secret).toMatch(/^hss_[0-9a-f]{48}$/);
    const stored = sqlite.prepare("SELECT * FROM api_keys WHERE user_id=?").get(user.id) as any;
    expect(JSON.stringify(stored)).not.toContain(secret);
    expect(stored.prefix).toBe(secret.slice(0, 7));
    const list = (await call(worker, env, "GET", "/api/keys", undefined, user.cookie)).data.keys;
    expect(list).toEqual([{ id: stored.id, name: "Claude", prefix: secret.slice(0, 7), lastUsedAt: null, createdAt: stored.created_at }]);
    // Someone else can neither see nor delete it.
    const other = signedIn(sqlite);
    expect((await call(worker, env, "GET", "/api/keys", undefined, other.cookie)).data.keys).toEqual([]);
    expect((await call(worker, env, "DELETE", `/api/keys/${stored.id}`, undefined, other.cookie)).status).toBe(404);
    expect((await bearer(env, "GET", "/api/v1/me", secret)).status).toBe(200);
    expect((await call(worker, env, "DELETE", `/api/keys/${stored.id}`, undefined, user.cookie)).status).toBe(200);
    expect((await bearer(env, "GET", "/api/v1/me", secret)).status).toBe(401);
  });
  it("need a confirmed email, a name, and stop at ten", async () => {
    const { env, sqlite, user } = setup();
    expect((await call(worker, env, "POST", "/api/keys", { name: " " }, user.cookie)).status).toBe(400);
    for (let i = 0; i < 10; i++)
      sqlite.prepare("INSERT INTO api_keys(id,user_id,name,key_hash,prefix,created_at) VALUES (?,?,?,?,'hss_000',1)").run(crypto.randomUUID(), user.id, `Key ${i}`, `hash-${i}`);
    const full = await call(worker, env, "POST", "/api/keys", { name: "One more" }, user.cookie);
    expect(full.status).toBe(400);
    expect(full.data.error).toMatch(/10 API keys/);
    const unconfirmed = signedIn(sqlite);
    sqlite.prepare("UPDATE users SET verified=0 WHERE id=?").run(unconfirmed.id);
    expect((await call(worker, env, "POST", "/api/keys", { name: "Mine" }, unconfirmed.cookie)).status).toBe(403);
  });
});

describe("the REST API", () => {
  it("refuses missing and wrong keys, and needs no browser Origin with a right one", async () => {
    const { env, user } = setup();
    expect((await bearer(env, "GET", "/api/v1/me", null)).status).toBe(401);
    expect((await bearer(env, "GET", "/api/v1/me", `hss_${"0".repeat(48)}`)).status).toBe(401);
    expect((await bearer(env, "GET", "/api/v1/me", "sk_live_123")).status).toBe(401);
    const key = await newKey(env, user.cookie);
    const me = await bearer(env, "GET", "/api/v1/me", key);
    expect(me.data).toMatchObject({ plan: "daily", credits: { left: 60, used: 0, total: 60 } });
    const types = (await bearer(env, "GET", "/api/v1/types", key)).data;
    expect(types.types.map((t: any) => t.id)).toEqual(expect.arrayContaining(["facts", "script", "povscenario", "mashup", "storytime"]));
  });

  it("writes and makes a video with the owner's credits, and hands out a short-lived download link once it is made", async () => {
    const { env, sqlite, user } = setup();
    const key = await newKey(env, user.cookie);
    const made = await bearer(env, "POST", "/api/v1/videos", key, { type: "facts", prompt: "octopus hearts", seconds: 30 });
    expect(made.status).toBe(201);
    expect(made.data.video).toMatchObject({ title: "Octopus hearts", status: "queued", download: null, credits: 1, url: `${SITE}/app/videos/${made.data.video.id}` });
    expect(env.CONTENT.created).toHaveLength(1);
    expect((await bearer(env, "GET", "/api/v1/me", key)).data.credits.used).toBe(1);
    // Nobody else's key reaches it.
    const other = signedIn(sqlite);
    const otherKey = await newKey(env, other.cookie);
    expect((await bearer(env, "GET", `/api/v1/videos/${made.data.video.id}`, otherKey)).status).toBe(404);
    // Made: a signed link serves the MP4 without a session; changed or expired, it doesn't.
    const id = made.data.video.id, asset = crypto.randomUUID(), objectKey = `media/${user.id}/${asset}.mp4`;
    await env.MEDIA.put(objectKey, new Uint8Array(1000).fill(3), { httpMetadata: { contentType: "video/mp4" } });
    sqlite.prepare("INSERT INTO media_assets(id,user_id,video_id,kind,name,object_key,mime,bytes,status,created_at,updated_at) VALUES (?,?,?,'render','Video',?,'video/mp4',1000,'ready',1,1)")
      .run(asset, user.id, id, objectKey);
    sqlite.prepare("UPDATE videos SET render_status='ready',video_asset=? WHERE id=?").run(asset, id);
    const ready = (await bearer(env, "GET", `/api/v1/videos/${id}`, key)).data.video;
    expect(ready.status).toBe("ready");
    const link = new URL(ready.download);
    expect(link.pathname).toBe(`/api/v1/files/${id}`);
    const file = await bearer(env, "GET", link.pathname + link.search, null);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-disposition")).toBe('attachment; filename="Octopus hearts.mp4"');
    const forged = new URLSearchParams(link.search);
    forged.set("exp", String(Number(forged.get("exp")) + 3600));
    expect((await bearer(env, "GET", `${link.pathname}?${forged}`, null)).status).toBe(404);
    const expired = new URLSearchParams(link.search);
    expired.set("exp", "1000");
    expect((await bearer(env, "GET", `${link.pathname}?${expired}`, null)).status).toBe(404);
    expect((await bearer(env, "GET", "/api/v1/videos?limit=5", key)).data.videos.map((v: any) => v.id)).toEqual([id]);
    // Without the server's secret there are no links, and none is accepted.
    const unkeyed = { ...env, TOKEN_ENCRYPTION_KEY: "" };
    expect((await bearer(unkeyed, "GET", `/api/v1/videos/${id}`, key)).data.video.download).toBeNull();
    expect((await bearer(unkeyed, "GET", link.pathname + link.search, null)).status).toBe(404);
  });

  it("checks requests like the app: credits, input and series ownership", async () => {
    const { env, sqlite, user } = setup();
    const key = await newKey(env, user.cookie);
    expect((await bearer(env, "POST", "/api/v1/videos", key, { type: "nope" })).status).toBe(400);
    expect((await bearer(env, "POST", "/api/v1/videos", key, { type: "script" })).status).toBe(400); // no script
    await call(worker, env, "GET", "/api/auth/me", undefined, user.cookie);
    sqlite.prepare("UPDATE usage_windows SET used=quota WHERE user_id=?").run(user.id);
    const broke = await bearer(env, "POST", "/api/v1/videos", key, { type: "facts" });
    expect(broke.status).toBe(402);
    expect(env.CONTENT.created).toHaveLength(0);
    const series = (await call(worker, env, "POST", "/api/series", { name: "Facts", template: "facts", first: false }, user.cookie)).data.series;
    expect((await bearer(env, "POST", `/api/v1/series/${series.id}/pause`, key)).data.series).toEqual({ id: series.id, status: "paused" });
    expect((await bearer(env, "GET", "/api/v1/series", key)).data.series[0]).toMatchObject({ id: series.id, status: "paused", type: "facts" });
    const other = signedIn(sqlite);
    expect((await bearer(env, "POST", `/api/v1/series/${series.id}/resume`, await newKey(env, other.cookie))).status).toBe(404);
  });
});

describe("the MCP server", () => {
  const rpc = (method: string, params?: unknown, id: number | null = 1) => ({ jsonrpc: "2.0", ...(id !== null && { id }), method, ...(params !== undefined && { params }) });

  it("initializes, lists its tools and answers tool calls as the key's owner", async () => {
    const { env, user } = setup();
    const key = await newKey(env, user.cookie);
    const init = await bearer(env, "POST", "/mcp", key, rpc("initialize", { protocolVersion: MCP_PROTOCOL, capabilities: {}, clientInfo: { name: "test", version: "1" } }));
    expect(init.status).toBe(200);
    expect(init.data.result).toMatchObject({ protocolVersion: MCP_PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: "hookstreak-shorts" } });
    expect(init.headers.get("mcp-protocol-version")).toBe(MCP_PROTOCOL);
    // A notification gets no answer.
    expect((await bearer(env, "POST", "/mcp", key, rpc("notifications/initialized", undefined, null))).status).toBe(202);
    const tools = (await bearer(env, "POST", "/mcp", key, rpc("tools/list"))).data.result.tools;
    expect(tools.map((t: any) => t.name)).toEqual([
      "list_video_types", "create_video", "get_video", "list_videos", "list_series", "set_series_status",
      "list_long_videos", "find_clips", "get_long_video", "make_clip", "get_account",
    ]);
    for (const t of tools) expect(t.inputSchema.type).toBe("object");
    const account = (await bearer(env, "POST", "/mcp", key, rpc("tools/call", { name: "get_account", arguments: {} }))).data.result;
    expect(account).toMatchObject({ isError: false, structuredContent: { plan: "daily", credits: { left: 60 } } });
    expect(JSON.parse(account.content[0].text)).toEqual(account.structuredContent);
    const made = (await bearer(env, "POST", "/mcp", key, rpc("tools/call", { name: "create_video", arguments: { type: "facts", prompt: "octopuses" } }))).data.result;
    expect(made.structuredContent).toMatchObject({ title: "Octopus hearts", status: "queued", credits: 1 });
    // Batches answer each request, in order.
    const batch = await bearer(env, "POST", "/mcp", key, [rpc("ping", undefined, 7), rpc("tools/call", { name: "get_video", arguments: { id: made.structuredContent.id } }, 8)]);
    expect(batch.data.map((a: any) => a.id)).toEqual([7, 8]);
    expect(batch.data[1].result.structuredContent.id).toBe(made.structuredContent.id);
  });

  it("finds clips in the owner's long videos and makes them, with the app's prices", async () => {
    const { env, sqlite, user } = setup();
    const key = await newKey(env, user.cookie);
    await call(worker, env, "GET", "/api/auth/me", undefined, user.cookie);
    const tool = async (name: string, args: unknown) => (await bearer(env, "POST", "/mcp", key, rpc("tools/call", { name, arguments: args }))).data.result;
    // A 20-minute podcast whose speech was found, and an hour-long stream not transcribed yet.
    const words = Array.from({ length: 400 }, (_, i) => ({ text: i % 8 === 7 ? `end${i}.` : `word${i}`, start: i * 0.4 + Math.floor(i / 8) * 0.5, end: i * 0.4 + Math.floor(i / 8) * 0.5 + 0.3 }));
    const podcast = crypto.randomUUID(), stream = crypto.randomUUID();
    for (const [id, duration, meta] of [[podcast, 1200, { hasAudio: true, speech: { status: "found", at: 1 }, transcript: { language: "en", words } }], [stream, 3600, { hasAudio: true }]] as const)
      sqlite.prepare("INSERT INTO media_assets(id,user_id,kind,name,object_key,mime,bytes,duration,width,height,status,meta,created_at,updated_at) VALUES (?,?,'upload','Show.mp4',?,'video/mp4',10,?,1920,1080,'ready',?,1,1)")
        .run(id, user.id, `media/${user.id}/${id}.mp4`, duration, JSON.stringify(meta));
    const listed = await tool("list_long_videos", {});
    expect(listed.structuredContent.videos.map((v: any) => [v.id, v.speech, v.transcribeCredits])).toEqual(expect.arrayContaining([[podcast, "found", 0], [stream, null, 2]]));
    env.AI.run = async () => ({ status: "completed", output_text: JSON.stringify({ clips: [{ title: "The big idea", why: "It lands.", caption: "Watch.", hashtags: ["ideas"], first: 2, last: 10, hook: 9, payoff: 8, clarity: 8, energy: 7 }] }) });
    const found = await tool("find_clips", { source: podcast, count: 3 });
    expect(found.structuredContent).toMatchObject({ id: podcast, searching: false, moments: [{ index: 0, title: "The big idea", score: 82 }] });
    // A long video is transcribed first, at the price it was shown; without it nothing is charged.
    expect((await tool("find_clips", { source: stream })).content[0].text).toBe("Transcribing this video costs 2 credits. Check the price and try again.");
    expect(await tool("find_clips", { source: stream, credits: 2 })).toMatchObject({ isError: false, structuredContent: { searching: true, credits: 2 } });
    const clip = await tool("make_clip", { source: podcast, moment: 0, layout: "speakers", style: "karaoke" });
    expect(clip.structuredContent).toMatchObject({ title: "The big idea", status: "queued", credits: 1 });
    const spec = JSON.parse((sqlite.prepare("SELECT spec FROM videos WHERE id=?").get(clip.structuredContent.id) as any).spec);
    expect(spec).toMatchObject({ format: "highlight", layout: { kind: "split", preset: "speakers" }, captions: { style: "karaoke", position: "middle" }, moment: { score: 82 } });
    expect((await tool("make_clip", { source: podcast, moment: 4 })).content[0].text).toBe("Moment not found. Find clips in the video first.");
    // The REST API: a moment by its seconds.
    const rest = await bearer(env, "POST", "/api/v1/clips", key, { source: podcast, start: 30, end: 75, title: "Custom" });
    expect([rest.status, rest.data.video.credits, rest.data.video.title]).toEqual([201, 1, "Custom"]);
    expect((await bearer(env, "GET", `/api/v1/sources/${podcast}`, key)).data.source.clips).toBe(2);
    expect((await bearer(env, "GET", `/api/v1/sources/${crypto.randomUUID()}`, key)).status).toBe(404);
    expect((await tool("get_account", {})).structuredContent.credits.left).toBe(60 - 2 - 2);
  });

  it("reports failures as results or JSON-RPC errors, never internals, and needs a key", async () => {
    const { env, user } = setup();
    const key = await newKey(env, user.cookie);
    const missing = await bearer(env, "POST", "/mcp", null, rpc("tools/list"));
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toMatch(/^Bearer/);
    const notFound = (await bearer(env, "POST", "/mcp", key, rpc("tools/call", { name: "get_video", arguments: { id: crypto.randomUUID() } }))).data.result;
    expect(notFound).toEqual({ content: [{ type: "text", text: "Video not found." }], isError: true });
    const invalid = (await bearer(env, "POST", "/mcp", key, rpc("tools/call", { name: "create_video", arguments: { seconds: 5000 } }))).data.result;
    expect(invalid.isError).toBe(true);
    expect(invalid.content[0].text).toMatch(/^Invalid arguments: seconds/);
    expect((await bearer(env, "POST", "/mcp", key, rpc("resources/list"))).data.error).toMatchObject({ code: -32601 });
    expect((await bearer(env, "POST", "/mcp", key, "{not json")).data.error).toMatchObject({ code: -32700 });
    expect((await bearer(env, "POST", "/mcp", key, { method: "ping" })).status).toBe(400);
    expect((await bearer(env, "GET", "/mcp", key)).status).toBe(405);
  });
});
