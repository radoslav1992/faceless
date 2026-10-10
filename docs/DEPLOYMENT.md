# Deployment

Ghostreel deploys as one Cloudflare Worker (`faceless`, with its static assets) plus a container image for the
renderer. `npm run deploy` builds the client and runs `wrangler deploy`, which also publishes the renderer image,
creates the Workflows and sets the cron. With GitHub → Workers Builds use `npm ci && npm run build` as the build command
and `npx wrangler deploy` as the deploy command (a full deploy, so the container image is published too).

## 1. Cloudflare resources

**Workers Paid** is required (Containers, and the 120 s CPU limit in `wrangler.jsonc`).

| Resource | Binding | How to create |
| --- | --- | --- |
| D1 database `faceless` | `DB` | Created (Western Europe); its `database_id` is in `wrangler.jsonc` and `0001_initial.sql` is applied. On another account: `npx wrangler d1 create faceless` and put the printed ID there |
| R2 bucket `faceless-media` (private) | `MEDIA` | Created (location: Eastern North America). On another account: `npx wrangler r2 bucket create faceless-media --location weur` |
| Workflows `faceless-content` (`ContentGeneration`) and `faceless-publish` (`Publication`) | `CONTENT`, `PUBLISH` | Created by `wrangler deploy` |
| Container `MediaRenderer` (`renderer/Dockerfile`, up to 3 instances of `standard-2`) | `MEDIA_RENDERER` (Durable Object, migration `renderer-v1`) | Enable Containers on the account; `wrangler deploy` builds and pushes the image. The first rollout takes a few minutes |
| Workers AI | `AI` | Nothing to create; scripts and picture descriptions run on `TEXT_MODEL` (default `openai/gpt-6-luna`) |
| Email Sending | `EMAIL` | Onboard the domain in Cloudflare Email, then add `"allowed_sender_addresses": ["hello@your-domain"]` to the `send_email` entry in `wrangler.jsonc` |
| Cron `* * * * *` | – | Set by `wrangler deploy` (`triggers` in `wrangler.jsonc`) |
| Turnstile widget | – | Create one for the domain; set `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` |

Apply the schema once, and again whenever a file lands in `migrations/`:

```sh
npm run db:remote     # wrangler d1 migrations apply faceless --remote
npx wrangler d1 migrations list faceless --remote   # nothing left to apply
```

- **R2**: add a lifecycle rule to *abort incomplete multipart uploads after 1 day*. Do **not** add an object-expiry
  rule; the app deletes its files itself.
- **Renderer image**: Python 3.12 on Debian bookworm with its FFmpeg (libass, x264) and Noto fonts, plus the bundled
  caption fonts. It also installs OpenCV and downloads the YuNet face model at a fixed commit, checked against its
  SHA-256, so the build needs network access to `media.githubusercontent.com`. Each `standard-2` instance runs one
  render at a time.
- **Domain**: once the domain is known, put `SITE_URL` and `CONTACT_EMAIL` in `vars` and add `routes` with the custom
  domain in `wrangler.jsonc`; until then the Worker answers on `workers.dev`. The Worker sends every other host
  (except `*.workers.dev` and localhost) to the same path on `SITE_URL` (308). `SITE_URL` must be the public `https`
  origin: the renderer downloads only from it, and OAuth redirect URIs and the providers' input links are built from
  it.
- `keep_vars` is on: variables and secrets set in the dashboard survive deploys. Keep switches, secrets and private
  values (`ADMIN_EMAILS`) in the dashboard.

## 2. Variables and secrets

Set these in Workers → Settings → Variables and Secrets (or `npx wrangler secret put NAME`). These are all the names
the Worker reads (`Env` in `server/types.ts`); `.dev.vars.example` lists them for local development.

| Name | Kind | Purpose |
| --- | --- | --- |
| `SITE_URL` | text | Public `https` origin. Canonical host, Origin check, OAuth redirect URIs, capability links, the renderer's only download origin |
| `COMPANY_NAME`, `COMPANY_ADDRESS`, `CONTACT_EMAIL` | text | Operator shown on the legal pages and in confirmation e-mails. `COMPANY_NAME`, `CONTACT_EMAIL` and `SITE_URL` are required before sign-ups and payments open |
| `EMAIL_FROM` | text | Sender address (defaults to `CONTACT_EMAIL`); must be an allowed sender of the `EMAIL` binding |
| `ADMIN_EMAILS` | text | Comma-separated. Confirmed accounts with these addresses are administrators; the first 10 valid addresses get the operations e-mail, and all get contact-form messages |
| `REGISTRATION_ENABLED` | text | `true` opens sign-ups |
| `BILLING_ENABLED` | text | `true` opens checkout and credit packs, and turns on reconciliation and contract e-mails |
| `MEDIA_ENABLED` | text | `true` turns on making videos (AI generation and rendering) and the series autopilot |
| `APP_ENV` | text | `development` lets sign-ups work without Turnstile. Local only |
| `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` | text / secret | Bot checks on sign-up, the contact form and repeated failed sign-ins. Sign-ups refuse without the secret outside development |
| `TRIAL_HASH_SECRET` | secret | Long random string: keys the HMAC that makes the free trial once per mailbox |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | secret | Stripe API key and the webhook endpoint's signing secret |
| `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_DAILY`, `STRIPE_PRICE_DOUBLE`, `STRIPE_PRICE_STUDIO` | text | Monthly price IDs (section 3) |
| `STRIPE_PRICE_STARTER_YEARLY`, `STRIPE_PRICE_DAILY_YEARLY`, `STRIPE_PRICE_DOUBLE_YEARLY`, `STRIPE_PRICE_STUDIO_YEARLY` | text | Yearly price IDs (section 3) |
| `STRIPE_AUTOMATIC_TAX` | text | `true` when Stripe Tax is set up: tax, tax ID collection and a required billing address at checkout |
| `TEXT_MODEL` | text | Optional Workers AI model for scripts and picture descriptions (default `openai/gpt-6-luna`) |
| `FAL_KEY` | secret | AI pictures (`openai/gpt-image-2.5/flare/text-to-image`) and clips (`fal-ai/kling-video/v2.5-turbo/pro/image-to-video`) |
| `FAL_IMAGE_MODEL` | text | Optional picture model: `openai/gpt-image-2.5/sunburst/text-to-image`, `fal-ai/nano-banana-2` or `fal-ai/flux/schnell` (cheapest); anything else uses the default |
| `FAL_IMAGE_QUALITY` | text | Optional GPT Image 2.5 quality: `low`, `medium`, `high` (default), `xhigh` or `max`. Each step up costs more per picture |
| `ELEVENLABS_API_KEY` | secret | Narration (`eleven_v4` with timestamps), forced alignment, and Scribe v2 transcription of uploads (Scribe and forced alignment read files through links on `SITE_URL`) |
| `ELEVENLABS_VOICES` | text | Optional JSON `{"george":"<voice id>", …}` replacing the ElevenLabs voice behind any of the 12 public voices (`server/voices.ts`) |
| `TOKEN_ENCRYPTION_KEY` | secret | `openssl rand -base64 32`. Seals OAuth tokens (AES-256-GCM) and signs API download links. Never change it once accounts are connected |
| `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET` | secret | TikTok app (section 4) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | secret | Google OAuth client for YouTube (section 4) |
| `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET` | secret | The Instagram app ID and secret of the Meta app (section 4) |

A network without its credentials (or without `TOKEN_ENCRYPTION_KEY`) shows as not available in Channels. Admin →
Overview shows which of these are configured.

## 3. Stripe

1. **Products and prices.** Create one product per paid plan, each with two recurring **USD** prices, and put the
   price IDs into these variables. The checkout refuses a price that is inactive or whose currency, amount or interval
   doesn't match `shared/plans.ts` (interval count 1).

   | Plan | Monthly price | Variable | Yearly price | Variable | Credits a month |
   | --- | --- | --- | --- | --- | --- |
   | Starter | $19 / month | `STRIPE_PRICE_STARTER` | $168 / year | `STRIPE_PRICE_STARTER_YEARLY` | 30 |
   | Daily | $35 / month | `STRIPE_PRICE_DAILY` | $288 / year | `STRIPE_PRICE_DAILY_YEARLY` | 60 |
   | Double | $59 / month | `STRIPE_PRICE_DOUBLE` | $492 / year | `STRIPE_PRICE_DOUBLE_YEARLY` | 120 |
   | Studio | $149 / month | `STRIPE_PRICE_STUDIO` | $1,248 / year | `STRIPE_PRICE_STUDIO_YEARLY` | 350 |

   A subscription's plan is recognised by these IDs, or by a price's lookup key or `metadata.plan` set to `starter`,
   `daily`, `double` or `studio`. Checkout allows promotion codes.
2. **Credit packs need no products.** They are one-time Checkout payments with inline `price_data`
   (`creditPacks` in `shared/plans.ts`): 10 credits for $8, 40 for $28 and 150 for $90, named "N credits — Ghostreel".
3. **Webhook.** Add an endpoint at `${SITE_URL}/api/billing/webhook` with these events and put its signing secret into
   `STRIPE_WEBHOOK_SECRET`:
   - `checkout.session.completed` and `checkout.session.async_payment_succeeded`
   - `customer.subscription.created`, `customer.subscription.updated` and `customer.subscription.deleted`
   - `invoice.paid` and `invoice.payment_failed`
   - `charge.refunded` and `charge.dispute.created`
4. **Customer Portal.** Allow cancellations, payment method updates and plan changes between the four products and both
   intervals. For a plan change the app opens the portal's plan-change confirmation, and the portal's start page when
   that flow is not available.
5. **Tax (optional).** With Stripe Tax set up, set `STRIPE_AUTOMATIC_TAX=true`.
6. Withdrawals need nothing else: a first checkout asks for the express request to start at once (repeated on Stripe's
   page, confirmed by e-mail), and refunds for withdrawals are made from Admin → Billing with the same secret key
   ([OPERATIONS.md](OPERATIONS.md)).

## 4. Social apps

Each network calls back to `${SITE_URL}/api/accounts/callback/<platform>`, with the platform IDs `tiktok`, `youtube`
and `instagram`. Register exactly these redirect URIs. The connection's state is single-use, valid for 10 minutes and
bound to the person who started it. Review and audit steps per network: [SOCIAL.md](SOCIAL.md).

| Network | App | Redirect URI | Scopes |
| --- | --- | --- | --- |
| TikTok | developers.tiktok.com app with Login Kit and the Content Posting API (direct post); `TIKTOK_CLIENT_KEY` / `TIKTOK_CLIENT_SECRET` | `${SITE_URL}/api/accounts/callback/tiktok` | `user.info.basic`, `video.publish`, `video.list` |
| YouTube | Google Cloud project with the YouTube Data API v3 enabled, an OAuth consent screen and an OAuth client of type *Web application*; `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | `${SITE_URL}/api/accounts/callback/youtube` | `https://www.googleapis.com/auth/youtube.upload`, `https://www.googleapis.com/auth/youtube.readonly` |
| Instagram | Meta app with the Instagram product, *Instagram API with Instagram login* (business login); `INSTAGRAM_APP_ID` / `INSTAGRAM_APP_SECRET` are the Instagram app's ID and secret, not the Facebook app ID | `${SITE_URL}/api/accounts/callback/instagram` | `instagram_business_basic`, `instagram_business_content_publish`, `instagram_business_manage_insights` |

- **TikTok** uses PKCE. Videos are uploaded as files in chunks, so no URL ownership check is needed for them. Until
  TikTok audits the app it accepts posts only to private accounts; people then see a message saying so. `video.list`
  reads video stats.
- **YouTube** asks for offline access with a consent prompt (for a refresh token) and PKCE. A Google account without a
  YouTube channel cannot connect, nor can people who untick the upload scope. The read scope reads the channel when
  it connects and the videos' stats. Check that the project's YouTube Data API quota covers your daily uploads.
- **Instagram** posts Reels to professional (business or creator) accounts only. Instagram fetches each video from
  `SITE_URL` (`/api/publish-media/…`), so the site must be reachable over https. Long-lived tokens last 60 days and are
  renewed by maintenance in their last 10.

## 5. Content library (as an admin)

Sign in with an address in `ADMIN_EMAILS` (confirmed), open **Admin → Library** and upload (each file up to 50 MB,
half a second to 10 minutes, at most 4096 px a side; length, size and a thumbnail are measured in the browser):

- **Music**: tracks licensed for commercial use, tagged with the moods series choose from: `calm`, `upbeat`,
  `inspiring`, `dark`, `epic`, `mysterious`, `playful`, `ambient`. The writer picks a track whose tags include the
  series' mood (any track for "auto", and any when no track has that mood). Without music in the library, videos have
  none.
- **Background clips**: short vertical clips (tags such as `satisfying`, `gameplay-style`, `parkour`, `cooking`,
  `nature`, `city`). Storytime loops one behind the whole video, and any scene can use one. Without an active clip,
  storytime videos get AI pictures instead.

Switching an item off removes it from new videos; videos already made keep their render. You need the rights to
everything you upload, including permission for every person shown.

## 6. Go-live checklist

1. Create the resources (section 1; the D1 database and the R2 bucket already exist), then `npm run db:remote` for any migration newer than `0001_initial.sql`.
2. Set the variables and secrets (section 2): at least `SITE_URL`, `COMPANY_NAME`, `COMPANY_ADDRESS`, `CONTACT_EMAIL`,
   `ADMIN_EMAILS`, `TRIAL_HASH_SECRET`, `TOKEN_ENCRYPTION_KEY` and Turnstile; add the custom domain and the allowed
   sender address in `wrangler.jsonc`.
3. Deploy, then check `GET /api/health` (`{"ok":true}`) and point an uptime monitor at it.
4. Check e-mail deliverability (SPF, DKIM, DMARC; [OPERATIONS.md](OPERATIONS.md)).
5. Set `FAL_KEY` and `ELEVENLABS_API_KEY`, wait for the renderer image to roll out, then set `MEDIA_ENABLED=true`.
6. Fill the library: music for every mood and a few background clips (section 5).
7. Configure Stripe (section 3) and set `BILLING_ENABLED=true`.
8. Configure the social apps (section 4) and start their reviews.
9. Set `REGISTRATION_ENABLED=true`, last.
10. **Smoke test** with real keys, before announcing:
    1. Sign up and confirm the email.
    2. Create a video from a style in Create: draft, edit a scene, check the price, make it; it renders with subtitles,
       music and a cover, and carries the trial watermark.
    3. Start a series in review mode: its first episode is made at once and e-mailed; approve it.
    4. Connect one account per network and post a test video (privately on TikTok and YouTube).
    5. Buy a monthly and a yearly plan in Stripe test mode; check the confirmation e-mail and the credits.
    6. Buy a credit pack, refund it in Stripe, and check the credits are taken back.
    7. Withdraw a plan from Admin → Billing (the refund shows in Stripe) and give yourself a free month.
    8. Create an API key, call `GET /api/v1/me`, make a video through `/api/v1/videos` or the MCP server, and download
       it from the signed link.

## Known limits

- **Tested with mocks only**: the AI providers, the social networks (publishing and stats) and Stripe are covered by
  tests with mocked responses. Try each with live keys before launch.
- **Renderer**: the image uses Debian bookworm's FFmpeg 5.1; the renderer test runs on the FFmpeg of the CI runner.
- **Social platform review**: each network has review steps; until TikTok audits the app, posts can only go to
  private accounts.
- **Credit estimates**: a new video is charged by its script's estimated length (about 15 characters a second) before
  it is spoken; an owner's recording by its real length.
- **Legal pages**: the terms and privacy policy are a starting point; have them reviewed for your business and
  markets, in particular the withdrawal section (14 days, refund less the used share of the period's credits) and the
  retention periods ([PRIVACY.md](PRIVACY.md)).
