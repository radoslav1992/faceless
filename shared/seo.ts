import { PRODUCT } from "./brand";
import { tools } from "./templates";

// Titles and descriptions per public page; the Worker puts them into the HTML for crawlers and link previews, and the
// app updates them on navigation.
const UPDATED = "2026-10-30";
const toolPages = Object.fromEntries(tools.map((t) => [`/tools/${t.slug}`, { title: `${t.title} — ${PRODUCT.name}`, description: t.description, updated: UPDATED }]));
export const publicPages: Record<string, { title: string; description: string; updated: string }> = {
  "/": { title: `${PRODUCT.name} — ${PRODUCT.tagline}`, description: PRODUCT.pitch, updated: UPDATED },
  "/tools": { title: `AI video tools for faceless creators — ${PRODUCT.name}`, description: "Text to video, scary stories, POV, storytime and brainrot mashups: narrated vertical videos for TikTok, Shorts and Reels.", updated: UPDATED },
  ...toolPages,
  "/styles": { title: `Faceless video styles — ${PRODUCT.name}`, description: "Ready-made faceless video styles and art styles: scary stories, history, fun facts, POV, bedtime stories and more.", updated: UPDATED },
  "/pricing": { title: `Pricing — ${PRODUCT.name}`, description: "Start free. Starter, Creator, Pro and Studio plans for faceless videos on autopilot; unused credits roll over.", updated: UPDATED },
  "/mcp": { title: `MCP connection and API — ${PRODUCT.name}`, description: `Make faceless videos from your AI assistant or your own code with the ${PRODUCT.name} MCP server and REST API.`, updated: UPDATED },
  "/business": { title: `For business — ${PRODUCT.name}`, description: "Run many faceless channels with review, API access and one bill.", updated: UPDATED },
  "/about": { title: `About — ${PRODUCT.name}`, description: `Why ${PRODUCT.name} exists and how it makes videos.`, updated: UPDATED },
  "/faq": { title: `FAQ — ${PRODUCT.name}`, description: `How ${PRODUCT.name} makes faceless videos on your schedule.`, updated: UPDATED },
  "/terms": { title: `Terms of Service — ${PRODUCT.name}`, description: `The terms for using ${PRODUCT.name}.`, updated: UPDATED },
  "/privacy": { title: `Privacy Policy — ${PRODUCT.name}`, description: `How ${PRODUCT.name} handles your data.`, updated: UPDATED },
  "/contact": { title: `Contact — ${PRODUCT.name}`, description: `Questions about ${PRODUCT.name}? Write to us.`, updated: UPDATED },
};
const privatePages: Record<string, string> = {
  "/login": "Sign in",
  "/register": "Create your account",
  "/forgot": "Forgot password",
  "/reset": "Choose a new password",
  "/verify": "Confirm your email",
};
export type PageMeta = { title: string; description: string; route: string | null; indexable: boolean };
/** The page's metadata; `route` is null for paths the app does not know (a real 404). */
export function pageMeta(path: string): PageMeta {
  const clean = path.replace(/\/+$/, "") || "/";
  const page = publicPages[clean];
  if (page) return { title: page.title, description: page.description, route: clean, indexable: true };
  if (privatePages[clean]) return { title: `${privatePages[clean]} — ${PRODUCT.name}`, description: PRODUCT.pitch, route: clean, indexable: false };
  if (clean === "/app" || clean.startsWith("/app/")) return { title: PRODUCT.name, description: PRODUCT.pitch, route: "/app", indexable: false };
  return { title: `Page not found — ${PRODUCT.name}`, description: PRODUCT.pitch, route: null, indexable: false };
}
