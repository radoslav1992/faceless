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
3. **Body limits**: 8 MiB + 1 KiB for an upload part, 60 MB for an administrator's library upload, 30 MB for the
   samples AI describes a library file from (`/api/admin/library/describe`), 1 MiB otherwise.
4. **API key routes**, mounted before the Origin check (they use no cookies, so no CSRF risk): the REST API at
   `/api/v1` and the MCP server at `/mcp` (`server/api.ts`).
5. **Origin check**: every non-GET/HEAD request to `/api/*` must carry `Origin` equal to `SITE_URL`'s origin, except
   the signed Stripe webhook.
6. `POST /api/billing/webhook`, `GET /api/health` (D1 reachable: 200, else 503), then the public routes
   (`/api/public/config`, `/api/contact`).
7. **Capability links** (a token in the URL, no session): `/api/render-inputs` (the renderer and fal read a run's
   inputs), `/api/upload-inputs` (the renderer reads an upload it checks), `/api/publish-media` (Instagram fetches a
   video).
8. **Session**: the HttpOnly cookie's token is looked up by its SHA-256 in `sessions` (30 days). `/api/auth` follows.
9. **Sign-in required** for the rest (a social network's callback without a session goes to `/login`):
   `/api/billing`, `/api/series`, `/api/videos`, `/api/story`, `/api/media`, `/api/library`, `/api/accounts`,
   publishing under `/api` (`/videos/:id/publish`, `/publications…`), `/api/settings`, `/api/keys` and `/api/admin`
   (administrators only; others get 404).
10. Unknown `/api/*` paths answer 404 JSON. Other paths go to `server/pages.ts`: `robots.txt`, `sitemap.xml`, the
    installable app's files (`/sw.js` with `Cache-Control: no-cache`, `/manifest.webmanifest` with its own type,
    `/offline.html` with a 200) and the single-page app document with each public page's title, description and
    canonical/Open Graph tags (`shared/seo.ts`); unknown paths get the app's not-found page with a real 404.

**Installable app (PWA).** `index.html` links the manifest (`public/manifest.webmanifest`: name, icons, `start_url`
`/app`, standalone display, shortcuts) and the Apple touch icon. `src/install.ts` registers `public/sw.js` in
production builds and shows "Install app" in the sidebar: the browser's own dialog (`beforeinstallprompt`), or the
Share → Add to Home Screen steps on iPhone and iPad. The service worker caches only the site's own static files:
hashed build files (`/assets/…`) once fetched (the newest 150 kept), icons, fonts and the manifest (served from the
cache, refreshed in the background), and the offline page. Pages always come from the network first, so a deploy shows
at once; without a connection a page shows `public/offline.html`. It never answers `/api/…` (data, media files,
capability links, OAuth callbacks), `/mcp`, crawler files, requests other than GET, or video range requests.
Changing what it caches means bumping `VERSION` in `sw.js` (old caches are deleted when the new worker activates).

Errors: an `HTTPException` becomes `{error}` with its status; a zod error 400 with the fields; anything unexpected 503
with a reference that is logged as `Request failed` (billing routes answer their own plain message). The `scheduled`
handler runs `maintenance()` every minute.

## Data model

`migrations/0001_initial.sql`, `0002_clips.sql` (runs of kind `speech`), `0003_voices.sql` (narration voices) and
`0004_library.sql` (library pictures, descriptions and the AI mark), `0005_style_examples.sql` (each style's example
video), `0006_example_previews.sql` (the examples' short previews), `0007_library_categories.sql` (library items'
genre or category) and `0008_avatars.sql` (the presenters' avatars); D1 always enforces foreign keys.

| Area | Tables |
| --- | --- |
| Accounts | `users`, `sessions`, `auth_tokens` (verify/reset), `rate_limits`, `terms_acceptances`, `contact_messages`, `cleanup_tasks` |
| Billing | `subscriptions` (Stripe subscriptions and `grant_` rows), `stripe_status`, `stripe_reconciled`, `billing_events` (webhook de-duplication), `checkout_intents`, `usage_windows`, `trial_history`, `credit_topups`, `media_limits`, `checkout_consents`, `withdrawals` |
| Social | `social_accounts` (sealed credentials), `oauth_states` |
| Making videos | `series`, `videos`, `runs`, `media_assets`, `media_parts`, `library_items`, `voices`, `style_examples` |
| Publishing | `publications` (status, attempts, media-link token, provider ticket, URL, stats) |
| API | `api_keys` (SHA-256 of the key and a short prefix only) |
| Operations | `operations_state`, `manual_reviews` |

Triggers keep the rules in the database, so no code path can skip them:

- **Credits**: `run_credit_reserve` refuses a run (a video's, or a long video's paid transcription) whose credits do
  not fit its usage window (`QUOTA_EXCEEDED`),
  `run_credit_charge` adds them to `used` in the same transaction, and `run_refund` gives them back exactly once when
  a queued or running run becomes `failed`. `run_active_limit` allows 20 active runs per person (`RUNS_BUSY`).
- **Storage**: `media_storage_limit` (the plan's bytes in `media_limits`) and `media_file_limit` (5,000 files) answer
  `STORAGE_FULL`.
- **Work in progress**: `video_busy`, `account_busy` and `user_busy` refuse deletes while a run or a publication is
  under way.
- **Cleanup**: `media_cleanup`, `library_cleanup`, `style_example_cleanup` and `user_cleanup` queue R2 keys or prefixes
  in `cleanup_tasks`;
  `evidence_account_deleted` marks terms acceptances and checkout consents of a deleted account.

Unique indexes that carry rules: `videos_series_slot` (one video per series slot), `one_active_run_per_video`,
`runs(user_id, idempotency_key)` (a retried request or step finds its earlier run), `one_active_speech_per_asset` (one
paid transcription of a video at a time), `publication_once` (a video is
scheduled, publishing or published at most once per account) and `social_accounts(user_id, platform, external_id)`.

## A video

A video's editable description is its **spec** (`shared/formats.ts`, validated with zod on every write), of one of two
formats: `story` (below) or `highlight`, a clip of one of the owner's long videos (see [Clips](#clips-from-long-videos)).
A story's spec holds the video type (`kind`: `story`, `pov`, `mashup`, `script`, `backdrop`), the narration (an AI voice by ID, or one of the owner's
audio/video uploads with an optional exact script), the language, 1–40 scenes (their words, a picture description, key
words, the picture's source and the transition in), one art style (`shared/story.ts`, 15 prompt suffixes), one
recurring subject, captions (on/off, one of 21 styles), an optional on-screen headline (`shared/headline.ts`), an
optional background clip that replaces the pictures (storytime), music (a library track or an upload, with a volume),
and the post text (caption, hashtags, title, topic). `generated` (the recorded AI voice and its word timings) is owned
by the server: the browser never sets it.

A scene's picture is an **AI image** (made once, then shown with a slow zoom or pan), an **AI clip** made from that
image (5 or 10 s), the owner's **image or video**, or a **library clip or picture**, chosen scene by scene in the
editor; one button there turns every AI-picture scene into an AI clip as long as its scene (5 or 10 s), at the selected
scene's clip quality, with its price,
and a scene still to make is labelled with what it will be. Scenes hold words, never times:
times come from the voice's word timings, so an edit only moves words between scenes and keeps the paid recording
(`narrationKey`: voice, length and a fingerprint of the script).

**Credits** (`specCredits`, `shared/credits.ts`): a new video costs 1 credit per started 30 seconds of its estimated
length (the owner's recording by its own length), everything included, plus per 5 seconds of AI clip 1 credit at
regular quality (Kling 2.5 Turbo Standard, 720p, ~$0.21 per 5 s on fal) or 2 at high quality (Pro, 1080p, ~$0.35), so
a clip credit costs at most ~$0.21 to make, below a credit's value on every plan. The quality is the scene's
`clipQuality` (regular unless chosen), which picks the fal model (`IMAGE_CLIP_MODELS`). An
edit of a made video costs only what it asks for again: new narration when the words or voice changed, 1 credit per
5 new pictures, and new clips. Changes to the caption, hashtags or title need no new render; other free changes
(subtitles, music, transitions, timing) re-render for 0 credits.

**Voices** (`server/voices.ts`, `voices` table, Admin → Voices in `src/app/AdminVoices.tsx`). Administrators import a
voice of the ElevenLabs account (`GET /api/admin/voices/elevenlabs` lists it: `/v2/voices`, 100 at a time; `POST
/api/admin/voices` reads `/v1/voices/{id}`) with ElevenLabs' details: "George - Warm Storyteller" becomes the name
George and the description "Warm Storyteller", else the labels (descriptive, use case) or ElevenLabs' description;
gender, accent and age from the labels; its sample is copied to R2 (`voices/<id>/sample.mp3`, served at
`/api/public/voices/:id/preview`). Its public ID (made of its name, or chosen) never changes: specs and series keep
it, and the ElevenLabs voice behind it can be replaced. Administrators rename, describe, order, hide and choose the
default (`PATCH /api/admin/voices/:id`; the default is always offered); only a voice no series or video uses can be
deleted. They also make each voice's **sample** (`POST /api/admin/voices/:id/sample`, `speakSample` in
`server/providers/elevenlabs.ts`): their text, else `sampleText` in `shared/voices.ts` ("Hi, I'm George…", about ten
seconds of a story), spoken as an MP3 by the narration's model so it sounds as the videos will, stored as
`voices/<id>/sample-<8 hex>.mp3` in place of the one before; the key is in the sample's address (`?v=`), so browsers
fetch the new one. `GET /api/public/voices` lists the offered voices (the app's voice pickers: `VoiceSelect` shows the
chosen one with its sample, `VoicePicker` every voice with a play button, filtered by gender and accent; the API's
`/types` and `list_video_types`). A new video or series must use an offered voice; one that already has a voice keeps
it once hidden (`voiceUsable` with the kept voice), and a template whose voice was hidden gets the default.

**Presenters** (`shared/presenter.ts`, `server/avatars.ts`, `avatars` table, Admin → Presenters in
`src/app/AdminAvatars.tsx`; ported from rech-bg's HeyGen avatars). An on-screen AI presenter speaks a narrated video's
ElevenLabs voice, lip-synced by HeyGen. Administrators add HeyGen's stock avatars (`GET /api/admin/avatars/stock` pages
`/v3/avatars/looks?ownership=public`, 50 at a time, its previews proxied because the page's policy allows only our own
images; `POST /api/admin/avatars/stock`, which also takes a stock avatar's look ID alone) or link one of the account's
own by its look ID (`POST /api/admin/avatars/link`), each after confirming that the HeyGen plan (and, for an own avatar, the person in it) allows
offering it. Each keeps a copy of its preview (`avatars/<id>/preview.<ext>`, served at
`/api/public/avatars/:id/preview`) and the engines HeyGen lists for it, which decide its qualities: regular (Avatar IV)
and high (Avatar V); `POST /api/admin/avatars/:id/check` reads them again. They are renamed, ordered and hidden like
voices; one a video has can't be deleted, and a hidden one keeps working for those videos. `GET /api/public/avatars`
lists the offered ones (none without `HEYGEN_API_KEY`). The spec's `presenter` is `{ avatarId, quality, layout }`:
layout `mix` puts it on the first scene and every other scene with an AI picture or clip (the owner's or a library's
media stays), `full` on every scene; those scenes need no picture. It needs the AI voice and no background clip. One
presenter video is made for the whole voice (server-owned `presented`: the avatar, quality and words it was made for,
and the recording it follows), so timing, layout and pictures change for free; new words, a new voice, another avatar
or quality make it again. It costs 1 credit per started 5 seconds of the voice in regular quality and 3 in high
(`presenterCredits`, HeyGen bills about $0.04 and $0.12 a second), on top of the video. Not offered for series or the
API yet.

**Library** (`server/library.ts`, `library_items`, Admin → Library in `src/app/AdminLibrary.tsx` and
`server/routes/admin-library.ts`). Music, clips and pictures shared by everyone, with a name, a description, a genre
(music) or category (clips and pictures; `shared/library.ts` suggests a list, administrators may write their own) and
tags.
Administrators upload them (a picture's size is read from its header on the server; a clip's or track's length and a
thumbnail come from the browser) or copy one of their own media files (`POST /api/admin/library/from-media`: an upload,
or an AI picture or clip made for one of their videos, with its name, its prompt as the description and the AI mark;
`source_asset` keeps it from being added twice), then rename, describe, tag, mark as AI-made, switch off or delete
them; the list shows how many videos and series use each item. `GET /api/library?kind=clip,image&q=&tag=` searches
the active items (all of them, folded to lowercase without accents, a plural matching its singular): every word must
be in the name, genre or category, description or tags, name matches first, then the genre or category, then tags,
then descriptions; `?ids=` returns particular
items (the editor's scenes). Music is a track, a background a clip, a scene a clip or a picture (`checkReferences`).
An item marked as AI-made makes the video that shows it AI-made (`compose.synthetic`), like the owner's AI pictures.
**Filled in by AI** (✨ in the upload form, on every item and in its editor): the administrator's browser makes small
samples of the file (the picture or 6 frames spread over a clip as JPEGs of at most 720 to 1024 pixels, or a minute of a
track as a mono 22 kHz WAV, so any format and size works), `POST /api/admin/library/describe` checks them (JPEG or WAV,
fitting the kind, under 1.6 or 8 MB) and `describeMedia` (`server/describe.ts`) has a multimodal model, `DESCRIBE_MODEL`
(default `google/gemini-3.8-flash` through the Workers AI binding), suggest a name, description, genre or category from
the list and tags (for music, moods from the app's list first, each mood explained so a scary track is `dark`). A name
the administrator gave (a title, not a file name) is kept and read as what the item is for. Nothing is saved: the suggestions fill the form to check.
`GET /api/admin/library/:id/file` serves an item's file to administrators even when it is switched off.
People hear tracks before choosing them: `MusicChoice` (Create, a series) offers a mood the writer picks a track of
(`musicCatalog`) or a track chosen in `LibraryPicker`, where every track has a play button, and shows the chosen one
with its own; the draft then gets `musicTrackId`, the writer's only music, which plays whatever the mood says. The
editor's music section plays the video's track.

**Style examples** (`server/examples.ts`, `style_examples`, Admin → Examples in `src/app/AdminExamples.tsx`). One real
video per faceless style, played on the style's card in Create, the app's home, the home page's gallery and coverflow,
its tool page, and in the home page's hero once three styles have one (else the drawn samples). An administrator
chooses one of their own finished videos (`PUT /api/admin/examples/:template`); its file and cover are copied under
`examples/{id}/` (up to 100 MB), so deleting the video keeps the example, and a new choice gets a new id, deleting the
old files through `cleanup_tasks`. `GET /api/public/examples` lists them (cached a minute) and their files are served
with `immutable` caching. The cards play a **preview**: the maintenance stage `examples` (`makePreviews`) hands a new
example to a free renderer (operation `preview`: the first 8 seconds of its public video, fitted to 540 × 960, silent,
at most 1.2 Mbit/s, about 1 MB; AI-marked when the example is), asking for it every 4 seconds while it renders (a
renderer left without requests for a minute sleeps), and stores it as `examples/{id}/preview-*.mp4`; a failure is tried
again on the next passes, three times in all. Until a preview exists the cards play the full video, which stays at
its own address. `src/examples.tsx` shows the cover at rest and plays the preview muted and looping while the card is
hovered or focused, and on touch screens (or the hero) while it is in view; with reduced motion only hovering plays it.
A style without one shows its drawing (`StyleArt`, cropped to fill the 9:16 tile).

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

Uploads go to R2 as multipart uploads of 8 MiB parts (images up to 20 MB, tracks 50 MB, videos up to the plan's
`videoMb`: 500 MB on the free trial, 2,000 MB on paid plans). Images are checked from their header; videos and tracks
by the renderer (`inspect`: kind, picture size, length up to the plan's `videoMinutes` at upload time — 10 minutes,
or 2 hours for videos on paid plans — and sound) and, when they may hold speech and last up to 10 minutes, transcribed
once by ElevenLabs Scribe v2 for free within the same daily allowance. A failed transcription only means no subtitles.

**Imports from links** (`server/imports.ts`, `POST /api/media/imports`, the Clips page's *Import*, `POST
/api/v1/sources` and the MCP tool `import_video`): a direct link to an MP4, MOV or WebM file, or a Dropbox (`dl=1`) or
Google Drive (its `drive.usercontent.google.com` download address) share link. Only https on the default port to a
public host name is fetched: no IP addresses, local or reserved names, credentials or this site — on every redirect
too (at most five, followed by hand). Links to TikTok, Instagram, Facebook, X, Twitch, Vimeo and Kick, and to YouTube
unless YouTube import is on (below), are refused before any request, with what to do instead. While the person waits
the link is opened once: a page, a missing file or a file whose first bytes are not MP4, MOV or WebM is refused at
once, as is a size over the plan's `videoMb`. The file is then a `checking` upload with `meta.import` (the link and
the bytes reserved: its size, or the plan's largest video when the link doesn't tell); the workflow (`importId`)
downloads it into R2 in 5 MiB parts (`storeStream`, never past the reserved size, 40 minutes at most, one more try
after a minute) and checks it like an upload. Confirmed emails only; 30 links an hour and 3 imports at once per
person.

**YouTube import (beta, `YOUTUBE_IMPORT=true`, paid plans)** (`server/youtube-import.ts`): only videos of a YouTube
channel the person connected (the same OAuth connection as posting, with `youtube.readonly`). `GET /api/media/youtube`
lists each connected channel's 25 latest uploads for the import picker (channels, playlistItems and videos.list: 3
quota units per channel; 30 listings an hour per person), each with why it can't be imported: private, live or
upcoming, still processing, age-restricted, under 20 seconds or over the plan's `videoMinutes`. A YouTube link sent to
the import (any form: watch, youtu.be, shorts, live, embed) is looked up with videos.list; a video whose
`snippet.channelId` is not one of the person's connected channels is refused, so nobody can import someone else's
video. The file is reserved at 2 MB a second of the video plus 50 MB (at most the plan's `videoMb`), `meta.import`
holds `{ youtube, channel, limit }`, and the workflow hands the renderer an operation `youtube` (the video ID, the
longest length and the reserved size) that runs only on the fourth container, `download-0` (`DOWNLOAD_SLOT`), one
download at a time, so renders never wait behind one; the workflow waits up to 30 minutes, then moves the MP4 into R2
(never past the reserved size) and checks it like an upload. The renderer runs yt-dlp (with Deno, its JavaScript
runtime, both pinned in the Dockerfile) on `https://www.youtube.com/watch?v=<id>` only, at most 1080p (H.264 and AAC
when YouTube has them), with no proxy, cookies or account; YouTube's refusals come back as `YOUTUBE_BLOCKED` (bot
checks, 429, 403), `YOUTUBE_RESTRICTED` (members-only, age-restricted, private), `YOUTUBE_UNAVAILABLE` or
`YOUTUBE_FAILED`, and the video fails with what to do instead (download it in YouTube Studio and upload it). The app's
CSP allows `https://i.ytimg.com` images for the picker's thumbnails.

## The content workflow

`ContentGeneration` (`server/content-workflow.ts`) runs four kinds of jobs: a video's run (`runId`), an upload check
(`inspectId`), a video imported from a link (`importId`: downloaded, then checked) and a series episode (`episode`,
below). A **run** is created with its video (or for an edit) in one
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
   **Presenter** (when the video has one and no presenter video for its avatar, quality and recording): HeyGen API v3
   (`server/providers/heygen.ts`) animates the avatar lip-synced to that WAV, which it reads through a capability link
   (`POST /v3/videos`, type `avatar`, engine `avatar_iv` for regular quality and `avatar_v` for high, 1080p, the
   avatar's own shape, an `Idempotency-Key` of the run). The workflow polls it (every 20 s, up to 50 minutes), stores
   the MP4 as an `ai_clip` asset of the video (`{"ai":true,"presenter":true}`), writes `presented` into the spec and
   asks HeyGen to delete its copy (`DELETE /v3/videos/{id}`; a failed delete waits in `cleanup_tasks` as
   `heygen/video/<id>` and the hourly maintenance retries it for two weeks).
4. **Render**: `planRender` (`server/render-plan.ts`) turns the spec into a `compose` payload and the workflow submits
   it to a container and polls it (every 8 s, up to about 40 minutes).
5. **Save**: the MP4 and its JPEG **cover** are stored as `render` and `cover` assets, the video becomes `ready`, and
   files of earlier versions it no longer uses are deleted (R2 cleanup follows).
6. **Ready** (`videoReady`): an approved series episode is scheduled on its series' accounts, and the owner is
   e-mailed when the series sends notices.

**Paid calls are made once.** Before each fal, ElevenLabs or HeyGen call a claim is stored in `runs.provider`, and the
ticket right after; a retried step polls the existing job instead of paying again, and a claim without a ticket (the
answer was lost) fails the run (`GENERATION_UNCERTAIN`, `VOICE_FAILED`, `AVATAR_UNCERTAIN`). On any failure the workflow stops the render, marks
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
the voice exactly. A storytime loops its background clip under the whole voice instead. A presenter's scenes cut its
video at the same second of the voice (`trim` = where the segment starts on the output clock), so its lips stay in
time across cuts and transitions; it is cropped to fill the frame. The voice is one track from 0;
subtitles are burned in as ASS from real word timings only (never estimates); the headline is drawn on top for its
seconds; music loops, fades and is lowered under the voice; free-trial videos get a small watermark with the product
name. The cover is taken once the first words (and the headline) are on screen. Output is 1080×1920 at 30 fps, at most
180 seconds.

**The container** (`renderer/`, Python 3.12 with FFmpeg, libass and the bundled Noto fonts): three render instances
and one download instance for YouTube imports (`max_instances: 4`, `standard-2`), each running one job at a time. A
job goes to the container its ID hashes to, or the next free one (`429` means busy), and the workflow records the slot
that accepted it. Inputs are downloaded only from `SITE_URL`'s origin on the capability paths; finished files wait 30
minutes for the Worker. Files with an AI voice, picture or clip are marked as AI-made (MP4 tags and an XMP packet with
the IPTC digital source type), and the saved render carries `{"ai":true}`. The Worker uses the `compose`, `inspect`
and `track` operations; a clip's split layout is a `compose` segment with `panes` (windows of the picture cropped in
whole even pixels, scaled to fill the frame's width and their height, stacked).

## Clips from long videos

The app's Clips (code: "highlights", so they never mix with a scene's AI clip): `shared/highlights.ts`,
`server/highlights.ts`, the `highlight` spec in `shared/formats.ts`, the editor in `src/app/clip-editor.tsx` and
`src/app/ClipPreview.tsx`.

- **Sources** are the owner's videos, uploaded or imported from a link (`GET /api/highlights/sources`). Each keeps
  what was found in it in `media_assets.meta`: the transcript (up to 30,000 words, with who spoke when — Scribe's
  diarization, speakers numbered — and the sounds it tagged, such as laughter or applause), the last moments found
  (`moments`), a search waiting for its speech (`wanted`) and the last search's failure (`momentsError`). Lists never
  carry the transcript; a clip's editor loads the words around its moment (`GET /api/media/:id?from=&to=`).
- **Finding clips** (`POST /api/highlights/sources/:id/find`: how many, short/medium/long, an optional focus). With
  the speech known, the text model reads the transcript numbered by sentence, with the sounds heard after each
  (`[laughter]`, `[applause]`), in parts of 24,000 characters (up to 8, in parallel), as data; it picks
  non-overlapping sentence ranges of the asked length and rates each 1–10 for hook, payoff, clarity and energy.
  `acceptMoments` checks them (sentence edges with a little air, the accepted lengths, no overlap) and `viralityScore`
  weighs the parts into the **virality score** (10–99), plus 3 for each time people laughed, applauded or cheered in
  the moment or the 2 s after it (`reactionsIn`, 9 at most). It is shown as an estimate, never a promise of views. The
  best scored are kept. Twenty successful searches per person and day; a failed one gives its search back. A video
  whose speech is not known yet is transcribed first: free up to 10 minutes (the daily allowance), else as a run of
  kind `speech` for `speechCredits` (1 per started 30 minutes, the price the person was shown; refunded if it fails).
  The search waits in `meta.wanted` and runs in the workflow right after the transcription (`momentsAfterSpeech`).
- **A clip** is a video of format `highlight` (created with `POST /api/videos`): its source and moment (5 s to
  3 minutes), instant cuts (`shared/cuts.ts`: pauses over 0.6 s shortened, fillers removed, on the 1/30 s grid),
  a layout, captions (style and position), an optional hook title (`headline`), music, the post text, and the
  writer's note on the moment (`moment`: score and reason, never rendered). It costs 1 credit per started minute of its
  moment; an edit is free unless it keeps less than half of the moment it replaces (`specCredits` with the stored spec);
  a clip whose first run failed (refunded) costs a new one when it is made again.
- **Layouts**: `follow` (a 9:16 crop on whoever is talking, `shared/track.ts`), `split` with two windows stacked
  (`speakers`: placed on the two people found unless the owner moved them; `screen`: a camera window over the screen),
  `crop` (one window) and `fit` (the whole picture over a blur). A window is a centre and a zoom; `paneWindow` turns it
  into the exact rectangle of the pane's shape inside the picture, the same in the preview and the render plan.
- **The run**: when the layout needs it (`follow`, or `split` placed automatically) and the moment was not measured
  yet, the renderer's `track` operation finds the faces in the moment (YuNet, 4 samples a second) and returns the crop
  path and the two people seen most (`faces`), kept as the server-owned `tracked` with the moment's key; a failure
  only leaves the picture centred. **Active speaker**: the Worker sends who talks when in the moment, phrase by phrase
  (`speechSpans`: the words joined into stretches split at pauses over 0.3 s, each with the diarized speaker nearest
  it within a second, else -1), so the pauses between phrases are known too. For every face the renderer compares its
  mouth with the last sample (a small patch between the mouth's corners, less the change of one on the nose, so a
  moving head is not talking). A face whose lips move no more (×1.3) while someone talks than in the pauses — a photo,
  a face on a slide or a changing screen — is never the speaker. Each turn of at least a second goes to the face
  clearly moving its lips most, and a speaker label keeps the face it was matched to most often (so a turn whose lips
  were not readable still finds its face); when no turn is clear by itself (one voice the whole moment), the shot
  holds on the face whose lips move most with the voice rather than the biggest. The crop cuts at each change of
  speaker (never more than once a second) and follows that face calmly within the turn; with no speech, or one face,
  it follows the face seen most. `trackKey` carries the tracker's version (`TRACKER`), so a better tracker measures
  clips again when they are made again. A render that fails logs `Render failed` with the run, the code and FFmpeg's
  last error line (`detail`), which never reaches the owner. Then `planHighlight` makes one
  video segment: the moment trimmed, its kept parts, and either the `follow` path, `fit: "contain"` or `panes`; the
  clip's own sound; captions from the transcript's words cut like the picture; the hook title; music under it all.
  Nothing in a clip is AI-made, so it is never marked as such.
- **Posting**: clips post like any video; the Clips page can schedule a batch one a day (or twice a day, weekly) on
  chosen channels.

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
- **Clips** (REST): `GET /sources`, `POST /sources` (import a video from a link, `{ url }`; 202 while it downloads),
  `GET /sources/:id` (moments with their index), `POST /sources/:id/find` (with `credits` to agree to transcribing a
  long video) and `POST /clips` (a moment by index, or `start`/`end`; layout, caption style, captions, hook title,
  pause removal).
- **MCP** (`/mcp`, Streamable HTTP, JSON-RPC 2.0, protocol `2025-06-18`): `POST` with one message or a batch of up to
  20; notifications get 202; `GET` and `DELETE` answer 405 (no server stream, no session). Tools: `list_video_types`,
  `create_video`, `get_video`, `list_videos`, `list_series`, `set_series_status`, `list_long_videos`, `import_video`,
  `find_clips`, `get_long_video`, `make_clip`, `get_account`. A tool's failure is returned as its result with
  `isError`, in plain words. 300 requests an hour per person.
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
| Every minute | `publish` (`dispatchDue`); `series` (`dispatchSeries`, only with `MEDIA_ENABLED=true`); last, after the stages below, `examples` (previews of new style examples, `makePreviews`, only with `MEDIA_ENABLED=true`; may wait up to a minute for the renderer) |
| Minutes 0, 5, 10, … | `runs`: re-dispatch runs whose workflow never started, fail runs older than 3 hours, mark videos left "being made" without a run as failed |
| Minutes 2, 7, 12, … | `stats`: video stats from the networks |
| Minute 17 of every hour | `summary` first (the operator summary, `server/operations.ts`), then `cleanup` (R2 deletes, only under `media/`, `library/` and `examples/`), `uploads` (unfinished uploads after a day, stuck checks after an hour, failed uploads after a week), `reviews` (provider work a failed run may have left), `retention`, `contracts` (confirmation e-mails) |
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
