import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../server/index";
import { seal, open } from "../server/crypto";
import { dispatchDue, refreshAccounts } from "../server/publishing";
import { Publication } from "../server/publish-workflow";
import { videoReady } from "../server/series";
import { tiktokChunks } from "../server/social/tiktok";
import { dueForStats } from "../server/metrics";
import { specSchema } from "../shared/formats";
import { seriesSettingsSchema } from "../shared/series";
import type { Tokens } from "../server/social";
import { SITE, call, signedIn, testEnv } from "./helpers";

// Posting made videos on TikTok, YouTube and Instagram: now, at a chosen time, or (a series' episodes) at their slot.

const KEYS: Record<string, string> = {
  TIKTOK_CLIENT_KEY: "tt-key",
  TIKTOK_CLIENT_SECRET: "tt-secret",
  // Most tests post to TikTok directly; the drafts tests unset it.
  TIKTOK_DIRECT_POST: "true",
  INSTAGRAM_APP_ID: "ig-app",
  INSTAGRAM_APP_SECRET: "ig-secret",
  GOOGLE_CLIENT_ID: "g-client",
  GOOGLE_CLIENT_SECRET: "g-secret",
};
const now = () => Math.floor(Date.now() / 1000);
const HOUR = 3600, DAY = 86400, MiB = 1024 * 1024;
const NOT_MADE = "The video couldn't be made in time, so nothing was posted. Open it, make it again and post it.";

type Call = { method: string; url: URL; headers: Headers; body: any; redirect?: string };
type Route = [method: string, prefix: string, reply: (c: Call) => Response | Promise<Response>];
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
const ok = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, ...init, headers: { "Content-Type": "application/json", ...(init.headers as any) } });
/** Answers from a list, one per call; the last one repeats. */
const sequence = (...replies: (() => Response)[]) => {
  let i = 0;
  return () => replies[Math.min(i++, replies.length - 1)]();
};
const jsonBody = (c: Call) => JSON.parse(String(c.body));
const bytesOf = (c: Call) => new Uint8Array(c.body as ArrayBuffer);
const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));
afterEach(() => vi.unstubAllGlobals());

const step = { do: async (_name: string, a: any, b?: any) => (b ?? a)(), sleep: async () => {} };

type Ctx = ReturnType<typeof setup>;
type User = { id: string; email: string; cookie: string };
/** A signed-in person (free plan: posting needs no paid plan) with room for their videos' files. */
function person(sqlite: ReturnType<typeof testEnv>["sqlite"]): User {
  const user = signedIn(sqlite);
  sqlite.prepare("INSERT INTO media_limits(user_id,max_bytes) VALUES (?,?)").run(user.id, 10 * 1024 ** 3);
  return user;
}
function setup(overrides: Record<string, string> = {}) {
  const { env, sqlite } = testEnv({ ...KEYS, ...overrides });
  return { env, sqlite, user: person(sqlite) };
}

const fill = (n: number, seed: number) => {
  const bytes = new Uint8Array(n);
  for (let i = 0; i < n; i++) bytes[i] = (i * 7 + seed) % 251;
  return bytes;
};

type VideoOptions = {
  status?: "pending" | "approved" | "rejected";
  render?: "queued" | "running" | "ready" | "failed";
  /** False: never rendered (no video file yet). */
  made?: boolean;
  duration?: number;
  bytes?: number;
  spec?: Record<string, unknown>;
  /** The rendered file contains AI pictures, clips or voices (set by the render). */
  ai?: boolean;
  seriesId?: string;
  slotAt?: number;
  updatedAt?: number;
  user?: User;
};
/** A video (an own upload narrates it over library clips: no AI media) and, once made, its rendered file. */
async function addVideo(s: Ctx, o: VideoOptions = {}) {
  const user = o.user ?? s.user, id = crypto.randomUUID(), t = now();
  const spec = specSchema.parse({
    narration: { kind: "upload", assetId: crypto.randomUUID() },
    scenes: [{ text: "Meet the new blender. It is quiet.", source: "library", libraryId: crypto.randomUUID() }],
    caption: "Meet the new blender.\nIt is quiet.",
    hashtags: ["kitchen", "#launch"],
    ...o.spec,
  });
  s.sqlite.prepare("INSERT INTO videos(id,user_id,series_id,slot_at,spec,hook,caption,title,status,render_status,duration,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, user.id, o.seriesId ?? null, o.slotAt ?? null, JSON.stringify(spec), "Meet the new blender.", spec.caption, spec.title, o.status ?? "approved", o.render ?? "ready", o.duration ?? 30, t, o.updatedAt ?? t);
  if (o.made !== false) {
    const asset = crypto.randomUUID(), key = `media/${user.id}/${id}/${asset}.mp4`, bytes = fill(o.bytes ?? 4096, 1);
    s.sqlite.prepare("INSERT INTO media_assets(id,user_id,video_id,kind,name,object_key,mime,bytes,duration,meta,created_at,updated_at) VALUES (?,?,?,'render','Video',?,'video/mp4',?,?,?,?,?)")
      .run(asset, user.id, id, key, bytes.length, o.duration ?? 30, JSON.stringify(o.ai ? { ai: true } : {}), t, t);
    await s.env.MEDIA.put(key, bytes, { httpMetadata: { contentType: "video/mp4" } });
    s.sqlite.prepare("UPDATE videos SET video_asset=? WHERE id=?").run(asset, id);
  }
  return id;
}

type AccountOptions = { tokens?: Partial<Tokens>; status?: string; externalId?: string; handle?: string; expiresAt?: number; user?: User };
async function addAccount(s: Ctx, platform: "tiktok" | "youtube" | "instagram", o: AccountOptions = {}) {
  const id = crypto.randomUUID(), t = now();
  const tokens: Tokens = { accessToken: `${platform}-access`, refreshToken: `${platform}-refresh`, expiresAt: t + 30 * DAY, ...o.tokens };
  s.sqlite.prepare("INSERT INTO social_accounts(id,user_id,platform,external_id,name,handle,credentials,expires_at,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, (o.user ?? s.user).id, platform, o.externalId ?? `${platform}-${id.slice(0, 8)}`, `${platform} account`, o.handle ?? "brandco", await seal(s.env, tokens), o.expiresAt ?? null, o.status ?? "active", t, t);
  return id;
}

function addPublication(s: Ctx, videoId: string, accountId: string, platform: string, o: { at?: number; status?: string; private?: boolean } = {}) {
  const id = crypto.randomUUID(), t = now();
  s.sqlite.prepare("INSERT INTO publications(id,user_id,video_id,account_id,account_name,platform,scheduled_at,private,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, s.user.id, videoId, accountId, `${platform} account (@brandco)`, platform, o.at ?? now() - 5, o.private ? 1 : 0, o.status ?? "scheduled", t, t);
  return id;
}
const publication = (s: Ctx, id: string) => s.sqlite.prepare("SELECT * FROM publications WHERE id=?").get(id) as any;
const publicationsOf = (s: Ctx, videoId: string) => s.sqlite.prepare("SELECT * FROM publications WHERE video_id=? ORDER BY platform").all(videoId) as any[];
const video = (s: Ctx, id: string) => s.sqlite.prepare("SELECT * FROM videos WHERE id=?").get(id) as any;

function addSeries(s: Ctx, settings: Record<string, unknown>, status: "active" | "paused" = "active") {
  const id = crypto.randomUUID(), t = now();
  s.sqlite.prepare("INSERT INTO series(id,user_id,name,template,settings,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(id, s.user.id, "Kitchen facts", "facts", JSON.stringify(seriesSettingsSchema.parse(settings)), status, t, t);
  return id;
}

/** Claims the due publication like the cron does, then runs its workflow to the end. */
async function publish(s: Ctx, id: string) {
  await dispatchDue(s.env);
  const p = publication(s, id);
  expect(p.status).toBe("publishing");
  expect(s.env.PUBLISH.created).toContainEqual({ id: `pub-${id}-${p.attempts}`, params: { publicationId: id } });
  await new Publication({} as any, s.env).run({ payload: { publicationId: id }, instanceId: `pub-${id}-${p.attempts}` } as any, step as any);
  return publication(s, id);
}
/** Fetches one of our capability media links like a network would. */
async function fetchMedia(s: Ctx, url: string, headers: Record<string, string> = {}, method = "GET") {
  expect(url.startsWith(`${SITE}/api/publish-media/`)).toBe(true);
  const res = await worker.fetch(new Request(url, { method, headers }), s.env, { waitUntil: () => {}, passThroughOnException: () => {} } as any);
  return { status: res.status, headers: res.headers, bytes: new Uint8Array(await res.arrayBuffer()) };
}

describe("posting a video", () => {
  it("posts a made video now or at a chosen time, privately when asked, and approves it", async () => {
    const s = setup();
    const tiktok = await addAccount(s, "tiktok"), youtube = await addAccount(s, "youtube"), instagram = await addAccount(s, "instagram");
    const pending = await addVideo(s, { status: "pending" });
    const before = now();
    let r = await call(worker, s.env, "POST", `/api/videos/${pending}/publish`, { accountIds: [tiktok, youtube, tiktok] }, s.user.cookie);
    expect(r.status).toBe(201);
    // "Now" is in a minute (the cron's next run).
    expect(r.data.scheduledAt).toBeGreaterThanOrEqual(before + 60);
    expect(r.data.scheduledAt).toBeLessThanOrEqual(now() + 60);
    expect(r.data.publications).toHaveLength(2);
    expect(r.data.publications.map((p: any) => p.accountId).sort()).toEqual([tiktok, youtube].sort());
    expect(r.data.publications.find((p: any) => p.platform === "tiktok")).toMatchObject({
      videoId: pending, accountId: tiktok, status: "scheduled", scheduledAt: r.data.scheduledAt, private: 0, attempts: 0,
      accountName: "tiktok account", accountHandle: "brandco", url: null, error: null,
    });
    // Posting it is approving it; the account's name is kept with the publication (for after a disconnect).
    expect(video(s, pending)).toMatchObject({ status: "approved", reviewed_at: expect.any(Number) });
    expect(publicationsOf(s, pending).map((p) => p.account_name)).toEqual(["tiktok account (@brandco)", "youtube account (@brandco)"]);

    // At a chosen time, privately (TikTok and YouTube only).
    const other = await addVideo(s);
    const at = now() + 3 * HOUR;
    r = await call(worker, s.env, "POST", `/api/videos/${other}/publish`, { accountIds: [tiktok], at, private: true }, s.user.cookie);
    expect(r.status).toBe(201);
    expect(r.data).toMatchObject({ scheduledAt: at, publications: [{ accountId: tiktok, scheduledAt: at, private: 1 }] });
    r = await call(worker, s.env, "POST", `/api/videos/${other}/publish`, { accountIds: [instagram], private: true }, s.user.cookie);
    expect(r.status).toBe(409);
    expect(r.data.error).toBe("Instagram can't post privately. Leave it out, or post publicly.");

    // The same video on the same account again: refused as a whole (Instagram is not scheduled either).
    r = await call(worker, s.env, "POST", `/api/videos/${other}/publish`, { accountIds: [instagram, tiktok], at: at + DAY }, s.user.cookie);
    expect(r.status).toBe(409);
    expect(r.data.error).toBe("This video is already scheduled or published on one of these accounts.");
    expect(publicationsOf(s, other)).toHaveLength(1);
    // Once that one is canceled, the video can go to that account again.
    s.sqlite.prepare("UPDATE publications SET status='canceled' WHERE video_id=?").run(other);
    r = await call(worker, s.env, "POST", `/api/videos/${other}/publish`, { accountIds: [instagram, tiktok], at: at + DAY }, s.user.cookie);
    expect(r.status).toBe(201);
    expect(r.data.publications.map((p: any) => p.platform).sort()).toEqual(["instagram", "tiktok"]);
  });

  it("checks the video, the time, the accounts and what each network accepts", async () => {
    const s = setup();
    const tiktok = await addAccount(s, "tiktok"), youtube = await addAccount(s, "youtube");
    const ready = await addVideo(s);
    const post = (videoId: string, body: Record<string, unknown>) => call(worker, s.env, "POST", `/api/videos/${videoId}/publish`, body, s.user.cookie);

    const rendering = await addVideo(s, { render: "running", made: false });
    let r = await post(rendering, { accountIds: [tiktok] });
    expect(r.status).toBe(409);
    expect(r.data.error).toBe("This video is still being made. Post it when it's ready.");
    for (const at of [now() + 10, now() + 181 * DAY]) {
      r = await post(ready, { accountIds: [tiktok], at });
      expect(r.status).toBe(400);
      expect(r.data.error).toBe("Pick a time at least a minute from now and within the next 180 days.");
    }
    expect((await post(ready, { accountIds: [] })).status).toBe(400);
    expect((await post(ready, { accountIds: ["nope"] })).status).toBe(400);

    // Someone else's account or video is not found.
    const stranger = person(s.sqlite);
    const theirs = await addAccount(s, "tiktok", { user: stranger });
    r = await post(ready, { accountIds: [tiktok, theirs] });
    expect(r.status).toBe(404);
    expect(r.data.error).toBe("Social account not found.");
    r = await post(await addVideo(s, { user: stranger }), { accountIds: [tiktok] });
    expect(r.status).toBe(404);
    expect(r.data.error).toBe("Video not found.");

    // Connections that ended must be made again first.
    const expired = await addAccount(s, "instagram", { status: "expired" });
    r = await post(ready, { accountIds: [expired] });
    expect(r.status).toBe(409);
    expect(r.data.error).toBe("Reconnect your Instagram account (instagram account) first.");
    const lapsed = await addAccount(s, "tiktok", { expiresAt: now() - 10 });
    expect((await post(ready, { accountIds: [lapsed] })).data.error).toBe("Reconnect your TikTok account (tiktok account) first.");

    // Each network's length limits.
    const long = await addVideo(s, { duration: 240 });
    r = await post(long, { accountIds: [youtube] });
    expect(r.status).toBe(409);
    expect(r.data.error).toBe("This video is too long for YouTube: the limit is 3 minutes.");
    const short = await addVideo(s, { duration: 2 });
    expect((await post(short, { accountIds: [tiktok] })).data.error).toBe("This video is too short for TikTok: it needs at least 3 seconds.");
    expect(s.sqlite.prepare("SELECT COUNT(*) AS n FROM publications").get()).toEqual({ n: 0 });
    // Nothing was approved by a refused request.
    expect(video(s, long).reviewed_at).toBeNull();
    r = await post(long, { accountIds: [tiktok], at: now() + HOUR });
    expect(r.status).toBe(201);
  });

  it("lists the schedule, and moves, cancels and retries", async () => {
    const s = setup();
    const tiktok = await addAccount(s, "tiktok");
    const v = await addVideo(s, { spec: { title: "The quiet blender" } });
    const at = now() + 2 * HOUR;
    const created = await call(worker, s.env, "POST", `/api/videos/${v}/publish`, { accountIds: [tiktok], at }, s.user.cookie);
    const pubId = created.data.publications[0].id;
    let list = await call(worker, s.env, "GET", "/api/publications", undefined, s.user.cookie);
    expect(list.status).toBe(200);
    expect(list.data.publications).toEqual([expect.objectContaining({
      id: pubId, videoId: v, platform: "tiktok", scheduledAt: at, status: "scheduled", title: "The quiet blender", hook: "Meet the new blender.",
      seriesId: null, renderStatus: "ready", accountName: "tiktok account",
    })]);
    expect((await call(worker, s.env, "GET", `/api/publications?from=${at + 1}`, undefined, s.user.cookie)).data.publications).toHaveLength(0);
    expect((await call(worker, s.env, "GET", `/api/publications?from=${now()}&to=${now() + 101 * DAY}`, undefined, s.user.cookie)).status).toBe(400);
    expect((await call(worker, s.env, "GET", `/api/videos/${v}/publications`, undefined, s.user.cookie)).data.publications).toHaveLength(1);
    // Nobody else sees or changes it.
    const other = person(s.sqlite);
    expect((await call(worker, s.env, "GET", "/api/publications", undefined, other.cookie)).data.publications).toHaveLength(0);
    expect((await call(worker, s.env, "PATCH", `/api/publications/${pubId}`, { at: at + DAY }, other.cookie)).status).toBe(404);
    expect((await call(worker, s.env, "DELETE", `/api/publications/${pubId}`, undefined, other.cookie)).status).toBe(404);

    let r = await call(worker, s.env, "PATCH", `/api/publications/${pubId}`, { at: at + DAY }, s.user.cookie);
    expect(r.status).toBe(200);
    expect(publication(s, pubId).scheduled_at).toBe(at + DAY);
    expect((await call(worker, s.env, "PATCH", `/api/publications/${pubId}`, { at: now() + 5 }, s.user.cookie)).status).toBe(400);
    r = await call(worker, s.env, "POST", `/api/publications/${pubId}/retry`, undefined, s.user.cookie);
    expect(r.status).toBe(409);
    expect(r.data.error).toBe("Only failed posts can be retried.");
    r = await call(worker, s.env, "DELETE", `/api/publications/${pubId}`, undefined, s.user.cookie);
    expect(r.status).toBe(200);
    expect(publication(s, pubId).status).toBe("canceled");
    r = await call(worker, s.env, "PATCH", `/api/publications/${pubId}`, { at: at + DAY }, s.user.cookie);
    expect(r.status).toBe(409);
    expect(r.data.error).toBe("Only posts that are still scheduled can be moved.");
    expect((await call(worker, s.env, "DELETE", `/api/publications/${pubId}`, undefined, s.user.cookie)).status).toBe(409);
    list = await call(worker, s.env, "GET", "/api/publications", undefined, s.user.cookie);
    expect(list.data.publications).toHaveLength(0);

    // A failed publication goes back into the queue a minute from now, its attempts kept.
    const failed = addPublication(s, v, tiktok, "tiktok", { at: now() - HOUR, status: "failed" });
    s.sqlite.prepare("UPDATE publications SET error='x',ticket='{}',token='t',claimed_at=1,attempts=2 WHERE id=?").run(failed);
    r = await call(worker, s.env, "POST", `/api/publications/${failed}/retry`, undefined, s.user.cookie);
    expect(r.status).toBe(200);
    expect(publication(s, failed)).toMatchObject({ status: "scheduled", error: null, ticket: null, token: null, claimed_at: null, attempts: 2 });
    expect(publication(s, failed).scheduled_at).toBeGreaterThanOrEqual(now() + 59);

    // Not while another publication of the video on that account is still on, the account needs reconnecting, or the
    // video is being made again.
    const twice = addPublication(s, v, tiktok, "tiktok", { at: now() - HOUR, status: "failed" });
    r = await call(worker, s.env, "POST", `/api/publications/${twice}/retry`, undefined, s.user.cookie);
    expect(r.status).toBe(409);
    expect(r.data.error).toBe("This video is already scheduled or published on that account.");
    s.sqlite.prepare("UPDATE publications SET status='canceled' WHERE id=?").run(failed);
    s.sqlite.prepare("UPDATE social_accounts SET status='expired' WHERE id=?").run(tiktok);
    r = await call(worker, s.env, "POST", `/api/publications/${twice}/retry`, undefined, s.user.cookie);
    expect(r.data.error).toBe("Reconnect your TikTok account, then try again.");
    s.sqlite.prepare("UPDATE social_accounts SET status='active' WHERE id=?").run(tiktok);
    s.sqlite.prepare("UPDATE videos SET render_status='running' WHERE id=?").run(v);
    r = await call(worker, s.env, "POST", `/api/publications/${twice}/retry`, undefined, s.user.cookie);
    expect(r.data.error).toBe("This video isn't ready to post.");
    expect(publication(s, twice).status).toBe("failed");

    // A disconnected account leaves its history, under the name it had.
    s.sqlite.prepare("DELETE FROM social_accounts WHERE id=?").run(tiktok);
    const history = await call(worker, s.env, "GET", `/api/videos/${v}/publications`, undefined, s.user.cookie);
    expect(history.data.publications.every((p: any) => p.accountId === null && p.accountName === "tiktok account (@brandco)")).toBe(true);
  });
});

describe("series episodes", () => {
  it("are scheduled at their slot on the series' accounts once made, privately when the series asks", async () => {
    const s = setup();
    const tiktok = await addAccount(s, "tiktok"), youtube = await addAccount(s, "youtube"), instagram = await addAccount(s, "instagram");
    const expired = await addAccount(s, "youtube", { status: "expired" });
    const series = addSeries(s, { accounts: [tiktok, youtube, instagram, expired], private: true });
    const slot = now() + 5 * HOUR;
    // Still being made (made ahead of its slot): nothing is scheduled yet.
    const episode = await addVideo(s, { seriesId: series, slotAt: slot, render: "running" });
    await videoReady(s.env, episode);
    expect(publicationsOf(s, episode)).toHaveLength(0);
    expect(s.env.EMAIL.sent).toHaveLength(0);

    s.sqlite.prepare("UPDATE videos SET render_status='ready' WHERE id=?").run(episode);
    await videoReady(s.env, episode);
    // Private: on TikTok and YouTube (Instagram can't post privately; the expired account is left out).
    const rows = publicationsOf(s, episode);
    expect(rows.map((p) => [p.platform, p.account_id])).toEqual([["tiktok", tiktok], ["youtube", youtube]]);
    expect(rows.every((p) => p.scheduled_at === slot && p.private === 1 && p.status === "scheduled")).toBe(true);
    // The owner hears once when it posts.
    expect(s.env.EMAIL.sent).toHaveLength(1);
    expect(s.env.EMAIL.sent[0]).toMatchObject({ to: s.user.email, subject: "New episode of “Kitchen facts”: Meet the new blender." });
    expect(s.env.EMAIL.sent[0].text).toContain("It posts on ");
    // Ready again (a retried step, an edit): nothing is scheduled twice, and no second e-mail.
    await videoReady(s.env, episode);
    expect(publicationsOf(s, episode)).toHaveLength(2);
    expect(s.env.EMAIL.sent).toHaveLength(1);
    // Not due yet: the cron leaves it.
    await dispatchDue(s.env);
    expect(s.env.PUBLISH.created).toHaveLength(0);

    // A public series posts on Instagram too; a slot that passed a little while ago posts at once.
    const open = addSeries(s, { accounts: [instagram, tiktok], notify: false });
    const late = await addVideo(s, { seriesId: open, slotAt: now() - HOUR });
    await videoReady(s.env, late);
    const posted = publicationsOf(s, late);
    expect(posted.map((p) => p.platform)).toEqual(["instagram", "tiktok"]);
    expect(posted.every((p) => p.private === 0 && p.scheduled_at >= now() + 59 && p.scheduled_at <= now() + 60)).toBe(true);
    expect(s.env.EMAIL.sent).toHaveLength(1);

    // A slot long gone is left for the owner to post by hand; a paused series posts nothing; an episode the owner
    // rejected is not posted.
    const missed = await addVideo(s, { seriesId: open, slotAt: now() - 4 * HOUR });
    const paused = await addVideo(s, { seriesId: addSeries(s, { accounts: [tiktok] }, "paused"), slotAt: slot });
    const rejected = await addVideo(s, { seriesId: open, slotAt: slot, status: "rejected" });
    for (const id of [missed, paused, rejected]) {
      await videoReady(s.env, id);
      expect(publicationsOf(s, id)).toHaveLength(0);
    }
  });

  it("wait for approval when the series asks for review, then go out at their slot", async () => {
    const s = setup();
    const tiktok = await addAccount(s, "tiktok");
    const series = addSeries(s, { accounts: [tiktok], review: true });
    const slot = now() + 20 * HOUR;
    const episode = await addVideo(s, { seriesId: series, slotAt: slot, status: "pending" });
    await videoReady(s.env, episode);
    expect(publicationsOf(s, episode)).toHaveLength(0);
    expect(s.env.EMAIL.sent[0].text).toContain("It's waiting for your review");

    let r = await call(worker, s.env, "POST", `/api/videos/${episode}/review`, { decision: "approve" }, s.user.cookie);
    expect(r.data).toEqual({ ok: true, status: "approved", scheduled: 1 });
    expect(publicationsOf(s, episode)).toEqual([expect.objectContaining({ account_id: tiktok, scheduled_at: slot, private: 0, status: "scheduled" })]);
    // Rejected after all: what was scheduled is canceled.
    r = await call(worker, s.env, "POST", `/api/videos/${episode}/review`, { decision: "reject" }, s.user.cookie);
    expect(r.data).toEqual({ ok: true, status: "rejected", scheduled: 0 });
    expect(publicationsOf(s, episode)[0].status).toBe("canceled");
    expect(video(s, episode).status).toBe("rejected");
  });
});

describe("dispatching due publications", () => {
  it("claims only due publications of ready videos and starts one workflow each", async () => {
    const s = setup();
    const account = await addAccount(s, "tiktok");
    const due = addPublication(s, await addVideo(s), account, "tiktok", { at: now() - 30 });
    const later = addPublication(s, await addVideo(s), account, "tiktok", { at: now() + HOUR });
    const canceled = addPublication(s, await addVideo(s), account, "tiktok", { at: now() - 30, status: "canceled" });
    await dispatchDue(s.env);
    expect(publication(s, due)).toMatchObject({ status: "publishing", attempts: 1 });
    expect(publication(s, due).token).toMatch(/^[0-9a-f]{64}$/);
    expect(publication(s, due).claimed_at).toBeGreaterThan(now() - 5);
    expect(publication(s, later).status).toBe("scheduled");
    expect(publication(s, canceled).status).toBe("canceled");
    expect(s.env.PUBLISH.created).toEqual([{ id: `pub-${due}-1`, params: { publicationId: due } }]);
    // Claimed once: the next run does not start it again.
    await dispatchDue(s.env);
    expect(s.env.PUBLISH.created).toHaveLength(1);
  });

  it("waits while the video is being made, and fails it when the making failed or stalled", async () => {
    const s = setup();
    const tiktok = await addAccount(s, "tiktok"), youtube = await addAccount(s, "youtube");
    // An edit is being rendered again: the publication waits for it.
    const remade = await addVideo(s, { render: "running", updatedAt: now() - 5 * HOUR });
    const waiting = addPublication(s, remade, tiktok, "tiktok", { at: now() - 2 * HOUR });
    const stalled = await addVideo(s, { render: "queued", updatedAt: now() - 7 * HOUR });
    const given = addPublication(s, stalled, tiktok, "tiktok");
    const broken = await addVideo(s, { render: "failed" });
    const failed = addPublication(s, broken, tiktok, "tiktok");
    const notDue = addPublication(s, broken, youtube, "youtube", { at: now() + HOUR });
    await dispatchDue(s.env);
    expect(publication(s, waiting)).toMatchObject({ status: "scheduled", attempts: 0, token: null, error: null });
    expect(s.env.PUBLISH.created).toEqual([]);
    expect(publication(s, given)).toMatchObject({ status: "failed", error: NOT_MADE, attempts: 0 });
    expect(publication(s, failed)).toMatchObject({ status: "failed", error: NOT_MADE });
    expect(publication(s, notDue)).toMatchObject({ status: "scheduled", error: null });

    // Made: it goes out on the next run.
    s.sqlite.prepare("UPDATE videos SET render_status='ready' WHERE id=?").run(remade);
    await dispatchDue(s.env);
    expect(publication(s, waiting)).toMatchObject({ status: "publishing", attempts: 1 });
    expect(s.env.PUBLISH.created).toEqual([{ id: `pub-${waiting}-1`, params: { publicationId: waiting } }]);

    // Past the wait limit (six hours) a render that never finishes is given up.
    const slow = await addVideo(s, { render: "running" });
    const queued = addPublication(s, slow, youtube, "youtube");
    await dispatchDue(s.env);
    expect(publication(s, queued).status).toBe("scheduled");
    s.sqlite.prepare("UPDATE videos SET updated_at=? WHERE id=?").run(now() - 6 * HOUR - 60, slow);
    await dispatchDue(s.env);
    expect(publication(s, queued)).toMatchObject({ status: "failed", error: NOT_MADE });
    expect(s.env.PUBLISH.created).toHaveLength(1);
  });

  it("puts a publication back when its workflow cannot start, and times out stuck ones", async () => {
    const s = setup();
    const account = await addAccount(s, "tiktok");
    const due = addPublication(s, await addVideo(s), account, "tiktok");
    s.env.PUBLISH.create = async () => { throw new Error("unavailable"); };
    s.env.PUBLISH.get = async () => { throw new Error("not found"); };
    vi.spyOn(console, "error").mockImplementation(() => {});
    await dispatchDue(s.env);
    expect(publication(s, due)).toMatchObject({ status: "scheduled", token: null, claimed_at: null, attempts: 1 });

    const stuck = addPublication(s, await addVideo(s), account, "tiktok", { at: now() - 3 * HOUR, status: "publishing" });
    s.sqlite.prepare("UPDATE publications SET claimed_at=?,token='t' WHERE id=?").run(now() - 3 * HOUR, stuck);
    await dispatchDue(s.env);
    expect(publication(s, stuck)).toMatchObject({ status: "failed", token: null });
    expect(publication(s, stuck).error).toBe("TikTok took too long to confirm this post. Check your TikTok profile before retrying.");
    vi.restoreAllMocks();
  });
});

describe("media links", () => {
  it("serve the video only while publishing, with the right token, and support ranges", async () => {
    const s = setup();
    const account = await addAccount(s, "instagram");
    const v = await addVideo(s, { bytes: 1000 });
    const pubId = addPublication(s, v, account, "instagram");
    const base = `${SITE}/api/publish-media/${pubId}`;
    expect((await fetchMedia(s, `${base}/0.mp4?token=${"a".repeat(64)}`)).status).toBe(404);
    await dispatchDue(s.env);
    const token = publication(s, pubId).token;
    expect((await fetchMedia(s, `${base}/0.mp4?token=${"a".repeat(64)}`)).status).toBe(404);
    expect((await fetchMedia(s, `${base}/0.mp4?token=${token.toUpperCase()}`)).status).toBe(404);
    // Only the video (file 0) is ever served.
    expect((await fetchMedia(s, `${base}/1.jpg?token=${token}`)).status).toBe(404);

    const full = await fetchMedia(s, `${base}/0.mp4?token=${token}`);
    expect(full.status).toBe(200);
    expect(full.headers.get("Content-Type")).toBe("video/mp4");
    expect(full.headers.get("Content-Length")).toBe("1000");
    expect(full.headers.get("Accept-Ranges")).toBe("bytes");
    expect(full.headers.get("Cache-Control")).toBe("private, no-store");
    expect(full.bytes).toEqual(fill(1000, 1));
    const head = await fetchMedia(s, `${base}/0.mp4?token=${token}`, {}, "HEAD");
    expect(head.status).toBe(200);
    expect(head.headers.get("Content-Length")).toBe("1000");
    expect(head.bytes).toHaveLength(0);

    const part = await fetchMedia(s, `${base}/0?token=${token}`, { Range: "bytes=10-19" });
    expect(part.status).toBe(206);
    expect(part.headers.get("Content-Range")).toBe("bytes 10-19/1000");
    expect(part.headers.get("Content-Length")).toBe("10");
    expect(part.bytes).toEqual(fill(1000, 1).slice(10, 20));
    const tail = await fetchMedia(s, `${base}/0?token=${token}`, { Range: "bytes=-5" });
    expect(tail.status).toBe(206);
    expect(tail.bytes).toEqual(fill(1000, 1).slice(995));
    const rest = await fetchMedia(s, `${base}/0?token=${token}`, { Range: "bytes=999-" });
    expect(rest.bytes).toEqual(fill(1000, 1).slice(999));
    const outside = await fetchMedia(s, `${base}/0?token=${token}`, { Range: "bytes=1000-" });
    expect(outside.status).toBe(416);
    expect(outside.headers.get("Content-Range")).toBe("bytes */1000");

    // A day after the claim the link stops working, and so it does once the publication is done.
    s.sqlite.prepare("UPDATE publications SET claimed_at=? WHERE id=?").run(now() - 25 * HOUR, pubId);
    expect((await fetchMedia(s, `${base}/0.mp4?token=${token}`)).status).toBe(404);
    s.sqlite.prepare("UPDATE publications SET claimed_at=?,status='published' WHERE id=?").run(now(), pubId);
    expect((await fetchMedia(s, `${base}/0.mp4?token=${token}`)).status).toBe(404);
  });
});

describe("publishing", () => {
  const tiktokCreator = () => ok({ data: { creator_username: "brandco", privacy_level_options: ["FOLLOWER_OF_CREATOR", "PUBLIC_TO_EVERYONE", "SELF_ONLY"], comment_disabled: false, duet_disabled: true, stitch_disabled: false, max_video_post_duration_sec: 600 }, error: { code: "ok" } });
  const tiktokInit = (publishId: string) => () =>
    ok({ data: { publish_id: publishId, upload_url: "https://open-upload.tiktokapis.com/video/?upload_id=1&upload_token=abc" }, error: { code: "ok" } });

  it("checks the TikTok chunk plan", () => {
    expect(tiktokChunks(5000)).toEqual({ chunkSize: 5000, count: 1 });
    expect(tiktokChunks(10 * MiB)).toEqual({ chunkSize: 10 * MiB, count: 1 });
    // The last chunk takes the rest (up to twice the chunk size).
    expect(tiktokChunks(25 * MiB)).toEqual({ chunkSize: 10 * MiB, count: 2 });
    expect(tiktokChunks(30 * MiB)).toEqual({ chunkSize: 10 * MiB, count: 3 });
  });

  it("posts a TikTok video: creator info, chunked upload after a checkpoint, status", async () => {
    const s = setup();
    const account = await addAccount(s, "tiktok");
    const size = 20 * MiB + 5;
    const pubId = addPublication(s, await addVideo(s, { bytes: size }), account, "tiktok");
    const tickets: string[] = [];
    const calls = mockFetch([
      ["POST", "https://open.tiktokapis.com/v2/post/publish/creator_info/query/", tiktokCreator],
      ["POST", "https://open.tiktokapis.com/v2/post/publish/video/init/", tiktokInit("v_pub_file~v2.123")],
      ["PUT", "https://open-upload.tiktokapis.com/video/", () => {
        tickets.push(publication(s, pubId).ticket);
        return new Response(null, { status: 201 });
      }],
      ["POST", "https://open.tiktokapis.com/v2/post/publish/status/fetch/", sequence(
        () => ok({ data: { status: "PROCESSING_UPLOAD" }, error: { code: "ok" } }),
        // A 64-bit post ID that a JSON number would round.
        () => new Response('{"data":{"status":"PUBLISH_COMPLETE","publicaly_available_post_id":[7412345678901234567]},"error":{"code":"ok"}}', { status: 200 }),
      )],
    ]);
    const p = await publish(s, pubId);
    expect(p).toMatchObject({ status: "published", external_id: "7412345678901234567", url: "https://www.tiktok.com/@brandco/video/7412345678901234567", ticket: null, token: null, error: null });
    expect(p.published_at).toBeGreaterThan(now() - 5);
    const init = jsonBody(calls.find((c) => c.url.pathname.endsWith("/video/init/"))!);
    expect(init.post_info).toEqual({
      title: "Meet the new blender.\nIt is quiet.\n\n#kitchen #launch", privacy_level: "PUBLIC_TO_EVERYONE", disable_duet: true, disable_comment: false,
      disable_stitch: false, video_cover_timestamp_ms: 1000, brand_content_toggle: false, brand_organic_toggle: false, is_aigc: false,
    });
    expect(init.source_info).toEqual({ source: "FILE_UPLOAD", video_size: size, chunk_size: 10 * MiB, total_chunk_count: 2 });
    // The ticket is saved before the first byte goes out: a replayed step polls instead of posting again.
    expect(tickets.map((t) => JSON.parse(t))).toEqual([0, 1].map(() => ({ stage: "status", publishId: "v_pub_file~v2.123", kind: "video", username: "brandco" })));
    const puts = calls.filter((c) => c.method === "PUT");
    expect(puts.map((c) => c.headers.get("Content-Range"))).toEqual([`bytes 0-${10 * MiB - 1}/${size}`, `bytes ${10 * MiB}-${size - 1}/${size}`]);
    expect(puts.every((c) => c.headers.get("Content-Type") === "video/mp4" && c.headers.get("Authorization") === null)).toBe(true);
    const file = fill(size, 1);
    expect(same(bytesOf(puts[0]), file.subarray(0, 10 * MiB))).toBe(true);
    expect(same(bytesOf(puts[1]), file.subarray(10 * MiB))).toBe(true);
    expect(calls.filter((c) => c.url.pathname.endsWith("/status/fetch/")).map((c) => jsonBody(c).publish_id)).toEqual(["v_pub_file~v2.123", "v_pub_file~v2.123"]);
    expect(calls.filter((c) => c.url.hostname === "open.tiktokapis.com").every((c) => c.headers.get("Authorization") === "Bearer tiktok-access")).toBe(true);
    expect(calls.every((c) => c.redirect === "manual")).toBe(true);
  });

  it("posts on TikTok privately when asked, and privately when TikTok refuses public posts from an unaudited app", async () => {
    const s = setup();
    const account = await addAccount(s, "tiktok");
    const levels: string[] = [];
    let refuse = false;
    mockFetch([
      ["POST", "https://open.tiktokapis.com/v2/post/publish/creator_info/query/", tiktokCreator],
      ["POST", "https://open.tiktokapis.com/v2/post/publish/video/init/", (c) => {
        const level = jsonBody(c).post_info.privacy_level;
        levels.push(level);
        if (refuse && level !== "SELF_ONLY") return ok({ error: { code: "unaudited_client_can_only_post_to_private_accounts", message: "x" } }, { status: 403 });
        return tiktokInit("v_pub_file~v2.7")();
      }],
      ["PUT", "https://open-upload.tiktokapis.com/video/", () => new Response(null, { status: 201 })],
      // A private post never gets a public ID.
      ["POST", "https://open.tiktokapis.com/v2/post/publish/status/fetch/", () => ok({ data: { status: "PUBLISH_COMPLETE", publicaly_available_post_id: [] }, error: { code: "ok" } })],
    ]);
    const asked = addPublication(s, await addVideo(s), account, "tiktok", { private: true });
    expect(await publish(s, asked)).toMatchObject({ status: "published", external_id: "v_pub_file~v2.7", url: null });
    expect(levels).toEqual(["SELF_ONLY"]);

    refuse = true;
    const unaudited = addPublication(s, await addVideo(s), account, "tiktok");
    expect(await publish(s, unaudited)).toMatchObject({ status: "published", external_id: "v_pub_file~v2.7" });
    expect(levels).toEqual(["SELF_ONLY", "PUBLIC_TO_EVERYONE", "SELF_ONLY"]);

    // Never more widely than asked: without SELF_ONLY on offer, a private post is refused before anything is sent.
    const calls = mockFetch([
      ["POST", "https://open.tiktokapis.com/v2/post/publish/creator_info/query/", () => ok({ data: { creator_username: "brandco", privacy_level_options: ["PUBLIC_TO_EVERYONE"], max_video_post_duration_sec: 600 }, error: { code: "ok" } })],
    ]);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const strict = addPublication(s, await addVideo(s), account, "tiktok", { private: true });
    expect(await publish(s, strict)).toMatchObject({ status: "failed", error: expect.stringMatching(/doesn't offer private posting/) });
    expect(calls.map((c) => c.url.pathname)).toEqual(["/v2/post/publish/creator_info/query/"]);
  });

  it("sends a TikTok video to the creator's inbox as a draft: the file only, done once it's in the inbox", async () => {
    const s = setup({ TIKTOK_DIRECT_POST: "" });
    const account = await addAccount(s, "tiktok");
    const size = 20 * MiB + 5;
    const video = await addVideo(s, { bytes: size });
    // "Post privately" doesn't apply to a draft: the creator chooses who sees it in TikTok.
    const pubId = addPublication(s, video, account, "tiktok", { private: true });
    const tickets: string[] = [];
    const calls = mockFetch([
      ["POST", "https://open.tiktokapis.com/v2/post/publish/inbox/video/init/", tiktokInit("v_inbox_file~v2.5")],
      ["PUT", "https://open-upload.tiktokapis.com/video/", () => {
        tickets.push(publication(s, pubId).ticket);
        return new Response(null, { status: 201 });
      }],
      ["POST", "https://open.tiktokapis.com/v2/post/publish/status/fetch/", sequence(
        () => ok({ data: { status: "PROCESSING_UPLOAD" }, error: { code: "ok" } }),
        () => ok({ data: { status: "SEND_TO_USER_INBOX" }, error: { code: "ok" } }),
      )],
    ]);
    const p = await publish(s, pubId);
    expect(p).toMatchObject({ status: "published", draft: 1, external_id: "v_inbox_file~v2.5", url: null, ticket: null, token: null, error: null });
    // No creator info (it needs video.publish), and no caption or privacy: the Upload API takes the file only.
    expect(calls.map((c) => c.url.pathname)).toEqual([
      "/v2/post/publish/inbox/video/init/", "/video/", "/video/", "/v2/post/publish/status/fetch/", "/v2/post/publish/status/fetch/",
    ]);
    expect(jsonBody(calls[0])).toEqual({ source_info: { source: "FILE_UPLOAD", video_size: size, chunk_size: 10 * MiB, total_chunk_count: 2 } });
    // The ticket is saved before the first byte goes out, as for a direct post.
    expect(tickets.map((t) => JSON.parse(t))).toEqual([0, 1].map(() => ({ stage: "status", publishId: "v_inbox_file~v2.5", kind: "draft" })));
    // The app shows it as sent to drafts, and its stats are never read (we never learn the post made from it).
    const shown = await call(worker, s.env, "GET", `/api/videos/${video}`, undefined, s.user.cookie);
    expect(shown.data.video.publications).toMatchObject([{ id: pubId, status: "published", draft: 1, url: null }]);
    expect(await dueForStats(s.env, 10, now() + DAY)).toEqual([]);

    // A creator who posted it before our first check: the post is recorded, still marked as having come from a draft.
    mockFetch([
      ["POST", "https://open.tiktokapis.com/v2/post/publish/inbox/video/init/", tiktokInit("v_inbox_file~v2.6")],
      ["PUT", "https://open-upload.tiktokapis.com/video/", () => new Response(null, { status: 201 })],
      ["POST", "https://open.tiktokapis.com/v2/post/publish/status/fetch/", () => ok({ data: { status: "PUBLISH_COMPLETE", publicaly_available_post_id: [] }, error: { code: "ok" } })],
    ]);
    const quick = await publish(s, addPublication(s, await addVideo(s), account, "tiktok"));
    expect(quick).toMatchObject({ status: "published", draft: 1, external_id: "v_inbox_file~v2.6" });
  });

  it("asks people to clear their TikTok inbox when too many drafts are waiting", async () => {
    const s = setup({ TIKTOK_DIRECT_POST: "" });
    const account = await addAccount(s, "tiktok");
    const pubId = addPublication(s, await addVideo(s), account, "tiktok");
    const calls = mockFetch([
      ["POST", "https://open.tiktokapis.com/v2/post/publish/inbox/video/init/", () => ok({ error: { code: "spam_risk_too_many_pending_share", message: "x" } }, { status: 403 })],
    ]);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const p = await publish(s, pubId);
    // Tried again after 1, 5 and 15 minutes, then a message saying what to do.
    expect(calls).toHaveLength(4);
    expect(p).toMatchObject({ status: "failed", draft: 0 });
    expect(p.error).toBe("Too many TikTok drafts from this app are waiting in your TikTok inbox. Post or delete some in TikTok, then try again.");
  });

  it("labels a post as AI-made when its video contains AI media", async () => {
    const s = setup();
    const tiktok = await addAccount(s, "tiktok"), youtube = await addAccount(s, "youtube");
    const calls = mockFetch([
      ["POST", "https://open.tiktokapis.com/v2/post/publish/creator_info/query/", tiktokCreator],
      ["POST", "https://open.tiktokapis.com/v2/post/publish/video/init/", tiktokInit("v_pub_file~v2.9")],
      ["PUT", "https://open-upload.tiktokapis.com/video/", () => new Response(null, { status: 201 })],
      ["POST", "https://open.tiktokapis.com/v2/post/publish/status/fetch/", () => ok({ data: { status: "PUBLISH_COMPLETE", publicaly_available_post_id: ["1"] }, error: { code: "ok" } })],
      ["POST", "https://www.googleapis.com/upload/youtube/v3/videos", () => new Response(null, { status: 200, headers: { Location: "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=s" } })],
      ["PUT", "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=s", () => ok({ id: "abcdefghijk", status: { uploadStatus: "uploaded" } })],
    ]);
    // The rendered file has AI pictures or clips in it (marked by the render)…
    const pictures = await addVideo(s, { ai: true });
    expect((await publish(s, addPublication(s, pictures, tiktok, "tiktok"))).status).toBe("published");
    // …or an AI voice reads it.
    const voiced = await addVideo(s, { spec: { narration: { kind: "voice", voiceId: "george" } } });
    expect((await publish(s, addPublication(s, voiced, tiktok, "tiktok"))).status).toBe("published");
    expect((await publish(s, addPublication(s, voiced, youtube, "youtube"))).status).toBe("published");
    const inits = calls.filter((c) => c.url.pathname.endsWith("/video/init/")).map(jsonBody);
    expect(inits.map((b) => b.post_info.is_aigc)).toEqual([true, true]);
    const start = calls.find((c) => c.method === "POST" && c.url.hostname === "www.googleapis.com")!;
    expect(jsonBody(start).status.containsSyntheticMedia).toBe(true);
  });

  it("posts an Instagram Reel from our media link once its container is ready", async () => {
    const s = setup();
    const account = await addAccount(s, "instagram", { externalId: "17841400000000000", tokens: { refreshToken: undefined } });
    const pubId = addPublication(s, await addVideo(s, { bytes: 3000 }), account, "instagram");
    let fetched: { status: number; bytes: Uint8Array } | null = null;
    const calls = mockFetch([
      ["POST", "https://graph.instagram.com/v23.0/17841400000000000/media_publish", () => ok({ id: "18000000000000002" })],
      ["POST", "https://graph.instagram.com/v23.0/17841400000000000/media", async (c) => {
        // Instagram pulls the video from the link while it makes the container.
        fetched = await fetchMedia(s, (c.body as URLSearchParams).get("video_url")!);
        return ok({ id: "18000000000000001" });
      }],
      ["GET", "https://graph.instagram.com/v23.0/18000000000000001", sequence(() => ok({ status_code: "IN_PROGRESS" }), () => ok({ status_code: "FINISHED" }))],
      ["GET", "https://graph.instagram.com/v23.0/18000000000000002", () => ok({ permalink: "https://www.instagram.com/reel/AbC123/", id: "18000000000000002" })],
    ]);
    const p = await publish(s, pubId);
    expect(p).toMatchObject({ status: "published", external_id: "18000000000000002", url: "https://www.instagram.com/reel/AbC123/", token: null, ticket: null });
    expect(fetched).toMatchObject({ status: 200 });
    expect(fetched!.bytes).toEqual(fill(3000, 1));
    const created = calls.find((c) => c.url.pathname.endsWith("/media"))!;
    const fields = created.body as URLSearchParams;
    expect(fields.get("media_type")).toBe("REELS");
    expect(fields.get("share_to_feed")).toBe("true");
    expect(fields.get("caption")).toBe("Meet the new blender.\nIt is quiet.\n\n#kitchen #launch");
    expect(fields.get("video_url")).toMatch(new RegExp(`^${SITE}/api/publish-media/${pubId}/0\\.mp4\\?token=[0-9a-f]{64}$`));
    expect(created.headers.get("Authorization")).toBe("Bearer instagram-access");
    expect((calls.find((c) => c.url.pathname.endsWith("/media_publish"))!.body as URLSearchParams).get("creation_id")).toBe("18000000000000001");
    // Once published, the link no longer works.
    expect((await fetchMedia(s, fields.get("video_url")!)).status).toBe(404);
  });

  it("fails clearly when Instagram refuses the media, without its text", async () => {
    const s = setup();
    const account = await addAccount(s, "instagram", { externalId: "555" });
    const pubId = addPublication(s, await addVideo(s), account, "instagram");
    mockFetch([["POST", "https://graph.instagram.com/v23.0/555/media", () =>
      ok({ error: { message: "The video format is not supported <details>", type: "OAuthException", code: 352, error_subcode: 2207026 } }, { status: 400 })]]);
    const p = await publish(s, pubId);
    expect(p).toMatchObject({ status: "failed", ticket: null, token: null });
    expect(p.error).toBe("Instagram didn't accept this post. Check that it meets Instagram's requirements.");
  });

  it("uploads a YouTube Short with a refreshed token", async () => {
    const s = setup();
    // The token expires in a minute: it is refreshed (and saved) before the upload.
    const account = await addAccount(s, "youtube", { tokens: { expiresAt: now() + 60 } });
    const pubId = addPublication(s, await addVideo(s, { spec: { title: "Quiet blender <3" } }), account, "youtube");
    const session = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=xyz";
    const calls = mockFetch([
      ["POST", "https://oauth2.googleapis.com/token", () => ok({ access_token: "youtube-access-2", expires_in: 3599, scope: "https://www.googleapis.com/auth/youtube.upload", token_type: "Bearer" })],
      ["POST", "https://www.googleapis.com/upload/youtube/v3/videos", () => new Response(null, { status: 200, headers: { Location: session } })],
      ["PUT", session, () => ok({ id: "dQw4w9WgXcQ", status: { uploadStatus: "uploaded" } })],
    ]);
    const p = await publish(s, pubId);
    expect(p).toMatchObject({ status: "published", external_id: "dQw4w9WgXcQ", url: "https://youtube.com/shorts/dQw4w9WgXcQ" });
    const refresh = calls[0].body as URLSearchParams;
    expect(refresh.get("grant_type")).toBe("refresh_token");
    expect(refresh.get("refresh_token")).toBe("youtube-refresh");
    expect(refresh.get("client_id")).toBe("g-client");
    const start = calls.find((c) => c.method === "POST" && c.url.pathname === "/upload/youtube/v3/videos")!;
    expect(start.url.searchParams.get("uploadType")).toBe("resumable");
    expect(start.url.searchParams.get("part")).toBe("snippet,status");
    expect(start.headers.get("Authorization")).toBe("Bearer youtube-access-2");
    expect(start.headers.get("X-Upload-Content-Length")).toBe("4096");
    expect(start.headers.get("X-Upload-Content-Type")).toBe("video/mp4");
    const meta = jsonBody(start);
    expect(meta.snippet).toEqual({ title: "Quiet blender 3", description: "Meet the new blender.\nIt is quiet.\n\n#kitchen #launch #Shorts", categoryId: "22" });
    expect(meta.status).toEqual({ privacyStatus: "public", selfDeclaredMadeForKids: false, containsSyntheticMedia: false });
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.headers.get("Content-Range")).toBe("bytes 0-4095/4096");
    expect(same(bytesOf(put), fill(4096, 1))).toBe(true);
    const stored: any = s.sqlite.prepare("SELECT credentials,expires_at,status FROM social_accounts WHERE id=?").get(account);
    expect(await open<Tokens>(s.env, stored.credentials)).toMatchObject({ accessToken: "youtube-access-2", refreshToken: "youtube-refresh" });
    // Google refresh tokens do not expire on a schedule.
    expect(stored).toMatchObject({ expires_at: null, status: "active" });
  });

  it("resumes an interrupted YouTube upload instead of uploading a second video (and posts privately when asked)", async () => {
    const s = setup();
    const account = await addAccount(s, "youtube");
    const pubId = addPublication(s, await addVideo(s), account, "youtube", { private: true });
    const session = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=abc";
    const calls = mockFetch([
      ["POST", "https://www.googleapis.com/upload/youtube/v3/videos", () => new Response(null, { status: 200, headers: { Location: session } })],
      ["PUT", session, sequence(
        () => { throw new TypeError("network connection lost"); },
        // Status check: Google has the first 1000 bytes.
        () => new Response(null, { status: 308, headers: { Range: "bytes=0-999" } }),
        () => ok({ id: "abcdefghijk", status: { uploadStatus: "uploaded" } }),
      )],
    ]);
    const p = await publish(s, pubId);
    expect(p).toMatchObject({ status: "published", external_id: "abcdefghijk" });
    const starts = calls.filter((c) => c.method === "POST");
    expect(starts).toHaveLength(1);
    expect(jsonBody(starts[0]).status.privacyStatus).toBe("private");
    const puts = calls.filter((c) => c.method === "PUT");
    expect(puts.map((c) => c.headers.get("Content-Range"))).toEqual(["bytes 0-4095/4096", "bytes */4096", "bytes 1000-4095/4096"]);
    expect(bytesOf(puts[2])).toEqual(fill(4096, 1).slice(1000));
  });

  it("marks the account expired when its token cannot be refreshed", async () => {
    const s = setup();
    const account = await addAccount(s, "tiktok", { tokens: { expiresAt: now() - 10 } });
    const pubId = addPublication(s, await addVideo(s), account, "tiktok");
    const calls = mockFetch([
      ["POST", "https://open.tiktokapis.com/v2/oauth/token/", () => ok({ error: "invalid_grant", error_description: "Refresh token is invalid", log_id: "x" }, { status: 400 })],
    ]);
    const p = await publish(s, pubId);
    expect(calls).toHaveLength(1);
    expect(p).toMatchObject({ status: "failed", token: null });
    expect(p.error).toBe("Reconnect your TikTok account, then try again.");
    expect((s.sqlite.prepare("SELECT status FROM social_accounts WHERE id=?").get(account) as any).status).toBe("expired");
  });

  it("retries a start the network refused for a while, then gives up with a plain message", async () => {
    const s = setup();
    const account = await addAccount(s, "tiktok");
    const pubId = addPublication(s, await addVideo(s), account, "tiktok");
    const calls = mockFetch([
      ["POST", "https://open.tiktokapis.com/v2/post/publish/creator_info/query/", () => ok({ error: { code: "rate_limit_exceeded", message: "slow down" } }, { status: 429 })],
    ]);
    const p = await publish(s, pubId);
    expect(calls).toHaveLength(4);
    expect(p).toMatchObject({ status: "failed", ticket: null });
    expect(p.error).toBe("TikTok is limiting how often this account can post. Try again later.");
  });

  it("does nothing for a publication that is no longer being published, and fails videos that can't go out", async () => {
    const s = setup();
    const account = await addAccount(s, "tiktok");
    const calls = mockFetch([]);
    const canceled = addPublication(s, await addVideo(s), account, "tiktok", { status: "canceled" });
    await new Publication({} as any, s.env).run({ payload: { publicationId: canceled } } as any, step as any);
    expect(publication(s, canceled)).toMatchObject({ status: "canceled", attempts: 0, error: null });
    // Rejected after it was scheduled, or now too long for the network (an edit made it longer).
    const rejected = await addVideo(s);
    const pubId = addPublication(s, rejected, account, "tiktok");
    s.sqlite.prepare("UPDATE videos SET status='rejected' WHERE id=?").run(rejected);
    let p = await publish(s, pubId);
    expect(p.status).toBe("failed");
    expect(p.error).toBe("This post isn't ready to publish. Check that it is approved and finished.");
    const longer = await addVideo(s);
    const tooLong = addPublication(s, longer, account, "tiktok");
    s.sqlite.prepare("UPDATE videos SET duration=900 WHERE id=?").run(longer);
    p = await publish(s, tooLong);
    expect(p).toMatchObject({ status: "failed", error: "This post isn't ready to publish. Check that it is approved and finished." });
    expect(calls).toHaveLength(0);
    // A workflow of an earlier attempt finds a newer one owns the publication and leaves it alone.
    s.sqlite.prepare("UPDATE publications SET status='publishing',attempts=3,error=NULL WHERE id=?").run(tooLong);
    await new Publication({} as any, s.env).run({ payload: { publicationId: tooLong }, instanceId: `pub-${tooLong}-2` } as any, step as any);
    expect(publication(s, tooLong)).toMatchObject({ status: "publishing", error: null });
  });

  it("renews Instagram tokens in their last days, and marks ended connections", async () => {
    const s = setup();
    const renewed = await addAccount(s, "instagram", { tokens: { refreshToken: undefined, accessToken: "ig-old", expiresAt: now() + 5 * DAY }, expiresAt: now() + 5 * DAY });
    // Its token ends in a minute and Instagram no longer renews it (revoked): it has to be connected again.
    const revoked = await addAccount(s, "instagram", { tokens: { refreshToken: undefined, accessToken: "ig-revoked", expiresAt: now() + 60 }, expiresAt: now() + 60 });
    const fresh = await addAccount(s, "instagram", { tokens: { refreshToken: undefined }, expiresAt: now() + 40 * DAY });
    const gone = await addAccount(s, "tiktok", { expiresAt: now() - 10 });
    const calls = mockFetch([["GET", "https://graph.instagram.com/refresh_access_token", (c) =>
      c.url.searchParams.get("access_token") === "ig-old"
        ? ok({ access_token: "ig-renewed", token_type: "bearer", expires_in: 5184000 })
        : ok({ error: { message: "Error validating access token", type: "OAuthException", code: 190 } }, { status: 400 })]]);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await refreshAccounts(s.env);
    expect(calls.map((c) => [c.url.searchParams.get("grant_type"), c.url.searchParams.get("access_token")]).sort())
      .toEqual([["ig_refresh_token", "ig-old"], ["ig_refresh_token", "ig-revoked"]]);
    const row: any = s.sqlite.prepare("SELECT * FROM social_accounts WHERE id=?").get(renewed);
    expect((await open<Tokens>(s.env, row.credentials)).accessToken).toBe("ig-renewed");
    expect(row.expires_at).toBeGreaterThan(now() + 59 * DAY);
    const status = (id: string) => (s.sqlite.prepare("SELECT status FROM social_accounts WHERE id=?").get(id) as any).status;
    expect([status(renewed), status(revoked), status(fresh), status(gone)]).toEqual(["active", "expired", "active", "expired"]);
    vi.restoreAllMocks();
  });
});
