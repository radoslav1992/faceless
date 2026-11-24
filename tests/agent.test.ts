import { describe, expect, it, vi } from "vitest";
import worker from "../server/index";
import { agentTools, DEFAULT_AGENT_MODEL } from "../server/agent";
import { AGENT_OPEN } from "../shared/agent";
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

async function setup() {
  const { env, sqlite } = testEnv({ MEDIA_ENABLED: "true", FAL_KEY: "fal", ELEVENLABS_API_KEY: "el" });
  const user = signedIn(sqlite);
  subscribe(sqlite, user.id, "starter");
  await call(worker, env, "GET", "/api/auth/me", undefined, user.cookie);
  /** What the model answers, in order (a function reads the request it answers), and what it was asked. */
  const script: (object | null | ((request: any) => object))[] = [];
  const asked: any[] = [];
  env.AI.run = async (model: string, request: any) => {
    if (model !== DEFAULT_AGENT_MODEL) return { status: "completed", output_text: written };
    asked.push(structuredClone(request));
    const next = script.shift();
    if (next === undefined) throw new Error("The model was asked more often than the test expects");
    if (next === null) throw new Error("Model down");
    return typeof next === "function" ? next(request) : next;
  };
  const admin = () => sqlite.prepare("UPDATE users SET email='admin@example.com' WHERE id=?").run(user.id);
  /** A turn's events (one JSON object per line). */
  const events = (r: { data: any }) => (typeof r.data === "string" ? r.data.trim().split("\n").map((l: string) => JSON.parse(l)) : [r.data]);
  const send = async (chat: string, text: string, cookie = user.cookie) => events(await call(worker, env, "POST", `/api/agent/chats/${chat}/messages`, { text }, cookie));
  const decide = async (chat: string, id: string, decision: "confirm" | "decline") => events(await call(worker, env, "POST", `/api/agent/chats/${chat}/actions`, { id, decision }, user.cookie));
  const newChat = async () => (await call(worker, env, "POST", "/api/agent/chats", {}, user.cookie)).data.id as string;
  return { env, sqlite, user, script, asked, admin, send, decide, newChat };
}
const done = (events: any[]) => events.find((e) => e.event === "done");
const results = (request: any) => request.messages.at(-1).content.filter((b: any) => b.type === "tool_result");

describe("the assistant", () => {
  it("is the administrators' while it is tested", async () => {
    const { env, user, admin } = await setup();
    expect(AGENT_OPEN).toBe(false);
    const refused = await call(worker, env, "GET", "/api/agent", undefined, user.cookie);
    expect([refused.status, refused.data.error]).toEqual([403, "The assistant is still being tested and isn't available yet."]);
    expect((await call(worker, env, "POST", "/api/agent/chats", {}, user.cookie)).status).toBe(403);
    admin();
    expect((await call(worker, env, "GET", "/api/agent", undefined, user.cookie)).data).toEqual({ chats: [] });
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
    // Another person has the site's skills, never this one's own (and, while the assistant is tested, no access at all).
    const other = signedIn(sqlite, "other@example.com");
    expect((await call(worker, env, "GET", "/api/agent/skills", undefined, other.cookie)).status).toBe(403);
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
