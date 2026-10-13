// The service worker that makes the app installable and quick to open. It only ever caches the site's own static
// files: the build's hashed assets (/assets/…, never changed once built), icons, fonts and the offline page. Pages are
// always fetched from the network first, so a deploy shows at once; without a connection, the offline page shows.
// The API, media files, capability links and anything not fetched with GET are never touched.

const VERSION = "v1";
const STATIC = `static-${VERSION}`;
const ASSETS = `assets-${VERSION}`;
const OFFLINE = "/offline.html";
/** Hashed build files kept at most (old builds' files go first). */
const MAX_ASSETS = 150;
const PRECACHE = [OFFLINE, "/favicon.svg", "/icons/icon-192.png", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(STATIC).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) if (name !== STATIC && name !== ASSETS) await caches.delete(name);
    await self.clients.claim();
  })());
});

/** Paths this worker never answers: the API (and its file and capability links), the MCP server, crawler files. */
const PASS = /^\/(api\/|mcp$|robots\.txt$|sitemap\.xml$|sw\.js$)/;

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || request.headers.has("range")) return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || PASS.test(url.pathname)) return;
  if (request.mode === "navigate") return event.respondWith(page(request));
  if (url.pathname.startsWith("/assets/")) return event.respondWith(hashed(request));
  if (/^\/(icons\/|fonts\/|favicon\.svg$|apple-touch-icon\.png$|manifest\.webmanifest$)/.test(url.pathname)) event.respondWith(fresh(request));
});

/** A page: from the network; offline, the offline page. */
async function page(request) {
  try {
    return await fetch(request);
  } catch {
    return (await caches.match(OFFLINE)) || new Response("You're offline.", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
}

/** A hashed build file: from the cache once fetched (its name changes whenever its content does). */
async function hashed(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(ASSETS);
    await cache.put(request, response.clone());
    const keys = await cache.keys();
    for (const old of keys.slice(0, Math.max(0, keys.length - MAX_ASSETS))) await cache.delete(old);
  }
  return response;
}

/** An icon, font or the manifest: from the cache at once, refreshed from the network for next time. */
async function fresh(request) {
  const cache = await caches.open(STATIC);
  const cached = await cache.match(request);
  const update = fetch(request).then((response) => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  });
  if (cached) {
    update.catch(() => {});
    return cached;
  }
  return update;
}
