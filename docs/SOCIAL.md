# Social accounts and auto-publishing

People connect TikTok, Instagram and YouTube accounts (OAuth) on the Channels page (`/app/channels`). A made video is
posted now or at a chosen time, optionally privately on TikTok and YouTube; a series' approved episodes go to the
series' accounts at their slot. A cron + Workflow publishes them. Only videos are published: Reels on Instagram, Shorts
on YouTube, videos on TikTok.

| Piece | Where |
| --- | --- |
| Connect / list / disconnect accounts | `server/accounts.ts` (`/api/accounts`) |
| Post now or later, schedule view, move, cancel, retry | `server/publishing.ts` (`/api/videos/:id/publish`, `/api/publications`, `/api/videos/:id/publications`, `/api/publications/:id`, `/api/publications/:id/retry`) |
| A series' episode to its accounts at its slot | `scheduleEpisode(env, videoId)` in `server/publishing.ts`, called when an approved episode is ready (`videoReady` in `server/series.ts`) and when one is approved (`/api/videos/:id/review`) |
| Media links the networks fetch | `server/publishing.ts` (`/api/publish-media/:publication/:n?token=`) |
| Due posts → workflow (cron, every minute) | `dispatchDue(env)` in `server/publishing.ts`, from `server/maintenance.ts` |
| Publishing one video | `Publication` workflow, `server/publish-workflow.ts` |
| Caption and title, AI disclosure, length checks | `server/social/post.ts` (`postText`, `synthetic`, `unfit`); limits in `shared/social.ts` |
| Network clients | `server/social/{tiktok,instagram,youtube}.ts` |
| Post stats (cron, every 5 minutes) | `refreshMetrics(env)` in `server/metrics.ts`, `stats()` in each network client |
| Token renewal (daily, 03:17 UTC) | `refreshAccounts(env)` in `server/publishing.ts`, from `server/maintenance.ts` |
| Token encryption | `server/crypto.ts` (AES-256-GCM) |

## Environment

| Variable | What |
| --- | --- |
| `SITE_URL` | Public `https://` origin. Redirect URIs and media links are built from it. |
| `TOKEN_ENCRYPTION_KEY` | 32 random bytes, base64: `openssl rand -base64 32`. Encrypts every OAuth token at rest. Changing it disconnects every account (people reconnect). |
| `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET` | TikTok app. |
| `TIKTOK_DIRECT_POST` | `true` once TikTok has audited the app: videos post straight to the profile. Unset, they go to the person's TikTok inbox as drafts (see TikTok below). |
| `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET` | The Instagram app ID/secret of the Meta app (Instagram product, not the Facebook app ID). |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google OAuth client (Web application). |

Set them as Worker secrets (`npx wrangler secret put …`). A network without credentials shows as "not configured" and
cannot be connected; without `TOKEN_ENCRYPTION_KEY` none can.

**Redirect URI** for every network (register it exactly, no trailing slash):

```
${SITE_URL}/api/accounts/callback/tiktok
${SITE_URL}/api/accounts/callback/instagram
${SITE_URL}/api/accounts/callback/youtube
```

For local development register the `http://localhost:8787/...` variants where the network allows http (TikTok and
Meta require https: use a tunnel such as `cloudflared tunnel --url http://localhost:8787` and set `SITE_URL` to it).

How many accounts someone can connect follows their plan (`accounts` in `shared/plans.ts`); at the limit an expired
account can still be reconnected.

## AI disclosure

`synthetic()` (`server/social/post.ts`) marks a video that has an AI voice, AI pictures or AI clips (or whose rendered
file was marked AI by the renderer). TikTok gets `is_aigc: true` and YouTube `containsSyntheticMedia: true` for it.
Instagram gets no flag through the API; the file itself carries the renderer's AI metadata (MP4 tags + XMP).

## TikTok (Login Kit + Content Posting API)

Two modes (`server/social/tiktok.ts`):

- **Drafts** (the default): the video goes to the person's TikTok inbox (Upload API, scope `video.upload`). TikTok
  notifies them; they add the caption, choose who can see it, set the AI-content label and post it in the TikTok app.
  Only the normal app review is needed, not the Direct Post audit, and there is no private-only restriction.
- **Direct Post** (`TIKTOK_DIRECT_POST=true`, once TikTok has audited the app): the video posts straight to the profile
  with its caption (scope `video.publish`).

Setup:

1. developers.tiktok.com → Manage apps → create an app. Platform: Web. Fill in the terms and privacy policy URLs
   (`${SITE_URL}/terms`, `${SITE_URL}/privacy`).
2. Add products **Login Kit** and **Content Posting API** (Upload; turn on **Direct Post** only for the audit).
3. Scopes: `user.info.basic`, `video.upload` and `video.list` (post stats; see "Post stats" below); add
   `video.publish` for Direct Post. The app asks for the mode's set only, so each must be approved before people
   outside the app's test users can connect.
4. Login Kit → Redirect URI: `${SITE_URL}/api/accounts/callback/tiktok`.
5. No media domain verification is needed: videos are uploaded as files (`FILE_UPLOAD`). (`server/social/tiktok.ts`
   still has a photo-post branch that would fetch from our media links and need it; the Publication workflow only
   ever sends videos.)
6. Submit the app for review. Later, for Direct Post, apply for the **Direct Post audit**, then set
   `TIKTOK_DIRECT_POST=true`; people connected for drafts reconnect once to grant `video.publish` (until then their
   posts fail with "Reconnect your TikTok account and allow posting").

**Drafts.** The upload works like Direct Post (init, then the file in chunks after a checkpoint) on
`/post/publish/inbox/video/init/`, which takes the file only. The publication is done when the status is
`SEND_TO_USER_INBOX`: it is recorded as published with `draft=1` and the publish ID, without a link or stats (we don't
learn the post the person makes from it; if they posted before our first status check, `PUBLISH_COMPLETE` is recorded
with its link). The video's page says the draft is waiting, offers its caption to copy (`postCaption` in
`shared/social.ts`, the same text Direct Post would send) and reminds them to turn on TikTok's AI-generated content
label. "Post privately" has no effect on a draft: they choose who can see it in TikTok. TikTok limits how many drafts
from apps can wait in a person's inbox (`spam_risk_too_many_pending_share`, retried after 1, 5 and 15 minutes, then a
message asking them to post or delete some). The connection asks for no `video.publish`, so it has no creator info:
the account's handle is empty unless it was connected for Direct Post.

**Direct Post before the audit** (unaudited client): at most 5 users can post in 24 hours, every post is private
(`SELF_ONLY`), and the posting account must itself be set to private. The publisher picks `PUBLIC_TO_EVERYONE` when
TikTok offers it and otherwise the first allowed level; when TikTok refuses a public post from an unaudited app it
retries once as `SELF_ONLY`, and if that is refused too the person is told to make the account private. "Post
privately" sends `SELF_ONLY` whenever TikTok offers it.

The audit checks TikTok's Content Sharing Guidelines in the UI: the creator's nickname and avatar shown before
posting, the privacy level **chosen by the person (no default)**, comment/duet/stitch toggles respecting
`creator_info`, the commercial content disclosure, a preview, and the consent line ("By posting, you agree to TikTok's
Music Usage Confirmation"); and no watermark or branding added to the video (the free trial's mark would need to go
for TikTok). Fully automatic publishing (series on autopilot) needs those choices made once per account in our UI and
stored (see "Open items"); expect the audit to ask about it.

Tokens: access 24 hours, refresh 365 days (renewed automatically when publishing). Uploads go in 10 MiB chunks
(TikTok: 5–64 MB per chunk, the last up to 128 MB, `total_chunk_count = floor(size / chunk_size)`). A video longer
than the creator's `max_video_post_duration_sec` is refused before upload.

## Instagram (Instagram API with Instagram Login)

1. developers.facebook.com → create an app, use case "Manage messaging & content on Instagram" (type Business).
2. Add the **Instagram** product → "API setup with Instagram business login". Note the **Instagram app ID and secret**
   shown there (these are `INSTAGRAM_APP_ID` / `INSTAGRAM_APP_SECRET`).
3. Business login settings → OAuth redirect URI: `${SITE_URL}/api/accounts/callback/instagram`.
4. Permissions: `instagram_business_basic`, `instagram_business_content_publish` and
   `instagram_business_manage_insights` (views, shares and saves of published videos).
5. **App Review**: request Advanced Access for all three permissions (screencast of connecting, publishing and the
   video stats), and complete **Business Verification**. Until then only people with a role on the app (and test
   users) can connect.

Only **professional accounts** (Business or Creator) work; personal accounts cannot log in through this flow. Videos
go out as Reels (3 s–15 min, `shared/social.ts`), shared to the feed. Instagram downloads the video from our media
link, which works only while the post is publishing and for at most 24 hours. Instagram cannot post privately: "Post
privately" refuses Instagram accounts, and a series set to post privately skips them. Accounts have a rolling 24-hour
publishing limit (`/{ig-user-id}/content_publishing_limit`); hitting it shows "Instagram is limiting how often this
account can post". (`server/social/instagram.ts` still has an image/carousel branch; the workflow never uses it.)

Tokens: long-lived (60 days), renewed in their last 10 days by `refreshAccounts(env)` (daily from maintenance, so quiet
accounts stay connected) and when publishing. Graph API version: `v23.0` (`server/social/instagram.ts`).

## YouTube (Google OAuth + YouTube Data API v3)

1. console.cloud.google.com → new project → enable **YouTube Data API v3**.
2. OAuth consent screen (Google Auth Platform): External; app name, support email, logo, home page, privacy policy,
   terms; authorized domain = your domain. Scopes: `https://www.googleapis.com/auth/youtube.upload` and
   `https://www.googleapis.com/auth/youtube.readonly` (both "sensitive").
3. Clients → create OAuth client ID, type **Web application**; authorized redirect URI:
   `${SITE_URL}/api/accounts/callback/youtube`.
4. Publish the app and submit for **verification** (sensitive scopes: demo video, privacy policy).
5. Fill in the **YouTube API Services audit and quota extension** form.

Limits until then:

- **Testing** status: only listed test users can connect, and their refresh tokens expire after 7 days.
- **Unverified** app: people see the "Google hasn't verified this app" warning, and at most 100 users can ever
  connect.
- **Unaudited API project** (created after 28 July 2020): every video uploaded through the API is locked to
  **private**, whatever `privacyStatus` we send, until the project passes the YouTube compliance audit.
- Quota: uploads have their own allowance, by default 100 `videos.insert` calls a day per project for all customers
  together (Google's quota calculator, checked October 2026); reading channels and stats comes out of the separate
  10,000 units a day. Ask for more in the audit form before customers get near it.

What the audit checks on our side, already in place: the Terms say that connecting YouTube means agreeing to the
YouTube Terms of Service (`/terms#social-accounts`); the privacy policy's "YouTube API Services" section
(`/privacy#youtube`) says the app uses YouTube API Services, links the Google Privacy Policy, explains what YouTube data
is accessed, stored and shared, and how to revoke access (disconnect, account deletion, or Google's security settings
page); disconnecting revokes the token. Keep `YOUTUBE_IMPORT` off: downloading YouTube videos is outside what the
YouTube API Services policies allow (see DEPLOYMENT.md). The Channels page warns that videos may post as private
until Google finishes its review: take that sentence out of `src/app/Channels.tsx` once the audit passes.

Uploads use the resumable protocol in 16 MiB chunks; an interrupted upload is resumed through the same session, so it
never creates a second video. Videos are posted as Shorts (vertical, at most 3 minutes; longer ones are refused before
scheduling): the description ends with `#Shorts` and the link is `https://youtube.com/shorts/<id>`. "Post privately"
sends `privacyStatus: private`. A Google account without a YouTube channel gets "Create a YouTube channel…".

## Post stats

The cron reads the stats of videos published in the last 30 days: first about 30 minutes after publishing, every 3
hours for the first two days, then daily. Each pass (every 5 minutes) takes at most 40 posts on at most 10 accounts,
one token refresh and a few calls per account, so it stays far inside the Workers subrequest limit; a failing account
never stops the others. An expired or revoked token marks the account `expired`, as publishing does.

| Network | Call | Numbers | Scope |
| --- | --- | --- | --- |
| YouTube | `GET /youtube/v3/videos?part=statistics&id=…` (50 IDs a call, 1 quota unit) | views, likes, comments (no shares) | `youtube.readonly` |
| TikTok | `POST /v2/video/query/?fields=id,view_count,like_count,comment_count,share_count` (20 IDs a call) | views, likes, comments, shares | `video.list` |
| Instagram | `GET /v23.0/{media-id}?fields=like_count,comments_count` and `GET /v23.0/{media-id}/insights?metric=views,shares,saved` | likes, comments; views, shares and saves with insights | `instagram_business_manage_insights` |

- **Connections without the stats scope** (made before it was asked for, or with it unticked) get no numbers, or
  only Instagram's likes and comments: `publications.metrics_error` is `scope` (counted in the operations view).
  Reconnecting grants it and the account's recent posts are read again on the next pass.
- **Review:** add `video.list` to the TikTok app (Login Kit scopes) and request
  `instagram_business_manage_insights` in Meta App Review; both networks review new scopes before other people can grant
  them. Until then, ask for them only from test users, or leave them out of `SCOPES` (the connection still works
  without them: `exchange` only requires the publishing scopes).
- TikTok returns stats only for public videos: private posts (posted privately, or by an unaudited app) have only a
  publish ID and get no numbers.
- These parsers are written against the documented answers and tested with mocked responses only; check them with a
  real account of each network before relying on the numbers.

## How publishing works

1. `POST /api/videos/:id/publish` (now or at `at`, optionally `private`) or `scheduleEpisode` for a series' episode
   creates one `publications` row per account, `status='scheduled'`. The `publication_once` index prevents the same
   video twice on one account. An episode whose slot passed more than 3 hours ago (`LATE_GRACE`) is left for the owner
   to post by hand.
2. Every minute `dispatchDue(env)` claims up to 25 due rows whose video is ready (`status='publishing'`, `attempts+1`,
   a random media-link `token`) and creates Workflow instance `pub-<publication>-<attempt>`. If the instance cannot be
   created the row goes back to `scheduled`. A due video that is still being made waits; it fails at once when its
   making failed, or once the making has not moved for 6 hours. Rows stuck in `publishing` for 2 hours fail with a
   "took too long" message.
3. The `Publication` workflow checks the video, account and setup, refreshes the token if needed, starts the post
   once (retrying a refusal that may pass after 1, 5 and 15 minutes), then polls every 15 seconds for up to 30 minutes.
   Before any call that makes a post public it saves a checkpoint in `publications.ticket`; a step that runs again
   resumes from it instead of posting twice. When the outcome cannot be known the publication fails with "Publishing
   was interrupted. Check your … profile before retrying".
4. Results: `published` with `external_id`, `url`, `published_at`; or `failed` with a short plain-English `error`.
   An expired or revoked token marks the account `expired`. `POST /api/publications/:id/retry` queues a failed one
   again a minute later.

Disconnecting an account cancels what is still scheduled to it and removes it from every series; its published
history stays ("Disconnected account"). Pausing or deleting a series cancels its scheduled posts. Disconnecting a
YouTube channel, or deleting the account that owns it, also revokes its refresh token at Google after the response
(`revokeAccess` in `server/social/credentials.ts`), so the app leaves the person's Google connections list; a failed
revoke is only logged (`Social access not revoked`), since our copy of the tokens is already deleted.

Provider calls never follow redirects, have timeouts, and log only the platform, publication ID, HTTP status and a
short code — never tokens, URLs with tokens, or response bodies.

## Open items

- The Channels page reads `?connected=<platform>` or `?error=` with `expired`, `denied`, `permissions`,
  `no_channel`, `unavailable`, `limit` or `failed`.
- Avatar URLs point to the networks' CDNs, which the Content-Security-Policy (`img-src 'self' data: blob:`) blocks:
  show initials, or proxy/allow those hosts.
- TikTok audit UX (privacy level, interaction toggles, commercial content disclosure per account or post) needs a place
  to store the choices; the schema has none yet.
- The leftover photo/carousel branches in the TikTok and Instagram clients can go.
