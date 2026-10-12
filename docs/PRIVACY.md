# Personal data: retention and deletion

What the app keeps, for how long, and what account deletion removes. This is the technical source for the public
privacy policy (`/privacy`, `src/public/Legal.tsx`); keep both in line when either changes. The periods live in code:
`server/retention.ts` (constants and the hourly run), `server/maintenance.ts` (uploads, files) and
`server/operations.ts` (work set aside for a manual check). The indexes that keep each statement cheap are in
`migrations/0001_initial.sql`. Ported from rech-bg's `docs/PRIVACY.md`.

Retention runs hourly (maintenance at minute 17) as one D1 batch. Every statement is on an index or bounded
(at most 500 rows per statement and hour, 20 unconfirmed accounts per hour), so a backlog is worked off over a few
hours rather than in one expensive run.

## While the account exists

| Data | Kept | How it goes |
| --- | --- | --- |
| Profile (name, email, password hash), series (template, prompt, voice, language, art style, music, length, schedule, accounts, review and e-mail choices), videos (spec: script, scenes, captions, word timings), uploads (with the words found in their speech, and for videos clips are cut from the moments found in them and where their people appear), AI pictures, clips, voices and renders, connected accounts, publications and their stats, API keys (SHA-256 of the key, name, prefix, created and last used) | While the account exists | With the account, or when the user deletes the item (videos, series, uploads, API keys; disconnecting an account) |
| Sessions | 30 days | Removed hourly once expired |
| Email confirmation / password reset links (hash of the token only) | 24 hours / 1 hour | Removed hourly once expired |
| OAuth sign-in states for social networks | 10 minutes | Removed hourly once expired |
| Rate-limit counters, including the daily free speech-transcription allowance (SHA-256 of scope + IP, email or user ID + time window) | Until the window ends (at most 1 day) | Removed hourly |
| Accounts whose email was never confirmed | 30 days (the 7-day trial is long over) | Deleted with everything, like a deletion by the user. Never one with a Stripe customer; one with work in progress waits until it is done |
| Runs (making and rendering a video): provider tickets, the renderer's input-link token and the voice's word timings (`runs.provider`) | 30 days after the run finished | Cleared. `runs.payload` keeps only the video revision and whether it carried the trial watermark; the status, credits and dates stay (receipts). Any other key in `runs.payload` (none is written today) is cleared the same way, also for a run that failed before it started |
| Failed or cancelled publications: the media-link token and the network's ticket | 30 days after the last change | Cleared; the publication record (status, error message, times) stays with the video |
| Uploads that failed their check / never finished | 7 days / 1 day | Removed by maintenance |
| Contact form messages (name, email, topic, message; not linked to an account) | 365 days | Removed hourly |
| Checkout intents (which plan a checkout was opened for) | 7 days after the checkout link expired | Removed hourly |
| Request for immediate start of an abandoned checkout (never completed) | 30 days | Removed hourly |
| Processed Stripe event IDs (webhook de-duplication; no personal data) | 90 days | Removed hourly |
| Work set aside for a manual check (run ID, provider request ID, reason) | 90 days | Removed by maintenance |

The scene descriptions and script sent to the AI providers are part of the video itself (its spec): they stay as long
as the video does. A video imported from a link is fetched from that link by our Worker; the link is kept only until
the file is downloaded (then the file is kept like an upload). A video imported from the person's own YouTube channel
(a beta) is downloaded from YouTube by our renderer, after its channel was checked with the person's YouTube
connection; the connection also lists the channel's latest videos for the import picker, which are not stored. A long
video's transcript is sent to the text model (Cloudflare Workers AI) when the owner finds clips in it; the moments
found are kept with the video until it is deleted. Transcripts also hold who spoke when (speakers numbered by
ElevenLabs Scribe, never identified) and the sounds it tagged, such as laughter or applause, for as long as the file.
To frame a clip the renderer finds the faces in its moment and compares how their lips move while someone talks: it
only locates people (no face recognition, nothing kept per face), and only the crop's path and the two people's
positions are stored with the clip.

## Kept after the account is deleted

| Data | Kept | Why |
| --- | --- | --- |
| Trial identifier: HMAC-SHA256 of the normalised mailbox (`+tags` dropped, Gmail dots ignored) with `TRIAL_HASH_SECRET`, plus the trial credits counted as used (the whole trial allowance once a trial has started) | 24 months after it was last needed (trial started, sign-in) | So deleting and re-registering, or `user+1@…`, does not grant a new free trial. Not the address itself |
| Terms acceptance (internal user ID, terms version, time) | 5 years after the account is deleted | Evidence of the contract (general limitation period) |
| Request for immediate start at checkout (internal user ID, plan, text version, times of checkout, payment and confirmation email) | 5 years after the account is deleted | Evidence of the request and the withdrawal terms (CRD Art. 14(3) and 16(m); ЗЗП чл. 55) |
| Withdrawals (internal user ID, subscription ID, amounts paid and refunded, credits used and the period's credits, status, dates) | 5 years after the withdrawal | Evidence of the withdrawal and its refund |
| Credit pack purchases (`credit_topups`: internal user ID, pack, credits, amount, currency, Stripe payment intent, whether refunded, date) | No period in code yet: the table has no foreign key to `users` and no retention rule | Purchase records. Open point below |
| Stripe: customer, invoices, payments, refunds, disputes | Kept by Stripe | Accounting and tax records; managed in Stripe, not by the app |

The internal user ID is a random UUID. Once the account is gone it links to a person only through Stripe (paying
customers) and the records above. Deleting an account (trigger `evidence_account_deleted`) stamps
`account_deleted_at` on its terms acceptances and checkout consents, which starts their 5 years.

Open points for the operator: if withdrawals, checkout consents and credit pack purchases are treated as accounting
records, Bulgarian accounting law asks for 10 years; change `EVIDENCE_DAYS` (or add a separate constant) and this
table together. `credit_topups` needs a period of its own in `server/retention.ts` either way.

## What account deletion does

Settings → Danger zone → Delete account, with the password.

1. Refused while work is in progress: a video being made or published (database trigger `user_busy`).
2. Stripe: a paid subscription is cancelled at once, without a refund of the rest of the period
   (`endPaidAccess`). The dialog tells a subscriber who subscribed in the last 14 days to ask to withdraw first (with
   its refund). If Stripe refuses, nothing is deleted.
3. The account row is deleted. Foreign keys remove sessions, tokens, series, videos, runs, media files' records,
   connected social accounts, OAuth states, publications, API keys, subscriptions and usage windows, and the billing
   helper rows.
4. Files: the `media/<user>/` prefix is queued (trigger `user_cleanup`) and removed by the hourly cleanup.
5. Kept: what the table "Kept after the account is deleted" lists.

Videos already published stay on the social networks until the person removes them there.

## Requests from people

There is no self-service data export yet: videos and files can be downloaded in the app, and other access or
portability requests come through the contact form and are answered by hand within one month.

## Logs

Workers Logs carry user, run and publication IDs and short error codes, never email addresses, prompts or provider
messages (`server/error-report.ts` scrubs messages). Keep the Cloudflare log retention at 30 days or less
(docs/OPERATIONS.md).
