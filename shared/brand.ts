// The product's own name and wording in one place, so renaming it is a one-file change (plus index.html and
// public/favicon.svg). Never a third party's brand.
declare const __SITE__: string | undefined;

const hookstreak = {
  name: "Hookstreak Shorts",
  /** The wordmark's two parts: the family name and this product's own word (shown in lime). */
  family: "Hookstreak",
  product: "Shorts",
  /** For machine names: the MCP server, file names. */
  slug: "hookstreak-shorts",
  tagline: "Faceless videos on autopilot",
  pitch:
    "Pick a niche, a voice and an art style once. Hookstreak Shorts writes, narrates, illustrates and subtitles a new short video for every slot in your schedule, ready for TikTok, YouTube Shorts and Instagram Reels, and posts it straight to YouTube. Posting to TikTok and Instagram is coming soon.",
};
/** Реч БГ: Hookstreak in Bulgarian (shared/site.ts). */
const rechbg: typeof hookstreak = {
  name: "Реч БГ", family: "Реч", product: "БГ", slug: "rech-bg",
  tagline: "Видеа без лице на автопилот",
  pitch:
    "Изберете ниша, глас и стил на картините веднъж. Реч БГ пише, озвучава, илюстрира и поставя субтитри на ново кратко видео за всеки час от вашия график, готово за TikTok, YouTube Shorts и Instagram Reels, и го публикува направо в YouTube. Публикуването в TikTok и Instagram предстои скоро.",
};
export const PRODUCT: Readonly<typeof hookstreak> = typeof __SITE__ === "string" && __SITE__ === "rechbg" ? rechbg : hookstreak;
