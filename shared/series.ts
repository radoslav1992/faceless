import { z } from "zod";
import { captionStyles, type CaptionStyle } from "./captions";
import { scheduleSchema } from "./schedule";
import { storyStyleIds, type StoryStyle } from "./story";
import { voices } from "./voices";
import { videoCredits } from "./credits";
import { templates, type TemplateId } from "./templates";

// A series is a faceless channel on autopilot: one template (shared/templates.ts), voice, language, art style and
// schedule. For every posting slot the server writes a new episode, makes it ahead of time and posts it to the series'
// channels (server/series.ts). The settings here are shared by the wizard, the editor and the server.

/** Narration languages (ElevenLabs v3 reads all of them; subtitles use the bundled Latin, Greek and Cyrillic fonts). */
export const languages = [
  ["en", "English"], ["es", "Spanish"], ["pt", "Portuguese"], ["fr", "French"], ["de", "German"], ["it", "Italian"],
  ["nl", "Dutch"], ["pl", "Polish"], ["ro", "Romanian"], ["cs", "Czech"], ["sk", "Slovak"], ["hu", "Hungarian"],
  ["sv", "Swedish"], ["da", "Danish"], ["no", "Norwegian"], ["fi", "Finnish"], ["tr", "Turkish"], ["id", "Indonesian"],
  ["ms", "Malay"], ["vi", "Vietnamese"], ["fil", "Filipino"], ["hr", "Croatian"], ["el", "Greek"], ["ru", "Russian"],
  ["uk", "Ukrainian"], ["bg", "Bulgarian"],
] as const;
export type LanguageCode = (typeof languages)[number][0];
export const languageCodes = languages.map((l) => l[0]) as LanguageCode[];
export const languageName = (code: string) => languages.find((l) => l[0] === code)?.[1] ?? code;

/** Background music moods; "auto" lets the writer pick a library track that fits each episode. */
export const musicMoods = ["auto", "none", "calm", "upbeat", "inspiring", "dark", "epic", "mysterious", "playful", "ambient"] as const;
export type MusicMood = (typeof musicMoods)[number];

/** Episode lengths a series offers (seconds of narration). */
export const episodeLengths = [30, 45, 60, 90] as const;
export type EpisodeLength = (typeof episodeLengths)[number];
export const lengthName = (s: number) => (s < 60 ? `${s} seconds` : s === 60 ? "1 minute" : `${s / 60} minutes`.replace("1.5 minutes", "1½ minutes"));

const voiceIds = voices.map((v) => v.id) as [string, ...string[]];
export const seriesSettingsSchema = z.object({
  /** The owner's topic and direction (required for "Your own topic", optional extra guidance for the others). */
  prompt: z.string().trim().max(600).default(""),
  language: z.enum(languageCodes as [LanguageCode, ...LanguageCode[]]).default("en"),
  voiceId: z.enum(voiceIds).default("george"),
  style: z.enum(storyStyleIds as [StoryStyle, ...StoryStyle[]]).default("doodle"),
  seconds: z.union(episodeLengths.map((n) => z.literal(n)) as unknown as [z.ZodLiteral<30>, z.ZodLiteral<45>, z.ZodLiteral<60>, z.ZodLiteral<90>]).default(45),
  /** A recurring character described once and drawn the same way in every picture (empty: the writer decides). */
  subject: z.string().trim().max(300).default(""),
  /** A mood the writer picks a library track for ("auto": any that fits, "none": no music), or a chosen track. */
  music: z.object({
    mood: z.enum(musicMoods).default("auto"),
    trackId: z.uuid().nullable().default(null),
    volume: z.number().min(0).max(1).default(0.25),
  }).default({ mood: "auto", trackId: null, volume: 0.25 }),
  /** Storytime: the library clip that loops behind every episode (null: a different one each time). */
  backdropId: z.uuid().nullable().default(null),
  /** Bring the first scenes to life with AI motion (credits per clip, shared/credits.ts). */
  animate: z.number().int().min(0).max(3).default(0),
  captions: z.object({ enabled: z.boolean().default(true), style: z.enum(captionStyles).default("keyword" satisfies CaptionStyle) })
    .default({ enabled: true, style: "keyword" }),
  /** Connected accounts every episode posts to (none: videos are only made, for download or e-mail). */
  accounts: z.array(z.uuid()).max(10).default([]),
  /** Post privately (only the account can see it) where the network allows it, to check before going public. */
  private: z.boolean().default(false),
  schedule: scheduleSchema.default(scheduleSchema.parse({})),
  /** Review first: episodes wait for approval instead of posting by themselves. */
  review: z.boolean().default(false),
  /** E-mail the owner when an episode is ready (with what it says and when it posts). */
  notify: z.boolean().default(true),
  /** Hashtags added to every episode's description, besides the writer's own. */
  hashtags: z.array(z.string().trim().regex(/^#?[\p{L}\p{N}_]{1,60}$/u)).max(5).default([]),
});
export type SeriesSettings = z.infer<typeof seriesSettingsSchema>;
/** A template's starting choices. */
export const defaultSeriesSettings = (template: TemplateId = "facts"): SeriesSettings => {
  const t = templates[template];
  const seconds = (episodeLengths as readonly number[]).includes(t.seconds) ? t.seconds : 60;
  return seriesSettingsSchema.parse({ style: t.style, voiceId: t.voice, seconds, music: { mood: t.music } });
};
/** Credits an episode of the series takes (its length, plus the scenes brought to life). */
export const episodeCredits = (s: Pick<SeriesSettings, "seconds" | "animate">) => videoCredits(s.seconds) + s.animate;

/** How long before its slot an episode is made: time to render, and in review mode time to look at it. */
export const MAKE_AHEAD = { autopilot: 6 * 3600, review: 24 * 3600 } as const;
/** An episode that is ready after its slot still posts at once if it is at most this late. */
export const LATE_GRACE = 3 * 3600;
