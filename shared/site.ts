// One codebase, two sites: Hookstreak Shorts (English, the default) and Реч БГ (Bulgarian). The site is chosen when
// the app is built (`SITE=rechbg`, see vite.config.ts and wrangler.rechbg.jsonc, which define `__SITE__`); without it
// everything is Hookstreak, exactly as before. docs/SITES.md.
declare const __SITE__: string | undefined;

export type SiteId = "hookstreak" | "rechbg";
/** `typeof` first: tests and tools that do not define it are Hookstreak. */
export const SITE_ID: SiteId = typeof __SITE__ === "string" && __SITE__ === "rechbg" ? "rechbg" : "hookstreak";

const sites = {
  hookstreak: { id: "hookstreak", lang: "en", locale: "en-US", narration: "en" },
  rechbg: { id: "rechbg", lang: "bg", locale: "bg-BG", narration: "bg" },
} as const;
/** This build's site: the interface language, how numbers and dates are written, and the narration language new videos start with. */
export const SITE: { id: SiteId; lang: "en" | "bg"; locale: string; narration: string } = sites[SITE_ID];
