import { cpSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

// Реч БГ's build (vite.config.ts, SITE=rechbg): what differs from Hookstreak's besides the words in the app.
// - index.html in Bulgarian: the language, the title and description, and the summary for readers without scripts.
// - Its own files over the shared public folder: the icons, the favicon, the share image, the manifest and the
//   offline page (sites/rechbg/public).
// - src/i18n/rechbg.ts loaded before the app.

const TITLE = "Машина за истории — видеа без лице на автопилот";
const DESCRIPTION =
  "Изберете ниша, глас и стил на картините веднъж. „Машина за истории“ пише, озвучава, илюстрира и поставя субтитри на ново кратко видео за всеки час от вашия график, готово за TikTok, YouTube Shorts и Instagram Reels.";
const NOSCRIPT = `<noscript>
      <main style="max-width: 640px; margin: 48px auto; padding: 0 16px; font-family: system-ui, sans-serif; line-height: 1.5">
        <h1>Машина за истории</h1>
        <p>${DESCRIPTION}</p>
        <p>Свържете своя YouTube канал, за да публикувате видеата си като Shorts в часовете, които зададете.</p>
        <p>Включете JavaScript, за да използвате приложението.</p>
        <p>
          <a href="/pricing">Цени</a> · <a href="/terms">Условия за ползване</a> · <a href="/privacy">Политика за поверителност</a> ·
          <a href="/contact">Контакт</a>
        </p>
      </main>
    </noscript>`;

/** One replacement that must happen: a shell that no longer has the text fails the build instead of staying English. */
function replace(html: string, pattern: RegExp, by: string, what: string) {
  if (!pattern.test(html)) throw new Error(`index.html: could not find ${what} to translate for Реч БГ (sites/rechbg/shell.ts)`);
  return html.replace(pattern, () => by);
}
export function rechbgShell(): Plugin[] {
  let outDir = "", ssr = false;
  return [{
    name: "rechbg-shell",
    configResolved(config) { outDir = config.build.outDir; ssr = !!config.build.ssr; },
    transform(code, id) {
      return id.endsWith("/src/main.tsx") ? { code: `import "./i18n/rechbg";\n${code}`, map: null } : null;
    },
    transformIndexHtml(html) {
      let out = replace(html, /<html lang="en">/, '<html lang="bg">', "the language");
      out = replace(out, /<title>[^<]*<\/title>/, `<title>${TITLE}</title>`, "the title");
      out = replace(out, /(<meta\s+name="description"\s+content=")[^"]*(")/, `<meta name="description" content="${DESCRIPTION}"`, "the description");
      out = replace(out, /(<meta name="apple-mobile-web-app-title" content=")[^"]*(")/, '<meta name="apple-mobile-web-app-title" content="Машина за истории"', "the app's title");
      return replace(out, /<noscript>[\s\S]*?<\/noscript>/, NOSCRIPT, "the summary for readers without scripts");
    },
    closeBundle() {
      const files = fileURLToPath(new URL("./public", import.meta.url));
      if (!ssr && outDir && existsSync(outDir)) cpSync(files, outDir, { recursive: true });
    },
  }];
}
