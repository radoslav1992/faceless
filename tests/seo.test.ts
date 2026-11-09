import { describe, expect, it } from "vitest";
import worker from "../server/index";
import { documentPath } from "../server/pages";
import { render, routes } from "../src/prerender";
import { faqPage } from "../shared/faq-page";
import { plans } from "../shared/plans";
import { publicPages } from "../shared/seo";
import { jsonLd, structuredData } from "../shared/structured-data";
import { templates, tools } from "../shared/templates";
import { toolPageCopy } from "../shared/tool-pages";
import { testEnv } from "./helpers";

const ORIGIN = "https://app.test";
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");

describe("public pages for crawlers", () => {
  it("renders every public page to HTML with its own heading and words, nothing left loading", async () => {
    expect(routes).toEqual(Object.keys(publicPages));
    for (const route of routes) {
      const html = await render(route);
      expect(html, route).toMatch(/<h1[\s>]/);
      expect(text(html), route).not.toContain("Loading…");
      expect(text(html), route).not.toContain("Page not found");
    }
    // A tool page carries its own words: how it works, ideas to start from and its questions.
    const history = text(await render("/tools/history-video"));
    expect(history).toContain("AI history video generator");
    for (const line of [toolPageCopy.history!.intro, ...toolPageCopy.history!.ideas, ...toolPageCopy.history!.faq.map(([q]) => q)]) expect(history).toContain(line);
    expect(history).toContain("More video tools");
  }, 60_000);

  it("gives every tool page its own words, ideas and questions, under a unique address", () => {
    expect(tools.length).toBe(18);
    expect(new Set(tools.map((t) => t.slug)).size).toBe(tools.length);
    for (const t of tools) {
      const copy = toolPageCopy[t.id];
      expect(copy, t.id).toBeDefined();
      expect(copy!.intro.length, t.id).toBeGreaterThan(150);
      expect(copy!.ideas, t.id).toHaveLength(6);
      expect(copy!.faq.length, t.id).toBeGreaterThanOrEqual(2);
      // Ideas start from the template's own examples, so the page and Create suggest the same topics.
      if (t.id !== "script") expect(copy!.ideas.slice(0, 3), t.id).toEqual([...templates[t.id].examples]);
      expect(publicPages[`/tools/${t.slug}`]?.title, t.id).toContain(t.title);
    }
  });

  it("serves a public page's prerendered document and the app shell for everything else", async () => {
    expect(documentPath("/")).toBe("/_pages/");
    expect(documentPath("/tools/history-video")).toBe("/_pages/tools/history-video/");
    expect(documentPath("/tools/history-video/")).toBe("/_pages/tools/history-video/");
    expect(documentPath("/pricing")).toBe("/_pages/pricing/");
    for (const path of ["/app", "/app/videos", "/login", "/tools/no-such-tool", "/nothing-here"]) expect(documentPath(path), path).toBeNull();
    // The prerendered files are not pages of their own.
    expect(documentPath("/_pages/tools/history-video/")).toBe("/");
    const { env } = testEnv();
    const asked: string[] = [];
    env.ASSETS = { fetch: async (r: Request) => { asked.push(new URL(r.url).pathname); return new Response("<!doctype html><title>app</title>", { headers: { "Content-Type": "text/html" } }); } };
    const get = (path: string) => worker.fetch(new Request(`${ORIGIN}${path}`), env, { waitUntil: () => {}, passThroughOnException: () => {} } as any);
    expect((await get("/tools/history-video")).status).toBe(200);
    expect((await get("/app/videos")).status).toBe(200);
    expect((await get("/_pages/tools/history-video/")).status).toBe(404);
    expect(asked).toEqual(["/_pages/tools/history-video/", "/app/videos", "/"]);
  });

  it("lists every public page in the sitemap", async () => {
    const { env } = testEnv();
    const xml = await (await worker.fetch(new Request(`${ORIGIN}/sitemap.xml`), env, { waitUntil: () => {}, passThroughOnException: () => {} } as any)).text();
    for (const route of routes) expect(xml, route).toContain(`<loc>${ORIGIN}${route}</loc>`);
  });
});

describe("structured data", () => {
  it("describes the product with each plan's monthly price on the home and pricing pages", () => {
    const home = structuredData("/", ORIGIN);
    expect(home.map((t) => t["@type"])).toEqual(["WebSite", "Organization", "SoftwareApplication"]);
    const product = home[2] as { offers: { name: string; price: string; priceCurrency: string }[] };
    expect(product.offers).toEqual(plans.map((p) => expect.objectContaining({ name: p.name, price: String(p.monthly), priceCurrency: "USD" })));
    expect(structuredData("/pricing", ORIGIN).map((t) => t["@type"])).toEqual(["SoftwareApplication", "BreadcrumbList"]);
  });

  it("gives the FAQ page and every tool page their questions, and a tool page its place on the site", () => {
    const [faq] = structuredData("/faq", ORIGIN) as { "@type": string; mainEntity: { name: string; acceptedAnswer: { text: string } }[] }[];
    expect(faq["@type"]).toBe("FAQPage");
    expect(faq.mainEntity.map((q) => [q.name, q.acceptedAnswer.text])).toEqual(faqPage);
    for (const t of tools) {
      const [trail, questions] = structuredData(`/tools/${t.slug}`, ORIGIN) as any[];
      expect(trail.itemListElement.map((i: any) => [i.name, i.item]), t.id).toEqual([["Home", `${ORIGIN}/`], ["Video tools", `${ORIGIN}/tools`], [t.title, `${ORIGIN}/tools/${t.slug}`]]);
      expect(questions.mainEntity.map((q: any) => q.name), t.id).toEqual(toolPageCopy[t.id]!.faq.map(([q]) => q));
    }
  });

  it("has none for pages that aren't public, and can't be broken out of its script element", () => {
    for (const path of ["/app", "/login", "/nothing-here", "/tools/no-such-tool"]) expect(structuredData(path, ORIGIN), path).toEqual([]);
    const written = jsonLd({ "@type": "Thing", name: "</script><script>alert(1)</script>" });
    expect(written).not.toContain("</script");
    expect(JSON.parse(written).name).toBe("</script><script>alert(1)</script>");
  });
});
