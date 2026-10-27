import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import worker from "../server/index";
import { open, seal } from "../server/crypto";
import { hashPassword } from "../server/security";
import { tiktokChunks } from "../server/social/tiktok";
import { SITE, call, signedIn, subscribe, testEnv } from "./helpers";

const KEYS = {
  TIKTOK_CLIENT_KEY: "tt-key",
  TIKTOK_CLIENT_SECRET: "tt-secret",
  INSTAGRAM_APP_ID: "ig-app",
  INSTAGRAM_APP_SECRET: "ig-secret",
  GOOGLE_CLIENT_ID: "g-client",
  GOOGLE_CLIENT_SECRET: "g-secret",
  // Most tests connect TikTok for Direct Post; the drafts test unsets it.
  TIKTOK_DIRECT_POST: "true",
  // Open to everyone; the "coming soon" test closes them again.
  SOCIAL_OPEN: "tiktok,youtube,instagram",
};
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const now = () => Math.floor(Date.now() / 1000);

type Call = { method: string; url: URL; headers: Headers; body: any; redirect?: string };
type Route = [method: string, prefix: string, reply: (c: Call) => Response | Promise<Response>];
/** Replaces fetch with fixed provider answers; records every call (and fails on an unexpected one). */
function mockFetch(routes: Route[]) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (input: any, init: any = {}) => {
    const c: Call = { method: (init.method || "GET").toUpperCase(), url: new URL(String(input)), headers: new Headers(init.headers), body: init.body, redirect: init.redirect };
    calls.push(c);
    const route = routes.find(([m, prefix]) => m === c.method && c.url.href.startsWith(prefix));
    if (!route) throw new Error(`Unexpected request ${c.method} ${c.url.href}`);
    return route[2](c);
  });
  return calls;
}
const ok = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" }, ...init });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

type Plan = "starter" | "daily" | "double" | "studio";
function setup(overrides: Record<string, unknown> = {}, plan: Plan | null = "starter") {
  const { env, sqlite } = testEnv({ ...KEYS, ...overrides });
  const user = signedIn(sqlite);
  if (plan) subscribe(sqlite, user.id, plan);
  return { env, sqlite, user };
}
type Ctx = ReturnType<typeof setup>;
async function connect(s: Ctx, platform: string, back?: string, cookie = s.user.cookie) {
  const r = await call(worker, s.env, "POST", "/api/accounts/connect", { platform, ...(back ? { back } : {}) }, cookie);
  expect(r.status).toBe(200);
  return new URL(r.data.url);
}
const stateOf = async (s: Ctx, platform: string, back?: string) => (await connect(s, platform, back)).searchParams.get("state")!;
const callback = (s: Ctx, platform: string, query: string, cookie = s.user.cookie) =>
  call(worker, s.env, "GET", `/api/accounts/callback/${platform}?${query}`, undefined, cookie);
function addAccount(s: Ctx, platform: string, externalId: string, o: { status?: string; userId?: string } = {}) {
  const id = crypto.randomUUID(), t = now();
  s.sqlite.prepare("INSERT INTO social_accounts(id,user_id,platform,external_id,name,credentials,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(id, o.userId ?? s.user.id, platform, externalId, `Account ${externalId}`, "x", o.status ?? "active", t, t);
  return id;
}
const count = (s: Ctx, table: string) => (s.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as any).n;
const tiktokRoutes = (openId = "open-1"): Route[] => [
  ["POST", "https://open.tiktokapis.com/v2/oauth/token/", () =>
    ok({ access_token: "tt-access", expires_in: 86400, open_id: openId, refresh_token: "tt-refresh", refresh_expires_in: 31536000, scope: "user.info.basic,video.publish", token_type: "Bearer" })],
  ["GET", "https://open.tiktokapis.com/v2/user/info/", () =>
    ok({ data: { user: { open_id: openId, display_name: "Brand Co", avatar_url: "https://p16.tiktokcdn.com/a.jpg" } }, error: { code: "ok", message: "" } })],
  ["POST", "https://open.tiktokapis.com/v2/post/publish/creator_info/query/", () =>
    ok({ data: { creator_username: "brandco", privacy_level_options: ["PUBLIC_TO_EVERYONE", "SELF_ONLY"] }, error: { code: "ok" } })],
];

describe("token encryption", () => {
  it("round-trips JSON and refuses changed or foreign values", async () => {
    const { env } = testEnv();
    const sealed = await seal(env, { accessToken: "secret-token", n: 1 });
    expect(sealed).toMatch(/^v1\.[\w-]+\.[\w-]+$/);
    expect(sealed).not.toContain("secret-token");
    expect(await open(env, sealed)).toEqual({ accessToken: "secret-token", n: 1 });
    // A fresh IV each time.
    expect(await seal(env, { a: 1 })).not.toBe(await seal(env, { a: 1 }));
    const [v, iv, data] = sealed.split(".");
    const flipped = data.slice(0, -2) + (data.at(-2) === "A" ? "B" : "A") + data.at(-1);
    await expect(open(env, [v, iv, flipped].join("."))).rejects.toThrow();
    await expect(open(env, `v2.${iv}.${data}`)).rejects.toThrow();
    await expect(open(env, `${sealed}.extra`)).rejects.toThrow();
    const other = testEnv().env;
    await expect(open(other, sealed)).rejects.toThrow();
  });
  it("explains a missing or invalid key as not set up", async () => {
    for (const key of [undefined, "short", btoa("x".repeat(31))]) {
      const { env } = testEnv({ TOKEN_ENCRYPTION_KEY: key });
      await expect(seal(env, {})).rejects.toMatchObject({ status: 503, message: "Social publishing is not set up yet." });
    }
  });
});

describe("connecting accounts", () => {
  it("lets the free trial connect one account", async () => {
    const s = setup({}, null);
    mockFetch(tiktokRoutes());
    const state = await stateOf(s, "tiktok");
    expect((await callback(s, "tiktok", `code=c&state=${state}`)).headers.get("Location")).toBe("/app/channels?connected=tiktok");
    const r = await call(worker, s.env, "POST", "/api/accounts/connect", { platform: "youtube" }, s.user.cookie);
    expect(r.status).toBe(402);
    expect(r.data.error).toBe("Your plan includes 1 social account. Disconnect one or upgrade to connect more.");
  });

  it("is unavailable when the network or the encryption key is not set up", async () => {
    const s = setup({ TIKTOK_CLIENT_KEY: undefined });
    const r = await call(worker, s.env, "POST", "/api/accounts/connect", { platform: "tiktok" }, s.user.cookie);
    expect(r.status).toBe(503);
    expect(r.data.error).toBe("Connecting TikTok is not available yet.");
    const s2 = setup({ TOKEN_ENCRYPTION_KEY: "" });
    const r2 = await call(worker, s2.env, "POST", "/api/accounts/connect", { platform: "youtube" }, s2.user.cookie);
    expect(r2.status).toBe(503);
    expect(r2.data.error).toBe("Social publishing is not set up yet.");
    expect(count(s, "oauth_states") + count(s2, "oauth_states")).toBe(0);
  });

  it("only connects the networks we publish to, and returns only to app pages", async () => {
    const s = setup();
    for (const body of [{ platform: "linkedin" }, { platform: "tiktok", back: "https://evil.test/app" }, { platform: "tiktok", back: "//evil.test" }, { platform: "tiktok", back: "/app/../admin" }]) {
      const r = await call(worker, s.env, "POST", "/api/accounts/connect", body, s.user.cookie);
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
    expect(count(s, "oauth_states")).toBe(0);
    expect((await call(worker, s.env, "POST", "/api/accounts/connect", { platform: "tiktok" })).status).toBe(401);
  });

  it("builds TikTok's authorize URL with state, redirect and a hex PKCE challenge", async () => {
    const s = setup();
    const url = await connect(s, "tiktok");
    expect(url.origin + url.pathname).toBe("https://www.tiktok.com/v2/auth/authorize/");
    const q = url.searchParams;
    expect(q.get("client_key")).toBe("tt-key");
    expect(q.get("response_type")).toBe("code");
    expect(q.get("scope")).toBe("user.info.basic,video.publish,video.list");
    expect(q.get("redirect_uri")).toBe(`${SITE}/api/accounts/callback/tiktok`);
    expect(q.get("code_challenge_method")).toBe("S256");
    const state = q.get("state")!;
    expect(state).toMatch(/^[0-9a-f]{64}$/);
    const row: any = s.sqlite.prepare("SELECT * FROM oauth_states").get();
    expect(row.state_hash).toBe(sha256(state));
    expect(row.user_id).toBe(s.user.id);
    expect(row.platform).toBe("tiktok");
    expect(row.back).toBe("/app/channels");
    expect(row.expires_at).toBeGreaterThan(Date.now() / 1000 + 500);
    expect(q.get("code_challenge")).toBe(sha256(row.verifier));
  });

  it("connects TikTok for drafts: asks for video.upload instead of video.publish, and the Channels page says so", async () => {
    const s = setup({ TIKTOK_DIRECT_POST: "" });
    const url = await connect(s, "tiktok");
    expect(url.searchParams.get("scope")).toBe("user.info.basic,video.upload");
    const [token, userInfo] = tiktokRoutes();
    const granting = (scope: string): Route => [token[0], token[1], () =>
      ok({ access_token: "tt-access", expires_in: 86400, open_id: "open-1", refresh_token: "tt-refresh", refresh_expires_in: 31536000, scope, token_type: "Bearer" })];
    // Without the upload permission there is nothing to connect.
    mockFetch([granting("user.info.basic,video.publish"), userInfo]);
    expect((await callback(s, "tiktok", `code=c&state=${url.searchParams.get("state")}`)).headers.get("Location")).toBe("/app/channels?error=permissions");
    const calls = mockFetch([granting("user.info.basic,video.upload"), userInfo]);
    expect((await callback(s, "tiktok", `code=c&state=${await stateOf(s, "tiktok")}`)).headers.get("Location")).toBe("/app/channels?connected=tiktok");
    // No creator info (it needs video.publish), so the account has no handle.
    expect(calls.map((c) => c.url.pathname)).toEqual(["/v2/oauth/token/", "/v2/user/info/"]);
    expect(s.sqlite.prepare("SELECT name,handle FROM social_accounts").get()).toEqual({ name: "Brand Co", handle: null });
    const list = await call(worker, s.env, "GET", "/api/accounts", undefined, s.user.cookie);
    expect(list.data.platforms.map((p: any) => [p.id, p.drafts])).toEqual([["tiktok", true], ["youtube", false], ["instagram", false]]);
    // With Direct Post on, TikTok isn't in drafts mode.
    const direct = setup();
    expect((await call(worker, direct.env, "GET", "/api/accounts", undefined, direct.user.cookie)).data.platforms[0]).toMatchObject({ id: "tiktok", drafts: false });
  });

  it("keeps connecting \"coming soon\" for everyone but administrators until a network is opened", async () => {
    const s = setup({ SOCIAL_OPEN: "" });
    const platformsFor = async (cookie: string) => (await call(worker, s.env, "GET", "/api/accounts", undefined, cookie)).data.platforms.map((p: any) => [p.id, p.soon]);
    expect(await platformsFor(s.user.cookie)).toEqual([["tiktok", true], ["youtube", true], ["instagram", true]]);
    const refused = await call(worker, s.env, "POST", "/api/accounts/connect", { platform: "youtube" }, s.user.cookie);
    expect(refused.status).toBe(403);
    expect(refused.data.error).toBe("Posting to YouTube is coming soon.");
    expect(count(s, "oauth_states")).toBe(0);
    // Administrators can connect every network, to try it before it opens.
    const admin = signedIn(s.sqlite, "admin@example.com");
    subscribe(s.sqlite, admin.id, "starter");
    expect(await platformsFor(admin.cookie)).toEqual([["tiktok", false], ["youtube", false], ["instagram", false]]);
    expect((await call(worker, s.env, "POST", "/api/accounts/connect", { platform: "youtube" }, admin.cookie)).status).toBe(200);
    // Opening one network opens it to everyone; the others stay "coming soon".
    s.env.SOCIAL_OPEN = " YouTube ";
    expect(await platformsFor(s.user.cookie)).toEqual([["tiktok", true], ["youtube", false], ["instagram", true]]);
    expect((await call(worker, s.env, "POST", "/api/accounts/connect", { platform: "youtube" }, s.user.cookie)).status).toBe(200);
    expect((await call(worker, s.env, "POST", "/api/accounts/connect", { platform: "tiktok" }, s.user.cookie)).status).toBe(403);
  });

  it("builds Google's authorize URL for offline access with an S256 challenge", async () => {
    const s = setup();
    const url = await connect(s, "youtube");
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    const q = url.searchParams;
    expect(q.get("client_id")).toBe("g-client");
    expect(q.get("scope")).toBe("https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly");
    expect(q.get("access_type")).toBe("offline");
    expect(q.get("prompt")).toBe("consent");
    expect(q.get("include_granted_scopes")).toBe("true");
    expect(q.get("redirect_uri")).toBe(`${SITE}/api/accounts/callback/youtube`);
    const row: any = s.sqlite.prepare("SELECT verifier FROM oauth_states").get();
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("code_challenge")).toBe(createHash("sha256").update(row.verifier).digest("base64url"));
  });

  it("builds Instagram's authorize URL", async () => {
    const s = setup();
    const ig = await connect(s, "instagram");
    expect(ig.origin + ig.pathname).toBe("https://www.instagram.com/oauth/authorize");
    expect(ig.searchParams.get("scope")).toBe("instagram_business_basic,instagram_business_content_publish,instagram_business_manage_insights");
    expect(ig.searchParams.get("client_id")).toBe("ig-app");
    expect(ig.searchParams.get("response_type")).toBe("code");
    expect(ig.searchParams.get("redirect_uri")).toBe(`${SITE}/api/accounts/callback/instagram`);
    expect(ig.searchParams.get("state")).toMatch(/^[0-9a-f]{64}$/);
    // The code is exchanged with the app secret: no PKCE.
    expect(ig.searchParams.has("code_challenge")).toBe(false);
  });

  it("connects a TikTok account from the callback, once per state", async () => {
    const s = setup();
    const state = await stateOf(s, "tiktok");
    const verifier = (s.sqlite.prepare("SELECT verifier FROM oauth_states").get() as any).verifier;
    const calls = mockFetch(tiktokRoutes());
    const r = await callback(s, "tiktok", `code=auth-code&state=${state}`);
    expect(r.status).toBe(302);
    expect(r.headers.get("Location")).toBe("/app/channels?connected=tiktok");
    const exchange = calls.find((c) => c.url.pathname === "/v2/oauth/token/")!;
    expect(exchange.body.get("code")).toBe("auth-code");
    expect(exchange.body.get("code_verifier")).toBe(verifier);
    expect(exchange.body.get("redirect_uri")).toBe(`${SITE}/api/accounts/callback/tiktok`);
    expect(exchange.body.get("grant_type")).toBe("authorization_code");
    expect(calls.every((c) => c.redirect === "manual")).toBe(true);
    const account: any = s.sqlite.prepare("SELECT * FROM social_accounts").get();
    expect(account).toMatchObject({ user_id: s.user.id, platform: "tiktok", external_id: "open-1", name: "Brand Co", handle: "brandco", avatar_url: "https://p16.tiktokcdn.com/a.jpg", status: "active" });
    expect(account.credentials).not.toContain("tt-access");
    expect(await open(s.env, account.credentials)).toMatchObject({ accessToken: "tt-access", refreshToken: "tt-refresh" });
    expect(account.expires_at).toBeGreaterThan(Date.now() / 1000 + 300 * 86400);
    expect(count(s, "oauth_states")).toBe(0);

    // The same state again is refused.
    const again = await callback(s, "tiktok", `code=auth-code&state=${state}`);
    expect(again.headers.get("Location")).toBe("/app/channels?error=expired");
    expect(count(s, "social_accounts")).toBe(1);
  });

  it("returns to the page the connection started from", async () => {
    const s = setup();
    mockFetch(tiktokRoutes());
    const state = await stateOf(s, "tiktok", "/app/series/new");
    expect((s.sqlite.prepare("SELECT back FROM oauth_states").get() as any).back).toBe("/app/series/new");
    expect((await callback(s, "tiktok", `code=c&state=${state}`)).headers.get("Location")).toBe("/app/series/new?connected=tiktok");
  });

  it("refuses expired states, other users' states and states of another network", async () => {
    const s = setup();
    mockFetch(tiktokRoutes());
    const expired = await stateOf(s, "tiktok", "/app/series/new");
    s.sqlite.prepare("UPDATE oauth_states SET expires_at=?").run(now() - 1);
    expect((await callback(s, "tiktok", `code=c&state=${expired}`)).headers.get("Location")).toBe("/app/series/new?error=expired");

    // Someone else's state: refused, without learning the page it was started from.
    const theirs = await stateOf(s, "tiktok", "/app/series/new");
    const intruder = signedIn(s.sqlite);
    expect((await callback(s, "tiktok", `code=c&state=${theirs}`, intruder.cookie)).headers.get("Location")).toBe("/app/channels?error=expired");

    const forYoutube = await stateOf(s, "youtube");
    expect((await callback(s, "tiktok", `code=c&state=${forYoutube}`)).headers.get("Location")).toBe("/app/channels?error=expired");

    expect((await callback(s, "tiktok", `code=c&state=${"0".repeat(64)}`)).headers.get("Location")).toBe("/app/channels?error=expired");
    expect((await callback(s, "tiktok", "code=c&state=not-hex")).headers.get("Location")).toBe("/app/channels?error=expired");
    expect((await callback(s, "linkedin", `code=c&state=${"0".repeat(64)}`)).headers.get("Location")).toBe("/app/channels?error=failed");
    expect(count(s, "social_accounts")).toBe(0);
  });

  it("sends a signed-out return to sign-in, then back to the channels page", async () => {
    // The callback outlives the session sometimes; after signing in, the page to come back to is /app/channels.
    const s = setup();
    const r = await call(worker, s.env, "GET", `/api/accounts/callback/tiktok?code=c&state=${"0".repeat(64)}`);
    expect(r.status).toBe(302);
    expect(r.headers.get("Location")).toBe(`/login?next=${encodeURIComponent("/app/channels")}`);
  });

  it("reports a declined consent without calling the network", async () => {
    const s = setup();
    const calls = mockFetch([]);
    const state = await stateOf(s, "tiktok");
    const r = await callback(s, "tiktok", `error=access_denied&error_description=Nope&state=${state}`);
    expect(r.headers.get("Location")).toBe("/app/channels?error=denied");
    expect(calls).toHaveLength(0);
    expect(count(s, "oauth_states")).toBe(0);
  });

  it("reconnecting renews the same account", async () => {
    const s = setup();
    mockFetch(tiktokRoutes());
    for (let i = 0; i < 3; i++) {
      const state = await stateOf(s, "tiktok");
      expect((await callback(s, "tiktok", `code=c&state=${state}`)).headers.get("Location")).toBe("/app/channels?connected=tiktok");
      s.sqlite.prepare("UPDATE social_accounts SET status='expired'").run();
    }
    const state = await stateOf(s, "tiktok");
    await callback(s, "tiktok", `code=c&state=${state}`);
    const rows: any[] = s.sqlite.prepare("SELECT * FROM social_accounts").all();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("active");
  });

  it("keeps to the plan's account limit (Starter: 1)", async () => {
    const s = setup();
    addAccount(s, "youtube", "UC1");
    const r = await call(worker, s.env, "POST", "/api/accounts/connect", { platform: "tiktok" }, s.user.cookie);
    expect(r.status).toBe(402);
    expect(r.data.error).toBe("Your plan includes 1 social account. Disconnect one or upgrade to connect more.");
    // An account that needs reconnecting can be renewed at the limit, but no new one is added.
    s.sqlite.prepare("UPDATE social_accounts SET status='expired'").run();
    expect((await call(worker, s.env, "POST", "/api/accounts/connect", { platform: "tiktok" }, s.user.cookie)).status).toBe(402);
    let state = await stateOf(s, "youtube");
    const full = "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly";
    const channel = (id: string) => [
      ["POST", "https://oauth2.googleapis.com/token", () => ok({ access_token: "g-access", expires_in: 3599, refresh_token: "g-refresh", scope: full, token_type: "Bearer" })],
      ["GET", "https://www.googleapis.com/youtube/v3/channels", () => ok({ items: [{ id, snippet: { title: `Channel ${id}` } }] })],
    ] as Route[];
    mockFetch(channel("UC9"));
    expect((await callback(s, "youtube", `code=c&state=${state}`)).headers.get("Location")).toBe("/app/channels?error=limit");
    expect(count(s, "social_accounts")).toBe(1);
    state = await stateOf(s, "youtube");
    mockFetch(channel("UC1"));
    expect((await callback(s, "youtube", `code=c&state=${state}`)).headers.get("Location")).toBe("/app/channels?connected=youtube");
    expect(s.sqlite.prepare("SELECT external_id,status,name FROM social_accounts").all()).toEqual([{ external_id: "UC1", status: "active", name: "Channel UC1" }]);
  });

  it("has no practical limit on Creator and higher plans", async () => {
    const s = setup({}, "daily");
    for (let i = 0; i < 5; i++) addAccount(s, "tiktok", `open-${i}`);
    mockFetch(tiktokRoutes("open-new"));
    const state = await stateOf(s, "tiktok");
    expect((await callback(s, "tiktok", `code=c&state=${state}`)).headers.get("Location")).toBe("/app/channels?connected=tiktok");
    expect((await call(worker, s.env, "GET", "/api/accounts", undefined, s.user.cookie)).data.limit).toEqual({ max: 100, used: 6 });
  });

  it("connects Instagram with a long-lived token and the professional account ID", async () => {
    const s = setup();
    const state = await stateOf(s, "instagram");
    const calls = mockFetch([
      ["POST", "https://api.instagram.com/oauth/access_token", () =>
        ok({ data: [{ access_token: "ig-short", user_id: "9001", permissions: "instagram_business_basic,instagram_business_content_publish" }] })],
      ["GET", "https://graph.instagram.com/access_token", () => ok({ access_token: "ig-long", token_type: "bearer", expires_in: 5184000 })],
      ["GET", "https://graph.instagram.com/v23.0/me", () =>
        ok({ user_id: "17841400000000000", username: "brand.co", name: "Brand Co", profile_picture_url: "https://scontent.cdninstagram.com/p.jpg", id: "9001" })],
    ]);
    const r = await callback(s, "instagram", `code=ig-code%23_&state=${state}`);
    expect(r.headers.get("Location")).toBe("/app/channels?connected=instagram");
    expect(calls[0].body.get("code")).toBe("ig-code");
    expect(calls[0].body.get("client_secret")).toBe("ig-secret");
    const longLived = calls[1].url.searchParams;
    expect(longLived.get("grant_type")).toBe("ig_exchange_token");
    expect(longLived.get("access_token")).toBe("ig-short");
    expect(calls[2].headers.get("Authorization")).toBe("Bearer ig-long");
    expect(calls[2].url.searchParams.get("fields")).toBe("user_id,username,name,profile_picture_url");
    const account: any = s.sqlite.prepare("SELECT * FROM social_accounts").get();
    expect(account).toMatchObject({ platform: "instagram", external_id: "17841400000000000", handle: "brand.co", name: "Brand Co" });
    expect(await open<any>(s.env, account.credentials)).toMatchObject({ accessToken: "ig-long", scope: "instagram_business_basic,instagram_business_content_publish" });
    // The token itself expires (no refresh token): so does the connection, in 60 days.
    expect(account.expires_at).toBeGreaterThan(now() + 59 * 86400);
  });

  it("refuses an Instagram connection without the publishing permission", async () => {
    const s = setup();
    const state = await stateOf(s, "instagram");
    const calls = mockFetch([
      ["POST", "https://api.instagram.com/oauth/access_token", () => ok({ data: [{ access_token: "ig-short", user_id: "9001", permissions: "instagram_business_basic" }] })],
    ]);
    expect((await callback(s, "instagram", `code=c&state=${state}`)).headers.get("Location")).toBe("/app/channels?error=permissions");
    expect(calls).toHaveLength(1);
    expect(count(s, "social_accounts")).toBe(0);
  });

  it("connects a YouTube channel, and explains missing permissions or channels", async () => {
    const s = setup();
    const token = (scope: string) => ok({ access_token: "g-access", expires_in: 3599, refresh_token: "g-refresh", scope, token_type: "Bearer" });
    let state = await stateOf(s, "youtube");
    mockFetch([["POST", "https://oauth2.googleapis.com/token", () => token("https://www.googleapis.com/auth/youtube.readonly")]]);
    let r = await callback(s, "youtube", `code=c&state=${state}`);
    expect(r.headers.get("Location")).toBe("/app/channels?error=permissions");

    const full = "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly";
    state = await stateOf(s, "youtube");
    mockFetch([["POST", "https://oauth2.googleapis.com/token", () => token(full)], ["GET", "https://www.googleapis.com/youtube/v3/channels", () => ok({ items: [] })]]);
    r = await callback(s, "youtube", `code=c&state=${state}`);
    expect(r.headers.get("Location")).toBe("/app/channels?error=no_channel");

    state = await stateOf(s, "youtube");
    const calls = mockFetch([
      ["POST", "https://oauth2.googleapis.com/token", () => token(full)],
      ["GET", "https://www.googleapis.com/youtube/v3/channels", () =>
        ok({ items: [{ id: "UC123", snippet: { title: "Brand Channel", customUrl: "@brandchannel", thumbnails: { default: { url: "https://yt3.ggpht.com/x" } } } }] })],
    ]);
    r = await callback(s, "youtube", `code=c&state=${state}`);
    expect(r.headers.get("Location")).toBe("/app/channels?connected=youtube");
    expect(calls[0].body.get("code_verifier")).toMatch(/^[\w-]{43,128}$/);
    expect(calls[1].url.searchParams.get("mine")).toBe("true");
    expect(calls[1].headers.get("Authorization")).toBe("Bearer g-access");
    const account: any = s.sqlite.prepare("SELECT * FROM social_accounts").get();
    expect(account).toMatchObject({ external_id: "UC123", name: "Brand Channel", handle: "brandchannel", avatar_url: "https://yt3.ggpht.com/x", expires_at: null });
  });

  it("maps a failed code exchange to a short error code, never the provider's text", async () => {
    const s = setup();
    const answers: [string, string][] = [["invalid_request", "failed"], ["invalid_client", "unavailable"], ["invalid_grant", "expired"]];
    for (const [error, code] of answers) {
      const state = await stateOf(s, "youtube");
      mockFetch([["POST", "https://oauth2.googleapis.com/token", () =>
        new Response(JSON.stringify({ error, error_description: "Secret <script> details" }), { status: 400 })]]);
      const r = await callback(s, "youtube", `code=c&state=${state}`);
      expect(r.headers.get("Location")).toBe(`/app/channels?error=${code}`);
    }
    expect(count(s, "social_accounts")).toBe(0);
  });

  it("lists accounts without credentials, with the networks and the limit", async () => {
    const s = setup({ GOOGLE_CLIENT_ID: undefined });
    mockFetch(tiktokRoutes());
    const state = await stateOf(s, "tiktok");
    await callback(s, "tiktok", `code=c&state=${state}`);
    const r = await call(worker, s.env, "GET", "/api/accounts", undefined, s.user.cookie);
    expect(r.status).toBe(200);
    expect(r.data.accounts).toHaveLength(1);
    expect(r.data.accounts[0]).toMatchObject({ platform: "tiktok", name: "Brand Co", handle: "brandco", avatarUrl: "https://p16.tiktokcdn.com/a.jpg", status: "active" });
    expect(JSON.stringify(r.data)).not.toMatch(/credentials|tt-access|tt-refresh/);
    expect(r.data.platforms).toEqual([
      { id: "tiktok", name: "TikTok", configured: true, soon: false, drafts: false },
      { id: "youtube", name: "YouTube", configured: false, soon: false, drafts: false },
      { id: "instagram", name: "Instagram", configured: true, soon: false, drafts: false },
    ]);
    expect(r.data.limit).toEqual({ max: 1, used: 1 });
    // A connection that ended shows as expired before maintenance notices.
    s.sqlite.prepare("UPDATE social_accounts SET expires_at=?").run(now() - 1);
    expect((await call(worker, s.env, "GET", "/api/accounts", undefined, s.user.cookie)).data.accounts[0].status).toBe("expired");
    // Accounts belong to the person who connected them.
    const other = signedIn(s.sqlite);
    expect((await call(worker, s.env, "GET", "/api/accounts", undefined, other.cookie)).data).toMatchObject({ accounts: [], limit: { max: 1, used: 0 } });
  });

  it("disconnects an account, unless a video is being published to it, and takes it out of series", async () => {
    const s = setup();
    const t = now();
    const accountId = addAccount(s, "tiktok", "open-1"), otherAccount = addAccount(s, "youtube", "UC1");
    s.sqlite.prepare("INSERT INTO videos(id,user_id,spec,render_status,created_at,updated_at) VALUES ('v1',?,'{}','ready',?,?),('v2',?,'{}','ready',?,?)").run(s.user.id, t, t, s.user.id, t, t);
    const pub = (id: string, video: string, status: string) =>
      s.sqlite.prepare("INSERT INTO publications(id,user_id,video_id,account_id,account_name,platform,scheduled_at,status,created_at,updated_at) VALUES (?,?,?,?,'Brand','tiktok',?,?,?,?)")
        .run(id, s.user.id, video, accountId, t, status, t, t);
    pub("p-now", "v1", "publishing");
    pub("p-done", "v2", "published");
    const settings = JSON.stringify({ prompt: "space facts", accounts: [accountId, otherAccount] });
    s.sqlite.prepare("INSERT INTO series(id,user_id,name,template,settings,created_at,updated_at) VALUES ('s1',?,'Space','story',?,?,?)").run(s.user.id, settings, t, t);
    const busy = await call(worker, s.env, "DELETE", `/api/accounts/${accountId}`, undefined, s.user.cookie);
    expect(busy.status).toBe(409);
    expect(busy.data.error).toBe("A video is being published to this account right now. Try again in a minute.");
    // Nothing changed meanwhile.
    expect(count(s, "social_accounts")).toBe(2);
    expect(JSON.parse((s.sqlite.prepare("SELECT settings FROM series").get() as any).settings).accounts).toEqual([accountId, otherAccount]);
    s.sqlite.prepare("UPDATE publications SET status='scheduled' WHERE id='p-now'").run();
    const other = signedIn(s.sqlite);
    expect((await call(worker, s.env, "DELETE", `/api/accounts/${accountId}`, undefined, other.cookie)).status).toBe(404);
    const done = await call(worker, s.env, "DELETE", `/api/accounts/${accountId}`, undefined, s.user.cookie);
    expect(done.status).toBe(200);
    expect(s.sqlite.prepare("SELECT id FROM social_accounts").all()).toEqual([{ id: otherAccount }]);
    // A video still scheduled to it is cancelled and kept; published history stays, with the account's name.
    expect(s.sqlite.prepare("SELECT id,status,account_id,account_name FROM publications ORDER BY id").all()).toEqual([
      { id: "p-done", status: "published", account_id: null, account_name: "Brand" },
      { id: "p-now", status: "canceled", account_id: null, account_name: "Brand" },
    ]);
    // Its series stop posting to it and keep everything else.
    expect(JSON.parse((s.sqlite.prepare("SELECT settings FROM series").get() as any).settings)).toEqual({ prompt: "space facts", accounts: [otherAccount] });
    expect((await call(worker, s.env, "DELETE", `/api/accounts/${accountId}`, undefined, s.user.cookie)).status).toBe(404);
  });

  it("forgets what YouTube told us about a channel's posts when it is disconnected; other networks' history stays", async () => {
    const s = setup();
    const t = now();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const youtube = addAccount(s, "youtube", "UC1"), tiktok = addAccount(s, "tiktok", "open-1");
    s.sqlite.prepare("INSERT INTO videos(id,user_id,spec,render_status,created_at,updated_at) VALUES ('v1',?,'{}','ready',?,?)").run(s.user.id, t, t);
    const pub = (id: string, account: string, platform: string) =>
      s.sqlite.prepare(
        "INSERT INTO publications(id,user_id,video_id,account_id,account_name,platform,scheduled_at,status,external_id,url,published_at,views,likes,comments,metrics_at,created_at,updated_at) VALUES (?,?,'v1',?,'Brand (@brand)',?,?,'published','abcdefghijk','https://example.com/p',?,40,3,1,?,?,?)",
      ).run(id, s.user.id, account, platform, t, t, t, t, t);
    pub("p-yt", youtube, "youtube");
    pub("p-tt", tiktok, "tiktok");
    expect((await call(worker, s.env, "DELETE", `/api/accounts/${youtube}`, undefined, s.user.cookie)).status).toBe(200);
    const row = (id: string) => s.sqlite.prepare("SELECT status,account_id,account_name,external_id,url,views,likes,comments,metrics_at FROM publications WHERE id=?").get(id);
    expect(row("p-yt")).toEqual({ status: "published", account_id: null, account_name: "", external_id: null, url: null, views: null, likes: null, comments: null, metrics_at: null });
    expect(row("p-tt")).toEqual({ status: "published", account_id: tiktok, account_name: "Brand (@brand)", external_id: "abcdefghijk", url: "https://example.com/p", views: 40, likes: 3, comments: 1, metrics_at: t });
    // The history still lists it, as a disconnected account's post.
    const shown = (await call(worker, s.env, "GET", "/api/videos/v1/publications", undefined, s.user.cookie)).data.publications;
    expect(shown.find((p: any) => p.id === "p-yt")).toMatchObject({ status: "published", accountName: "Disconnected account", url: null, views: null });
  });

  it("revokes Google's access when a YouTube channel is disconnected or its account deleted, and goes on when Google fails", async () => {
    const s = setup();
    const youtube = async (externalId: string, refreshToken?: string) => {
      const id = addAccount(s, "youtube", externalId);
      s.sqlite.prepare("UPDATE social_accounts SET credentials=? WHERE id=?").run(await seal(s.env, { accessToken: `a-${externalId}`, refreshToken }), id);
      return id;
    };
    const first = await youtube("UC1", "r-UC1"), second = await youtube("UC2", "r-UC2");
    await youtube("UC3");
    addAccount(s, "tiktok", "open-1");
    let answer = 200;
    const calls = mockFetch([["POST", "https://oauth2.googleapis.com/revoke", () => new Response("{}", { status: answer })]]);
    expect((await call(worker, s.env, "DELETE", `/api/accounts/${first}`, undefined, s.user.cookie)).status).toBe(200);
    // The refresh token is revoked (with it, every access token and the grant itself).
    expect(calls.map((c) => [c.url.href, String(c.body)])).toEqual([["https://oauth2.googleapis.com/revoke", "token=r-UC1"]]);
    // Google failing doesn't keep the channel connected: our copy of the tokens is gone either way.
    answer = 503;
    expect((await call(worker, s.env, "DELETE", `/api/accounts/${second}`, undefined, s.user.cookie)).status).toBe(200);
    expect(s.sqlite.prepare("SELECT platform FROM social_accounts ORDER BY platform").all()).toEqual([{ platform: "tiktok" }, { platform: "youtube" }]);
    // Deleting the account revokes its remaining YouTube channel (without a refresh token, the access token); TikTok
    // has nothing to revoke.
    answer = 200;
    s.sqlite.prepare("UPDATE users SET password_hash=? WHERE id=?").run(await hashPassword("a-long-password"), s.user.id);
    expect((await call(worker, s.env, "DELETE", "/api/settings/account", { password: "a-long-password" }, s.user.cookie)).status).toBe(200);
    expect(calls.map((c) => String(c.body))).toEqual(["token=r-UC1", "token=r-UC2", "token=a-UC3"]);
    expect(count(s, "social_accounts")).toBe(0);
  });
});

describe("platform details", () => {
  it("cuts TikTok uploads by the media transfer rules", () => {
    const MiB = 1024 * 1024;
    expect(tiktokChunks(3 * MiB)).toEqual({ chunkSize: 3 * MiB, count: 1 });
    expect(tiktokChunks(10 * MiB)).toEqual({ chunkSize: 10 * MiB, count: 1 });
    const big = 50 * MiB + 123;
    const { chunkSize, count } = tiktokChunks(big);
    expect(chunkSize).toBe(10 * MiB);
    expect(count).toBe(5);
    // The last chunk takes the rest and stays under 128 MB.
    expect(big - (count - 1) * chunkSize).toBeLessThan(2 * chunkSize);
    expect(tiktokChunks(19 * MiB)).toEqual({ chunkSize: 10 * MiB, count: 1 });
  });
});
