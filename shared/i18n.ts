import { bg } from "./locales/bg";

// The words of the other site. The code is written in English, and English is also the key: `t("Create video")`
// answers with the Bulgarian for it on Реч БГ and with the text itself on Hookstreak, where no catalog is loaded and
// nothing changes. The interface is translated without touching the screens: on Реч БГ the JSX runtime
// (src/i18n/jsx-runtime.ts) passes every piece of text an element shows through `t`. Call `t` by hand only for
// text that is not shown by an element (a page title, an email, a confirm dialog) and `localized` for data whose
// words are used as values. A text without a translation stays in English, and `untranslated` lists it.
declare const __SITE__: string | undefined;

/** What a locale file holds. */
export type Words = {
  /** English text to its translation. */
  exact: Readonly<Record<string, string>>;
  /**
   * Texts with changing parts, written as the code has them with `{1}`, `{2}`… for the parts:
   * "{1} credits left" to "остават {1} кредита".
   */
  templates?: Readonly<Record<string, string>>;
  /** For what neither covers, tried first: `$1`… are the pattern's groups. */
  patterns?: readonly (readonly [RegExp, string])[];
};
/** A text with changing parts, ready to match: `parts[i]` is the number the template gave the pattern's group i + 1. */
type Template = { pattern: RegExp; words: string; parts: readonly string[]; grammar: ReadonlySet<string> };
export type Catalog = { exact: Readonly<Record<string, string>>; patterns: readonly (readonly [RegExp, string])[]; templates: readonly Template[] };

const PART = /\{(\d+)\}/g;
const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, (character) => "\\" + character);
/** A locale's words ready to look up: its templates become patterns, those with more fixed words tried first. */
export function catalogOf(words: Words): Catalog {
  const fixed = (template: string) => template.replace(PART, "").length;
  const templates = Object.entries(words.templates ?? {})
    .sort((a, b) => fixed(b[0]) - fixed(a[0]))
    .map(([template, said]): Template => {
      const found = [...template.matchAll(PART)];
      // A part glued to the end of a word is English grammar (the "s" of "credit{2}"): matched, even when empty, and left out.
      const grammar = new Set(found.filter((match) => /[A-Za-z]/.test(template[match.index - 1] ?? "")).map((match) => match[1]));
      const source = template.split(/(\{\d+\})/)
        .map((piece) => (/^\{\d+\}$/.test(piece) ? (grammar.has(piece.slice(1, -1)) ? "([\\s\\S]*?)" : "([\\s\\S]+?)") : literal(piece))).join("");
      return { pattern: new RegExp("^" + source + "$"), words: said, parts: found.map((match) => match[1]), grammar };
    });
  return { exact: words.exact, patterns: words.patterns ?? [], templates };
}
// The comparison is on the build's constant itself, so Hookstreak's bundles drop the catalog.
const siteCatalog: Catalog | null = typeof __SITE__ === "string" && __SITE__ === "rechbg" ? catalogOf(bg) : null;

const misses = new Set<string>();
/** Texts that were shown without a translation since the page loaded (how the catalog is filled: docs/SITES.md). */
export const untranslated = () => [...misses].sort();
/** Whether a text is worth reporting: it has words in Latin letters and is not a code, an address or a file name. */
const reportable = (s: string) => /[A-Za-z]{2}/.test(s) && !/[Ѐ-ӿ]/.test(s) && !/^[\w.+-]+@[\w.-]+$|^https?:|^[A-Z0-9_]+$|^\/|^[a-z0-9-]+$/.test(s);

/** A catalog's translator. Spaces around a text are kept, so a piece of a sentence still fits its neighbours. */
export function translator(catalog: Catalog | null, missed?: (text: string) => void) {
  // The same texts are asked for on every render: what each came to (itself, without a translation) is kept.
  const known = new Map<string, string>();
  /** The translation of a text, or undefined. A template's changing parts are translated too where they have words of their own (a plan's name). */
  const find = (core: string, depth: number): string | undefined => {
    if (Object.hasOwn(catalog!.exact, core)) return catalog!.exact[core];
    for (const { pattern, words, parts, grammar } of catalog!.templates) {
      const match = pattern.exec(core);
      if (!match) continue;
      return words.replace(PART, (_, n: string) => {
        if (grammar.has(n)) return "";
        const part = match[parts.indexOf(n) + 1] ?? "";
        return (depth < 2 ? find(part.trim(), depth + 1) : undefined) ?? part;
      });
    }
    // Last, the catch-all patterns ("Show …"): a template written for the very text comes before them.
    for (const [pattern, replacement] of catalog!.patterns) if (pattern.test(core)) return core.replace(pattern, replacement);
    return undefined;
  };
  return (text: string): string => {
    if (!catalog || !text) return text;
    const core = text.trim();
    if (!core) return text;
    let said = known.get(core);
    if (said === undefined) {
      const found = find(core, 0);
      if (found === undefined && reportable(core)) missed?.(core);
      said = found ?? core;
      if (known.size < 20000) known.set(core, said);
    }
    const words = said;
    return words === core ? text : core === text ? words : text.replace(core, () => words);
  };
}
/** The text in this site's language: itself on Hookstreak. */
export const t = translator(siteCatalog, (text) => misses.add(text));
/** A copy of data (lists and records of texts: plans, templates, pages) in this site's language. Hookstreak gets the data itself. */
export function localized<T>(value: T): T {
  if (!siteCatalog) return value;
  if (typeof value === "string") return t(value) as T;
  if (Array.isArray(value)) return value.map((item) => localized(item)) as T;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype)
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, localized(item)])) as T;
  return value;
}
/** An e-mail in this site's language: its subject and each of its lines (server/security.ts sendMail). */
export const mailWords = (subject: string, text: string) => (siteCatalog ? { subject: t(subject), text: text.split("\n").map(t).join("\n") } : { subject, text });
