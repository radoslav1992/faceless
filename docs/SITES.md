# Two sites from one codebase

This repository is Hookstreak Shorts. The same code also builds a second site: **Реч БГ**, Hookstreak in Bulgarian,
with its own name, logo, currency, database, storage and Stripe account. Hookstreak is the default and does not
change: a build without `SITE=rechbg` renders the pages it always did.

Status: Реч БГ builds (`npm run build:rechbg`) with the public pages and the app in Bulgarian, its name and logo, and
prices in euro. It is not deployed yet. What is left is under "Still to do".

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

## Still to do

- **Legal pages** (`src/public/Legal.tsx`, terms and privacy policy): still English on Реч БГ. They need Bulgarian
  texts for this product and the Bulgarian company, reviewed by the owner.
- **E-mails** the server sends (confirmation, password reset, the consent confirmation after checkout, "your video is
  ready", reconnect a channel): still English.
- **The administrators' screens**: left in English on purpose.
- **Checkout on Реч БГ**: the currency follows the site; the Bulgarian checkout language and always collecting tax
  and address are still to set (`server/billing.ts`).
- **Deployment**: Реч БГ's wrangler config with its own database, bucket, workflows, renderer and secrets; eight
  Stripe prices in euro; then the domain.
- The shared libraries (music, sound effects, voices, example videos) for Реч БГ's own database.
