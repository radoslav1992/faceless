# Two sites from one codebase

This repository is Hookstreak Shorts. The same code also builds a second site: **Реч БГ**, Hookstreak in Bulgarian,
with its own name, logo, currency, database, storage and Stripe account. Hookstreak is the default and does not
change: a build without `SITE=rechbg` renders the pages it always did.

Status: Реч БГ builds (`npm run build:rechbg`) with the public pages, the app, the legal pages and the e-mails in
Bulgarian, its name and logo, and prices in euro. Its database and bucket exist; it is not deployed yet: the
first deploy replaces the earlier Реч БГ app. What is left
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

Реч БГ deploys into the Worker the earlier Реч БГ app ran in, `rech-bg` (`wrangler.rechbg.jsonc`), because that
Worker holds the site's variables and secrets and Cloudflare cannot copy a secret to another Worker. Its data is new
and its own; nothing is shared with Hookstreak.

| | Hookstreak (`wrangler.jsonc`) | Реч БГ (`wrangler.rechbg.jsonc`) |
| --- | --- | --- |
| Worker | `faceless` | `rech-bg` (the earlier app's Worker, with its variables and secrets) |
| Site switch (`define`) | `__SITE__` = `hookstreak` | `__SITE__` = `rechbg` |
| Database (D1) | `faceless` | `rechbg`, `1124cf5a-4c90-4a18-9c31-552a2fe8a689`, Western Europe, created empty 2026-11-18 |
| Bucket (R2) | `faceless-media` | `rechbg-media`, created empty 2026-11-18 (Eastern North America, as Hookstreak's) |
| Workflows | `faceless-content`, `faceless-publish` | `rechbg-content`, `rechbg-publish` |
| Renderer (Durable Object migration) | `renderer-v1` | `media-v1`: the class exists in that Worker since the earlier app |
| App files | `dist` | `dist-rechbg` |
| Address | hookstreak.app | rechbg.com |
| Deploy | every push to `main` (Actions → Deploy) | every push to the branch `rechbg` (Actions → Deploy Реч БГ), which can also be run by hand; or `npm run deploy:rechbg` |

**The branch `rechbg` is Реч БГ's release.** It does not exist until the site is ready to go live: creating it from
`main` is the first deploy. After that, Реч БГ is updated by merging `main` into `rechbg` (a pull request from `main`
to `rechbg`, or `git push origin main:rechbg` when it fast-forwards). A merge to `main` alone never touches Реч БГ,
which leaves time to translate the texts a change added (`node scripts/extract-texts.mjs --missing`) before it
reaches the Bulgarian site.

**The first deploy replaces the earlier app at rechbg.com at once.** There is no separate address to try it on
first. Accounts, projects and files of the earlier app are not carried over: its database (`rech-bg`) and bucket
(`rech-bg-audio`) are no longer bound and stay where they are until they are deleted by hand.

### What the Worker already has (checked in the dashboard on 2026-11-18)

Read by the new code under the same names, so nothing to do:

- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (the webhook's address stays `https://rechbg.com/api/billing/webhook`),
  `FAL_KEY`, `ELEVENLABS_API_KEY`, `HEYGEN_API_KEY`, `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`.
- `ADMIN_EMAILS`, `COMPANY_ADDRESS`, `COMPANY_ID` (shown as ЕИК), `EMAIL_FROM`.
- `REGISTRATION_ENABLED`, `BILLING_ENABLED`, `MEDIA_ENABLED`, all `true`.

`SITE_URL`, `CONTACT_EMAIL` and `COMPANY_NAME` were defaults in the earlier app's code; they are in
`wrangler.rechbg.jsonc` now, with the same values.

### Before the first deploy

1. **Stop the earlier app's own deploys.** The Worker is connected to the earlier repository (Workers → rech-bg →
   Settings → Build). Disconnect it, or the next push there puts the earlier app back.
2. **Set `BILLING_ENABLED` to `false`** until the euro prices below are in place: the three price IDs the Worker has
   are the earlier plans', which the new checkout refuses.
3. **The eight euro prices** (next section): `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_DAILY`, `STRIPE_PRICE_DOUBLE`,
   `STRIPE_PRICE_STUDIO` and the four `…_YEARLY`. `STRIPE_PRICE_STARTER` and `STRIPE_PRICE_STUDIO` exist with the
   earlier prices and get new values.
4. **`TOKEN_ENCRYPTION_KEY`** (`openssl rand -base64 32`, as a secret): needed before a channel can be connected
   and for the API's download links. Never change it afterwards.
5. **`TRIAL_HASH_SECRET`** (a long random string, as a secret): recommended. Without it the "one free trial per
   mailbox" record is a plain hash of the address.
6. **`HEYGEN_API_KEY` is stored as a plain variable.** Change its type to Secret (Edit → type Secret, same value), so
   the key is not readable in the dashboard.
7. **The deploy token**: the repository's `CLOUDFLARE_API_TOKEN` must also be allowed to edit D1 and the
   `rechbg.com` zone.
8. In Stripe, check that the webhook endpoint sends the events in `docs/DEPLOYMENT.md` section 3, and set the
   customer portal up as described there.

After everything works: the earlier app's variables the new code does not read can be deleted
(`STRIPE_PRICE_CREATOR`, `VIDEO_MEDIUM`, `VIDEO_PROVIDER`, `WAVESPEED_API_KEY`).

Posting to channels needs each network's app (`GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` for YouTube,
`TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`, `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`), with rechbg.com as a
redirect address; Google must verify the app for the domain before everyone can connect YouTube. Until then leave
`SOCIAL_OPEN` unset: the Channels page says "coming soon".

### Prices in euro

`scripts/stripe-prices-rechbg.mjs` makes the four products (Реч БГ · Начало, Създател, Про, Студио) with a monthly and
a yearly price each: €19, €35, €59 and €149 a month, ten months' price a year, VAT included
(`tax_behavior: inclusive`). Run it with a secret key of Реч БГ's Stripe account, a test key first:

```bash
STRIPE_SECRET_KEY=sk_test_… node scripts/stripe-prices-rechbg.mjs
```

```bash
STRIPE_SECRET_KEY=sk_test_… node scripts/stripe-prices-rechbg.mjs --create
```

Without `--create` it only shows what exists and what is missing. It prints the eight variables with their price
IDs: set them on the Worker. It can be run again: a price that exists is left alone. Credit packs need no products
(€8, €28 and €90 are charged with inline prices). The same prices can be made by hand in Stripe's dashboard instead:
one product per plan, two recurring prices in EUR with "include tax in price".

## The library

Реч БГ's database starts empty, so it takes Hookstreak's library: music, sound effects, background clips and
pictures, voices, presenters and example videos. `server/library-import.ts` copies the rows into Реч БГ's database
and their files into its bucket, twelve files' worth every five minutes from the scheduled maintenance, until all of
it is there; after that the same pass brings whatever Hookstreak adds.

- Hookstreak's database and bucket are bound to Реч БГ's Worker for this alone (`HOOKSTREAK_DB`,
  `HOOKSTREAK_MEDIA` in `wrangler.rechbg.jsonc`) and are only read. Hookstreak's own Worker has no such bindings and
  never runs the import.
- **It only adds.** A copied item is Реч БГ's own: renaming, hiding or deleting it there is not undone, and a change
  or removal in Hookstreak does not reach it. An example video is copied only for a style that has none.
- Not copied: sound effects made for one person's video or still waiting for review, an item whose file is gone,
  and voices' samples.
- A voice or a presenter works on Реч БГ when its ElevenLabs or HeyGen account can use it: with the same API keys as
  Hookstreak they all do.
- The example videos are Hookstreak's, in English. Replace them in Admin → Examples as Bulgarian ones are made.

## Still to do

- **Legal pages: open questions.** The texts are in place (see "Legal pages" above); `docs/LEGAL-BG.md` lists what
  the owner or a lawyer still has to decide.
- **The administrators' screens** and the e-mails to administrators: left in English on purpose.
- **Voice samples**: voices arrive from Hookstreak without their English sample. Admin → Voices makes the missing
  ones, spoken in Bulgarian (it uses ElevenLabs characters).
- **Bulgarian names** for the copied library: the items keep Hookstreak's English names, tags and categories until
  they are edited in Admin → Library.
- **Messages for failed work** written into a video's record by the server (why a video could not be made) are
  translated only where the catalog happens to have them.
- **The first deploy and the switch**: the steps under "Deployment".
