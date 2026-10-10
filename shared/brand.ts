// The product's own name and wording in one place, so renaming it is a one-file change (plus index.html and
// public/favicon.svg). Never a third party's brand.
export const PRODUCT = {
  name: "Hookstreak Shorts",
  /** The wordmark's two parts: the family name and this product's own word (shown in lime). */
  family: "Hookstreak",
  product: "Shorts",
  /** For machine names: the MCP server, file names. */
  slug: "hookstreak-shorts",
  tagline: "Faceless videos that post themselves",
  pitch:
    "Pick a niche, a voice and an art style once. Hookstreak Shorts writes, narrates, illustrates and subtitles a new short video for every slot in your schedule and posts it to TikTok, YouTube Shorts and Instagram Reels.",
} as const;
