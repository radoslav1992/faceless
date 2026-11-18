# Two sites from one codebase

This repository is Hookstreak Shorts. It is being made able to build a second site from the same code: **Реч БГ**,
Hookstreak in Bulgarian, with its own name, prices, database, storage and Stripe account. Hookstreak is the default
and does not change: a build without `SITE=rechbg` is the build it always was.

Status: the foundation and the home page's words. The rest is listed under "Still to do".

## How a build knows its site

`SITE=rechbg` when building. `vite.config.ts` (the app and the prerendered pages) and, once it exists, Реч БГ's
wrangler config (the Worker) define the constant `__SITE__`; `shared/site.ts` reads it as `SITE_ID` and `SITE`
(interface language, locale for numbers and dates, the narration language new videos start with). Tests and tools
that do not define it are Hookstreak.

## Words

The code is written in English, and the English text is also the key. `shared/locales/bg.ts` is Реч БГ's catalog:
exact texts, and patterns for texts with a changing part ("12 credits").

- **The interface is translated without touching the screens.** On Реч БГ the JSX import source is `src/i18n`
  (`jsx-runtime.ts`, `jsx-dev-runtime.ts`): React's runtime with the text of every element passed through `t` on the
  way in: string children, and the attributes `placeholder`, `title`, `aria-label` and `alt`. Hookstreak is built
  with React's own runtime and never loads the catalog.
- **A text without a translation stays in English.** Nothing breaks; it is just not translated yet.
- `translate="no"` on an element (the HTML attribute) keeps its text as it is: names, titles and other words people
  typed. Text inside `code`, `pre`, `textarea`, `script` and `style` is never translated.
- **Pieces of sentences.** `<p>You have {n} credits left</p>` reaches the runtime as "You have ", a number and
  " credits left", and each piece has its own entry. Spaces around a piece are kept.
- **By hand**, for words no element shows: `t("…")` (a page title, an e-mail, a confirm dialog) and
  `localized(data)` for lists and records whose words are used as values. Both return what they were given on
  Hookstreak.

### Filling the catalog

`npm run dev:rechbg` runs Реч БГ's build of the app. Every text shown without a translation is collected:
`window.__untranslated()` in the browser's console lists them for the pages visited so far. Translate them into
`shared/locales/bg.ts`, with the key exactly as the code has it.

## Реч БГ's own files

- `src/i18n/rechbg.ts` loads first on Реч БГ only: the heading font (Hookstreak's Bricolage Grotesque has no
  Cyrillic letters, so headings use Manrope), `rechbg.css`, `lang="bg"`.

## Still to do

- The rest of the words: the other public pages, the app, the editor, the admin screens, e-mails, page titles and
  descriptions, the legal pages (Реч БГ has its own Bulgarian texts), messages from the server.
- The name and logo as a setting (`shared/brand.ts`), instead of the catalog entries that stand in for them now.
- Prices and currency per site (`shared/plans.ts`, `server/billing.ts`: Hookstreak charges in US dollars).
- Bulgarian as the narration language new videos and series start with, and Bulgarian examples and topics.
- Реч БГ's build and deployment: prerendered pages in its own folder, its own wrangler config with its own
  database, bucket, workflows and secrets.
