# Ghostreel

Faceless videos that post themselves. Pick a niche, a voice and an art style once: Ghostreel writes, narrates,
illustrates and subtitles a new short vertical video for every slot in your schedule and posts it to TikTok, YouTube
Shorts and Instagram Reels.

The product name and wording live in one place (`shared/brand.ts`, plus `index.html` and `public/favicon.svg`). The
public address is whatever `SITE_URL` says; the Worker's other hosts redirect there, except `*.workers.dev` and
localhost (`server/config.ts`).

Built on the same stack as [rech-bg](https://github.com/radoslav1992/rech-bg): Cloudflare Workers (Hono), D1, R2,
Workflows, Containers (FFmpeg) and Workers AI, with Stripe billing. Code reused from it includes auth and sessions,
rate limits, the Stripe usage windows, webhooks and reconciliation, the caption engine and libass renderer, the
ElevenLabs voice, forced alignment and Scribe pipelines, the narrated-video scene split and timeline, chunked uploads
and the maintenance cron.

## What it does

- **Video types.** Every video is a narrated vertical video (1080×1920, up to 3 minutes): a voiceover, a picture for
  every scene of one or two sentences, word-by-word subtitles, transitions and background music. Five types
  (`shared/templates.ts`):
  - **AI story**: a story or explainer with a new AI picture for every sentence and a title card;
  - **POV**: second-person scenes with a "POV: …" line on screen the whole time;
  - **Brainrot mashup**: an absurd animal-and-object creature with a chanted name;
  - **Storytime**: a title question, then the story narrated over a looping background clip;
  - **Text to video**: the owner's own script, split into scenes and illustrated.

  On top of these sit 22 ready-made styles in six categories (scary stories, history, fun facts, POV scenarios,
  bedtime stories, "Your own topic" and more), each with its brief for the writer, voice, art style, length and music
  mood. There are 15 art styles, 12 voices, 26 narration languages and 21 caption styles.
- **Series on autopilot.** A series is one faceless channel: a style, a topic, a language, voice, art style, length
  (30, 45, 60 or 90 s), music mood, subtitles, the connected accounts it posts to and a schedule (times per day on
  chosen weekdays, in its time zone). For every slot an episode is written and made ahead of time (6 hours before;
  24 hours in review mode) and posted at the slot, or it waits for approval when the series asks for review. When the
  series sends notices, the owner is e-mailed when an episode is ready or could not be made, and when slots start being
  skipped for lack of credits or because the trial ended.
- **Editing.** Any video can be changed before it posts: the words of each scene (on a timeline of the voice, with
  draggable scene edges, split and merge), each scene's picture (a new AI picture, an AI clip made from it, the owner's
  own image or video, or a library clip), transitions, the on-screen title, subtitles, music and the post text. The
  voice can be an AI voice or the owner's own recording, timed by its transcript or by forced alignment of its script.
  The editor shows the exact credit price before anything is made.
- **Posting.** TikTok, YouTube (Shorts) and Instagram (Reels) are connected with OAuth; tokens are stored encrypted.
  Videos post at a series slot, at a chosen time or at once, publicly or (TikTok, YouTube) privately. Published
  videos' views, likes, comments and shares (and saves on Instagram) are read back for 30 days.
- **Credits and plans** (`shared/plans.ts`, `shared/credits.ts`). Credits are the one currency: a new video costs
  1 credit per started 30 seconds, script, narration and every picture included. Bringing a scene to life with an AI
  clip costs 1 credit per 5 seconds; redoing pictures of a made video 1 credit per 5 pictures; new narration for
  changed words 1 credit per started 30 seconds. Editing subtitles, music, transitions, timing and text is free.

  | Plan | Monthly | Yearly | Credits a month | Series | Social accounts | Storage |
  | --- | --- | --- | --- | --- | --- | --- |
  | Free trial (7 days) | $0 | – | 4 in all | 1 | 1 | 1 GB |
  | Starter | $19 | $168 | 30 | 2 | 1 | 10 GB |
  | Daily | $35 | $288 | 60 | 5 | 100 | 30 GB |
  | Double | $59 | $492 | 120 | 10 | 100 | 60 GB |
  | Studio | $149 | $1,248 | 350 | 30 | 100 | 200 GB |

  The free trial is once per mailbox and its videos carry a small watermark. A yearly plan gives its credits month by
  month. Unused credits roll over while a plan runs, up to three months of the plan's credits plus credit packs.
  Subscribers can buy credit packs at any time: 10 credits for $8, 40 for $28, 150 for $90. Credits are reserved when
  work starts and refunded automatically when it fails.
- **API and MCP.** Personal API keys (Settings) work with a small REST API (`/api/v1`) and an MCP server (`/mcp`), so
  scripts and AI assistants can make videos, fetch download links and pause or resume series, with the same credits and
  limits as the app.
- **Administration.** Administrators (`ADMIN_EMAILS`) fill the shared library (music tagged by mood, background
  clips), see operations and failures, handle withdrawals within 14 days and give free months of a plan.

The public pages show drawn samples of the styles (`src/art.tsx`), never invented results, user numbers, reviews or
trend data.

## Stack

- **Client** (`src/`): React 19, React Router 7, Vite 7; Inter and Bricolage Grotesque (Fontsource), lucide icons.
- **Worker** (`server/`): Hono 4 on Cloudflare Workers, zod 4 for every input.
- **Data**: D1 (`migrations/0001_initial.sql`), a private R2 bucket for every file.
- **Background work**: two Workflows (`ContentGeneration` makes videos and episodes and checks uploads; `Publication`
  posts one video) and a cron every minute (`server/maintenance.ts`).
- **Rendering**: a pool of three FFmpeg/libass containers (`renderer/`, Python 3.12), reached through the
  `MediaRenderer` Durable Object.
- **AI**: Workers AI for scripts and picture descriptions; fal for pictures (`fal-ai/nano-banana-2`) and clips
  (Kling image-to-video); ElevenLabs for voices (`eleven_v3`), forced alignment and Scribe transcription.
- **Payments and mail**: Stripe (subscriptions, credit packs, Customer Portal); Cloudflare Email Sending.

Contracts the client and the Worker share live in `shared/` (plans and credits, series settings and schedules,
templates, the video spec and narrated-video timing, captions and on-screen text, renderer payloads, social limits).

## Local development

Node.js 24 and npm:

```sh
npm install
cp .dev.vars.example .dev.vars   # fill in what you need
npm run db:local                 # applies migrations/ to the local D1
npm run preview                  # builds the client and runs the Worker (wrangler dev) on :8787
```

For hot reload, keep the Worker running and start Vite in another terminal with `npm run dev` (port 5173, `/api` is
proxied to :8787). Set `SITE_URL=http://localhost:5173` in `.dev.vars` then: state-changing requests must come from
`SITE_URL`'s origin.

Sign-ups need `COMPANY_NAME`, `CONTACT_EMAIL` and `SITE_URL`, `REGISTRATION_ENABLED=true` and the `EMAIL` binding
(the confirmation link is e-mailed; the sender is `EMAIL_FROM`, else `CONTACT_EMAIL`). With `APP_ENV=development` they
work without Turnstile. Add your address to `ADMIN_EMAILS` (and confirm it) to see Admin.

Making videos needs `MEDIA_ENABLED=true`, `FAL_KEY`, `ELEVENLABS_API_KEY` and the renderer container. `wrangler dev`
builds `renderer/Dockerfile` with a local Docker. The renderer downloads its inputs only from `SITE_URL`'s origin, and
fal and ElevenLabs read some inputs from capability links on `SITE_URL`, so an end-to-end render needs a `SITE_URL` that
the container and the providers can reach. Everything else works with `MEDIA_ENABLED=false`.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Vite dev server for the client (proxies `/api` to the Worker on :8787) |
| `npm run preview` | `build`, then `wrangler dev` |
| `npm run build` | Type check, then `vite build` into `dist/` |
| `npm run deploy` | `build`, then `wrangler deploy` (Worker, assets and the renderer image) |
| `npm run db:local` / `db:remote` | Apply `migrations/` to the local / remote D1 database `faceless` |
| `npm run check` | `tsc --noEmit` |
| `npm run lint` | ESLint (hooks, accessibility, unsafe patterns) |
| `npm test` | Vitest |
| `npm run check:bundle` | Fails when the entry chunk is over 400 kB or any other chunk over 500 kB |
| `npm run ci` | `check`, `lint`, `test`, `build` and `check:bundle`: the same as CI |

The Vitest suites call the real Hono app, SQL schema and triggers through local stand-ins: D1 over `node:sqlite`
with every migration applied, an in-memory R2, Workflow stubs and mocked providers (`tests/helpers.ts`). The renderer
has its own test, run with FFmpeg installed:

```sh
python3 tests/renderer_test.py
```

CI (`.github/workflows/ci.yml`) runs `npm run ci` and `wrangler deploy --dry-run`, the renderer test on Python 3.12
with FFmpeg and Noto fonts, and a Docker build of the renderer image. None of it replaces a smoke test with real keys.

## Project layout

```
server/                Worker
  index.ts             middleware and routes, cron entry, exported Workflows and container class
  series.ts            series API, slot planning, episodes, e-mail notices
  videos.ts            videos API, credits, runs
  story.ts             the script writer, drafts, picture plans, voiceover timing
  content-workflow.ts  ContentGeneration: AI pictures and clips, voice, render, upload checks, transcription
  render-plan.ts       a video's spec → the renderer payload
  renderer.ts          the MediaRenderer container and its three slots
  publishing.ts        scheduling, the publishing cron, media links for the networks
  publish-workflow.ts  Publication: posts one video exactly once
  social/              TikTok, YouTube and Instagram clients, token sealing
  providers/           fal and ElevenLabs
  billing.ts           plans, usage windows, Stripe checkout, credit packs, webhook, reconciliation
  plan-grants.ts, withdrawals.ts   free months and 14-day withdrawals (admin)
  api.ts               API keys, REST API (/api/v1), MCP server (/mcp)
  maintenance.ts, operations.ts, retention.ts   cron, operator summary, retention
  routes/              admin, public (config, contact), settings (account)
shared/                code shared by client and Worker (plans, credits, series, schedule, templates, story, …)
src/                   client: App.tsx (routes), public/ (site), app/ (dashboard), style.css (design tokens)
renderer/              FFmpeg container: Dockerfile, server.py, caption fonts
migrations/            D1 schema
tests/                 Vitest suites and the renderer test
scripts/check-bundle.mjs
```

## Docs

- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md): Cloudflare resources, variables and secrets, Stripe, social apps, go-live.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): request flow, data model, how a video is made, series, publishing,
  billing, API.
- [docs/DESIGN.md](docs/DESIGN.md): design tokens and components, the public site and the app.
- [docs/OPERATIONS.md](docs/OPERATIONS.md): admin console, alerts, failure codes, provider outages, withdrawals, free
  months, retention.
- [docs/SOCIAL.md](docs/SOCIAL.md): developer apps and reviews for the social networks.
- [docs/PRIVACY.md](docs/PRIVACY.md): what is kept for how long, and what account deletion removes.
