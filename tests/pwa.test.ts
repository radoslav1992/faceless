import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import worker from "../server/index";
import { imageInfo } from "../server/storage";
import { call, testEnv } from "./helpers";

// The installable app: a manifest with icons that exist at their stated sizes, the service worker served so browsers
// always check it for updates, and the worker itself, which caches only the site's own static files, answers pages
// from the network (the offline page without one) and never touches the API.

const file = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url));

describe("installable app", () => {
  it("has a manifest with real icons, a start page in its scope, and the page links it", () => {
    const manifest = JSON.parse(file("public/manifest.webmanifest").toString());
    expect(manifest).toMatchObject({ name: "Hookstreak Shorts", start_url: "/app", scope: "/", display: "standalone" });
    for (const icon of manifest.icons) {
      const [w, h] = icon.sizes.split("x").map(Number);
      expect(imageInfo(new Uint8Array(file(`public${icon.src}`)))).toMatchObject({ width: w, height: h, mime: "image/png" });
    }
    expect(manifest.icons.map((i: any) => `${i.sizes} ${i.purpose}`)).toEqual(expect.arrayContaining(["192x192 any", "512x512 any", "512x512 maskable"]));
    expect(imageInfo(new Uint8Array(file("public/apple-touch-icon.png")))).toMatchObject({ width: 180, height: 180 });
    const html = file("index.html").toString();
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
    expect(html).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png" />');
  });

  it("tells readers without scripts what the site is and links the legal pages", () => {
    // Google's app verification checks the home page for a description and links to the terms and privacy policy.
    const fallback = /<noscript>([\s\S]*)<\/noscript>/.exec(file("index.html").toString())?.[1] ?? "";
    expect(fallback).toContain("YouTube");
    for (const path of ["/terms", "/privacy"]) expect(fallback).toContain(`href="${path}"`);
  });

  it("serves the service worker uncached, the manifest with its type, and the offline page as a page of its own", async () => {
    const { env } = testEnv();
    const sw = await call(worker, env, "GET", "/sw.js");
    expect([sw.headers.get("Content-Type"), sw.headers.get("Cache-Control"), sw.headers.get("Service-Worker-Allowed")]).toEqual(["text/javascript; charset=utf-8", "no-cache", "/"]);
    expect((await call(worker, env, "GET", "/manifest.webmanifest")).headers.get("Content-Type")).toBe("application/manifest+json; charset=utf-8");
    // The app answers unknown paths with 404; the offline page must answer 200, or the worker can't install.
    expect((await call(worker, env, "GET", "/offline.html")).status).toBe(200);
    expect((await call(worker, env, "GET", "/no-such-page")).status).toBe(404);
  });

  it("answers pages from the network, the offline page without one, keeps build files and never touches the API", async () => {
    const handlers: Record<string, (e: any) => void> = {};
    const stores = new Map<string, Map<string, Response>>();
    const store = (name: string) => {
      if (!stores.has(name)) stores.set(name, new Map());
      const m = stores.get(name)!;
      return {
        match: async (r: Request | string) => m.get(typeof r === "string" ? new URL(r, "https://app.test").href : r.url)?.clone(),
        put: async (r: Request, res: Response) => { m.set(r.url, res); },
        addAll: async (paths: string[]) => { for (const p of paths) m.set(new URL(p, "https://app.test").href, new Response(`cached ${p}`)); },
        keys: async () => [...m.keys()].map((u) => new Request(u)),
        delete: async (r: Request) => m.delete(r.url),
      };
    };
    const caches = {
      open: async (name: string) => store(name),
      keys: async () => [...stores.keys()],
      delete: async (name: string) => stores.delete(name),
      match: async (r: Request | string) => { for (const name of stores.keys()) { const hit = await store(name).match(r); if (hit) return hit; } },
    };
    let online = true;
    const fetched: string[] = [];
    const fetch = async (r: Request) => {
      fetched.push(new URL(r.url).pathname);
      if (!online) throw new TypeError("Failed to fetch");
      return new Response(`network ${new URL(r.url).pathname}`);
    };
    const self = {
      location: { origin: "https://app.test" },
      addEventListener: (type: string, f: (e: any) => void) => { handlers[type] = f; },
      skipWaiting: async () => {}, clients: { claim: async () => {} },
    };
    new Function("self", "caches", "fetch", file("public/sw.js").toString())(self, caches, fetch);
    const settle = async (type: string, extra = {}) => { let work: Promise<unknown> = Promise.resolve(); handlers[type]({ waitUntil: (p: Promise<unknown>) => { work = p; }, ...extra }); await work; };
    await settle("install");
    stores.set("static-v0", new Map());
    await settle("activate");
    expect([...stores.keys()]).toEqual(["static-v1"]);
    /** What the worker answers for a request (undefined: it leaves the request to the browser). */
    const answer = async (path: string, init: Omit<RequestInit, "mode"> & { mode?: string } = {}) => {
      let response: Promise<Response> | undefined;
      const { mode = "cors", ...rest } = init;
      const request = new Request(`https://app.test${path}`, rest);
      Object.defineProperty(request, "mode", { value: mode });
      handlers.fetch({ request, respondWith: (r: Promise<Response>) => { response = r; } });
      return response && (await response).text();
    };
    // Pages: the network first; offline, the offline page. The API, other sites, uploads and video ranges: never.
    expect(await answer("/app/videos", { mode: "navigate" })).toBe("network /app/videos");
    for (const path of ["/api/auth/me", "/api/media/x/file", "/api/accounts/callback/youtube", "/mcp", "/sw.js"]) expect(await answer(path, { mode: "navigate" })).toBeUndefined();
    expect(await answer("/api/videos", { method: "POST", body: "{}" })).toBeUndefined();
    expect(await answer("/assets/clip.mp4", { headers: { Range: "bytes=0-" } })).toBeUndefined();
    // Build files: fetched once, then from the cache, offline too.
    expect(await answer("/assets/index-abc123.js")).toBe("network /assets/index-abc123.js");
    online = false;
    expect(await answer("/assets/index-abc123.js")).toBe("network /assets/index-abc123.js");
    expect(fetched.filter((p) => p === "/assets/index-abc123.js")).toHaveLength(1);
    expect(await answer("/app/videos", { mode: "navigate" })).toBe("cached /offline.html");
    expect(await answer("/icons/icon-192.png")).toBe("cached /icons/icon-192.png");
  });
});
