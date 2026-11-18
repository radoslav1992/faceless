# Two sites from one codebase

This repository is Hookstreak Shorts. The same code also builds a second site: **Реч БГ**, Hookstreak in Bulgarian,
with its own name, logo, currency, database, storage and Stripe account. Hookstreak is the default and does not
change: a build without `SITE=rechbg` renders the pages it always did.

Status: Реч БГ builds (`npm run build:rechbg`) with the public pages, the app, the legal pages and the e-mails in
Bulgarian, its name and logo, and prices in euro. Its database and bucket exist; it is not deployed yet. What is left
is under "Deployment" and "Still to do".

## How a build knows its site

`SITE=rechbg` when building. `vite.config.ts` (the app and the prerendered pages) and, once it exists, Реч БГ's
wrangler config (the Worker) define the constant `__SITE__`. `shared/site.ts` reads it as `SITE_ID` and `SITE`: the
interface language, the locale for numbers and dates, and the narration language new videos and series start with
(Bulgarian on Реч БГ). Tests and tools that do not define it are Hookstreak.

Modules that hold something per site compare `__SITE__` themselves (`shared/brand.ts`, `shared/money.ts`,
`shared/i18n.ts`), so the bundler drops the other site's half: Hookstreak's build has no Bulgarian text in it.

| | Hookstreak | Реч БГ |
| --- | --- | --- |
| Name and logo (`shared/brand.ts`, `LogoMark` in `src/ui.tsx`) | Hookstreak Shorts, the hook | Реч БГ, four bars of a sound wave |
| Interface | English | Bulgarian (`shared/locales/bg.ts`) |
| Narration language new videos start with | English | Bulgarian |
| Numbers and dates | `en-US` | `bg-BG` |
| Currency (`shared/money.ts`) | US dollars | euro; the plan prices are the same numbers and include VAT |
| Heading font | Bricolage Grotesque | Manrope (Bricolage has no Cyrillic letters) |
| Shell, icons, manifest, offline page, share image | `index.html`, `public/` | `sites/rechbg/shell.ts`, `sites/rechbg/public/` |
| Build output | `dist`, `dist-ssr` | `dist-rechbg`, `dist-rechbg-ssr` |

## Words

The code is written in English, and the English text is also the key. `shared/locales/bg.ts` is Реч БГ's catalog:

- `exact`: a text and its translation.
- `templates`: texts with changing parts, written as the code has them with `{1}`, `{2}`… for the parts
  (`"{1} credits left"`). A part glued to the end of a word (`credit{2}`) is English grammar, the plural's "s": it
  is matched and left out of the translation.
- `patterns`: regular expressions for what neither covers.

How texts reach the catalog:

- **The interface is translated without touching the screens.** On Реч БГ the JSX import source is `src/i18n`
  (`jsx-runtime.ts`, `jsx-dev-runtime.ts`): React's runtime with the words of every element passed through `t` on
  the way in: string children, and the attributes `placeholder`, `title`, `aria-label` and `alt`. Hookstreak is
  built with React's own runtime.
- **A text without a translation stays in English.** Nothing breaks; it is just not translated yet.
- `translate="no"` on an element (the HTML attribute) keeps its text as it is: names, titles and other words people
  typed. Text inside `code`, `pre`, `textarea`, `script` and `style` is never translated (their attributes are).
- **Pieces of sentences.** `<p>You have {n} credits left</p>` reaches the runtime as "You have ", a number and
  " credits left", and each piece has its own entry. Spaces around a piece are kept.
- **By hand**, for words no element shows: `t("…")` and `localized(data)` from `shared/i18n.ts`. Used for page
  titles and descriptions (`shared/seo.ts`), structured data (`shared/structured-data.ts`), a sample caption before
  it is split into words (`src/public/Phone.tsx`) and an example topic that becomes the topic when clicked
  (`src/app/Create.tsx`, `src/public/Pages.tsx`). Both return what they were given on Hookstreak.
- **Site-specific sentences** are just translations: "Prices in US dollars. Taxes may apply at checkout." is
  "Цените са в евро и са крайни, с включен ДДС." on Реч БГ.

### Keeping the catalog complete

- `node scripts/extract-texts.mjs` lists every text the code can show (JSX text, attributes, sentences in data and in
  the server's messages; templates for texts with changing parts). `--missing` lists those without an entry.
- `npm run dev:rechbg` runs Реч БГ's build of the app; every text shown without a translation is collected, and
  `window.__untranslated()` in the browser's console lists them for the pages visited so far.
- Tone: natural Bulgarian written for the page, not word for word; the reader is addressed politely in the plural
  ("Изберете", "Създайте"); quotation marks are „…“. The home page's headline is the owner's wording.

## Legal pages

Реч БГ has its own terms and privacy policy in Bulgarian, on the same two addresses and with the same anchors the
app links to (`/terms`, `/privacy`, `#withdrawal`, `#withdrawal-form`, `#affiliates`): `src/public/LegalBg.tsx` shows
the texts in `src/public/legal-bg.ts`, and `src/App.tsx` loads it in place of `Legal.tsx` on Реч БГ only.

- The wording comes from the earlier Реч БГ site (its terms, privacy, cookies and refund pages, folded into two);
  every statement about the product was replaced with what Hookstreak's texts and the shared files say.
  `docs/LEGAL-BG.md` records what was kept, what changed and why, and the open questions.
- The provider's name, company number (`COMPANY_ID`, shown as ЕИК), address and e-mail come from the site's settings
  and are shown at the top of both pages and in the standard withdrawal form.
- Prices and credit numbers are not in the texts: they point to the pricing page.
- The sentence a customer agrees to before paying ("start my plan straight away", `shared/withdrawal.ts`) is the
  Bulgarian one the earlier site used, with its own version.

## E-mails

`sendMail` (`server/security.ts`) passes the subject and each line of the text through the catalog on Реч БГ
(`mailWords` in `shared/i18n.ts`), so the e-mails are written once, in English, where they are sent. Their lines are
templates in `shared/locales/bg.ts`; a plan's name and a price inside a sentence are translated too. A line without
an entry stays in English. `tests/i18n-mail.test.ts` writes each e-mail as the server does and checks that every
line comes out in Bulgarian: sign-up confirmation, password reset, the existing-account notice, a plan's
confirmation with the consent and the right of withdrawal, a series' notices, channel notices and the thanks for a
call. E-mails to administrators (operations, quota, contact-form messages) are not translated.

## Deployment

Реч БГ is its own Worker with its own data: `wrangler.rechbg.jsonc`. Nothing is shared with Hookstreak.

| | Hookstreak (`wrangler.jsonc`) | Реч БГ (`wrangler.rechbg.jsonc`) |
| --- | --- | --- |
| Worker | `faceless` | `rechbg` |
| Site switch (`define`) | `__SITE__` = `hookstreak` | `__SITE__` = `rechbg` |
| Database (D1) | `faceless` | `rechbg`, `1124cf5a-4c90-4a18-9c31-552a2fe8a689`, Western Europe, created empty 2026-11-18 |
| Bucket (R2) | `faceless-media` | `rechbg-media`, created empty 2026-11-18 |
| Workflows | `faceless-content`, `faceless-publish` | `rechbg-content`, `rechbg-publish` |
| App files | `dist` | `dist-rechbg` |
| Address | hookstreak.app | its workers.dev address until the switch, then rechbg.com |

`npm run deploy:rechbg` builds Реч БГ, applies the migrations to its database and deploys the Worker (the renderer's
container needs Docker, as for Hookstreak). The earlier Реч БГ (the Worker `rech-bg`, the database `rech-bg`, the
bucket `rech-bg-audio`) is a different app and is not touched by any of this.

The bucket was created through Cloudflare's API without a location, and Cloudflare placed it in Eastern North
America. It is empty: to keep files in Europe, delete it and create it again before the first deploy with
`npx wrangler r2 bucket create rechbg-media --location weur`.

### Before the first deploy: variables and secrets of the Worker `rechbg`

Set them in the dashboard (Workers → rechbg → Settings → Variables and Secrets) or with
`npx wrangler secret put NAME -c wrangler.rechbg.jsonc`. `docs/DEPLOYMENT.md` section 2 says what each is for.

- **The site**: `SITE_URL` (the Worker's workers.dev address while it is tried out; `https://rechbg.com` at the
  switch), `COMPANY_NAME`, `COMPANY_ADDRESS`, `COMPANY_ID` (ЕИК), `ADMIN_EMAILS`. `CONTACT_EMAIL` is in the config.
- **Its own secrets, new values** (never Hookstreak's): `TRIAL_HASH_SECRET`, `TOKEN_ENCRYPTION_KEY`
  (`openssl rand -base64 32`), `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` (a Turnstile widget for the site's
  address).
- **Stripe, Реч БГ's account**: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (an endpoint at
  `${SITE_URL}/api/billing/webhook` with the events in `docs/DEPLOYMENT.md` section 3) and the eight price IDs below.
  Tax and the billing address are always collected on Реч БГ; `STRIPE_AUTOMATIC_TAX` is not needed.
- **AI services** (the same accounts as Hookstreak, or separate ones to tell the costs apart): `FAL_KEY`,
  `ELEVENLABS_API_KEY`, and `HEYGEN_API_KEY` for presenters.
- **Posting**: `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (YouTube), `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`,
  `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`: each app must list Реч БГ's address as a redirect address, and Google
  must verify the app for the new domain before everyone can connect YouTube. Until then leave `SOCIAL_OPEN` unset.
- **Switches**, when everything above is in place: `REGISTRATION_ENABLED`, `BILLING_ENABLED`, `MEDIA_ENABLED`.

### Prices in euro

`scripts/stripe-prices-rechbg.mjs` makes the four products (Реч БГ · Начало, Създател, Про, Студио) with a monthly and
a yearly price each: €19, €35, €59 and €149 a month, ten months' price a year, VAT included
(`tax_behavior: inclusive`). Run it with the secret key of Реч БГ's Stripe account, a test key first:

```bash
STRIPE_SECRET_KEY=sk_test_… node scripts/stripe-prices-rechbg.mjs
```

```bash
STRIPE_SECRET_KEY=sk_test_… node scripts/stripe-prices-rechbg.mjs --create
```

Without `--create` it only shows what exists and what is missing. It prints the eight variables
(`STRIPE_PRICE_STARTER` … `STRIPE_PRICE_STUDIO_YEARLY`) with their price IDs: set them on the Worker `rechbg`. It can
be run again: a price that exists is left alone. Credit packs need no products (€8, €28 and €90 are charged with
inline prices). Set the customer portal up as `docs/DEPLOYMENT.md` section 3 describes.

### The switch to rechbg.com

Set `SITE_URL` to `https://rechbg.com`, uncomment the route in `wrangler.rechbg.jsonc`, remove the route from the
earlier Реч БГ's own config (or its next deploy takes the domain back), move the Stripe webhook to the new address
and deploy. Accounts and files of the earlier app are not carried over.

## Still to do

- **Legal pages: open questions.** The texts are in place (see "Legal pages" above); `docs/LEGAL-BG.md` lists what
  the owner or a lawyer still has to decide.
- **The administrators' screens** and the e-mails to administrators: left in English on purpose.
- **The libraries** (music, sound effects, voices, example videos, presenters, background clips): Реч БГ's database
  starts empty, so they are added in its Admin screens or copied from Hookstreak's.
- **Messages for failed work** written into a video's record by the server (why a video could not be made) are
  translated only where the catalog happens to have them.
- **The first deploy and the switch**: the steps under "Deployment".
