import { describe, expect, it, vi } from "vitest";
import worker from "../server/index";
import { agentTools, DEFAULT_AGENT_MODEL, resetAgentStream } from "../server/agent";
import { AGENT_DAILY_FREE, AGENT_OPEN } from "../shared/agent";
import { call, signedIn, subscribe, testEnv } from "./helpers";

// The assistant (server/agent.ts): a scripted model stands in for Claude. Each answer is what the model would send
// back (words, tool calls, a thinking block); the test reads what the server asked it and what the chat shows.

const lines = ["A small octopus found a jar on the reef.", "It squeezed inside and looked out at the fish.", "By night it had made the jar its home."];
const written = JSON.stringify({
  title: "The octopus and the jar", topic: "an octopus", caption: "A home on the reef.", hashtags: ["ocean"], headline: "The octopus and the jar", subject: "", look: "Clear blue water.",
  places: [], music: "", scenes: lines.map((text, n) => ({ text, picture: `Wide shot of a reef with a small orange octopus, moment ${n + 1}`, keys: [], tone: "", place: "" })),
});
const thinking = (n: number) => ({ type: "thinking", thinking: "", signature: `sig-${n}` });
const say = (text: string) => ({ content: [{ type: "text", text }], stop_reason: "end_turn" });
const use = (n: number, name: string, input: unknown, text = "") => ({
  content: [thinking(n), ...(text ? [{ type: "text", text }] : []), { type: "tool_use", id: `call-${n}`, name, input }], stop_reason: "tool_use",
});

/** An answer as Anthropic streams it: blocks that start, grow by deltas and stop, cut into pieces that end mid-line. */
function streamed(answer: { content: any[]; stop_reason: string }) {
  const events: object[] = [{ type: "message_start", message: { role: "assistant", content: [] } }];
  answer.content.forEach((b, index) => {
    const half = (s: string) => [s.slice(0, Math.ceil(s.length / 2)), s.slice(Math.ceil(s.length / 2))].filter(Boolean);
    if (b.type === "text") {
      events.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
      for (const text of half(b.text)) events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text } });
    } else if (b.type === "tool_use") {
      events.push({ type: "content_block_start", index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
      for (const partial_json of half(JSON.stringify(b.input))) events.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json } });
    } else {
      events.push({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "" } });
      events.push({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: b.signature } });
    }
    events.push({ type: "content_block_stop", index });
  });
  events.push({ type: "message_delta", delta: { stop_reason: answer.stop_reason } }, { type: "message_stop" });
  const text = events.map((e: any) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (let at = 0; at < bytes.length; at += 97) c.enqueue(bytes.slice(at, at + 97));
      c.close();
    },
  });
}

async function setup(overrides: Record<string, unknown> = {}) {
  resetAgentStream();
  const { env, sqlite } = testEnv({ MEDIA_ENABLED: "true", FAL_KEY: "fal", ELEVENLABS_API_KEY: "el", ...overrides });
  const user = signedIn(sqlite);
  subscribe(sqlite, user.id, "starter");
  await call(worker, env, "GET", "/api/auth/me", undefined, user.cookie);
  /** What the model answers, in order (a function reads the request it answers), and what it was asked. */
  const script: (object | null | ((request: any) => object))[] = [];
  const asked: any[] = [];
  /** A model that is down is down for the same request asked whole, too. */
  let down = "";
  env.AI.run = async (model: string, request: any) => {
    if (model !== DEFAULT_AGENT_MODEL) return { status: "completed", output_text: written };
    if (!request.stream && down === JSON.stringify(request.messages)) throw new Error("Model down");
    asked.push(structuredClone(request));
    const next = script.shift();
    if (next === undefined) throw new Error("The model was asked more often than the test expects");
    if (next === null) { down = JSON.stringify(request.messages); throw new Error("Model down"); }
    const answer: any = typeof next === "function" ? next(request) : next;
    // Asked for a stream, the model streams (an answer that is a stream already is given as it is).
    return request.stream && Array.isArray(answer?.content) ? streamed(answer) : answer;
  };
  const admin = () => sqlite.prepare("UPDATE users SET email='admin@example.com' WHERE id=?").run(user.id);
  /** A turn's events (server-sent: one JSON object per `data:` line). */
  const events = (r: { data: any }) => String(r.data).split("\n").filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5)));
  const send = async (chat: string, text: string, cookie = user.cookie) => events(await call(worker, env, "POST", `/api/agent/chats/${chat}/messages`, { text }, cookie));
  const decide = async (chat: string, id: string, decision: "confirm" | "decline") => events(await call(worker, env, "POST", `/api/agent/chats/${chat}/actions`, { id, decision }, user.cookie));
  const newChat = async () => (await call(worker, env, "POST", "/api/agent/chats", {}, user.cookie)).data.id as string;
  return { env, sqlite, user, script, asked, admin, send, decide, newChat };
}
const done = (events: any[]) => events.find((e) => e.event === "done");
const results = (request: any) => request.messages.at(-1).content.filter((b: any) => b.type === "tool_result");

describe("the assistant", () => {
  it("is everyone's, with a few messages a day on the free plan and many on a paid one", async () => {
    const { env, sqlite, user, script, send, newChat } = await setup();
    expect(AGENT_OPEN).toBe(true);
    // An ordinary account on a paid plan: no administrator needed, and more than the free plan's messages in a day.
    expect((await call(worker, env, "GET", "/api/agent", undefined, user.cookie)).data).toEqual({ chats: [] });
    const paid = await newChat();
    for (let n = 0; n < AGENT_DAILY_FREE + 1; n++) script.push(say("Yes."));
    for (let n = 0; n < AGENT_DAILY_FREE + 1; n++) expect((await send(paid, `Question ${n}`)).find((e) => e.event === "text").text).toBe("Yes.");
    // A free account has the assistant too, for a few messages a day: every one is a paid call to the model.
    const free = signedIn(sqlite, "free@example.com");
    const chat = (await call(worker, env, "POST", "/api/agent/chats", {}, free.cookie)).data.id as string;
    for (let n = 0; n < AGENT_DAILY_FREE; n++) script.push(say("Sure."));
    for (let n = 0; n < AGENT_DAILY_FREE; n++) expect((await send(chat, `Idea ${n}`, free.cookie)).find((e) => e.event === "text").text).toBe("Sure.");
    const over = await call(worker, env, "POST", `/api/agent/chats/${chat}/messages`, { text: "One more" }, free.cookie);
    expect([over.status, over.data.error]).toEqual([429, `The free plan has ${AGENT_DAILY_FREE} assistant messages a day. Upgrade for more, or come back tomorrow.`]);
    // Nothing was asked of the model for the message that was not taken.
    expect(script).toHaveLength(0);
  });

  it("drafts a video, shows media, and makes the video only when the owner confirms what it costs", async () => {
    const { env, sqlite, user, script, asked, admin, send, decide, newChat } = await setup();
    admin();
    // The voices have samples to play.
    sqlite.prepare("UPDATE voices SET preview_key='voices/samples/' || id || '.mp3'").run();
    const chat = await newChat();
    script.push(
      use(1, "write_draft", { type: "story", prompt: "An octopus that moves into a jar", seconds: 15 }, "I'll draft it."),
      use(2, "list_voices", {}),
      (request: any) => {
        const voices = JSON.parse(results(request)[0].content).voices;
        return use(3, "show_media", { items: [{ source: "voice", id: voices[0].id, note: "Warm and calm" }, { source: "library", id: "nothing-here" }] });
      },
      (request: any) => {
        const draft = JSON.parse(request.messages.find((m: any) => m.role === "user" && m.content[0]?.tool_use_id === "call-1").content[0].content).draft;
        return use(4, "make_video", { draft }, "Here it is. Making it now.");
      },
    );
    const first = await send(chat, "Make a short video about an octopus that moves into a jar");
    expect(first.filter((e) => e.event === "step").map((e) => [e.tool, e.state])).toEqual([
      ["write_draft", "start"], ["write_draft", "done"], ["list_voices", "start"], ["list_voices", "done"], ["show_media", "start"], ["show_media", "done"],
    ]);
    // The model is Claude, asked in the Messages shape with the tools and the instructions; every answer of this turn
    // goes back whole (its thinking with it), and what the owner typed is the first message.
    expect(asked).toHaveLength(4);
    expect(asked[0]).toMatchObject({ max_tokens: 8000, output_config: { effort: "low" }, messages: [{ role: "user", content: [{ type: "text", text: "Make a short video about an octopus that moves into a jar" }] }] });
    expect(asked[0].system).toContain("Tools that spend credits");
    expect(asked[0].tools.map((t: any) => t.name)).toEqual(agentTools().map((t) => t.name));
    expect(asked[0].tools.map((t: any) => t.name)).toEqual(expect.arrayContaining(["write_draft", "edit_draft", "make_video", "show_media", "search_library", "find_clips", "make_clip", "load_skill"]));
    expect(asked[0].tools.map((t: any) => t.name)).not.toContain("create_video");
    expect(asked[1].messages[1].content[0]).toEqual(thinking(1));
    expect(asked[3].messages.filter((m: any) => m.role === "assistant").map((m: any) => m.content[0])).toEqual([thinking(1), thinking(2), thinking(3)]);
    // The draft is the writer's, kept for the chat: its card shows the scenes and what making it costs.
    const cards = first.filter((e) => e.event === "card").map((e) => e.card);
    expect(cards.map((c) => c.type)).toEqual(["draft", "media"]);
    expect(cards[0]).toMatchObject({ title: "The octopus and the jar", template: "story", credits: 1, scenes: lines.map((text) => ({ text })) });
    // The voice is shown to be played; what isn't there is told to the model, not shown.
    expect(cards[1].items).toHaveLength(1);
    expect(cards[1].items[0]).toMatchObject({ source: "voice", show: "audio", kind: "voice", note: "Warm and calm" });
    expect(cards[1].items[0].url).toMatch(/^\/api\/public\/voices\//);
    expect(JSON.parse(results(asked[3])[0].content).notFound).toEqual(["nothing-here"]);
    // Making it spends: nothing is made, the chat shows the cost and waits.
    const action = first.find((e) => e.event === "action").action;
    expect(action).toMatchObject({ id: "call-4", tool: "make_video", summary: "The octopus and the jar", credits: 1, status: "pending" });
    expect(done(first).waiting).toBe(true);
    expect(done(first).title).toBe("Make a short video about an octopus that moves into a jar");
    expect(env.CONTENT.created).toHaveLength(0);
    expect((sqlite.prepare("SELECT COUNT(*) AS n FROM videos").get() as any).n).toBe(0);
    // The chat as it is read again: the owner's words, then the model's messages with their steps and cards.
    const read = (await call(worker, env, "GET", `/api/agent/chats/${chat}`, undefined, user.cookie)).data;
    expect(read.waiting).toBe(true);
    expect(read.items.map((i: any) => [i.kind, i.text, i.steps?.map((s: any) => s.tool), i.cards?.map((c: any) => c.type), i.actions?.map((a: any) => a.status)])).toEqual([
      ["user", "Make a short video about an octopus that moves into a jar", undefined, undefined, undefined],
      ["assistant", "I'll draft it.", ["write_draft"], ["draft"], []],
      ["assistant", "", ["list_voices"], [], []],
      ["assistant", "", ["show_media"], ["media"], []],
      ["assistant", "Here it is. Making it now.", [], [], ["pending"]],
    ]);
    // Nothing of the model's thinking is stored.
    expect(JSON.stringify(sqlite.prepare("SELECT content FROM agent_messages").all())).not.toContain("sig-");
    // Confirmed: the video is made as Create makes it, and the model reads that it was.
    script.push(say("It's being made. It will show here in a few minutes."));
    const confirmed = await decide(chat, "call-4", "confirm");
    expect(env.CONTENT.created).toHaveLength(1);
    const video = sqlite.prepare("SELECT id,title FROM videos").get() as any;
    expect(video.title).toBe("The octopus and the jar");
    expect(confirmed.filter((e) => e.event === "text").map((e) => e.text)).toEqual(["It's being made. It will show here in a few minutes."]);
    expect(done(confirmed).waiting).toBe(false);
    expect(done(confirmed).items.at(-2)).toMatchObject({ actions: [{ status: "confirmed" }], cards: [{ type: "video", id: video.id }], steps: [{ tool: "make_video", ok: true }] });
    expect(JSON.parse(results(asked[4])[0].content)).toMatchObject({ video: video.id, credits: 1, status: "queued" });
    // A turn that starts from the stored chat carries no thinking: only words, calls and results.
    expect(JSON.stringify(asked[4].messages)).not.toContain("sig-");
    // The same draft is one video, however often it is asked for: the second call answers with it, unasked.
    script.push((request: any) => use(6, "make_video", { draft: JSON.parse(results(request)[0]?.content ?? "{}").draft ?? (sqlite.prepare("SELECT id FROM agent_drafts").get() as any).id }), say("Already made."));
    const again = await send(chat, "Make it again");
    expect(again.find((e) => e.event === "action")).toBeUndefined();
    expect(JSON.parse(results(asked.at(-1))[0].content)).toMatchObject({ video: video.id });
    expect(env.CONTENT.created).toHaveLength(1);
    // The draft opens in the editor.
    const draftId = (sqlite.prepare("SELECT id FROM agent_drafts").get() as any).id;
    expect((await call(worker, env, "GET", `/api/agent/drafts/${draftId}`, undefined, user.cookie)).data).toMatchObject({ template: "story", videoId: video.id, spec: { title: "The octopus and the jar" } });
  });

  it("makes nothing when the owner declines, or says something else instead", async () => {
    const { env, script, asked, admin, send, decide, newChat } = await setup();
    admin();
    const chat = await newChat();
    const draftOf = (request: any) => JSON.parse(request.messages.find((m: any) => m.role === "user" && m.content[0]?.tool_use_id === "call-1").content[0].content).draft;
    script.push(use(1, "write_draft", { prompt: "An octopus", seconds: 15 }), (r: any) => use(2, "make_video", { draft: draftOf(r) }));
    expect(done(await send(chat, "A video about an octopus")).waiting).toBe(true);
    script.push(say("No problem. What should I change?"));
    const declined = await decide(chat, "call-2", "decline");
    expect(results(asked.at(-1))[0]).toMatchObject({ tool_use_id: "call-2", is_error: true, content: "The owner declined this. Nothing was made or spent." });
    expect(done(declined).waiting).toBe(false);
    expect(done(declined).items.at(-2).actions[0].status).toBe("declined");
    // There is nothing to confirm twice.
    expect(done(await decide(chat, "call-2", "confirm"))).toBeDefined();
    expect(env.CONTENT.created).toHaveLength(0);
    // Asked again, and answered with words instead of the button: the call is closed as not confirmed, with the words.
    script.push((r: any) => use(3, "make_video", { draft: draftOf(r) }));
    expect(done(await send(chat, "Okay, make it")).waiting).toBe(true);
    script.push(say("Sure, shorter."));
    const instead = await send(chat, "Wait, make it shorter first");
    const last = asked.at(-1).messages.at(-1);
    expect(last.content).toEqual([
      { type: "tool_result", tool_use_id: "call-3", content: "The owner did not confirm this. Nothing was made or spent.", is_error: true },
      { type: "text", text: "Wait, make it shorter first" },
    ]);
    expect(done(instead).waiting).toBe(false);
    expect(env.CONTENT.created).toHaveLength(0);
  });

  it("changes a draft's scenes, voice and style, and never runs what it can't price", async () => {
    const { env, sqlite, script, asked, admin, send, newChat } = await setup();
    admin();
    const chat = await newChat();
    const draftOf = (request: any) => JSON.parse(request.messages.find((m: any) => m.role === "user" && m.content[0]?.tool_use_id === "call-1").content[0].content).draft;
    script.push(
      use(1, "write_draft", { prompt: "An octopus", seconds: 15 }),
      (r: any) => use(2, "edit_draft", {
        draft: draftOf(r), title: "The jar", style: "festive",
        change_scenes: [{ scene: 1, text: "A tiny octopus found a jar." }], remove_scenes: [2],
        add_scenes: [{ after: 3, text: "And it never left.", picture: "Close-up of an orange octopus asleep inside a glass jar on the sea floor" }],
      }),
      (r: any) => use(3, "edit_draft", { draft: draftOf(r), remove_scenes: [9] }),
      use(4, "make_video", { draft: "no-such-draft" }),
      say("Done."),
    );
    const events = await send(chat, "Draft and tighten it");
    const edited = JSON.parse(results(asked[2])[0].content);
    expect(edited).toMatchObject({ title: "The jar", style: "festive" });
    expect(edited.scenes.map((s: any) => s.text)).toEqual(["A tiny octopus found a jar.", lines[2], "And it never left."]);
    const stored = JSON.parse((sqlite.prepare("SELECT spec FROM agent_drafts").get() as any).spec);
    expect(stored.scenes.map((s: any) => s.text)).toEqual(["A tiny octopus found a jar.", lines[2], "And it never left."]);
    // A scene that isn't there, and a draft that isn't there: said to the model, nothing changed, nothing made or asked.
    expect(results(asked[3])[0]).toMatchObject({ is_error: true, content: "The draft has 3 scenes: there is no scene 9." });
    expect(results(asked[4])[0]).toMatchObject({ is_error: true });
    expect(results(asked[4])[0].content).toMatch(/^Draft not found/);
    expect(events.find((e) => e.event === "action")).toBeUndefined();
    expect(events.filter((e) => e.event === "step" && e.state === "failed").map((e) => e.tool)).toEqual(["edit_draft", "make_video"]);
    expect(env.CONTENT.created).toHaveLength(0);
  });

  it("has the site's skills and the owner's own, and loads one when asked", async () => {
    const { env, sqlite, user, script, asked, admin, send, newChat } = await setup();
    admin();
    const skill = (body: object) => call(worker, env, "POST", "/api/agent/skills", body, user.cookie);
    expect((await skill({ name: "Product ads", description: "How to plan an ad for a product.", body: "Open on the product in use. Three scenes.", site: true })).status).toBe(201);
    expect((await skill({ name: "My tone", description: "The channel's voice.", body: "Dry humour, short sentences." })).status).toBe(201);
    expect((await skill({ name: "Off", description: "Not used.", body: "Never loaded.", enabled: false })).status).toBe(201);
    // Another person has the site's skills, never this one's own; the site's are an administrator's to write and change.
    const other = signedIn(sqlite, "other@example.com");
    const theirs = (await call(worker, env, "GET", "/api/agent/skills", undefined, other.cookie)).data;
    expect(theirs.skills.map((s: any) => [s.name, s.site])).toEqual([["Product ads", true]]);
    expect(theirs.canEditSite).toBe(false);
    expect((await call(worker, env, "POST", "/api/agent/skills", { name: "Mine for all", description: "For everyone.", body: "Do this.", site: true }, other.cookie)).data.error).toBe("Only administrators add skills for everyone.");
    expect((await call(worker, env, "DELETE", `/api/agent/skills/${theirs.skills[0].id}`, undefined, other.cookie)).status).toBe(404);
    const listed = (await call(worker, env, "GET", "/api/agent/skills", undefined, user.cookie)).data;
    expect(listed.skills.map((s: any) => [s.name, s.site, s.enabled])).toEqual([["My tone", false, true], ["Off", false, false], ["Product ads", true, true]]);
    expect(listed.canEditSite).toBe(true);
    const chat = await newChat();
    script.push(use(1, "load_skill", { name: "my tone" }), use(2, "load_skill", { name: "Off" }), say("Loaded."));
    await send(chat, "Use my tone");
    // The instructions list the skills by name and what they are for; a skill's text comes only when it is loaded.
    expect(asked[0].system).toContain("- My tone: The channel's voice.");
    expect(asked[0].system).toContain("- Product ads: How to plan an ad for a product.");
    expect(asked[0].system).not.toContain("Dry humour");
    expect(asked[0].system).not.toContain("Not used.");
    expect(JSON.parse(results(asked[1])[0].content)).toEqual({ name: "My tone", instructions: "Dry humour, short sentences." });
    expect(results(asked[2])[0]).toMatchObject({ is_error: true });
    // Changed and deleted by their owner.
    const mine = listed.skills.find((s: any) => s.name === "My tone");
    expect((await call(worker, env, "PUT", `/api/agent/skills/${mine.id}`, { name: "My tone", description: "The channel's voice.", body: "Warm and plain." }, user.cookie)).status).toBe(200);
    expect((await call(worker, env, "DELETE", `/api/agent/skills/${mine.id}`, undefined, user.cookie)).status).toBe(200);
    expect((await call(worker, env, "DELETE", `/api/agent/skills/${mine.id}`, undefined, user.cookie)).status).toBe(404);
  });

  it("asks before it drafts, with answers to tap, and waits for the owner", async () => {
    const { env, user, script, asked, admin, send, newChat } = await setup();
    admin();
    const chat = await newChat();
    script.push({ content: [{ type: "text", text: "How long should it be?" }, { type: "tool_use", id: "call-1", name: "suggest_replies", input: { options: ["15 seconds", "30 seconds", "You choose"] } }], stop_reason: "tool_use" });
    const first = await send(chat, "A Christmas tale");
    // The instructions say what to ask and what a second costs; the question ends the turn, the model is not asked again.
    expect(asked).toHaveLength(1);
    expect(asked[0].system).toContain("1 credit for every started 20 seconds");
    expect(asked[0].system).toContain("ask before drafting");
    expect(first.filter((e) => e.event === "text").map((e) => e.text)).toEqual(["How long should it be?"]);
    expect(first.find((e) => e.event === "card").card).toEqual({ type: "replies", options: ["15 seconds", "30 seconds", "You choose"] });
    expect(done(first).items.at(-1)).toMatchObject({ kind: "assistant", text: "How long should it be?", cards: [{ type: "replies" }] });
    expect(done(first).waiting).toBe(false);
    // The answer follows the buttons' result, and the model goes on from both.
    script.push(say("Thirty seconds it is."));
    await send(chat, "30 seconds");
    expect(asked[1].messages.slice(-2).map((m: any) => [m.role, m.content.map((b: any) => b.type)])).toEqual([["user", ["tool_result"]], ["user", ["text"]]]);
    // The answer is sent as a stream of events that nothing in between holds back.
    const raw = await call(worker, env, "POST", `/api/agent/chats/${chat}/messages`, { text: "Thanks" }, user.cookie);
    expect(raw.headers.get("Content-Type")).toBe("text/event-stream; charset=utf-8");
    expect(raw.headers.get("Cache-Control")).toBe("no-store, no-transform");
  });

  it("sends the model's words as it writes them, and asks for them whole when the stream can't be read", async () => {
    const { script, asked, admin, send, newChat } = await setup();
    admin();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const chat = await newChat();
      script.push(use(1, "get_account", {}, "Let me check your credits."), say("You have plenty left."));
      const first = await send(chat, "How many credits do I have?");
      // Asked as a stream; the words arrive in pieces, then whole; the call's arguments are put together from theirs.
      expect(asked.map((r) => r.stream)).toEqual([true, true]);
      expect(first.filter((e) => ["delta", "text", "step"].includes(e.event)).map((e) => (e.event === "step" ? `${e.tool}:${e.state}` : `${e.event}:${e.text}`))).toEqual([
        "delta:Let me check ", "delta:your credits.", "text:Let me check your credits.", "get_account:start", "get_account:done",
        "delta:You have pl", "delta:enty left.", "text:You have plenty left.",
      ]);
      // The answer put together from the stream goes back whole in the same turn, its thinking with it.
      expect(asked[1].messages[1].content).toEqual([thinking(1), { type: "text", text: "Let me check your credits." }, { type: "tool_use", id: "call-1", name: "get_account", input: {} }]);
      // A stream that holds no answer: what was shown is taken back and the answer asked for whole. From then on
      // answers are asked for whole at once, so no round is paid for twice.
      const garbage = () => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode("data: {\"choices\":[{\"delta\":{\"content\":\"Hi\"}}]}\n\ndata: [DONE]\n\n")); c.close(); } });
      script.push(garbage(), say("Hello there."), say("Still here."));
      const second = await send(chat, "Hello");
      expect(second.filter((e) => ["delta", "undo", "text"].includes(e.event)).map((e) => e.event + (e.text ? `:${e.text}` : ""))).toEqual(["undo", "text:Hello there."]);
      expect(asked.slice(2).map((r) => !!r.stream)).toEqual([true, false]);
      expect(error.mock.calls.map((c) => c[0])).toContain("Agent stream unreadable");
      await send(chat, "Are you there?");
      expect(asked.slice(4).map((r) => !!r.stream)).toEqual([false]);
    } finally {
      error.mockRestore();
    }
    // Switched off by hand: answers are asked for whole.
    const off = await setup({ AGENT_STREAM: "off" });
    off.admin();
    off.script.push(say("Whole."));
    const events = await off.send(await off.newChat(), "Hi");
    expect(off.asked[0].stream).toBeUndefined();
    expect(events.filter((e) => e.event === "delta")).toEqual([]);
    expect(events.find((e) => e.event === "text").text).toBe("Whole.");
  });

  it("says so when the model has no answer, and goes on from the next message", async () => {
    const { env, user, script, asked, admin, send, newChat } = await setup();
    admin();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const chat = await newChat();
      script.push(null);
      const failed = await send(chat, "Hello");
      expect(failed.find((e) => e.event === "error").message).toBe("The assistant couldn't answer right now. Please try again in a minute.");
      // With this turn's thinking in play, a failed request is asked once more without it.
      script.push(use(1, "get_account", {}), null, say("You have credits left."));
      const next = await send(chat, "How many credits do I have?");
      expect(next.find((e) => e.event === "text").text).toBe("You have credits left.");
      expect(JSON.stringify(asked.at(-2).messages)).toContain("sig-1");
      expect(JSON.stringify(asked.at(-1).messages)).not.toContain("sig-1");
      // A chat is its owner's, and goes when they delete it.
      expect((await call(worker, env, "GET", "/api/agent", undefined, user.cookie)).data.chats.map((c: any) => c.title)).toEqual(["Hello"]);
      expect((await call(worker, env, "DELETE", `/api/agent/chats/${chat}`, undefined, user.cookie)).status).toBe(200);
      expect((await call(worker, env, "GET", `/api/agent/chats/${chat}`, undefined, user.cookie)).status).toBe(404);
    } finally {
      error.mockRestore();
    }
  });
});
