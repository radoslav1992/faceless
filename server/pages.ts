import { Hono } from "hono";
import type { Env } from "./types";
import { origin } from "./security";
import { pageMeta, publicPages } from "../shared/seo";
import { jsonLd, structuredData } from "../shared/structured-data";
import { PRODUCT } from "../shared/brand";

/** Crawler files and the single-page app document with per-page metadata. */
export const pages = new Hono<{ Bindings: Env }>();
pages.get("/robots.txt", (c) =>
  c.text(`User-agent: *\nAllow: /\nDisallow: /app\nDisallow: /api\nDisallow: /reset\nDisallow: /verify\nSitemap: ${origin(c.env, c.req.raw)}/sitemap.xml\n`),
);
pages.get("/sitemap.xml", (c) => {
  const base = origin(c.env, c.req.raw);
  const urls = Object.entries(publicPages).map(([path, page]) => `<url><loc>${base}${path}</loc><lastmod>${page.updated}</lastmod></url>`).join("");
  return c.body(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`, 200, {
    "Content-Type": "application/xml; charset=utf-8",
  });
});
// The installable app's files (index.html links them): the service worker is always checked for a new version and may
// control the whole site; the manifest has its own type; the offline page is a file of its own, never the app.
pages.get("/sw.js", async (c) => {
  const r = await c.env.ASSETS.fetch(c.req.raw);
  const out = new Response(r.body, r);
  out.headers.set("Content-Type", "text/javascript; charset=utf-8");
  out.headers.set("Cache-Control", "no-cache");
  out.headers.set("Service-Worker-Allowed", "/");
  return out;
});
pages.get("/manifest.webmanifest", async (c) => {
  const r = await c.env.ASSETS.fetch(c.req.raw);
  const out = new Response(r.body, r);
  out.headers.set("Content-Type", "application/manifest+json; charset=utf-8");
  out.headers.set("Cache-Control", "public, max-age=3600");
  return out;
});
pages.get("/offline.html", (c) => c.env.ASSETS.fetch(c.req.raw));
const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
/** Where a page's document comes from: a public page's own HTML, rendered at build (scripts/prerender.mjs writes it
 *  to dist/_pages/<route>/index.html), so its words are there for crawlers that run no JavaScript; every other path
 *  gets the app shell. Without a prerendered file (local development), the assets' single-page fallback answers with
 *  the shell too. The prerendered files themselves are not pages of the site. */
export function documentPath(path: string): string | null {
  const meta = pageMeta(path);
  if (meta.indexable && meta.route) return `/_pages${meta.route === "/" ? "" : meta.route}/`;
  return path === "/_pages" || path.startsWith("/_pages/") ? "/" : null;
}
pages.get("*", async (c) => {
  const meta = pageMeta(c.req.path);
  const from = documentPath(c.req.path);
  const r = await c.env.ASSETS.fetch(from ? new Request(new URL(from, c.req.url), c.req.raw) : c.req.raw);
  if (!r.headers.get("content-type")?.includes("text/html")) return r;
  const base = origin(c.env, c.req.raw);
  const url = base + (meta.route || c.req.path);
  const image = `${base}/og-image.png`;
  const head = meta.indexable
    ? [
        `<link rel="canonical" href="${escapeAttr(url)}">`,
        `<meta property="og:type" content="website">`,
        `<meta property="og:site_name" content="${escapeAttr(PRODUCT.name)}">`,
        `<meta property="og:title" content="${escapeAttr(meta.title)}">`,
        `<meta property="og:description" content="${escapeAttr(meta.description)}">`,
        `<meta property="og:url" content="${escapeAttr(url)}">`,
        `<meta property="og:image" content="${escapeAttr(image)}">`,
        `<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">`,
        `<meta name="twitter:card" content="summary_large_image">`,
        `<meta name="twitter:image" content="${escapeAttr(image)}">`,
        ...structuredData(c.req.path, base).map((thing) => `<script type="application/ld+json">${jsonLd(thing)}</script>`),
      ].join("")
    : '<meta name="robots" content="noindex,nofollow">';
  // HTMLRewriter is part of the Workers runtime; outside it (tests) the document is served unchanged.
  const rewritten = typeof HTMLRewriter === "undefined" ? r : new HTMLRewriter()
    .on("title", { element(el) { el.setInnerContent(meta.title); } })
    .on('meta[name="description"]', { element(el) { el.setAttribute("content", meta.description); } })
    .on("head", { element(el) { el.append(head, { html: true }); } })
    .transform(r);
  // Unknown paths still render the app's not-found page, with a real 404 status for crawlers.
  return meta.route ? rewritten : new Response(rewritten.body, { status: 404, headers: rewritten.headers });
});
