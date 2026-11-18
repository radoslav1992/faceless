import { bg } from "./locales/bg";

// The words of the other site. The code is written in English, and English is also the key: `t("Create video")`
// answers with the Bulgarian for it on Реч БГ and with the text itself on Hookstreak, where no catalog is loaded and
// nothing changes. The interface is translated without touching the screens: on Реч БГ the JSX runtime
// (src/i18n/jsx-runtime.ts) passes every piece of text an element shows through `t`. Call `t` by hand only for
// text that is not shown by an element (a page title, an email, a confirm dialog) and `localized` for data whose
// words are used as values. A text without a translation stays in English, and `untranslated` lists it.
declare const __SITE__: string | undefined;

export type Catalog = {
  /** English text to its translation. */
  exact: Readonly<Record<string, string>>;
  /** Texts with a changing part, tried in order when there is no exact entry: `$1`… are the pattern's groups. */
  patterns: readonly (readonly [RegExp, string])[];
};
// The comparison is on the build's constant itself, so Hookstreak's bundles drop the catalog.
const siteCatalog: Catalog | null = typeof __SITE__ === "string" && __SITE__ === "rechbg" ? bg : null;

const misses = new Set<string>();
/** Texts that were shown without a translation since the page loaded (how the catalog is filled: docs/SITES.md). */
export const untranslated = () => [...misses].sort();
/** Whether a text is worth reporting: it has words in Latin letters and is not a code, an address or a file name. */
const reportable = (s: string) => /[A-Za-z]{2}/.test(s) && !/[\u0400-\u04FF]/.test(s) && !/^[\w.+-]+@[\w.-]+$|^https?:|^[A-Z0-9_]+$|^\/|^[a-z0-9-]+$/.test(s);

/** A catalog's translator. Spaces around a text are kept, so a piece of a sentence still fits its neighbours. */
export function translator(catalog: Catalog | null, missed?: (text: string) => void) {
  return (text: string): string => {
    if (!catalog || !text) return text;
    const core = text.trim();
    if (!core) return text;
    let found: string | undefined = Object.hasOwn(catalog.exact, core) ? catalog.exact[core] : undefined;
    if (found === undefined) {
      for (const [pattern, replacement] of catalog.patterns) {
        if (pattern.test(core)) { found = core.replace(pattern, replacement); break; }
      }
    }
    if (found === undefined) { if (reportable(core)) missed?.(core); return text; }
    const words = found;
    return core === text ? words : text.replace(core, () => words);
  };
}
/** The text in this site's language: itself on Hookstreak. */
export const t = translator(siteCatalog, (text) => misses.add(text));
const catalog = siteCatalog;
/** A copy of data (lists and records of texts: plans, templates, pages) in this site's language. Hookstreak gets the data itself. */
export function localized<T>(value: T): T {
  if (!catalog) return value;
  if (typeof value === "string") return t(value) as T;
  if (Array.isArray(value)) return value.map((item) => localized(item)) as T;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype)
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, localized(item)])) as T;
  return value;
}
