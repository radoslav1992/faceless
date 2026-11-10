import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../server/index";
import { dispatchSeries, runEpisode, videoReady } from "../server/series";
import { now, HOUR, MINUTE } from "../server/types";
import { call, signedIn, subscribe, testEnv } from "./helpers";
import { episodeCredits, LATE_GRACE, MAKE_AHEAD, seriesSettingsSchema } from "../shared/series";
import { slots } from "../shared/schedule";
import { estimatedSeconds } from "../shared/formats";
import { videoCredits } from "../shared/credits";

// Series on autopilot: creating one (checked against the plan and the account), the cron handing due slots to the
// workflow, one episode per slot, skipped slots and their reasons, pausing, and the notices to the owner.

afterEach(() => vi.restoreAllMocks());

/** What the text model answers when asked to write an episode. */
const episode = (n = 1) => ({
  status: "completed",
  output_text: JSON.stringify({
    title: `Octopus fact ${n}`, topic: "Octopuses", caption: "Nature is weird.", hashtags: ["#ocean"], headline: "Three hearts", subject: "", music: "",
    scenes: [
      { text: "Octopuses have three hearts and blue blood.", picture: "An orange octopus pointing at three hearts", keys: ["hearts"] },
      { text: "Two of them stop when it swims, so it would rather crawl.", picture: "An octopus crawling over rocks", keys: ["crawl"] },
    ],
  }),
});
function setup(plan: "starter" | "daily" | null = "daily") {
  const { env, sqlite } = testEnv({ MEDIA_ENABLED: "true", FAL_KEY: "fal", ELEVENLABS_API_KEY: "el" });
  const user = signedIn(sqlite);
  if (plan) subscribe(sqlite, user.id, plan);
  let n = 0;
  env.AI.run = async () => episode(++n);
  const create = (body: Record<string, unknown> = {}) =>
    call(worker, env, "POST", "/api/series", { name: "Ocean facts", template: "facts", settings: { schedule: { timezone: "UTC", times: ["09:00", "18:00"], days: [0, 1, 2, 3, 4, 5, 6] } }, ...body }, user.cookie);
  const row = (id: string) => sqlite.prepare("SELECT * FROM series WHERE id=?").get(id) as any;
  const videos = (id: string) => sqlite.prepare("SELECT * FROM videos WHERE series_id=? ORDER BY slot_at").all(id) as any[];
  return { env, sqlite, user, create, row, videos };
}

describe("starting a series", () => {
  it("checks the settings against the account and the plan's number of series", async () => {
    const { env, sqlite, user, create } = setup(null);
    expect((await create({ template: "custom" })).status).toBe(400); // "your own topic" needs one
    expect((await create({ settings: { schedule: { timezone: "Mars/Olympus", times: ["09:00"], days: [1] } } })).status).toBe(400);
    const other = signedIn(sqlite);
    sqlite.prepare("INSERT INTO social_accounts(id,user_id,platform,external_id,name,credentials,status,created_at,updated_at) VALUES (?,?,'tiktok','x','Theirs','x','active',1,1)")
      .run("00000000-0000-4000-8000-000000000001", other.id);
    expect((await create({ settings: { accounts: ["00000000-0000-4000-8000-000000000001"] } })).status).toBe(400);
    expect((await create({ template: "script" })).status).toBe(400); // text to video has no autopilot
    // A confirmed email first (the free trial is once per mailbox).
    sqlite.prepare("UPDATE users SET verified=0 WHERE id=?").run(user.id);
    expect((await create()).status).toBe(403);
    sqlite.prepare("UPDATE users SET verified=1 WHERE id=?").run(user.id);
    // A series that posts to YouTube needs the creator's "made for kids" answer.
    sqlite.prepare("INSERT INTO social_accounts(id,user_id,platform,external_id,name,credentials,status,created_at,updated_at) VALUES (?,?,'youtube','UC1','Mine','x','active',1,1)")
      .run("00000000-0000-4000-8000-000000000002", user.id);
    const posting = (madeForKids?: boolean) => ({
      settings: { schedule: { timezone: "UTC", times: ["09:00"], days: [1] }, accounts: ["00000000-0000-4000-8000-000000000002"], ...(madeForKids !== undefined && { madeForKids }) },
    });
    const unanswered = await create(posting());
    expect(unanswered.status).toBe(400);
    expect(unanswered.data.error).toBe("Say whether the episodes are made for kids. YouTube asks every creator whether their videos are made for kids.");
    // The free trial runs one series.
    const first = await create(posting(false));
    expect(first.status).toBe(201);
    const second = await create({ name: "Another" });
    expect(second.status).toBe(402);
    expect(second.data.error).toMatch(/1 series/);
    expect((await call(worker, env, "GET", "/api/series", undefined, user.cookie)).data.series).toHaveLength(1);
  });

  it("plans the first slot and starts its episode at once, so the owner sees it before anything posts", async () => {
    const { env, sqlite, user, create, row } = setup();
    const r = await create();
    expect(r.data).toMatchObject({ started: true, series: { status: "active", template: "facts", credits: episodeCredits(seriesSettingsSchema.parse({})) } });
    const s = row(r.data.series.id);
    expect(s.next_slot).toBe(slots({ timezone: "UTC", times: ["09:00", "18:00"], days: [0, 1, 2, 3, 4, 5, 6] }, now() + 10 * MINUTE)[0]);
    expect(env.CONTENT.created).toEqual([{ id: `episode-${s.id}-${s.next_slot}`, params: { episode: { seriesId: s.id, slot: s.next_slot, first: true } } }]);
    // Claimed while that episode is written: the cron starts no second writer for the same slot.
    sqlite.prepare("UPDATE series SET next_slot=? WHERE id=?").run(now() + 3600, s.id);
    await dispatchSeries(env);
    expect(env.CONTENT.created).toHaveLength(1);
    // (Back to the planned slot: within an hour before a slot, the hour ahead set above lies past it.)
    sqlite.prepare("UPDATE series SET next_slot=? WHERE id=?").run(s.next_slot, s.id);
    // The page shows the coming slots (none made yet); nobody else sees the series.
    const page = (await call(worker, env, "GET", `/api/series/${s.id}`, undefined, user.cookie)).data;
    expect(page.upcoming[0]).toEqual({ at: s.next_slot, made: false });
    expect(page.upcoming.length).toBeGreaterThan(20);
    expect((await call(worker, env, "GET", `/api/series/${s.id}`, undefined, signedIn(sqlite).cookie)).status).toBe(404);
  });

  it("never lists a slot the series won't make: started minutes before a posting time, it begins at the next", async () => {
    // 08:55 UTC: the 09:00 slot is too close, so the first episode is for 18:00 (and the page starts there).
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-11-03T08:55:00Z"));
      const { env, user, create, row } = setup();
      const s = row((await create()).data.series.id);
      expect(s.next_slot).toBe(Date.parse("2026-11-03T18:00:00Z") / 1000);
      const page = (await call(worker, env, "GET", `/api/series/${s.id}`, undefined, user.cookie)).data;
      expect(page.upcoming[0]).toEqual({ at: s.next_slot, made: false });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("episodes", () => {
  it("play sound effects when the series has them on: new series start with them, older ones keep none", async () => {
    const { env, sqlite, create, videos } = setup();
    const whoosh = crypto.randomUUID();
    sqlite.prepare("INSERT INTO library_items(id,kind,name,category,tags,object_key,mime,bytes,duration,active,created_at) VALUES (?,'sfx','Whoosh','Transition','',?,'audio/mpeg',10,1,1,1)")
      .run(whoosh, `library/${whoosh}/file.mp3`);
    expect(seriesSettingsSchema.parse({}).sounds).toBe(false);
    const on = (await create({ settings: { schedule: { timezone: "UTC", times: ["09:00"], days: [1] }, sounds: true } })).data.series.id;
    await runEpisode(env, on, (sqlite.prepare("SELECT next_slot FROM series WHERE id=?").get(on) as any).next_slot);
    expect(JSON.parse(videos(on)[0].spec).sounds).toEqual({ enabled: true, volume: 0.6, transitionId: whoosh });
    const off = (await create({ name: "Quiet" })).data.series.id;
    await runEpisode(env, off, (sqlite.prepare("SELECT next_slot FROM series WHERE id=?").get(off) as any).next_slot);
    expect(JSON.parse(videos(off)[0].spec).sounds).toBeUndefined();
  });

  it("writes and creates one video per slot, charges its credits once and moves on to the next slot", async () => {
    const { env, sqlite, user, create, row, videos } = setup();
    const id = (await create()).data.series.id;
    const slot = row(id).next_slot;
    const made = await runEpisode(env, id, slot);
    expect(made.state).toBe("made");
    const [v] = videos(id);
    expect(v).toMatchObject({ slot_at: slot, status: "approved", render_status: "queued", kind: "story", title: "Octopus fact 1" });
    expect(JSON.parse(v.spec)).toMatchObject({ narration: { kind: "voice", voiceId: "george" }, headline: { text: "Three hearts" } });
    // Charged by the length of what was written (here two short sentences: one credit).
    const used = () => (sqlite.prepare("SELECT SUM(used) AS n FROM usage_windows WHERE user_id=?").get(user.id) as any).n;
    const price = videoCredits(estimatedSeconds(JSON.parse(v.spec)));
    expect(price).toBe(1);
    expect(used()).toBe(price);
    expect(row(id)).toMatchObject({ next_slot: slots({ timezone: "UTC", times: ["09:00", "18:00"], days: [0, 1, 2, 3, 4, 5, 6] }, slot)[0], failures: 0, blocked: null });
    // A retried workflow step finds the episode it already made: never two videos or two charges for one slot.
    expect(await runEpisode(env, id, slot)).toEqual({ state: "made", videoId: v.id });
    expect(videos(id)).toHaveLength(1);
    expect(used()).toBe(price);
    // The page lists it under its slot.
    const page = (await call(worker, env, "GET", `/api/series/${id}`, undefined, user.cookie)).data;
    expect(page.videos.map((x: any) => x.id)).toEqual([v.id]);
  });

  it("never charges an episode more than the series says, however long the writer ran", async () => {
    const { env, sqlite, user, create, row, videos } = setup();
    const id = (await create({ settings: { seconds: 30 } })).data.series.id;
    const long = "Octopuses have three hearts, blue blood and a brain in every arm, and they can taste with their skin. ";
    env.AI.run = async () => ({ status: "completed", output_text: JSON.stringify({
      title: "Long", topic: "Octopuses", caption: "", hashtags: [], headline: "", subject: "", music: "",
      scenes: [0, 1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ text: long, picture: `Octopus picture ${n}`, keys: [] })),
    }) });
    await runEpisode(env, id, row(id).next_slot);
    const [v] = videos(id);
    expect(videoCredits(estimatedSeconds(JSON.parse(v.spec)))).toBeGreaterThan(videoCredits(30));
    expect((sqlite.prepare("SELECT credits FROM runs WHERE video_id=?").get(v.id) as any).credits).toBe(videoCredits(30));
    expect((sqlite.prepare("SELECT SUM(used) AS n FROM usage_windows WHERE user_id=?").get(user.id) as any).n).toBe(videoCredits(30));
  });

  it("holds episodes for review when asked, and tells the owner once that one is waiting", async () => {
    const { env, sqlite, create, row, videos } = setup();
    const id = (await create({ settings: { review: true } })).data.series.id;
    await runEpisode(env, id, row(id).next_slot);
    const [v] = videos(id);
    expect(v.status).toBe("pending");
    sqlite.prepare("UPDATE videos SET render_status='ready' WHERE id=?").run(v.id);
    await videoReady(env, v.id);
    await videoReady(env, v.id);
    expect(env.EMAIL.sent).toHaveLength(1);
    expect(String(env.EMAIL.sent[0].text)).toMatch(/waiting for your review/);
    expect(env.EMAIL.sent[0].subject).toMatch(/New episode of “Ocean facts”/);
  });

  it("skips a slot without enough credits, says why once, and goes ahead when credits are back", async () => {
    const { env, sqlite, user, create, row, videos } = setup("starter");
    const id = (await create()).data.series.id;
    await call(worker, env, "GET", "/api/auth/me", undefined, user.cookie);
    sqlite.prepare("UPDATE usage_windows SET used=quota WHERE user_id=?").run(user.id);
    const first = row(id).next_slot;
    expect(await runEpisode(env, id, first)).toEqual({ state: "skipped", reason: "credits" });
    expect(videos(id)).toHaveLength(0);
    expect(row(id)).toMatchObject({ blocked: "credits" });
    expect(row(id).next_slot).toBeGreaterThan(first);
    const second = row(id).next_slot;
    await runEpisode(env, id, second);
    expect(env.EMAIL.sent.filter((m: any) => /skipped an episode/.test(m.subject))).toHaveLength(1);
    const listed = (await call(worker, env, "GET", "/api/series", undefined, user.cookie)).data.series[0];
    expect(listed.blocked).toMatch(/not enough credits/);
    sqlite.prepare("UPDATE usage_windows SET used=0 WHERE user_id=?").run(user.id);
    expect((await runEpisode(env, id, row(id).next_slot)).state).toBe("made");
    expect(row(id).blocked).toBeNull();
  });

  it("skips a slot when the storage is full, before writing it, says why once, and goes ahead when there is room", async () => {
    const { env, sqlite, user, create, row, videos } = setup("starter");
    const id = (await create()).data.series.id;
    let written = 0;
    env.AI.run = async () => episode(++written);
    await call(worker, env, "GET", "/api/auth/me", undefined, user.cookie);
    const big = crypto.randomUUID();
    sqlite.prepare("INSERT INTO media_assets(id,user_id,kind,name,object_key,mime,bytes,status,created_at,updated_at) VALUES (?,?,'upload','Big',?,'video/mp4',(SELECT max_bytes FROM media_limits WHERE user_id=?),'ready',1,1)")
      .run(big, user.id, `media/${user.id}/${big}.mp4`, user.id);
    const first = row(id).next_slot;
    expect(await runEpisode(env, id, first)).toEqual({ state: "skipped", reason: "storage" });
    expect([videos(id).length, written]).toEqual([0, 0]);
    expect(row(id)).toMatchObject({ blocked: "storage", failures: 0 });
    expect(row(id).next_slot).toBeGreaterThan(first);
    await runEpisode(env, id, row(id).next_slot);
    expect(env.EMAIL.sent.filter((m: any) => /skipped an episode/.test(m.subject))).toHaveLength(1);
    expect((await call(worker, env, "GET", "/api/series", undefined, user.cookie)).data.series[0].blocked).toMatch(/storage is full/);
    // "Make one now" says so too.
    const now = await call(worker, env, "POST", `/api/series/${id}/episodes`, { idempotencyKey: crypto.randomUUID() }, user.cookie);
    expect([now.status, now.data.error]).toEqual([413, "Your storage is full. Delete some files or videos, or upgrade your plan."]);
    sqlite.prepare("DELETE FROM media_assets WHERE id=?").run(big);
    expect((await runEpisode(env, id, row(id).next_slot)).state).toBe("made");
    expect(row(id).blocked).toBeNull();
  });

  it("retries a slot the writer failed up to three times, then skips it", async () => {
    const { env, create, row } = setup();
    const id = (await create()).data.series.id;
    vi.spyOn(console, "error").mockImplementation(() => {});
    env.AI.run = async () => { throw new Error("model down"); };
    const slot = row(id).next_slot;
    expect(await runEpisode(env, id, slot)).toEqual({ state: "retry", reason: "failed" });
    expect(row(id)).toMatchObject({ next_slot: slot, failures: 1 });
    expect((await runEpisode(env, id, slot)).state).toBe("retry");
    expect(await runEpisode(env, id, slot)).toEqual({ state: "skipped", reason: "failed" });
    expect(row(id)).toMatchObject({ failures: 0, blocked: "failed" });
    expect(row(id).next_slot).toBeGreaterThan(slot);
  });

  it("stops after the free trial, and makes nothing for a paused series", async () => {
    const { env, sqlite, user, create, row, videos } = setup(null);
    const id = (await create()).data.series.id;
    sqlite.prepare("UPDATE users SET created_at=? WHERE id=?").run(now() - 30 * 86400, user.id);
    expect(await runEpisode(env, id, row(id).next_slot)).toEqual({ state: "skipped", reason: "trial" });
    sqlite.prepare("UPDATE series SET status='paused' WHERE id=?").run(id);
    expect(await runEpisode(env, id, row(id).next_slot)).toEqual({ state: "stopped" });
    expect(videos(id)).toHaveLength(0);
  });

  it("makes one now for a coming slot, never for a time outside the schedule", async () => {
    const { env, user, create, row, videos } = setup();
    const id = (await create()).data.series.id;
    const coming = slots(JSON.parse(row(id).settings).schedule, now(), 3)[2];
    const make = (body: Record<string, unknown>) => call(worker, env, "POST", `/api/series/${id}/episodes`, { idempotencyKey: crypto.randomUUID(), ...body }, user.cookie);
    expect((await make({ slot: coming + 60 })).status).toBe(400);
    const r = await make({ slot: coming });
    expect(r.status).toBe(201);
    expect(videos(id).map((v) => v.slot_at)).toEqual([coming]);
    // That slot has its episode: asked again, the same one comes back.
    expect((await make({ slot: coming })).data.video.id).toBe(r.data.video.id);
    // An extra episode has no slot.
    expect((await make({})).status).toBe(201);
    expect(videos(id)).toHaveLength(2);
  });

  it("makes one now once per click: sent again with the same key, the same episode comes back, charged once", async () => {
    const { env, sqlite, user, create, videos } = setup();
    const id = (await create({ first: false })).data.series.id;
    const used = () => (sqlite.prepare("SELECT SUM(used) AS n FROM usage_windows WHERE user_id=?").get(user.id) as any).n;
    const make = (idempotencyKey?: string) => call(worker, env, "POST", `/api/series/${id}/episodes`, { idempotencyKey }, user.cookie);
    // A retry after a timeout sends the click's key again.
    const key = crypto.randomUUID();
    const first = await make(key);
    expect(first.status).toBe(201);
    const again = await make(key);
    expect(again.status).toBe(200);
    expect(again.data.video.id).toBe(first.data.video.id);
    expect(videos(id)).toHaveLength(1);
    expect(used()).toBe(1);
    // A new click has a new key: another episode.
    expect((await make(crypto.randomUUID())).status).toBe(201);
    expect(videos(id)).toHaveLength(2);
    expect(used()).toBe(2);
    // The browser always sends one.
    expect((await make()).status).toBe(400);
  });
});

describe("the cron", () => {
  it("hands series due within their make-ahead time to the workflow, once per claim", async () => {
    const { env, sqlite, create, row } = setup();
    const soon = (await create({ name: "Soon", first: false })).data.series.id;
    const t = now();
    sqlite.prepare("UPDATE series SET next_slot=? WHERE id=?").run(t + MAKE_AHEAD.autopilot - 60, soon);
    // Plan limits aside: more series for the test.
    const insert = (name: string, settings: Record<string, unknown>, at: number) => {
      const id = crypto.randomUUID();
      sqlite.prepare("INSERT INTO series(id,user_id,name,template,settings,status,next_slot,created_at,updated_at) SELECT ?,user_id,?,template,?,'active',?,1,1 FROM series WHERE id=?")
        .run(id, name, JSON.stringify(seriesSettingsSchema.parse(settings)), at, soon);
      return id;
    };
    const later = insert("Later", {}, t + MAKE_AHEAD.autopilot + 3600);
    const review = insert("Review", { review: true }, t + MAKE_AHEAD.autopilot + 3600);
    // Its next slot is half a day away, beyond the make-ahead time whatever the hour the test runs at.
    const halfDay = new Date((t + 12 * HOUR) * 1000).toISOString().slice(11, 16);
    const missed = insert("Missed", { schedule: { times: [halfDay] } }, t - LATE_GRACE - 60);
    env.CONTENT.created.length = 0;
    await dispatchSeries(env);
    const started = env.CONTENT.created.map((c: any) => c.params.episode.seriesId);
    expect(started.sort()).toEqual([soon, review].sort());
    expect(started).not.toContain(later);
    // A slot missed by more than the grace is not made late: the series moves to its next slot.
    expect(row(missed).next_slot).toBeGreaterThan(t);
    // Claimed: the next minute starts nothing again while the workflow writes.
    await dispatchSeries(env);
    expect(env.CONTENT.created).toHaveLength(2);
    sqlite.prepare("UPDATE series SET attempted_at=? WHERE id=?").run(t - 16 * MINUTE, soon);
    await dispatchSeries(env);
    expect(env.CONTENT.created).toHaveLength(3);
  });
});

describe("changing a series", () => {
  const at = (iso: string) => Date.parse(iso) / 1000;
  /**
   * 12:00 UTC: a daily 18:00 series posting to two TikTok accounts makes today's episode (it is ready, and scheduled
   * on both at 18:00).
   */
  async function madeAtNoon() {
    vi.setSystemTime(new Date("2026-11-03T12:00:00Z"));
    const s = setup();
    const accounts = [crypto.randomUUID(), crypto.randomUUID()];
    for (const account of accounts)
      s.sqlite.prepare("INSERT INTO social_accounts(id,user_id,platform,external_id,name,credentials,status,created_at,updated_at) VALUES (?,?,'tiktok',?,'Channel','x','active',1,1)")
        .run(account, s.user.id, account);
    const id = (await s.create({ settings: { schedule: { timezone: "UTC", times: ["18:00"], days: [0, 1, 2, 3, 4, 5, 6] }, accounts } })).data.series.id;
    expect(s.row(id).next_slot).toBe(at("2026-11-03T18:00:00Z"));
    await runEpisode(s.env, id, s.row(id).next_slot);
    const [v] = s.videos(id);
    s.sqlite.prepare("UPDATE videos SET render_status='ready',video_asset='file',duration=30 WHERE id=?").run(v.id);
    await videoReady(s.env, v.id);
    const posts = () => s.sqlite.prepare("SELECT * FROM publications WHERE video_id=? AND status<>'canceled' ORDER BY account_id").all(v.id) as any[];
    expect(posts().map((p) => p.scheduled_at)).toEqual([at("2026-11-03T18:00:00Z"), at("2026-11-03T18:00:00Z")]);
    const patch = (body: Record<string, unknown>) => call(worker, s.env, "PATCH", `/api/series/${id}`, body, s.user.cookie);
    return { ...s, id, video: v.id, posts, patch };
  }

  it("moves the episode already made to a new posting time, with its posts: never made, charged or posted twice", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const s = await madeAtNoon();
      const used = () => (s.sqlite.prepare("SELECT SUM(used) AS n FROM usage_windows WHERE user_id=?").get(s.user.id) as any).n;
      const charged = used();
      // 13:00: the series now posts at 19:00. Today's episode goes out at 19:00 instead of 18:00.
      vi.setSystemTime(new Date("2026-11-03T13:00:00Z"));
      const r = await s.patch({ settings: { schedule: { timezone: "UTC", times: ["19:00"], days: [0, 1, 2, 3, 4, 5, 6] } } });
      expect(r.status).toBe(200);
      const seven = at("2026-11-03T19:00:00Z");
      expect(s.videos(s.id)).toEqual([expect.objectContaining({ id: s.video, slot_at: seven })]);
      expect(s.posts().map((p) => [p.scheduled_at, p.status])).toEqual([[seven, "scheduled"], [seven, "scheduled"]]);
      // 19:00 has its episode: the series makes tomorrow's next, and nothing more is written or charged today.
      expect(r.data.series.nextSlot).toBe(at("2026-11-04T19:00:00Z"));
      const started = s.env.CONTENT.created.length;
      await dispatchSeries(s.env);
      expect(s.env.CONTENT.created).toHaveLength(started);
      expect(used()).toBe(charged);
      const page = (await call(worker, s.env, "GET", `/api/series/${s.id}`, undefined, s.user.cookie)).data;
      expect(page.upcoming[0]).toEqual({ at: seven, made: true });
      // A time the schedule still has keeps its episode: adding 21:00 moves nothing.
      await s.patch({ settings: { schedule: { timezone: "UTC", times: ["19:00", "21:00"], days: [0, 1, 2, 3, 4, 5, 6] } } });
      expect(s.videos(s.id)[0].slot_at).toBe(seven);
      expect(s.row(s.id).next_slot).toBe(at("2026-11-03T21:00:00Z"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("resuming posts the episode made before the pause: at its slot, at once when it just passed, never a post canceled by hand", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const s = await madeAtNoon();
      const six = at("2026-11-03T18:00:00Z");
      // The owner cancels the post on the second account, then pauses: nothing is left to post.
      const [kept, dropped] = s.posts();
      expect((await call(worker, s.env, "DELETE", `/api/publications/${dropped.id}`, undefined, s.user.cookie)).status).toBe(200);
      vi.setSystemTime(new Date("2026-11-03T13:00:00Z"));
      await s.patch({ status: "paused" });
      expect(s.posts()).toHaveLength(0);
      // 14:00, resumed: today's episode posts at 18:00 again, on the first account only. The series makes tomorrow's next.
      vi.setSystemTime(new Date("2026-11-03T14:00:00Z"));
      expect((await s.patch({ status: "active" })).data.series.nextSlot).toBe(at("2026-11-04T18:00:00Z"));
      expect(s.posts().map((p) => [p.account_id, p.scheduled_at, p.status])).toEqual([[kept.account_id, six, "scheduled"]]);
      const page = (await call(worker, s.env, "GET", `/api/series/${s.id}`, undefined, s.user.cookie)).data;
      expect(page.upcoming[0]).toEqual({ at: six, made: true });
      expect(page.videos[0].publications).toEqual([expect.objectContaining({ scheduledAt: six, status: "scheduled" })]);

      // Paused again before 18:00 and resumed at 19:00: the slot passed less than LATE_GRACE ago, so it posts at once.
      vi.setSystemTime(new Date("2026-11-03T17:00:00Z"));
      await s.patch({ status: "paused" });
      vi.setSystemTime(new Date("2026-11-03T19:00:00Z"));
      await s.patch({ status: "active" });
      expect(s.posts().map((p) => [p.account_id, p.scheduled_at])).toEqual([[kept.account_id, now() + MINUTE]]);

      // Resumed longer after its slot: it is left for the owner to post by hand.
      await s.patch({ status: "paused" });
      vi.setSystemTime(new Date((six + LATE_GRACE + 60) * 1000));
      await s.patch({ status: "active" });
      expect(s.posts()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("pauses (cancelling what was still to post), resumes from the next slot and keeps its videos when deleted", async () => {
    const { env, sqlite, user, create, row, videos } = setup();
    const id = (await create()).data.series.id;
    await runEpisode(env, id, row(id).next_slot);
    const [v] = videos(id);
    sqlite.prepare("INSERT INTO social_accounts(id,user_id,platform,external_id,name,credentials,status,created_at,updated_at) VALUES (?,?,'youtube','c1','Channel','x','active',1,1)")
      .run("00000000-0000-4000-8000-0000000000aa", user.id);
    sqlite.prepare("INSERT INTO publications(id,user_id,video_id,account_id,account_name,platform,scheduled_at,status,created_at,updated_at) VALUES ('p1',?,?,?,'Channel','youtube',?,'scheduled',1,1)")
      .run(user.id, v.id, "00000000-0000-4000-8000-0000000000aa", now() + HOUR);
    expect((await call(worker, env, "PATCH", `/api/series/${id}`, { status: "paused" }, user.cookie)).data.series.status).toBe("paused");
    expect((sqlite.prepare("SELECT status FROM publications WHERE id='p1'").get() as any).status).toBe("canceled");
    sqlite.prepare("UPDATE series SET next_slot=1 WHERE id=?").run(id);
    await call(worker, env, "PATCH", `/api/series/${id}`, { status: "active" }, user.cookie);
    expect(row(id).next_slot).toBeGreaterThan(now());
    // Settings are merged and checked as a whole.
    const changed = await call(worker, env, "PATCH", `/api/series/${id}`, { settings: { seconds: 90, animate: 1 } }, user.cookie);
    expect(changed.data.series).toMatchObject({ settings: { seconds: 90, animate: 1, schedule: { times: ["09:00", "18:00"] } }, credits: videoCredits(90) + 1 });
    expect((await call(worker, env, "PATCH", `/api/series/${id}`, { settings: { seconds: 50 } }, user.cookie)).status).toBe(400);
    // Someone else's series is not found.
    const other = signedIn(sqlite);
    expect((await call(worker, env, "PATCH", `/api/series/${id}`, { status: "paused" }, other.cookie)).status).toBe(404);
    expect((await call(worker, env, "DELETE", `/api/series/${id}`, undefined, user.cookie)).status).toBe(200);
    expect(row(id)).toBeUndefined();
    expect((sqlite.prepare("SELECT series_id FROM videos WHERE id=?").get(v.id) as any).series_id).toBeNull();
  });

  it("always pauses, even a series saved before a rule its settings now break; resuming checks them", async () => {
    const { env, sqlite, user, create } = setup();
    const id = (await create()).data.series.id;
    // Saved before YouTube's "made for kids" question: it posts to a YouTube channel without an answer.
    sqlite.prepare("INSERT INTO social_accounts(id,user_id,platform,external_id,name,credentials,status,created_at,updated_at) VALUES (?,?,'youtube','c2','Channel','x','active',1,1)")
      .run("00000000-0000-4000-8000-0000000000bb", user.id);
    sqlite.prepare("UPDATE series SET settings=json_set(json_remove(settings,'$.madeForKids'),'$.accounts',json_array(?)) WHERE id=?").run("00000000-0000-4000-8000-0000000000bb", id);
    const paused = await call(worker, env, "PATCH", `/api/series/${id}`, { status: "paused" }, user.cookie);
    expect(paused.status).toBe(200);
    expect(paused.data.series.status).toBe("paused");
    // A rename is never refused either; running it again needs the answer first.
    expect((await call(worker, env, "PATCH", `/api/series/${id}`, { name: "Renamed" }, user.cookie)).status).toBe(200);
    const resumed = await call(worker, env, "PATCH", `/api/series/${id}`, { status: "active" }, user.cookie);
    expect(resumed.status).toBe(400);
    expect(resumed.data.error).toMatch(/made for kids/);
    expect((await call(worker, env, "PATCH", `/api/series/${id}`, { status: "active", settings: { madeForKids: false } }, user.cookie)).data.series.status).toBe("active");
  });
});
