// Where to continue after signing in (?next=): only a page of this site, never another site or the sign-in pages.

/**
 * A path on this site to continue to after signing in, or null. Browsers drop tabs and line breaks from a link and read
 * "\" as "/", so "/\t/evil.com" or "/\evil.com" would lead to another site: anything with whitespace, control characters
 * or backslashes is refused, and the rest must still be a path on `origin` once the browser has resolved it.
 */
export function safeNext(next: string | null, origin = window.location.origin): string | null {
  if (!next || !next.startsWith("/") || /[\s\p{Cc}\\]/u.test(next)) return null;
  let url: URL;
  try {
    url = new URL(next, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin || !url.pathname.startsWith("/") || url.pathname.startsWith("//")) return null;
  if (/^\/(login|register)(\/|$)/i.test(url.pathname)) return null;
  return url.pathname + url.search + url.hash;
}
