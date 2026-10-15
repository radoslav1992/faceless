import { CLIP_CREDITS, CLIP_SECONDS, HIGHLIGHT_SECONDS_PER_CREDIT, PICTURES_PER_CREDIT, SECONDS_PER_CREDIT, SPEECH_CREDIT_SECONDS } from "./credits";

// Plans: the source of truth for prices and limits. Credits are the one currency: a new video costs one credit per
// started 30 seconds (shared/credits.ts), so "up to N videos" assumes one-minute videos. The server enforces credits
// per usage window (a D1 trigger) and `series`, `accounts`, `storageGb` and the upload limits of videos (`videoMinutes`,
// `videoMb`: long videos for clips on paid plans) in code. Unused credits roll over from month to month while a plan
// runs (up to ROLLOVER_MONTHS of them), and subscribers can buy credit packs. Ids never change (subscriptions, Stripe
// lookup keys and the API use them); names are what people see: "daily" is Creator and "double" is Pro.
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
    features: ["4 credits (up to 2 one-minute videos)", "All video types and art styles", "1 series on autopilot", "1 social account", "Download in full HD"],
  },
  {
    id: "starter",
    name: "Starter",
    monthly: 19,
    yearly: 168,
    credits: 30,
    series: 2,
    accounts: 1,
    storageGb: 10,
    videoMinutes: 120,
    videoMb: 2000,
    popular: false,
    description: "A few videos a week for one channel.",
    features: ["30 credits a month", "Up to 15 videos a month", "All video types", "Unused credits roll over", "1 social account"],
  },
  {
    id: "daily",
    name: "Creator",
    monthly: 35,
    yearly: 288,
    credits: 60,
    series: 5,
    accounts: 100,
    storageGb: 30,
    videoMinutes: 120,
    videoMb: 2000,
    popular: true,
    description: "A new video every day.",
    features: ["60 credits a month", "Up to 30 videos a month", "All video types", "Unused credits roll over", "Up to 100 social accounts"],
  },
  {
    id: "double",
    name: "Pro",
    monthly: 59,
    yearly: 492,
    credits: 120,
    series: 10,
    accounts: 100,
    storageGb: 60,
    videoMinutes: 120,
    videoMb: 2000,
    popular: false,
    description: "Two videos a day, or several channels.",
    features: ["120 credits a month", "Up to 60 videos a month", "All video types", "Unused credits roll over", "Up to 100 social accounts"],
  },
  {
    id: "studio",
    name: "Studio",
    monthly: 149,
    yearly: 1248,
    credits: 350,
    series: 30,
    accounts: 100,
    storageGb: 200,
    videoMinutes: 120,
    videoMb: 2000,
    popular: false,
    description: "Agencies and networks of channels.",
    features: ["350 credits a month", "Up to 175 videos a month", "All video types", "Unused credits roll over", "Up to 100 social accounts", "Priority support"],
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
/** "Up to N videos a month": one-minute videos. */
export const videosPerMonth = (p: Plan) => Math.floor(p.credits / 2);
/** What a year costs against twelve months, as a whole percentage. */
export const yearlySaving = (p: Plan) => (p.monthly ? Math.round((1 - p.yearly / (p.monthly * 12)) * 100) : 0);
/** The most any paid plan saves billed yearly (the toggle's "Save N%"). */
export const BEST_SAVING = Math.max(...plans.map(yearlySaving));

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
  { name: "New video", text: `1 credit per started ${SECONDS_PER_CREDIT} seconds: a one-minute video is 2 credits, script, narration and every picture included.` },
  { name: "Animated scenes", text: `${CLIP_CREDITS} credit per ${CLIP_SECONDS} seconds to bring a scene's picture to life with AI motion (optional).` },
  { name: "New pictures", text: `1 credit per ${PICTURES_PER_CREDIT} pictures redone in a made video.` },
  { name: "New narration", text: `1 credit per started ${SECONDS_PER_CREDIT} seconds when you change the words of a made video. Your own recording is free.` },
  { name: "Clips from your videos", text: `1 credit per started ${HIGHLIGHT_SECONDS_PER_CREDIT} seconds of each clip: cut, framed on the speaker and captioned.` },
  { name: "Long videos", text: `Videos up to 10 minutes are transcribed for free; longer ones (up to 2 hours, on paid plans) cost 1 credit per started ${SPEECH_CREDIT_SECONDS / 60} minutes.` },
  { name: "Editing", text: "Subtitles, music, transitions, timing, layouts and text changes are free." },
];
export const PRICE_NOTE = "Prices in US dollars. Taxes may apply at checkout.";
