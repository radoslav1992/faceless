// What videos cost in credits. The server charges by these rules and the pricing page shows them, so the two cannot
// drift. Rendering (subtitles, music, transitions, timing) never costs credits.

/** A new video: one credit per started 30 seconds, its narration and every AI picture included. */
export const SECONDS_PER_CREDIT = 30;
/** Redoing pictures of a made video: one credit per started 5 new pictures. */
export const PICTURES_PER_CREDIT = 5;
/**
 * Bringing a scene to life: an AI clip made from its picture, per 5 seconds 1 credit at regular quality (720p) and 2
 * at high quality (1080p, a finer model that costs more to run).
 */
export const clipQualities = ["regular", "high"] as const;
export type ClipQuality = (typeof clipQualities)[number];
export const CLIP_CREDITS: Record<ClipQuality, number> = { regular: 1, high: 2 };
export const CLIP_SECONDS = 5;
/**
 * An on-screen presenter (shared/presenter.ts): an avatar who speaks the whole AI voice, lip-synced, per started 5
 * seconds of the voice 1 credit at regular quality and 3 at high quality — in step with what the avatar service
 * charges for them (about $0.04 and $0.12 a second).
 */
export const presenterQualities = ["regular", "high"] as const;
export type PresenterQuality = (typeof presenterQualities)[number];
export const PRESENTER_CREDITS: Record<PresenterQuality, number> = { regular: 1, high: 3 };
export const PRESENTER_SECONDS = 5;
/**
 * A clip of a long video (shared/highlights.ts): one credit per started minute of its moment. Edits are free while
 * the clip keeps at least half of its moment; moved to other footage, it costs a new clip.
 */
export const HIGHLIGHT_SECONDS_PER_CREDIT = 60;
/** Transcribing a long video (over 10 minutes, for clips): one credit per started 30 minutes of it. */
export const SPEECH_CREDIT_SECONDS = 1800;
/** English speech runs at about 15 characters a second; lengths are estimated from the script before it is spoken. */
export const SPEECH_CHARS_PER_SECOND = 15;

export const speechSeconds = (text: string) => Math.max(2, Math.ceil(text.trim().length / SPEECH_CHARS_PER_SECOND));
/** A new video of `seconds` (narration included). */
export const videoCredits = (seconds: number) => Math.max(1, Math.ceil(seconds / SECONDS_PER_CREDIT - 1e-9));
/** New narration for a made video's changed words. */
export const voiceCredits = (text: string) => videoCredits(speechSeconds(text));
/** New pictures for a made video. */
export const pictureCredits = (count: number) => (count > 0 ? Math.ceil(count / PICTURES_PER_CREDIT) : 0);
/** AI clips of these lengths and qualities (regular unless said). */
export const clipCredits = (clips: { seconds: number; quality?: ClipQuality }[]) =>
  clips.reduce((n, c) => n + CLIP_CREDITS[c.quality ?? "regular"] * Math.ceil(c.seconds / CLIP_SECONDS), 0);

/** A presenter speaking a voice of `seconds`. */
export const presenterCredits = (seconds: number, quality: PresenterQuality) =>
  PRESENTER_CREDITS[quality] * Math.max(1, Math.ceil(seconds / PRESENTER_SECONDS - 1e-9));
/** A clip of a moment `seconds` long. */
export const highlightCredits = (seconds: number) => Math.max(1, Math.ceil(seconds / HIGHLIGHT_SECONDS_PER_CREDIT - 1e-9));
/** Transcribing a video of `seconds` (shown before it is charged). */
export const speechCredits = (seconds: number) => Math.max(1, Math.ceil(seconds / SPEECH_CREDIT_SECONDS - 1e-9));

/** "1 credit", "12 credits" */
export const creditsLabel = (n: number) => `${n.toLocaleString("en-US")} credit${n === 1 ? "" : "s"}`;
