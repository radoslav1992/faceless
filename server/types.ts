export interface Env {
  DB: D1Database;
  /** Private bucket: uploads, generated media, renders, library files. */
  MEDIA: R2Bucket;
  AI: { run: (model: string, input: Record<string, unknown>) => Promise<unknown> };
  ASSETS: Fetcher;
  /** Video runs ({runId}), upload checks ({inspectId}), imports from links ({importId}) and series episodes ({episode}). */
  CONTENT?: Workflow<{ runId?: string; inspectId?: string; importId?: string; episode?: { seriesId: string; slot: number; first?: boolean } }>;
  PUBLISH?: Workflow<{ publicationId: string }>;
  MEDIA_RENDERER?: DurableObjectNamespace;
  EMAIL?: SendEmail;
  SITE_URL?: string;
  APP_ENV?: string;
  REGISTRATION_ENABLED?: string;
  BILLING_ENABLED?: string;
  /** Rendering and AI generation (needs the renderer container and provider keys). */
  MEDIA_ENABLED?: string;
  /**
   * "true": paid plans can import videos from their own connected YouTube channel for clips (server/youtube-import.ts;
   * a beta, off by default: see docs/DEPLOYMENT.md before switching it on).
   */
  YOUTUBE_IMPORT?: string;
  EMAIL_FROM?: string;
  CONTACT_EMAIL?: string;
  ADMIN_EMAILS?: string;
  COMPANY_NAME?: string;
  COMPANY_ADDRESS?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  /** Key of the trial identifier (HMAC of the mailbox), see billing.ts trialKey. */
  TRIAL_HASH_SECRET?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  /** Monthly prices of the paid plans (USD), and their yearly prices. */
  STRIPE_PRICE_STARTER?: string;
  STRIPE_PRICE_DAILY?: string;
  STRIPE_PRICE_DOUBLE?: string;
  STRIPE_PRICE_STUDIO?: string;
  STRIPE_PRICE_STARTER_YEARLY?: string;
  STRIPE_PRICE_DAILY_YEARLY?: string;
  STRIPE_PRICE_DOUBLE_YEARLY?: string;
  STRIPE_PRICE_STUDIO_YEARLY?: string;
  /** "true": Stripe Checkout calculates tax (needs Stripe Tax set up). */
  STRIPE_AUTOMATIC_TAX?: string;
  /** Workers AI text model for episode scripts and picture descriptions. */
  TEXT_MODEL?: string;
  /** Multimodal model that suggests library items' details from a picture, clip frames or a part of a track (server/describe.ts). */
  DESCRIBE_MODEL?: string;
  FAL_KEY?: string;
  /** HeyGen: on-screen presenters (avatars lip-synced to the narration; server/providers/heygen.ts). */
  HEYGEN_API_KEY?: string;
  /** A scheduling page (Cal.com, Calendly…) where customers book a call for credits (server/calls.ts). */
  CALL_BOOKING_URL?: string;
  /** fal model for scene pictures: GPT Image 2.5 Flare by default, or its Sunburst variant, "fal-ai/nano-banana-2" or "fal-ai/flux/schnell". */
  FAL_IMAGE_MODEL?: string;
  /** GPT Image 2.5's quality: low, medium, high (default), xhigh or max. */
  FAL_IMAGE_QUALITY?: string;
  /** Later pictures of a video drawn from its first as a reference (server/providers/fal.ts); "off" to stop it. */
  FAL_REFERENCE_MODEL?: string;
  ELEVENLABS_API_KEY?: string;
  /** 32 random bytes, base64: encrypts social OAuth tokens at rest. */
  TOKEN_ENCRYPTION_KEY?: string;
  TIKTOK_CLIENT_KEY?: string;
  TIKTOK_CLIENT_SECRET?: string;
  /**
   * The networks everyone can connect, comma-separated ("tiktok,youtube,instagram"). Unset, only administrators can, and
   * everyone else sees "Coming soon" (server/accounts.ts).
   */
  SOCIAL_OPEN?: string;
  /** "true" once TikTok has audited the app: videos post straight to the profile instead of arriving as drafts. */
  TIKTOK_DIRECT_POST?: string;
  INSTAGRAM_APP_ID?: string;
  INSTAGRAM_APP_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
}
export type DbUser = {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  verified: number;
  created_at: number;
  stripe_customer: string | null;
  /** The affiliate this account signed up through (migrations/0009_growth.sql). */
  referred_by?: string | null;
};
export type ContextVars = { user: DbUser; session: string };
export type App = { Bindings: Env; Variables: ContextVars };
export const now = () => Math.floor(Date.now() / 1000);
/** Durations in seconds, matching now(). */
export const MINUTE = 60, HOUR = 3600, DAY = 86400;
export const MB = 1024 * 1024, GB = 1024 * MB;
export const uid = () => crypto.randomUUID();
/** The operator details the legal pages need before registrations and payments open. */
export function ready(e: Env) {
  return !!(e.COMPANY_NAME && e.CONTACT_EMAIL && e.SITE_URL);
}
export const mediaEnabled = (e: Env) => e.MEDIA_ENABLED === "true";
