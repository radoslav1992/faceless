# Operations runbook

How to keep Ghostreel running after launch: what alerts you, where to look, what the failure codes mean, what to do
when a provider fails, and how to handle withdrawals and free months. Setting up from scratch is in
[DEPLOYMENT.md](DEPLOYMENT.md); what is kept for how long is in [PRIVACY.md](PRIVACY.md).

## 1. Signals at a glance

| Signal | Where | What it means |
| --- | --- | --- |
| E-mail "Ghostreel: maintenance needs a look" | inboxes in `ADMIN_EMAILS` | The hourly maintenance found something overdue or failing (section 3) |
| Admin → **Operations** | the app (`/app/admin?tab=operations`) | Failures of the last 24 hours by area and code, work still open, accounts to reconnect, cleanup, Stripe, manual checks, the last maintenance run. Same data: `GET /api/admin/operations` |
| Admin → **Overview** | the app | Users, paying customers (free months counted apart), videos, active series, runs and publications of the last 24 hours, and which features are configured |
| `GET /api/health` | an external uptime monitor | `200 {"ok":true}` when the Worker runs and D1 answers, `503 {"ok":false}` otherwise. Uncached |
| Workers Logs | Cloudflare → Workers & Pages → `faceless` → Logs | Every log line quoted in this file |
| Workflows | Cloudflare → Workflows → `faceless-content`, `faceless-publish` | One instance per run (its run ID), episode (`episode-<series>-<slot>…`), upload check (`inspect-<file>`), "Find speech" (`speech-<file>-<time>`) or publication attempt (`pub-<publication>-<attempt>`) |

Point an external uptime check (every 1–5 minutes, alert on anything but 200) at `${SITE_URL}/api/health`; it also
catches DNS, certificate and account problems nothing inside Cloudflare can report. If your plan offers alerts on
Workers Logs, alert on `Maintenance attention`, `Maintenance stage failed`, `Storage cleanup refused` and
`Request failed`; the admin e-mail covers the first three without it.

## 2. The admin console

Sign in with a confirmed address listed in `ADMIN_EMAILS`; **Admin** appears in the sidebar (`/app/admin`). Everything
under `/api/admin` answers 404 to anyone else.

- **Overview**: counts (users and new users, paying customers, free months, videos made and published in 24 hours,
  active series, active and failed runs, failed publications) and the configuration: rendering (`MEDIA_ENABLED`), fal,
  ElevenLabs, Stripe, billing, token encryption, TikTok, Instagram, YouTube.
- **Operations**: the last hourly maintenance and its failed stages (a warning when none finished in 2 hours); tiles
  for runs open over an hour, publications publishing over an hour, scheduled posts overdue by 15 minutes and cleanup
  waiting over a day; failures of the last 24 hours (runs by service and code, publishing by network and message, stats
  reads by network, transcriptions); accounts to reconnect by network; Stripe (the nightly reconciliation, renewals
  overdue, the last webhook event, free months running); work set aside for a manual check (section 5).
- **Billing**: *Withdrawal within 14 days* (section 6) and *Free month of a plan* (section 7).
- **Library**: the shared music and background clips. Upload (kind, file up to 50 MB, name, tags with suggestions:
  moods for music, themes for clips), preview, rename, retag, switch off or delete. Music is picked by its mood tags
  (`calm`, `upbeat`, `inspiring`, `dark`, `epic`, `mysterious`, `playful`, `ambient`); background clips loop behind
  storytime videos and can be any scene's picture. Switched-off or deleted items leave new videos; made videos keep
  their render.
- **Messages**: the last 100 contact-form messages; abuse reports are red, billing and withdrawal requests amber. Each
  message is also e-mailed to `ADMIN_EMAILS`.

## 3. The hourly summary e-mail

The cron runs every minute (`server/maintenance.ts`); the hourly part runs at minute 17 and **starts** with the summary
(`server/operations.ts`), so a stage that later fails or runs out of time cannot hold it back. When any line is above
zero it logs `Maintenance attention` with the counts and e-mails up to 10 valid addresses in `ADMIN_EMAILS` through the
`EMAIL` binding, from `EMAIL_FROM`:

- at once when the summary differs from the last one sent;
- otherwise at most once every **6 hours** for an unchanged summary;
- nothing once everything is back to zero (the next occurrence is reported again at once).

The last alert (a hash of its lines and the time) is kept in `operations_state` (key `alert`). A failed send is logged
as `Operator alert not sent` and tried again next hour; it never stops maintenance.

| Line | Counted | What to do |
| --- | --- | --- |
| AI or render runs still open after 3 hours | runs queued or running, created over 3 h 15 min ago | Maintenance fails (and refunds) runs at 3 hours every 5 minutes, so it is not reaching them: is the `CONTENT` binding there, is the cron running? Look the run ID up in Workers Logs and in the `faceless-content` Workflow |
| fal / ElevenLabs / Renderer / Other: N failed runs in the last hour (codes) | failed runs of the last hour by code (section 4), from **3** up, leaving out failures caused by the request itself | Probably an outage or an account problem at that provider (section 8). The credits were refunded |
| Scheduled posts of ready videos more than 15 minutes overdue | scheduled publications of ready videos due over 15 minutes ago | The per-minute publishing stage isn't starting them: look for `Publishing is not configured` (the `PUBLISH` binding) or `Maintenance stage failed` with stage `publish` |
| Failed publications in the last hour | from **3** up | Operations groups them by network and message: a network outage, an app review change or revoked permissions |
| Social accounts that need reconnecting, marked in the last 24 hours | from **5** up | Many at once means a network revoked tokens, the app's credentials changed, or `TOKEN_ENCRYPTION_KEY` changed (never change it) |
| Video stats reads that failed in the last hour | published posts whose last stats read failed, from **5** up | The network's stats API is failing (`Post stats failed`); reads are retried at the next interval |
| Speech transcriptions that failed in the last hour | uploads whose speech status became failed (among the 5,000 newest files), from **3** up | ElevenLabs Scribe is failing or cannot read the files from `SITE_URL` (`Speech not found`); people only lose the transcript |
| Storage cleanup waiting for more than 1 day | `cleanup_tasks` older than a day | R2 deletes keep failing: look for `Maintenance stage failed` with stage `cleanup` |
| Work set aside for a manual check in the last 24 hours | rows in `manual_reviews` | Section 5 |
| Stripe: failed reconciliations, or paid periods overdue for renewal by over 4 days | the last nightly reconciliation's failures, plus active, non-cancelling subscriptions whose period ended over 4 days ago | Webhooks are being missed and the backstop can't read Stripe: check the endpoint, its secret and `STRIPE_SECRET_KEY` |
| Maintenance stages that failed in the last hour | stage names | Search Workers Logs for `Maintenance stage failed` with that `stage`; the log has the error name, a scrubbed message and the top of the stack |

The thresholds are constants at the top of `server/operations.ts` (`FAILURE_BURST`, `RECONNECT_BURST`,
`METRICS_BURST`).

## 4. Failure codes

Runs store a short code (`runs.error`); people see a plain message on the video and "Your credits were refunded". The
summary groups codes by prefix: `GENERATION_` is fal, `VOICE_` is ElevenLabs, `RENDER…` and `MEDIA_TIMEOUT` the
renderer, everything else "Other".

| Code | Meaning |
| --- | --- |
| `GENERATION_REJECTED` | fal's content filter refused a picture or clip. Caused by the request; never counted as an outage |
| `GENERATION_UNAVAILABLE` | fal refused the key, plan or balance (401/402/403, or `FAL_KEY` missing) |
| `GENERATION_BUSY` | fal rate limit (429) |
| `GENERATION_FAILED`, `GENERATION_STATUS`, `GENERATION_RESULT` | fal failed the request, its status check or its result; or the output was not a readable picture |
| `GENERATION_TIMEOUT` | fal did not finish in time (150 status checks) |
| `GENERATION_UNCERTAIN` | a fal request was claimed but its answer was lost: it may have been accepted (section 5) |
| `VOICE_UNAVAILABLE` | ElevenLabs refused the key or plan (401/402), or the key or voice is missing |
| `VOICE_BUSY` | ElevenLabs rate or concurrency limit (429) |
| `VOICE_FAILED` | the narration failed, or a retried step found a claimed voice without its result |
| `RENDERER_UNAVAILABLE` | the container did not answer, or the `MEDIA_RENDERER` binding is missing |
| `MEDIA_TIMEOUT` | no render finished in about 40 minutes (no free container, or a stuck render), or maintenance ended a run at 3 hours |
| `MEDIA_LOST` | the container no longer knew the job (it restarted) |
| `MEDIA_PROCESSING_FAILED`, `MEDIA_INVALID`, `MEDIA_NO_AUDIO`, `MEDIA_TOO_LONG`, `MEDIA_CANCELLED` | the renderer refused or failed the job |
| `MEDIA_INPUT`, `MEDIA_FORMAT`, `MEDIA_TOO_LARGE` | a file of the video is missing or unreadable. Caused by the request |
| `VIDEO_INVALID` | the stored spec no longer validates. Caused by the request |
| `PROVIDER_REDIRECT`, `PROVIDER_URL`, `PROVIDER_DOWNLOAD` | a provider answered with a redirect or an output on an unexpected host |
| `INTERNAL` | anything else; the workflow log (`Run failed`) has the run ID |

**Publications** store the plain message people read, not a code; Operations groups them by network and the message's
first sentence. The codes behind them (`server/social/errors.ts`): `AUTH_EXPIRED` (reconnect; the account is marked
expired), `PERMISSION` (reconnect and allow posting), `RATE_LIMITED`, `ACCOUNT_LIMITED`, `MEDIA_REJECTED` (the network
refused the video), `NOT_CONFIGURED` (app credentials or `TOKEN_ENCRYPTION_KEY` missing or refused), `NO_CHANNEL` (a
Google account without a YouTube channel), `TIMEOUT` and `INTERRUPTED` (it may have been posted: check the profile
before retrying), `NOT_READY` and `PROVIDER_ERROR`. TikTok's "only private posts" refusal for apps it has not audited
gets its own message. Publications stuck in `publishing` for 2 hours fail with `TIMEOUT`; due posts whose video failed,
or is still being made 6 hours later, fail with "The video couldn't be made in time".

**Stats reads** (`publications.metrics_error`): `scope` (the connection lacks the stats permission; reconnecting fixes
it), `reconnect`, `not_found` (the post was removed), `failed`.

**Series** keep why their last slot was skipped (`series.blocked`, shown on the series page): `credits`, `trial`,
`busy` (20 runs active) or `failed` (the writer failed three times).

## 5. Manual checks (provider work that may still bill)

fal keeps working (and billing) after Ghostreel gives up on a run. The run is failed and its credits are refunded; the
hourly stage `reviews` then sets the provider work aside in `manual_reviews`, shown under **Operations → Set aside for
a manual check** with fal's request ID:

- reason `timeout`: the run failed with `GENERATION_TIMEOUT` or `MEDIA_TIMEOUT` while a fal request it started had no
  stored result;
- reason `uncertain`: a request was claimed but no ticket was stored (`GENERATION_UNCERTAIN`; there is no request ID);
- reason `failed`: the run failed for another reason (`INTERNAL`) while fal work was open.

What to do: open fal's dashboard, find the request, and cancel it or note what it billed. Rows are kept 90 days.

Storage cleanup refuses any key outside `media/` and `library/` (`drainCleanup`): nothing is deleted, `Storage cleanup
refused` is logged, and the row moves to the same list (area "Storage cleanup", reason `refused`). A refused row means
a bug or a new kind of key; when a feature stores files under another prefix, extend the check and its test.

## 6. Withdrawal within 14 days

Consumers may withdraw from a paid plan within 14 days of subscribing (CRD Art. 9 and 14(3); ЗЗП чл. 50 and 55).
Before a first checkout they ask for the plan to start at once (`checkout_consents`, text and version in
`shared/withdrawal.ts`); the request is repeated on Stripe's page and confirmed by e-mail after payment (stage
`contracts` retries a failed e-mail hourly for a week).

How a customer asks: the contact form with the topic "Withdraw from my plan (14 days)" (linked from Billing, the
account deletion section of Settings, the terms and the confirmation e-mail), an e-mail, or the model form in the terms
(`/terms#withdrawal-form`). Such messages show in
Admin → Messages in amber and are also forwarded to `ADMIN_EMAILS`.

What to do: Admin → **Billing** → Withdrawal within 14 days.

1. Enter the customer's e-mail and **Check**. The app reads the subscription and its paid invoices from Stripe and
   shows the plan, the start and the deadline, what was paid (net of earlier refunds), the credits used in the paid
   period and the amount to refund.
2. Confirm that the customer withdrew in time, then **End the plan and refund**. In one action the subscription is
   cancelled in Stripe (no further charges), the period's remaining credits stop, and the amount is refunded to the
   original payment (Stripe idempotency key `withdrawal-<id>-<payment>`). The withdrawal is recorded.

The refund is `floor(paid × (quota − used) / quota)` (`withdrawalRefund` in `shared/withdrawal.ts`), where `quota` is
the paid period's credits (the month's for a monthly plan, twelve months' worth for a yearly plan) and `used` the
credits used in that period. Example: Starter monthly, $19.00 paid, 9 of 30 credits used → $13.30. Credit packs are
separate purchases and are not part of it.

Safeguards: one withdrawal per subscription; the amount must still match what the administrator saw (more use since
then answers 409 "check again"); after 14 days it is refused. If Stripe refuses the refund the plan has still ended,
the withdrawal shows "Refund by hand" and `Withdrawal refund failed` is logged: refund the rest in Stripe. A full
refund or a dispute made directly in Stripe also ends the plan by itself (webhook `charge.refunded` /
`charge.dispute.created`).

## 7. Free months (plan grants)

Admin → **Billing** → Free month of a plan gives a person (they need an account) a paid plan for 30 days without
Stripe: testers, partners, support cases. A grant is a `subscriptions` row with an ID starting `grant_`, so it gets
its own usage window with the plan's full credits and ends by itself. **New month** replaces a running grant with a
fresh one; **End now** ends it.

- A running grant wins over a paid plan unless the person pays for a higher one; afterwards they return to their paid
  plan or the free plan (`allowance` in `server/billing.ts`). Billing shows "Free month" and the end date.
- Grants never reach Stripe: the nightly reconciliation skips them, refunds, disputes and withdrawals never touch their
  window, and the Customer Portal is offered only for a real Stripe subscription.
- If the person also pays in Stripe, the subscription keeps billing while the grant runs; the admin page says so.

## 8. When a provider fails

Failed runs always refund their credits, and people see a plain message with a retry on the video's page; a retry
charges only the AI work still missing. A series episode whose making failed is e-mailed to its owner and is not made
again by itself.

- **fal** (`GENERATION_*`): check fal's status page and dashboard (key, balance, rate limits). `GENERATION_UNAVAILABLE`
  usually means the balance or the key; `GENERATION_BUSY` concurrency. For pictures, `FAL_IMAGE_MODEL` (for example
  `fal-ai/nano-banana-2` or `fal-ai/flux/schnell`) switches to another model, and `FAL_IMAGE_QUALITY` lowers GPT Image
  2.5's quality and price, both without a deploy. Check section 5 for requests that may still bill.
- **ElevenLabs** (`VOICE_*`): check the key, the plan's characters and concurrency. A voice ElevenLabs removed can be
  replaced with `ELEVENLABS_VOICES` (JSON, public voice ID → ElevenLabs voice ID). Forced alignment failing
  (`Narration timing unavailable`, `Forced alignment failed`) only costs exact timings; Scribe failing (`Speech not
  found`) only costs transcripts of uploads.
- **Renderer** (`RENDERER_UNAVAILABLE`, `MEDIA_TIMEOUT`, `MEDIA_LOST`): check Containers in the dashboard (instances
  running, the latest image rolled out, errors). Three containers render one job each; more work waits for a free
  one, and runs time out after about 40 minutes of waiting or rendering.
- **Workers AI** (the writer): drafts answer "We couldn't write this video right now", series slots are retried and
  then skipped with reason `failed`, and `Text model failed` is logged (without the input). `TEXT_MODEL` switches the
  model without a deploy.
- **A social network**: Operations groups failed publications by network and message. For `TIMEOUT` or `INTERRUPTED`
  ask people to check their profile before retrying, so nothing posts twice. Many reconnections at once point at the
  app's credentials or a revoked permission at the network.
- **Stripe**: if webhooks fail (the last webhook event in Operations is old), check the endpoint and its secret; the
  nightly reconciliation catches up on doubtful subscriptions, and people can trigger a re-read by returning to
  Billing.
- **E-mail**: sign-ups, confirmations and notices need the `EMAIL` binding and `EMAIL_FROM`; sign-ups answer
  "temporarily unavailable" without them.

To stop making videos (an outage or a cost problem), set `MEDIA_ENABLED=false`: new videos answer "being set up" and
series stop. Work already running finishes. Series slots missed by more than 3 hours are skipped, not made late, when
it is switched back on. Publishing of ready videos continues. `BILLING_ENABLED=false` closes checkout and credit packs;
webhooks are still processed.

## 9. Retention

Hourly stage `retention` (`server/retention.ts`) removes or clears what has expired: expired sessions, links, rate
limits and OAuth states; contact messages after 365 days; Stripe event IDs after 90 days; checkout intents 7 days
after they expired; run prompts, provider tickets, input-link tokens and voice timings 30 days after the run finished;
failed or cancelled publications' media-link tokens and tickets after 30 days; trial identifiers unused for 730 days;
evidence (terms acceptances and checkout consents of deleted accounts, withdrawals) after 5 years, abandoned checkout
consents after 30 days; and accounts never confirmed after 30 days. Maintenance also drops unfinished uploads after a
day and failed uploads after a week. The periods and the reasons are in [PRIVACY.md](PRIVACY.md); change both (and the
privacy policy) together.

## 10. Migrations and rollback

The schema is `migrations/0001_initial.sql`. Apply new migrations **before** deploying the code that needs them
(`npm run db:remote`) and keep them additive (new tables, nullable columns, indexes, triggers), so the version already
running keeps working on the newer schema and a Worker rollback (`npx wrangler rollback`) never needs a schema
rollback. To check: `npx wrangler d1 migrations list faceless --remote` shows nothing left to apply.

D1 keeps 30 days of point-in-time history (`npx wrangler d1 time-travel info|restore faceless --timestamp=…`). A
restore replaces the whole database, including payments and credits written since: switch `REGISTRATION_ENABLED`,
`BILLING_ENABLED` and `MEDIA_ENABLED` off first, note the current bookmark, and afterwards let the nightly
reconciliation re-read doubtful subscriptions. R2 is not part of Time Travel.

## 11. Logs and privacy

- Keep Workers Logs retention (and any Logpush destination) at **30 days or less**. Logs carry user, run, video and
  publication IDs and short error codes, never prompts or provider messages.
- Request logs record full URLs, including capability links with their token (`/api/render-inputs/…?token=`,
  `/api/upload-inputs/…`, `/api/publish-media/…`) and signed download links (`/api/v1/files/…?sig=`). These are
  short-lived or tied to a running task, but limit dashboard access and don't export request logs to third parties
  without stripping query strings.
- The app's own error logs are scrubbed (`server/error-report.ts`). Unexpected errors are logged as `Request failed`
  with a reference the user sees; search for it when a user quotes it.

Useful log lines: `Run failed` (code and run ID), `Run dispatch failed; maintenance will retry`, `Episode not
started`, `Series cannot run: the CONTENT workflow binding is missing`, `Publication failed`, `Publication workflow
error`, `Publication timed out`, `Social API call failed`, `Social token renewal failed`, `Post stats failed`,
`Stripe reconciliation failed`, `Subscription price is not a configured plan`, `Paid access ended`, `Credit pack paid by
an account that no longer exists; review for refund`, `Cancelled subscription of a deleted account; review for refund`,
`Contract confirmation failed`, `MCP tool failed`.

## 12. E-mail deliverability

- [ ] Email Sending is active for the domain and its DNS records are present and verified.
- [ ] One SPF record including Cloudflare's sender (and any other service sending for the domain).
- [ ] DKIM records published and verified; DMARC `p=none` with reports first, then `quarantine` or `reject`.
- [ ] `EMAIL_FROM` (or `CONTACT_EMAIL`) is in `allowed_sender_addresses` of the `send_email` binding in `wrangler.jsonc`.
- [ ] Send a test alert: with one summary line above zero (e.g. a cleanup row older than a day in a staging database),
      the next minute-17 run e-mails `ADMIN_EMAILS`; check it lands in the inbox with `spf=pass`, `dkim=pass` and
      `dmarc=pass`.
