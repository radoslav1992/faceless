# Design

Hookstreak Shorts is part of the Hookstreak family: Hookstreak's logo and electric lime, its own product name and wording. One dark theme serves the public site and the app, with a
electric lime accent. No third-party branding, testimonials or metrics are shown; every example video on the site is a
drawing in the page (`src/art.tsx`, `src/public/Phone.tsx`), never a real result or an AI picture.

Stylesheets: `src/style.css` (tokens and shared components, loaded everywhere), `src/public/public.css` (the public
site and sign-in pages, scoped under `.public` / `.auth-page`), `src/app/app.css` (dashboard layout and shared app
pieces) plus small per-screen sheets in `src/app/` (`create.css`, `story.css` for the editor, `pages.css`,
`admin.css`). Components are plain classes; there is no CSS framework.

## Tokens

Defined on `:root` in `src/style.css` (`color-scheme: dark`):

| Token | Value | Use |
| --- | --- | --- |
| `--bg` / `--bg-2` | `#0b0d0c` / `#0f1211` | Page canvas; inputs |
| `--surface`, `--surface-2`, `--surface-3` | `#141816`, `#1a1f1c`, `#222824` | Cards, tiles, hovers and selected tabs |
| `--line` / `--line-2` | `#262c28` / `#343b36` | Borders |
| `--text`, `--muted`, `--soft` | `#f1f5f2`, `#9aa49d`, `#6b756e` | Text, secondary text, placeholders |
| `--brand` | `#b8f53a` | Hookstreak's electric lime: primary buttons, selection, meters, key words |
| `--brand-hover` / `--focus` | `#c9f866` | Hover of lime fills; focus outline |
| `--brand-ink` | `#c9f866` | Lime used as text (links, chips) |
| `--brand-soft` / `--brand-line` | lime at 10% / 35% | Selected tiles, good notices; lime borders |
| `--on-brand` | `#0c0d10` | Ink text on a lime fill |
| `--violet`, `--red`, `--yellow` | `#a08bff`, `#ff6b6f`, `#f6c453` | Secondary chips; errors and danger; waiting / worth a look |
| `--radius` / `--radius-sm` | 18px / 12px | Cards; small surfaces |
| `--shadow` / `--shadow-lg` | soft dark shadows | Cards; modals, drawers, toasts |
| `--font` / `--display` | Inter Variable / Bricolage Grotesque Variable | Body; headings and the wordmark |

Lime as a fill always carries ink text (`--on-brand`); on the dark canvas the lime reads as text too. Amber chips and
notices mean "waiting" or "worth a look", red means failed or destructive, violet is a neutral secondary accent.

## Typography

- **Headings**: Bricolage Grotesque (variable, from Fontsource), weight 800, letter-spacing −0.025em, line-height 1.08.
  Public page titles `clamp(38px, 6vw, 68px)`, the home hero `clamp(42px, 7.2vw, 84px)`, app page titles 30px.
- **Body**: Inter (variable), 15px, line-height 1.5; small text 13px; table headers 12px uppercase.
- **Caption fonts**: Noto Sans (Regular, Bold) and Noto Serif Italic, served from `public/fonts` as WOFF2. They are the
  same faces the renderer burns into videos (`renderer/fonts`), so the editor's preview and the sample phones match the
  rendered subtitles and titles.
- **Code** (MCP and API examples): the system monospace stack.

## Brand

- **Logo**: Hookstreak's mark, a hook whose point turns into an upward streak (`LogoMark` in `src/ui.tsx`), ink on a
  lime rounded tile, beside the wordmark "Hookstreak Shorts" in Bricolage 800. The favicon (`public/favicon.svg`) is the
  same mark, as on hookstreak.com.
- **Glow**: soft radial lime gradients behind the home hero, the sign-in stage, the try-it demo and the call-to-action
  band; `.glow-text` gives a headline phrase a lime glow.
- **Sample phones**: 9:16 frames with a drawn picture slowly zooming (Ken Burns), a white title card (or a POV line, or
  a yellow mashup name) and a word-by-word caption with one key word in lime, mirroring what the renderer makes.

## Components (`src/style.css`)

- **Buttons**: pills (radius 999px). Default is a dark surface with a border; `primary` is the lime fill with ink
  text and a soft lime shadow; `ghost`, `outline`, `danger`; sizes `sm`, `big`, `block`; `icon` buttons are 12px
  rounded squares. `.link` and `.text-link` are lime text links.
- **Chips**: small pills for status: neutral, `brand`/`green` (both lime), `violet`, `orange` (amber), `red`, `solid`.
- **Forms**: labelled fields (14px, weight 600) with hints; inputs, selects and textareas on `--bg-2` with a 14px
  radius and a lime border plus a soft lime ring on focus; checkboxes, ranges and the `switch` toggle use the brand
  colour; notices in neutral, `warn`, `bad` and `good`.
- **Cards**: `--surface`, a 1px line, radius 18px and a soft shadow; `flat` and `glow` (lime-tinted) variants. Grids of
  two, three or four columns collapse to one under 900px.
- **Tabs and filters**: a pill-shaped segmented control (`.tabs`); category filters with counts, the selected one
  filled lime.
- **Overlays**: modals (radius 22px, sticky header and footer, 720px or 1000px wide), toasts top right, spinners and
  empty states.
- **Choice tiles** (`.choice` in `src/app/app.css`): surface tiles with a title and a short line; the selected tile
  gets the soft lime background, a lime border and an inner ring. Style, art-style, voice and caption grids are radio
  groups (`aria-checked`), moved with the arrow keys.

**Accessibility**: a 3px lime focus outline on `:focus-visible`; `prefers-reduced-motion` stops animations and
transitions (samples and previews then show a still moment); a skip link on public pages; on navigation the new page's
heading receives focus and the title updates; icons beside text are `aria-hidden`.

## Public site (`src/public/`)

- **Shell** (`PublicLayout.tsx`): a sticky, blurred header with the logo, links (Tools, Pricing, MCP Connection,
  Business, About, FAQ) and *Log in* / *Free trial* (or *Dashboard* when signed in); under 960px the links move into a
  left drawer. The footer has Product (Video tools, Art styles, Pricing, MCP Connection, API access), Company (About,
  Business, FAQ, Contact) and Legal (Terms of Use, Privacy Policy).
- **Home** (`/`): the hero ("Grow a faceless channel without lifting a finger", *Start for free* and *Browse video
  tools*, "Free trial · no card needed · cancel any time") over a reel of sample phones; *How it works* in three steps
  (pick a style, shape the draft, stay consistent); *Try it*, a live storytime preview (title, story, caption colour,
  four CSS-animated backgrounds) that carries the draft into Create, after sign-up if needed; the gallery of faceless
  styles; *Why creators switch*, comparing hiring editors and making every video yourself with Hookstreak Shorts; the plan
  cards; FAQ; a call-to-action band.
- **Tools** (`/tools`, `/tools/:slug`): one page per template with a `tool` entry (text to video, scary story, story,
  POV, brainrot mashup, storytime), each a hero with a short form that opens Create with that style.
- **Styles** (`/styles`): the faceless styles by category and the 15 art styles as drawn samples.
- **Pricing** (`/pricing`): a Monthly / Annual toggle with "Save N%" (the best yearly saving, from `shared/plans.ts`),
  the four paid plans (yearly shows the monthly equivalent and the yearly amount), credit packs, *What credits buy*
  (the tariffs the server charges by), FAQ and the note on USD and taxes.
- **MCP** (`/mcp`): three steps (create an API key, add the server, ask), the tools the assistant gets, and *API
  access* (`/mcp#api`) with curl examples and the REST endpoints.
- **Business**, **About**, **FAQ**, **Terms** and **Privacy** (`/terms`, `/privacy`, one legal component with a
  switch), **Contact** (topics include a 14-day withdrawal), and a not-found page with a real 404.
- **Sign-in pages** (`/login`, `/register`, `/forgot`, `/reset`, `/verify`): a centred card on the dark stage, a
  password show/hide toggle, Turnstile where needed.
- **Metadata**: titles and descriptions per public page in `shared/seo.ts`; the Worker writes them, canonical and Open
  Graph tags into the HTML, and `sitemap.xml` lists the public pages.

## App (`src/app/`)

- **Layout** (`Layout.tsx`): a left sidebar (248px, collapsible to icons, a drawer under 860px) with the logo,
  **Create video** (lime), Home, Series, Videos, Schedule, Channels, then Billing (shown as *Upgrade* on the free
  plan), Settings and Admin for administrators, a credits card with a meter and *Upgrade* / *Add credits*, and *Log
  out*. A top bar shows the trial's time left or the plan and credits left, with an *Upgrade* / *Add credits* pill.
  Banners ask to confirm the email, update a failed card or choose a plan after the trial.
- **Home**: "Let's make your first video" with a few styles for new accounts, videos needing review, what posts next,
  the series and the latest videos.
- **Create**: choose a faceless style (gallery by category), fill a short brief (topic or script, length, language,
  voice, art style, music), *Write the draft (free)*, then edit it in the video editor and press *Make video · N
  credits*. Nothing is made or charged before that.
- **The video editor** (`StoryEditor.tsx`, `StoryTimeline.tsx`, `StoryPreview.tsx`): a phone preview that plays the
  scenes on the voice's clock with their transitions, subtitles and title; the selected scene (its words as chips to
  mark key words, split or merge; its picture source with prices; the transition in); the timeline of the voice with
  scene edges that snap to pauses between words; sections for the background clip, on-screen title, subtitles (21
  live style samples), music, and *Plan and price*, whose button is the only thing that spends credits.
- **Clips** (`/app/clips`, `Clips.tsx`): the owner's long videos as 16:9 cards with where each stands (Checking,
  Listening, *N moments*, clips made), an upload button and a drop zone. **A video's clips page** has *Find clips*
  (how many, how long, an optional topic; the price when a long video must be transcribed first), the moments as cards
  ranked by their score badge (lime from 80, amber from 60) with the four part scores, the reason and the words, a
  sticky phone preview of the chosen moment (`ClipPreview.tsx`: the source drawn into the frame by its layout, cut and
  captioned as the render will be), *Make the clips* (layout tiles, caption style, hook title, pause removal, the
  price) and the clips made, with *Schedule clips* (channels, first post, one a day / two a day / one a week).
- **The clip editor** (`clip-editor.tsx`, on a clip's video page): the preview with the moment's score; a trim bar of
  the words around the moment whose edges snap to word edges (draggable, or arrow keys); layout tiles, and for a fixed
  crop or a split the source picture with each window as a draggable box (lime on top, cyan below), its zoom and the
  split's ratio; captions (position and style), the hook title (text, 3 s / 5 s / whole clip), music and the post text.
- **Videos** (`/app/videos`): a grid of 9:16 video cards filtered by All, Being made, To review, Ready and Failed.
  **A video's page** shows the player beside its posts (post now or later, privately where possible, retry), review
  (approve / reject), the editor, a retry for a failed render and delete.
- **Series** (`/app/series`): series cards with their latest cover; **New series** is a four-step wizard (Style;
  Content: topic, voice and language, art style, music and subtitles, background clip for storytime; Posting: where
  and when it posts; Review). A series' page has *Episodes* (the coming slots of two weeks beside the episodes made,
  *Make one now*, pause and resume, the blocked reason) and *Settings*.
- **Schedule**: the next two weeks of posts by day; planned slots of series appear dashed.
- **Channels**: one section per network with its connected accounts, *Connect* and *Disconnect*, and the plan's
  account limit.
- **Billing**: the current plan and credits, plan cards (monthly or yearly), credit packs, *Changed your mind?* (the
  14-day withdrawal), and what every plan includes and what credits buy.
- **Settings**: account name, password, API keys (created once, shown once) and account deletion.
- **Admin** (administrators only): Overview, Operations, Billing, Library and Messages tabs
  ([OPERATIONS.md](OPERATIONS.md)).
