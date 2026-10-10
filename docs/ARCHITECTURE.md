# Architecture

## Stack

React 19 + React Router + Vite (client, `src/`), a Hono Worker (`server/`), Cloudflare D1 (schema in
`migrations/0001_initial.sql`), a private R2 bucket (`MEDIA`), two Workflows (`ContentGeneration`, `Publication`), a
Containers pool of three FFmpeg renderers (`renderer/server.py`, reached through the `MediaRenderer` Durable Object),
Workers AI for text, and a cron every minute. Contracts shared by the client and the Worker live in `shared/`: plans
and credits, series settings and schedules, templates and video types, the video spec and its timing, captions and
on-screen text, renderer payloads and the networks' limits.

## Request flow

Everything is one Worker (`server/index.ts`); static assets are served by the `ASSETS` binding with the Worker first.
Each request passes, in order:

1. **Headers** on every answer: `nosniff`, `Referrer-Policy`, `X-Frame-Options: DENY`, a `Permissions-Policy`, HSTS on
   https and a Content-Security-Policy (`default-src 'self'` plus Turnstile for pages; `default-src 'none'` for
   `/api/v1/*` and `/mcp`). API answers without their own caching get `Cache-Control: no-store`.
2. **One public address**: a request on another host is redirected (308, method and body kept) to the same path on
   `SITE_URL`; `*.workers.dev` and localhost are left alone (`canonicalUrl` in `server/config.ts`).
3. **Body limits**: 8 MiB + 1 KiB for an upload part, 60 MB for an administrator's library upload, 1 MiB otherwise.
4. **API key routes**, mounted before the Origin check (they use no cookies, so no CSRF risk): the REST API at
   `/api/v1` and the MCP server at `/mcp` (`server/api.ts`).
5. **Origin check**: every non-GET/HEAD request to `/api/*` must carry `Origin` equal to `SITE_URL`'s origin, except
   the signed Stripe webhook.
6. `POST /api/billing/webhook`, `GET /api/health` (D1 reachable: 200, else 503), then the public routes
   (`/api/public/config`, `/api/contact`).
7. **Capability links** (a token in the URL, no session): `/api/render-inputs` (the renderer and fal read a run's
   inputs), `/api/upload-inputs` (the renderer and Scribe read an upload), `/api/publish-media` (Instagram fetches a
   video).
8. **Session**: the HttpOnly cookie's token is looked up by its SHA-256 in `sessions` (30 days). `/api/auth` follows.
9. **Sign-in required** for the rest (a social network's callback without a session goes to `/login`):
   `/api/billing`, `/api/series`, `/api/videos`, `/api/story`, `/api/media`, `/api/library`, `/api/accounts`,
   publishing under `/api` (`/videos/:id/publish`, `/publications…`), `/api/settings`, `/api/keys` and `/api/admin`
   (administrators only; others get 404).
10. Unknown `/api/*` paths answer 404 JSON. Other paths go to `server/pages.ts`: `robots.txt`, `sitemap.xml` and the
    single-page app document with each public page's title, description and canonical/Open Graph tags
    (`shared/seo.ts`); unknown paths get the app's not-found page with a real 404.

Errors: an `HTTPException` becomes `{error}` with its status; a zod error 400 with the fields; anything unexpected 503
with a reference that is logged as `Request failed` (billing routes answer their own plain message). The `scheduled`
handler runs `maintenance()` every minute.

## Data model

One migration, `migrations/0001_initial.sql`; D1 always enforces foreign keys.

| Area | Tables |
| --- | --- |
| Accounts | `users`, `sessions`, `auth_tokens` (verify/reset), `rate_limits`, `terms_acceptances`, `contact_messages`, `cleanup_tasks` |
| Billing | `subscriptions` (Stripe subscriptions and `grant_` rows), `stripe_status`, `stripe_reconciled`, `billing_events` (webhook de-duplication), `checkout_intents`, `usage_windows`, `trial_history`, `credit_topups`, `media_limits`, `checkout_consents`, `withdrawals` |
| Social | `social_accounts` (sealed credentials), `oauth_states` |
| Making videos | `series`, `videos`, `runs`, `media_assets`, `media_parts`, `library_items` |
| Publishing | `publications` (status, attempts, media-link token, provider ticket, URL, stats) |
| API | `api_keys` (SHA-256 of the key and a short prefix only) |
| Operations | `operations_state`, `manual_reviews` |

Triggers keep the rules in the database, so no code path can skip them:

- **Credits**: `run_credit_reserve` refuses a run whose credits do not fit its usage window (`QUOTA_EXCEEDED`),
  `run_credit_charge` adds them to `used` in the same transaction, and `run_refund` gives them back exactly once when
  a queued or running run becomes `failed`. `run_active_limit` allows 20 active runs per person (`RUNS_BUSY`).
- **Storage**: `media_storage_limit` (the plan's bytes in `media_limits`) and `media_file_limit` (5,000 files) answer
  `STORAGE_FULL`.
- **Work in progress**: `video_busy`, `account_busy` and `user_busy` refuse deletes while a run or a publication is
  under way.
- **Cleanup**: `media_cleanup`, `library_cleanup` and `user_cleanup` queue R2 keys or prefixes in `cleanup_tasks`;
  `evidence_account_deleted` marks terms acceptances and checkout consents of a deleted account.

Unique indexes that carry rules: `videos_series_slot` (one video per series slot), `one_active_run_per_video`,
`runs(user_id, idempotency_key)` (a retried request or step finds its earlier run), `publication_once` (a video is
scheduled, publishing or published at most once per account) and `social_accounts(user_id, platform, external_id)`.

## A video

A video's editable description is its **spec** (`shared/formats.ts`, validated with zod on every write): the video
type (`kind`: `story`, `pov`, `mashup`, `script`, `backdrop`), the narration (an AI voice by ID, or one of the owner's
audio/video uploads with an optional exact script), the language, 1–40 scenes (their words, a picture description, key
words, the picture's source and the transition in), one art style (`shared/story.ts`, 15 prompt suffixes), one
recurring subject, captions (on/off, one of 21 styles), an optional on-screen headline (`shared/headline.ts`), an
optional background clip that replaces the pictures (storytime), music (a library track or an upload, with a volume),
and the post text (caption, hashtags, title, topic). `generated` (the recorded AI voice and its word timings) is owned
by the server: the browser never sets it.

A scene's picture is an **AI image** (made once, then shown with a slow zoom or pan), an **AI clip** made from that
image (5 or 10 s), the owner's **image or video**, or a **library clip**. Scenes hold words, never times: times come
from the voice's word timings, so an edit only moves words between scenes and keeps the paid recording
(`narrationKey`: voice, length and a fingerprint of the script).

**Credits** (`specCredits`, `shared/credits.ts`): a new video costs 1 credit per started 30 seconds of its estimated
length (the owner's recording by its own length), everything included, plus 1 credit per 5 seconds of AI clips. An
edit of a made video costs only what it asks for again: new narration when the words or voice changed, 1 credit per
5 new pictures, and new clips. Changes to the caption, hashtags or title need no new render; other free changes
(subtitles, music, transitions, timing) re-render for 0 credits.

## Writing

The script writer (`writeVideo` in `server/story.ts`, rech-bg's studio writer on this app's text model) gets the
template's brief, the owner's prompt and recent titles as **data**, never as instructions. Its rules: original content
only, no existing characters, brands or real private people, no invented statistics or quotes, no hate, sexual
content, graphic violence or medical, legal or financial advice; spoken text in the narration language, picture
descriptions in English. It writes about 15 characters per second of the target length as one scene per ~4.5 s
(3–40 scenes), each with a picture description and one or two key words, plus a recurring subject, a headline, a
title, a caption, hashtags, a topic and a music code from the library list. Each video type adds rules (POV in the
second person, the mashup's chanted name, storytime's title question read out first). `acceptStory` cleans and checks
the answer; fewer than two usable scenes means failure.

- `POST /api/story/draft` (free; 40 an hour and 200 a day per person) turns a template and a brief into a spec for the
  editor. Text to video splits the owner's script into scenes (`scriptScenes`) and only describes their pictures
  (`planScenes`); a storytime with the owner's own story is split the same way.
- `POST /api/story/plan` (free, 30 an hour) describes pictures for scenes that already have words.
- `POST /api/story/timing` times an owner's voiceover: its transcript, or with an exact script ElevenLabs forced
  alignment (made once per file and script, kept in `media_assets.meta.alignment`, within the daily free speech
  allowance of 20 files or 30 minutes).

Uploads go to R2 as multipart uploads of 8 MiB parts (images up to 20 MB, videos 500 MB, tracks 50 MB). Images are
checked from their header; videos and tracks by the renderer (`inspect`: kind, picture size, length up to 10 minutes,
sound) and, when they may hold speech, transcribed once by ElevenLabs Scribe v2 for free within the same daily
allowance. A failed transcription only means no subtitles.

## The content workflow

`ContentGeneration` (`server/content-workflow.ts`) runs three kinds of jobs: a video's run (`runId`), an upload check
(`inspectId`) and a series episode (`episode`, below). A **run** is created with its video (or for an edit) in one
D1 batch, so the credits are reserved by the triggers before any work starts. Its steps:

1. **Load**: the run becomes `running`, gets a capability token and a render job ID.
2. **AI pictures and clips** (fal, `server/providers/fal.ts`): every picture the spec still needs
   (GPT Image 2.5 Flare at 864 × 1536, `FAL_IMAGE_QUALITY` high by default; `FAL_IMAGE_MODEL` can choose its Sunburst
   variant, `fal-ai/nano-banana-2` or `fal-ai/flux/schnell`), then every clip made from its
   picture (`fal-ai/kling-video/v2.5-turbo/pro/image-to-video`, which reads the picture through a capability link).
   Each is stored in R2 as an asset of the video (marked `{"ai":true}`) and written back into the spec.
3. **Voice + alignment** (after the pictures, so a refused picture stops the run before the voice is paid): ElevenLabs
   `eleven_v4` with timestamps of the text as written, saved as a WAV. When the timings do not have one word per word
   of the script, forced alignment of the WAV with the script times it; if that fails, the voice's own timings are
   matched to the script by their letters. A voice without any timings still makes a video: its scenes are spread over
   it and it has no subtitles.
4. **Render**: `planRender` (`server/render-plan.ts`) turns the spec into a `compose` payload and the workflow submits
   it to a container and polls it (every 8 s, up to about 40 minutes).
5. **Save**: the MP4 and its JPEG **cover** are stored as `render` and `cover` assets, the video becomes `ready`, and
   files of earlier versions it no longer uses are deleted (R2 cleanup follows).
6. **Ready** (`videoReady`): an approved series episode is scheduled on its series' accounts, and the owner is
   e-mailed when the series sends notices.

**Paid calls are made once.** Before each fal or ElevenLabs call a claim is stored in `runs.provider`, and the ticket
right after; a retried step polls the existing job instead of paying again, and a claim without a ticket (the answer
was lost) fails the run (`GENERATION_UNCERTAIN`, `VOICE_FAILED`). On any failure the workflow stops the render, marks
the run failed with a short code (the trigger refunds its credits), stores a plain message on the video and, for a
series episode, e-mails the owner once. Maintenance re-dispatches runs whose workflow never started and fails (and
refunds) runs older than 3 hours.

**Capability links**: `/api/render-inputs/:run/:n?token=` works only while the run is `running` and at most 6 hours
after it was created, and only for the owner's files (`media/<user>/…`) or the library (`library/…`).

### The render

`planRender` lays the scenes on the voice's clock (`storyTiming`): each scene starts in the middle of the pause before
its first word, on the 1/30 s frame grid, and lasts at least half a second. Transitions (FFmpeg `xfade`: fade, fade
through black, dissolve, slides, wipes, circle, zoom; "auto" is a calm varied sequence) are an even number of frames
centred on their scene edge, shortened to fit 40% of the shorter scene, so the segments less their overlaps add up to
the voice exactly. A storytime loops its background clip under the whole voice instead. The voice is one track from 0;
subtitles are burned in as ASS from real word timings only (never estimates); the headline is drawn on top for its
seconds; music loops, fades and is lowered under the voice; free-trial videos get a small watermark with the product
name. The cover is taken once the first words (and the headline) are on screen. Output is 1080×1920 at 30 fps, at most
180 seconds.

**The container** (`renderer/`, Python 3.12 with FFmpeg, libass and the bundled Noto fonts): three instances
(`max_instances: 3`, `standard-2`), each running one job at a time. A job goes to the container its ID hashes to, or
the next free one (`429` means busy), and the workflow records the slot that accepted it. Inputs are downloaded only
from `SITE_URL`'s origin on the capability paths; finished files wait 30 minutes for the Worker. Files with an AI
voice, picture or clip are marked as AI-made (MP4 tags and an XMP packet with the IPTC digital source type), and the
saved render carries `{"ai":true}`. The Worker uses the `compose` and `inspect` operations.

## Series autopilot

A series (`server/series.ts`, settings in `shared/series.ts`) is a template, its settings and a `next_slot`. Its
schedule (`shared/schedule.ts`) is 1–6 times a day on chosen weekdays in an IANA time zone; `slots()` lists them,
handling daylight saving time. Plans limit how many series a person has; text to video cannot run as a series.

- **Planning.** A new series points at the first slot at least 10 minutes away; by default its first episode is
  started at once, so the owner sees what it makes before anything posts. Changing the schedule or resuming a paused
  series starts again from the next slot from now; pausing cancels what was still scheduled; deleting a series keeps
  its videos.
- **Made ahead.** Every minute (when `MEDIA_ENABLED=true`) `dispatchSeries` takes active series whose next slot is
  within `MAKE_AHEAD` (6 hours on autopilot, 24 hours in review mode), at most 10 a minute. Each is **claimed** for
  15 minutes (`attempted_at`) and handed to the workflow as an `episode` job.
- **Attempt.** The workflow's `episode` step (`runEpisode`) reuses the video already made for that slot, or writes
  the episode (avoiding the series' 40 latest titles, picking a library track of its mood and, for storytime, a
  background clip), builds the spec and creates the video with the idempotency key `episode:<series>:<slot>`. Autopilot
  episodes are approved when they are made; review-mode episodes wait. The series then moves on to the slot after.
- **Retries and blocked reasons.** A slot that cannot be made is skipped with a reason kept in `series.blocked`:
  `trial` (the free trial ended), `credits` (not enough credits), `busy` (20 runs active) or `failed` (the writer
  failed). A writer failure is retried by the cron after the 15-minute claim, up to three attempts, before the slot is
  skipped. The owner gets one e-mail when a series becomes blocked by credits or the trial (not for every skipped
  slot), when the series sends notices.
- **Late grace.** A slot more than 3 hours (`LATE_GRACE`) in the past is never made late: the series jumps to its next
  slot. An episode that becomes ready after its slot still posts at once if the slot passed less than 3 hours ago;
  later ones are left for the owner to post by hand.
- **Notices.** `videoReady` e-mails once per video (`notified_at`): when it posts, or that it waits for review.
  `videoFailed` e-mails once when an episode could not be made.
- **"Make one now"** (`POST /api/series/:id/episodes`) makes an extra episode, or the one of a coming slot.

## Publishing

`POST /api/videos/:id/publish` posts a ready video to chosen accounts now (in a minute) or at a time up to 180 days
ahead, publicly or privately (TikTok and YouTube; Instagram cannot); it approves a video still waiting for review. A
series' approved episode is scheduled on the series' accounts at its slot (`scheduleEpisode`). Each network's limits
(`shared/social.ts`) are checked first: TikTok 3 s–10 min, YouTube Shorts up to 3 min, Instagram Reels 3 s–15 min.

Every minute `dispatchDue` (`server/publishing.ts`):

1. fails publications stuck in `publishing` for 2 hours (`TIMEOUT`);
2. fails due publications whose video failed, or is still being made 6 hours after its time;
3. claims up to 25 due publications of ready videos: status `publishing`, a fresh media-link token, `attempts + 1`;
4. starts a **Publication** workflow named `pub-<publication>-<attempt>` for each.

The workflow (`server/publish-workflow.ts`) checks the video and account, refreshes the token when needed, then
**starts the post once**: the network client saves a checkpoint in `publications.ticket` before any call that makes a
post public, so a replayed step resumes by polling instead of posting twice. Refusals that may pass (rate limits,
outages) are started again after 1, 5 and 15 minutes; then it polls every 15 seconds for up to 30 minutes and records
the URL. A run that cannot tell whether the post went out fails with a message asking the person to check their
profile before retrying. Failures are stored as plain-English messages; an `AUTH_EXPIRED` marks the account expired.

- **TikTok**: Content Posting API, direct post, the file uploaded in chunks from R2 (`FILE_UPLOAD`); `is_aigc` set for
  AI-made videos.
- **YouTube**: a resumable upload from R2 with `#Shorts` in the description and `containsSyntheticMedia` for AI-made
  videos.
- **Instagram**: a `REELS` container whose `video_url` is the capability link
  `/api/publish-media/:publication/0.mp4?token=` (valid while that publication is publishing, 24 hours at most), then
  `media_publish`.

OAuth tokens are sealed with AES-256-GCM (`TOKEN_ENCRYPTION_KEY`, `server/crypto.ts`) and never leave the server.
Instagram's 60-day tokens are renewed in their last 10 days by the 03:17 UTC maintenance.

**Video stats** (`server/metrics.ts`): at minute 2, 7, 12, … of every hour the cron reads views, likes, comments and
shares (saves on Instagram) of up to 40 posts on up to 10 accounts, for posts published in the last 30 days: first 30
minutes after posting, every 3 hours for two days, then daily. A number a network does not report stays empty.

## Billing

**Usage windows** (`allowance` in `server/billing.ts`). Credits are spent from one window at a time:

- each paid month of a subscription has its own window, `user:subscription:period_start`; a yearly period is cut into
  calendar months from its start (`:1` … `:11`), each with the plan's monthly credits;
- the free trial is one lasting window (`user:trial`) with 4 credits, once per mailbox: an HMAC of the mailbox (Gmail
  dots and `+tags` ignored, keyed with `TRIAL_HASH_SECRET`) in `trial_history` survives account deletion; new videos can
  be made for 7 days after sign-up;
- a renewing subscription keeps its last paid period for 3 days while Stripe collects the invoice;
- an upgrade inside a month adds only the unused share of the difference; a downgrade uses the new plan's credits;
- **rollover**: a new paid month starts with the credits left in the previous paid month (if it was created within
  45 days), capped at three months of the plan's credits (`ROLLOVER_MONTHS`) plus the credit packs bought in it. Free
  months (grants) take no part: they start with the full plan and leave nothing behind;
- storage follows the plan (`media_limits`); files over a lower limit stay, new ones wait.

**Subscriptions**: Stripe Checkout in `subscription` mode for a paid plan and interval (`month` or `year`), from the
price IDs in `STRIPE_PRICE_*`. The checkout needs a confirmed email, `BILLING_ENABLED=true`, the operator details and
the person's express request for the plan to start at once (recorded in `checkout_consents` with its version and
repeated on Stripe's page). The price is checked before the session is created: active, USD, the exact amount of
`shared/plans.ts`, interval and count 1. A customer with a live subscription is sent to the Customer Portal's plan
change confirmation instead; one open checkout per person (`checkout_intents`). Optional Stripe Tax
(`STRIPE_AUTOMATIC_TAX=true`). After payment the contract is confirmed by e-mail (retried hourly for a week).

**Webhook** (`/api/billing/webhook`): the signature is verified, each event is handled once (`billing_events`), and the
subscription is always read back from Stripe rather than trusted from the payload; an older reading never overwrites a
newer one. A nightly reconciliation (03:17 UTC) re-reads customers whose plan looks doubtful.

**Credit packs**: one-time Checkout payments (`mode: payment`) with inline `price_data` (`shared/plans.ts`
`creditPacks`), only for people on a paid plan. Credits are added by the webhook (`checkout.session.completed` or
`checkout.session.async_payment_succeeded`), never on the redirect, once per Checkout session, to the current window's
`quota` and `topped`.

**Refunds and disputes**: a refunded credit pack takes back its unused credits. A fully refunded subscription payment,
a dispute, a withdrawal or the deletion of the account ends paid access (`endPaidAccess`): Stripe subscriptions are
cancelled and the paid windows' quota is set to what was used.

**Withdrawals** (`server/withdrawals.ts`): within 14 days of subscribing an administrator ends the plan and refunds
`floor(paid × (quota − used) / quota)`, where `quota` is the paid period's credits (twelve months' worth for a yearly
plan) and `used` the credits used in it (`shared/withdrawal.ts`).

**Plan grants** (`server/plan-grants.ts`): an administrator gives a paid plan for 30 days as a `subscriptions` row with a
`grant_` ID, so it gets its own window and ends by itself. It wins over a lower paid plan; reconciliation, refunds and
withdrawals never touch it.

## API keys, REST API and MCP

`server/api.ts`. A key is `hss_` plus 48 hex characters, shown once; only its SHA-256 and a 7-character prefix are
stored (`api_keys`). Up to 10 keys per person, a confirmed email is required, and `last_used_at` is written at most
once a minute. Requests send `Authorization: Bearer hss_…` and act as the key's owner with the same credits, limits and
checks as the app; making a video through the API is limited to 30 an hour.

- **REST** (`/api/v1`): `GET /me` (plan and credits), `GET /types` (video types, art styles, voices, languages),
  `GET /videos`, `POST /videos` (writes and makes a video), `GET /videos/:id`, `GET /series`,
  `POST /series/:id/pause|resume`.
- **MCP** (`/mcp`, Streamable HTTP, JSON-RPC 2.0, protocol `2025-06-18`): `POST` with one message or a batch of up to
  20; notifications get 202; `GET` and `DELETE` answer 405 (no server stream, no session). Tools: `list_video_types`,
  `create_video`, `get_video`, `list_videos`, `list_series`, `set_series_status`, `get_account`. A tool's failure is
  returned as its result with `isError`, in plain words. 300 requests an hour per person.
- **Signed download links**: a ready video's `download` is
  `/api/v1/files/:video?exp=&sig=`, an HMAC-SHA256 (keyed with `TOKEN_ENCRYPTION_KEY`) of the video, its render and the
  expiry, valid for one hour, served as an attachment without a session.

## Safety and privacy

- **Requests**: exact Origin check on every state change (except the signed webhook and the API key routes); HttpOnly
  session cookies of which only a SHA-256 is stored; PBKDF2-SHA256 passwords; Turnstile on sign-up and the contact
  form (and on sign-in after repeated failures); rate limits per person or address.
- **Untrusted text**: prompts, scripts and model answers are data. Model output is cleaned and schema-validated.
- **Providers**: provider calls refuse redirects; outputs are downloaded only from known provider hosts; provider
  messages are never logged or shown. Failures become short codes with plain-English messages.
- **AI marking**: AI-made videos carry machine-readable marks and set the networks' AI labels when posted.
- **Deletion**: deleting videos, files or accounts queues R2 cleanup; work in progress is protected by triggers.
  Deleting an account cancels its Stripe subscription first.

## Maintenance

The cron (`server/maintenance.ts`) runs every minute; a stage that throws never stops the others and is reported:

| When | Stages |
| --- | --- |
| Every minute | `publish` (`dispatchDue`); `series` (`dispatchSeries`, only with `MEDIA_ENABLED=true`) |
| Minutes 0, 5, 10, … | `runs`: re-dispatch runs whose workflow never started, fail runs older than 3 hours, mark videos left "being made" without a run as failed |
| Minutes 2, 7, 12, … | `stats`: video stats from the networks |
| Minute 17 of every hour | `summary` first (the operator summary, `server/operations.ts`), then `cleanup` (R2 deletes, only under `media/` and `library/`), `uploads` (unfinished uploads after a day, stuck checks after an hour, failed uploads after a week), `reviews` (provider work a failed run may have left), `retention`, `contracts` (confirmation e-mails) |
| 03:17 UTC | also `stripe` (reconciliation) and `social-tokens` (Instagram renewals, ended connections marked expired) |

The operator summary is e-mailed to `ADMIN_EMAILS` when it changes (or every 6 hours) and shown in Admin → Operations;
see [OPERATIONS.md](OPERATIONS.md).

## Retention

`applyRetention` (`server/retention.ts`) runs hourly as one D1 batch of bounded statements: expired sessions, links,
rate limits and OAuth states; contact messages after 365 days; Stripe event IDs after 90 days; checkout intents 7 days
after they expired; run prompts, provider tickets, input-link tokens and voice timings 30 days after the run finished
(only the revision and the watermark flag stay); failed or cancelled publications' media-link tokens and tickets after
30 days; trial identifiers unused for 730 days; terms acceptances and checkout consents 5 years after the account was
deleted, abandoned consents after 30 days, withdrawals after 5 years; accounts never confirmed after 30 days (never
one with a Stripe customer; one with work in progress waits). Periods and reasons: [PRIVACY.md](PRIVACY.md).
