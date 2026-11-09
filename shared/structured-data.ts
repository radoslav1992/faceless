import { PRODUCT } from "./brand";
import { plans } from "./plans";
import { faqPage } from "./faq-page";
import { pageMeta } from "./seo";
import { toolBySlug } from "./templates";
import { toolPageCopy } from "./tool-pages";

// Schema.org structured data (JSON-LD) for the public pages, which the Worker puts into each page's HTML so search
// engines and AI assistants can read what the product is, what it costs, where a page sits on the site and the
// questions it answers. Only what the pages themselves show. Kept apart from shared/seo.ts, which the app's entry
// bundle loads, so the FAQ text stays out of it.

type Thing = Record<string, unknown>;
const context = "https://schema.org";

const faq = (items: readonly (readonly [string, string])[]): Thing => ({
  "@context": context, "@type": "FAQPage",
  mainEntity: items.map(([q, a]) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })),
});
const breadcrumbs = (origin: string, trail: [string, string][]): Thing => ({
  "@context": context, "@type": "BreadcrumbList",
  itemListElement: trail.map(([name, path], i) => ({ "@type": "ListItem", position: i + 1, name, item: origin + path })),
});
/** The product with each plan's monthly price (the free trial included), as the pricing page shows them. */
const product = (origin: string): Thing => ({
  "@context": context, "@type": "SoftwareApplication", name: PRODUCT.name, url: `${origin}/`,
  applicationCategory: "MultimediaApplication", operatingSystem: "Web", description: PRODUCT.pitch,
  offers: plans.map((p) => ({ "@type": "Offer", name: p.name, price: String(p.monthly), priceCurrency: "USD", url: `${origin}/pricing` })),
});

/** The structured data of a public page (none for any other path), each item one JSON-LD document. */
export function structuredData(path: string, origin: string): Thing[] {
  const meta = pageMeta(path);
  if (!meta.indexable || !meta.route) return [];
  const route = meta.route;
  if (route === "/") {
    return [
      { "@context": context, "@type": "WebSite", name: PRODUCT.name, url: `${origin}/` },
      { "@context": context, "@type": "Organization", name: PRODUCT.name, url: `${origin}/`, logo: `${origin}/icons/icon-512.png` },
      product(origin),
    ];
  }
  if (route === "/pricing") return [product(origin), breadcrumbs(origin, [["Home", "/"], ["Pricing", "/pricing"]])];
  if (route === "/faq") return [faq(faqPage), breadcrumbs(origin, [["Home", "/"], ["FAQ", "/faq"]])];
  if (route === "/tools") return [breadcrumbs(origin, [["Home", "/"], ["Video tools", "/tools"]])];
  const tool = route.startsWith("/tools/") ? toolBySlug(route.slice("/tools/".length)) : undefined;
  if (tool) {
    const copy = toolPageCopy[tool.id];
    return [
      breadcrumbs(origin, [["Home", "/"], ["Video tools", "/tools"], [tool.title, route]]),
      ...(copy ? [faq(copy.faq)] : []),
    ];
  }
  return [];
}
/** A JSON-LD document as script-safe text: "<" is escaped, so no text inside can close the script element. */
export const jsonLd = (thing: Thing) => JSON.stringify(thing).replace(/</g, "\\u003c");
