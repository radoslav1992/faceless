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
    // The free trial runs one series.
    const first = await create();
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
    // The page shows the coming slots (none made yet); nobody else sees the series.
    const page = (await call(worker, env, "GET", `/api/series/${s.id}`, undefined, user.cookie)).data;
    expect(page.upcoming[0]).toEqual({ at: s.next_slot, made: false });
    expect(page.upcoming.length).toBeGreaterThan(20);
    expect((await call(worker, env, "GET", `/api/series/${s.id}`, undefined, signedIn(sqlite).cookie)).status).toBe(404);
  });
});

describe("episodes", () => {
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
      scenes: [0, 1, 2, 3, 4, 5].map((n) => ({ text: long, picture: `Octopus picture ${n}`, keys: [] })),
    }) });
    await runEpisode(env, id, row(id).next_slot);
    const [v] = videos(id);
    expect(videoCredits(estimatedSeconds(JSON.parse(v.spec)))).toBeGreaterThan(1);
    expect((sqlite.prepare("SELECT credits FROM runs WHERE video_id=?").get(v.id) as any).credits).toBe(1);
    expect((sqlite.prepare("SELECT SUM(used) AS n FROM usage_windows WHERE user_id=?").get(user.id) as any).n).toBe(1);
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
    expect((await call(worker, env, "POST", `/api/series/${id}/episodes`, { slot: coming + 60 }, user.cookie)).status).toBe(400);
    const r = await call(worker, env, "POST", `/api/series/${id}/episodes`, { slot: coming }, user.cookie);
    expect(r.status).toBe(201);
    expect(videos(id).map((v) => v.slot_at)).toEqual([coming]);
    // An extra episode has no slot.
    expect((await call(worker, env, "POST", `/api/series/${id}/episodes`, {}, user.cookie)).status).toBe(201);
    expect(videos(id)).toHaveLength(2);
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
    expect(changed.data.series).toMatchObject({ settings: { seconds: 90, animate: 1, schedule: { times: ["09:00", "18:00"] } }, credits: 4 });
    expect((await call(worker, env, "PATCH", `/api/series/${id}`, { settings: { seconds: 50 } }, user.cookie)).status).toBe(400);
    // Someone else's series is not found.
    const other = signedIn(sqlite);
    expect((await call(worker, env, "PATCH", `/api/series/${id}`, { status: "paused" }, other.cookie)).status).toBe(404);
    expect((await call(worker, env, "DELETE", `/api/series/${id}`, undefined, user.cookie)).status).toBe(200);
    expect(row(id)).toBeUndefined();
    expect((sqlite.prepare("SELECT series_id FROM videos WHERE id=?").get(v.id) as any).series_id).toBeNull();
  });
});
