import { z } from "zod";
import type { CaptionStyle } from "./captions";
import { defaultLook } from "./overlay";

// Clips from long videos. The app calls them "Clips"; the code says "highlights", so they never mix with a scene's AI
// clip (shared/story.ts) or a library clip. The owner uploads a podcast, interview, stream or webinar; its speech is
// transcribed (shared/speech.ts), the writer finds and scores its strongest stand-alone moments (server/highlights.ts),
// and each chosen moment becomes a video of format "highlight" (shared/formats.ts): cut to the moment, framed in one of
// the layouts below, with captions of what is said and an optional hook title.

/** A clip lasts 5 seconds to 3 minutes of its video (the longest any of the networks takes as a short). */
export const HIGHLIGHT_MIN_SECONDS = 5, HIGHLIGHT_MAX_SECONDS = 180;
/** Seconds the hook title stays on screen by default. */
export const HIGHLIGHT_TITLE_SECONDS = 3;

// Moments -------------------------------------------------------------------------------------------------------------

/** How long the moments the writer looks for are. */
export const momentLengths = {
  short: { name: "Short", about: "15–30 s", min: 15, max: 30 },
  medium: { name: "Medium", about: "30–60 s", min: 30, max: 60 },
  long: { name: "Long", about: "60–90 s", min: 60, max: 90 },
} as const;
export type MomentLength = keyof typeof momentLengths;
export const momentLengthIds = Object.keys(momentLengths) as [MomentLength, ...MomentLength[]];
/** How many moments one search may ask for. */
export const MOMENT_COUNTS = [3, 5, 8, 12] as const;
/** A search for moments: how many, how long, and optionally what they should be about. */
export const momentRequestSchema = z.object({
  count: z.number().int().refine((n) => (MOMENT_COUNTS as readonly number[]).includes(n), "Choose how many clips to find.").default(5),
  length: z.enum(momentLengthIds).default("medium"),
  focus: z.string().trim().max(200).default(""),
});
export type MomentRequest = z.infer<typeof momentRequestSchema>;

/** What the writer rates every moment on, 1–10 each, and how much each part counts in the clip score. */
export const scoreParts = {
  hook: { name: "Hook", about: "The first seconds make people stay", weight: 0.35 },
  payoff: { name: "Payoff", about: "It lands a point, a laugh or a surprise", weight: 0.3 },
  clarity: { name: "Stands alone", about: "It makes sense without the rest of the video", weight: 0.2 },
  energy: { name: "Energy", about: "Emotion, pace and delivery", weight: 0.15 },
} as const;
export type ScorePart = keyof typeof scoreParts;
export const scorePartIds = Object.keys(scoreParts) as ScorePart[];
export type Scores = Record<ScorePart, number>;
/**
 * The clip score, 10–99: the parts weighted. It is the writer's judgement of how well a moment works as a short on
 * its own — never a prediction of views.
 */
export function clipScore(s: Scores) {
  const total = scorePartIds.reduce((n, k) => n + scoreParts[k].weight * Math.min(10, Math.max(1, s[k])), 0);
  return Math.min(99, Math.max(10, Math.round(total * 10)));
}
/**
 * A moment: seconds `start` to `end` of the video, a hook title, why it works, the post text it would go with, the
 * words said in it, and its score.
 */
export type Moment = {
  title: string; why: string; caption: string; hashtags: string[]; start: number; end: number; text: string;
  score: number; scores: Scores;
};

// Layouts -------------------------------------------------------------------------------------------------------------

const share = z.number().min(0).max(1);
/**
 * A window of the source picture shown in a pane: its centre (shares of the picture's width and height) and how far it
 * zooms in (1: the largest window of the pane's shape that fits in the picture).
 */
export const paneSchema = z.object({ x: share.default(0.5), y: share.default(0.5), zoom: z.number().min(1).max(4).default(1) });
export type Pane = z.infer<typeof paneSchema>;
/**
 * How the (usually wider) source fills the 9:16 frame:
 * - follow: a 9:16 crop that follows the main speaker (face tracking, shared/track.ts);
 * - crop: one fixed window the owner places;
 * - fit: the whole picture over a blurred copy of itself;
 * - split: two windows stacked, the top one `ratio` of the frame's height — two speakers, or a screen and a camera.
 *   With `auto`, the two speakers' windows are centred on the two people the clip's tracking found.
 */
export const layoutSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("follow") }),
  z.object({ kind: z.literal("crop"), pane: paneSchema }),
  z.object({ kind: z.literal("fit") }),
  z.object({
    kind: z.literal("split"), preset: z.enum(["speakers", "screen"]), top: paneSchema, bottom: paneSchema,
    ratio: z.number().min(0.3).max(0.7).default(0.5), auto: z.boolean().default(false),
  }),
]);
export type Layout = z.infer<typeof layoutSchema>;
/** The layouts as the editor offers them. */
export const layoutChoices = {
  follow: { name: "Speaker focus", about: "A vertical crop that follows whoever is talking" },
  speakers: { name: "Two speakers", about: "Two people stacked, one above the other" },
  screen: { name: "Screen + camera", about: "Your camera on top, the screen or game below" },
  crop: { name: "Fixed crop", about: "You pick the part of the picture; it stays put" },
  fit: { name: "Full frame", about: "The whole picture over a blurred copy of itself" },
} as const;
export type LayoutChoice = keyof typeof layoutChoices;
export const layoutChoiceIds = Object.keys(layoutChoices) as LayoutChoice[];
export const choiceOf = (layout: Layout): LayoutChoice => (layout.kind === "split" ? layout.preset : layout.kind);
/** A layout as it starts when it is chosen. */
export function layoutFor(choice: LayoutChoice): Layout {
  switch (choice) {
    case "follow": return { kind: "follow" };
    case "crop": return { kind: "crop", pane: { x: 0.5, y: 0.5, zoom: 1 } };
    case "fit": return { kind: "fit" };
    case "speakers": return { kind: "split", preset: "speakers", top: { x: 0.27, y: 0.45, zoom: 1.4 }, bottom: { x: 0.73, y: 0.45, zoom: 1.4 }, ratio: 0.5, auto: true };
    case "screen": return { kind: "split", preset: "screen", top: { x: 0.86, y: 0.18, zoom: 3 }, bottom: { x: 0.5, y: 0.5, zoom: 1 }, ratio: 0.4, auto: false };
  }
}
/** Heights of a split layout's two panes in a frame `height` pixels tall (whole even pixels; they add up to it). */
export function splitHeights(ratio: number, height: number): [number, number] {
  const top = Math.round((height * ratio) / 2) * 2;
  return [top, height - top];
}
/**
 * The two windows of a split layout: with `auto`, centred on the two people found (left one on top), a little below
 * their faces so heads keep some room above them.
 */
export function placedPanes(layout: Extract<Layout, { kind: "split" }>, faces?: [number, number][] | null): [Pane, Pane] {
  if (!layout.auto || layout.preset !== "speakers" || faces?.length !== 2) return [layout.top, layout.bottom];
  const at = ([x, y]: [number, number], pane: Pane): Pane => ({ ...pane, x, y: Math.min(1, y + 0.08) });
  return [at(faces[0], layout.top), at(faces[1], layout.bottom)];
}
const clamp = (v: number, low: number, high: number) => Math.min(high, Math.max(low, v));
/**
 * The window of the source a pane shows, as shares of the picture ({x, y} its top left): the largest rectangle of the
 * pane's shape (`paneW` × `paneH` pixels) inside a `sourceW` × `sourceH` picture, divided by the zoom, centred on the
 * pane's point and moved inside the picture. The renderer crops exactly this and scales it to the pane.
 */
export function paneWindow(pane: Pane, sourceW: number, sourceH: number, paneW: number, paneH: number) {
  const W = Math.max(1, sourceW), H = Math.max(1, sourceH), aspect = paneW / paneH;
  let w = W, h = W / aspect;
  if (h > H) { h = H; w = H * aspect; }
  w /= pane.zoom; h /= pane.zoom;
  const left = clamp(pane.x * W - w / 2, 0, W - w), top = clamp(pane.y * H - h / 2, 0, H - h);
  const r = (n: number) => Math.round(n * 10000) / 10000;
  return { x: r(left / W), y: r(top / H), w: r(w / W), h: r(h / H) };
}

// A moment's clip -----------------------------------------------------------------------------------------------------

/** The choices that apply to every clip made from a video's moments at once. */
export type ClipOptions = { layout: LayoutChoice; style: CaptionStyle; captions: boolean; title: boolean; cuts: boolean; fillers: boolean };
export const defaultClipOptions: ClipOptions = { layout: "follow", style: "bold", captions: true, title: true, cuts: true, fillers: true };
/** The on-screen hook title's look: dark words on a white box at the top, popping in. */
export const titleLook = () => ({ ...defaultLook(), position: "top" as const, background: "#ffffff", color: "#111111", stroke: 0, animation: "pop" as const });

/** The clip of a moment, as the spec schema reads it (shared/formats.ts checks it when it is saved). */
export function momentSpec(assetId: string, m: Moment, o: ClipOptions): Record<string, unknown> {
  const layout = layoutFor(o.layout);
  return {
    format: "highlight",
    kind: "highlight",
    source: { assetId, start: m.start, end: m.end },
    cuts: { enabled: o.cuts, fillers: o.fillers },
    layout,
    // On a split layout the captions sit on the seam between the two pictures.
    captions: { enabled: o.captions, style: o.style, position: layout.kind === "split" ? "middle" : "bottom" },
    headline: o.title && m.title ? { text: m.title.slice(0, 140), look: titleLook(), seconds: HIGHLIGHT_TITLE_SECONDS } : null,
    music: null,
    moment: { score: m.score, why: m.why.slice(0, 200) },
    caption: m.caption,
    hashtags: m.hashtags,
    title: m.title.slice(0, 100),
    topic: m.title.slice(0, 60),
  };
}
