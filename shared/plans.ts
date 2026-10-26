import {
  CLIP_CREDITS, CLIP_SECONDS, HIGHLIGHT_SECONDS_PER_CREDIT, NARRATION_SECONDS_PER_CREDIT, PICTURES_PER_CREDIT, PRESENTER_CREDITS, PRESENTER_SECONDS, SECONDS_PER_CREDIT,
  SPEECH_CREDIT_SECONDS, videoCredits,
} from "./credits";

// Plans: the source of truth for prices and limits. Credits are the one currency: a new video costs one credit per
// started 20 seconds (shared/credits.ts), so "up to N videos" assumes 30-second videos (2 credits). The server enforces credits
// per usage window (a D1 trigger) and `series`, `accounts`, `storageGb` and the upload limits of videos (`videoMinutes`,
// `videoMb`: long videos for clips on paid plans) in code. Unused credits roll over from month to month while a plan
// runs (up to ROLLOVER_MONTHS of them), and subscribers can buy credit packs. Ids never change (subscriptions, Stripe
// lookup keys and the API use them); names are what people see: "daily" is Creator and "double" is Pro.
/**
 * Yearly billing is ten months' price for twelve ("2 months free"): with a 30-second video at 2 credits, every plan
 * keeps a margin billed yearly too, and bigger plans always have cheaper credits.
 */
export const PAID_MONTHS_A_YEAR = 10;
export const FREE_MONTHS_A_YEAR = 12 - PAID_MONTHS_A_YEAR;
export const plans = [
  {
    id: "free",
    name: "Free trial",
    monthly: 0,
    yearly: 0,
    credits: 4,
    series: 1,
    accounts: 1,
    storageGb: 1,
    videoMinutes: 10,
    videoMb: 500,
    popular: false,
    description: "Try every video type and post your first videos. No card needed.",
    features: ["4 credits (up to 2 thirty-second videos)", "All video types and art styles", "1 series on autopilot", "1 social account (posting soon)", "Download in full HD"],
  },
  {
    id: "starter",
    name: "Starter",
    monthly: 19,
    yearly: 19 * PAID_MONTHS_A_YEAR,
    credits: 30,
    series: 2,
    accounts: 1,
    storageGb: 10,
    videoMinutes: 120,
    videoMb: 2000,
    popular: false,
    description: "A few videos a week for one channel.",
    features: ["30 credits a month", "Up to 15 thirty-second videos a month", "All video types", "Unused credits roll over", "1 social account (posting soon)"],
  },
  {
    id: "daily",
    name: "Creator",
    monthly: 35,
    yearly: 35 * PAID_MONTHS_A_YEAR,
    credits: 60,
    series: 5,
    accounts: 100,
    storageGb: 30,
    videoMinutes: 120,
    videoMb: 2000,
    popular: true,
    description: "A new video every day.",
    features: ["60 credits a month", "Up to 30 thirty-second videos a month", "All video types", "Unused credits roll over", "Up to 100 social accounts (posting soon)"],
  },
  {
    id: "double",
    name: "Pro",
    monthly: 59,
    yearly: 59 * PAID_MONTHS_A_YEAR,
    credits: 120,
    series: 10,
    accounts: 100,
    storageGb: 60,
    videoMinutes: 120,
    videoMb: 2000,
    popular: false,
    description: "Two videos a day, or several channels.",
    features: ["120 credits a month", "Up to 60 thirty-second videos a month", "All video types", "Unused credits roll over", "Up to 100 social accounts (posting soon)"],
  },
  {
    id: "studio",
    name: "Studio",
    monthly: 149,
    yearly: 149 * PAID_MONTHS_A_YEAR,
    credits: 350,
    series: 30,
    accounts: 100,
    storageGb: 200,
    videoMinutes: 120,
    videoMb: 2000,
    popular: false,
    description: "Agencies and networks of channels.",
    features: ["350 credits a month", "Up to 175 thirty-second videos a month", "All video types", "Unused credits roll over", "Up to 100 social accounts (posting soon)", "Priority support"],
  },
] as const;
export type Plan = (typeof plans)[number];
export type PlanId = Plan["id"];
export const paidPlans = ["starter", "daily", "double", "studio"] as const;
export type PaidPlanId = (typeof paidPlans)[number];
export const intervals = ["month", "year"] as const;
export type Interval = (typeof intervals)[number];
/** The free plan is a trial: it makes new videos for this many days after sign-up (made videos stay). */
export const TRIAL_DAYS = 7;
/** Unused credits roll over while a plan runs, up to this many months' worth. */
export const ROLLOVER_MONTHS = 3;
export const planById = (id: string | undefined): Plan => plans.find((p) => p.id === id) || plans[0];
/** "Up to N videos a month": 30-second videos. */
export const videosPerMonth = (p: Plan) => Math.floor(p.credits / videoCredits(30));

/** Credit packs active subscribers can add at any time (they roll over like the plan's own credits). */
export const creditPacks = [
  { id: "pack10", credits: 10, price: 8 },
  { id: "pack40", credits: 40, price: 28 },
  { id: "pack150", credits: 150, price: 90 },
] as const;
export type CreditPackId = (typeof creditPacks)[number]["id"];
export const packById = (id: string) => creditPacks.find((p) => p.id === id);

/** In every plan. */
export const planIncludes = [
  "Scripts written for your niche, a new topic every time",
  "Natural AI narration in 26 languages",
  "A new AI picture for every sentence, in one art style",
  "Word-by-word subtitles, transitions and background music",
  "Clips from your podcasts, interviews and streams",
  "Edit any video before it posts, or download it",
  "Commercial use of everything you make",
] as const;

/** Every credit price, built from the constants the server charges by. */
export const tariffs: readonly { name: string; text: string }[] = [
  { name: "New video", text: `1 credit per started ${SECONDS_PER_CREDIT} seconds: a 30-second video is ${videoCredits(30)} credits and a one-minute video ${videoCredits(60)}, script, narration and every picture included.` },
  { name: "Animated scenes", text: `${CLIP_CREDITS.regular} credit per ${CLIP_SECONDS} seconds to bring a scene's picture to life with AI motion, or ${CLIP_CREDITS.high} in high quality (1080p). Optional.` },
  { name: "On-screen presenter", text: `An AI presenter speaking your video's narration: ${PRESENTER_CREDITS.regular} credit per ${PRESENTER_SECONDS} seconds of narration, or ${PRESENTER_CREDITS.high} in high quality. Optional.` },
  { name: "New pictures", text: `1 credit per ${PICTURES_PER_CREDIT} pictures redone in a made video.` },
  { name: "New narration", text: `1 credit per started ${NARRATION_SECONDS_PER_CREDIT} seconds when you change the words of a made video. Your own recording is free.` },
  { name: "Clips from your videos", text: `1 credit per started ${HIGHLIGHT_SECONDS_PER_CREDIT} seconds of each clip: cut, framed on the speaker and captioned.` },
  { name: "Long videos", text: `Videos up to 10 minutes are transcribed for free; longer ones (up to 2 hours, on paid plans) cost 1 credit per started ${SPEECH_CREDIT_SECONDS / 60} minutes.` },
  { name: "Editing", text: "Subtitles, music, transitions, timing, layouts and text changes are free." },
];
export const PRICE_NOTE = "Prices in US dollars. Taxes may apply at checkout.";
