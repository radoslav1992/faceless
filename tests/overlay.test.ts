import { describe, expect, it } from "vitest";
import { planRender, type PlanContext } from "../server/render-plan";
import { withItems } from "../server/caption-ass";
import { specSchema } from "../shared/formats";
import { headlineFor } from "../shared/headline";
import { defaultLook, layoutOverlay, overlayItems, revealSeconds, textAnimations, type TextLook } from "../shared/overlay";
import { animState, type CaptionItem } from "../shared/caption-scene";
import { textWidth } from "../shared/caption-fonts";

// On-screen text: the headline's entrance animations (preview and burnt-in ASS agree), and how each video type places
// its headline and background clip in the render.

const W = 1080, H = 1920;

/** The state an ASS event shows at its start and end, read back from its override tags. */
function eventStates(line: string) {
  const [, layer, start, end] = line.match(/^Dialogue: (\d+),([^,]+),([^,]+),/)!;
  const clock = (t: string) => { const [h, m, s] = t.split(":"); return Number(h) * 3600 + Number(m) * 60 + Number(s); };
  const tags = line.match(/\{([^}]*)\}/)![1];
  const move = tags.match(/\\move\(([^)]*)\)/), pos = tags.match(/\\pos\(([^,]+),([^)]+)\)/);
  const [x0, y0, x1, y1] = move ? move[1].split(",").map(Number) : [Number(pos![1]), Number(pos![2]), Number(pos![1]), Number(pos![2])];
  const head = tags.split("\\t(")[0], change = tags.match(/\\t\(0,\d+,(.*)\)/)?.[1] || "";
  const look = (t: string) => ({
    scale: Number(t.match(/\\fscy([\d.]+)/)?.[1] ?? NaN) / 100,
    alpha: 1 - parseInt(t.match(/\\1a&H([0-9A-F]{2})&/)?.[1] ?? "00", 16) / 255,
  });
  const first = look(head), last = change ? { ...first, ...Object.fromEntries(Object.entries(look(change)).filter(([, v]) => !Number.isNaN(v))) } : first;
  return { layer: Number(layer), start: clock(start), end: clock(end), from: { x: x0, y: y0, ...first }, to: { x: x1, y: y1, ...last } };
}
const near = (a: number, b: number, d = 0.02) => Math.abs(a - b) <= d;

describe("text animations", () => {
  const text = "nobody tells you this about pricing your first client";
  const look = (animation: TextLook["animation"], extra: Partial<TextLook> = {}): TextLook => ({ ...defaultLook(), animation, ...extra });

  it("enters within 0.6 s (word by word: paced to the text, done well before the block ends)", () => {
    for (const animation of textAnimations) {
      for (const [value, seconds] of [["wait for it", 3], [text, 4], [`${text} `.repeat(6).trim(), 12]] as const) {
        const items = overlayItems(value, look(animation, { background: "#ffffff" }), W, H, { start: 2, end: 2 + seconds });
        const reveal = revealSeconds(value, look(animation), W, H, seconds);
        if (animation === "none") expect(items.every((i) => !i.anim)).toBe(true);
        else if (animation === "words") expect(reveal).toBeLessThanOrEqual(Math.min(6, seconds * 0.4) + 0.01);
        else expect(reveal).toBeLessThanOrEqual(0.6 + 1e-9);
        for (const item of items) {
          // Hidden (or on its way in) at the start, settled once the entrance is over.
          if (animation !== "none") expect(animState(item, 2).alpha, animation).toBe(0);
          expect(animState(item, 2 + reveal + 0.001), animation).toEqual({ dx: 0, dy: 0, scale: 1, sx: 1, alpha: 1 });
        }
      }
    }
  });

  it("reveals words in reading order on the same wrapped lines as the static text", () => {
    const l = look("words");
    const layout = layoutOverlay(text, l, W, H);
    const words = overlayItems(text, l, W, H, { start: 0, end: 6 }).filter((i): i is Extract<CaptionItem, { kind: "text" }> => i.kind === "text");
    const lines = layout.lines.map((line) => words.filter((w) => w.y === line.y).map((w) => w.text).join(" "));
    expect(lines).toEqual(layout.lines.map((line) => line.text));
    layout.lines.forEach((line) => {
      const row = words.filter((w) => w.y === line.y);
      // Placed inside the line's own box, left to right.
      expect(row[0].x - textWidthOf(row[0]) / 2).toBeCloseTo(W / 2 - line.width / 2, 5);
      expect(row.at(-1)!.x + textWidthOf(row.at(-1)!) / 2).toBeCloseTo(W / 2 + line.width / 2, 5);
    });
    const starts = words.map((w) => w.anim![0].t);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    expect(new Set(starts).size).toBe(words.length);
  });

  it("burns the same keyframes into ASS as the preview draws", () => {
    for (const animation of textAnimations) {
      const items = overlayItems(text, look(animation, { background: "#222222" }), W, H, { start: 1.5, end: 5 });
      for (const item of items) {
        const lines = withItems("", [item], 1.5, 5).trim().split("\n");
        expect(lines[0]).toMatch(/^Dialogue: \d+,0:00:01\.50,/);
        expect(lines.at(-1)).toMatch(/,0:00:05\.00,Default,/);
        if (!item.anim) expect(lines.join("")).not.toMatch(/\\t\(|\\move/);
        // Event times are written in centiseconds; the state belongs to the exact keyframe time behind each.
        const cuts = [1.5, 5, ...(item.anim || []).map((k) => k.t)];
        const exact = (t: number) => cuts.find((c) => Math.abs(c - t) <= 0.0051) ?? t;
        for (const line of lines) {
          const e = eventStates(line);
          for (const [at, shown] of [[e.start, e.from], [e.end, e.to]] as const) {
            const want = animState(item, exact(at));
            expect(near(shown.x, item.x + want.dx, 0.01) && near(shown.y, item.y + want.dy, 0.01), `${animation} position at ${at}`).toBe(true);
            expect(near(shown.scale, want.scale, 0.0001), `${animation} scale at ${at}`).toBe(true);
            expect(near(shown.alpha, (item.alpha ?? 1) * want.alpha, 1 / 255 + 1e-9), `${animation} alpha at ${at}`).toBe(true);
          }
        }
      }
    }
  });
});
/** A word's width with the shared metrics the layout uses (bold text is the "sans" font). */
const textWidthOf = (item: Extract<CaptionItem, { kind: "text" }>) => textWidth(item.text, item.size, item.font);

describe("headlines and background clips in the render", () => {
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const words = [{ text: "Was", start: 0.2, end: 0.5 }, { text: "I", start: 0.5, end: 0.6 }, { text: "wrong?", start: 0.6, end: 1.2 }, { text: "Here's", start: 1.5, end: 1.9 }, { text: "what", start: 1.9, end: 2.2 }, { text: "happened.", start: 2.2, end: 3.0 }];
  const ctx: PlanContext = {
    media: {
      [id(1)]: { key: "media/u/a.jpg", kind: "image", duration: 0, ai: true },
      [id(2)]: { key: "media/u/b.jpg", kind: "image", duration: 0, ai: true },
      [id(9)]: { key: "library/parkour.mp4", kind: "video", duration: 1.5 },
    },
    narration: { key: "media/u/voice.wav", duration: 9, words }, watermark: "",
  };
  const spec = (extra: Record<string, unknown>) => specSchema.parse({
    narration: { kind: "voice", voiceId: "george" },
    scenes: [{ text: "Was I wrong?", description: "A", imageId: id(1) }, { text: "Here's what happened.", description: "B", imageId: id(2) }], ...extra,
  });

  it("gives each video type its headline: a title card, a POV line or a creature's name all along", () => {
    expect(headlineFor("story", "")).toBeNull();
    expect(headlineFor("story", "Three hearts")).toMatchObject({ seconds: 3, look: { background: "#ffffff", position: "top" } });
    expect(headlineFor("pov", "you wake up in 1350")!.text).toBe("POV: you wake up in 1350");
    expect(headlineFor("pov", "POV: you are a cat")!.text).toBe("POV: you are a cat");
    expect(headlineFor("mashup", "Tralla Spoonito")).toMatchObject({ seconds: 0, look: { color: "#ffe14d", background: null } });
    expect(headlineFor("backdrop", "AITA for leaving?")).toMatchObject({ seconds: 4 });
  });

  it("draws the headline over the pictures for its seconds, and the whole video when it has none", () => {
    const card = planRender(spec({ headline: headlineFor("story", "Was I wrong?") }), ctx).compose.ass;
    const lines = card.split("\n").filter((l) => l.startsWith("Dialogue") && l.includes("Was"));
    expect(lines.length).toBeGreaterThan(0);
    // Burnt in from the start, gone after three seconds.
    expect(card).toMatch(/Dialogue: \d+,0:00:00\.00,/);
    expect(card).not.toMatch(/0:00:0[4-9]\.\d\d,Default,,0,0,0,,\{[^}]*\}Was/);
    const pov = planRender(spec({ kind: "pov", headline: headlineFor("pov", "you are wrong") }), ctx).compose;
    expect(pov.ass).toContain("POV");
  });

  it("loops one background clip under the whole voice instead of the pictures", () => {
    const told = planRender(spec({ kind: "backdrop", backdrop: { libraryId: id(9) }, scenes: [{ text: "Was I wrong?", description: "Not shown" }, { text: "Here's what happened.", description: "Not shown" }] }), ctx).compose;
    expect(told.segments.every((s) => s.kind === "video" && told.keys[s.input!] === "library/parkour.mp4")).toBe(true);
    // The clip repeats to fill the voice's nine seconds, silent; the voice is one track.
    expect(Math.round(told.segments.reduce((n, s) => n + s.duration, 0) * 10) / 10).toBe(9);
    expect(told.segments.every((s) => !s.audio)).toBe(true);
    expect(told.voice).toMatchObject({ start: 0, volume: 1 });
    expect(() => planRender(spec({ backdrop: { libraryId: id(8) } }), ctx)).toThrow("MEDIA_INPUT");
  });
});
