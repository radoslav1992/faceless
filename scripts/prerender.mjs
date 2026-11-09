// Writes every public page's HTML (rendered by the server build of src/prerender.tsx) into a copy of the built app
// shell: dist/_pages/<route>/index.html, which the Worker serves for that page (server/pages.ts documentPath).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { render, routes } from "../dist-ssr/prerender.js";

// A prerendered page holds its own words and links (the footer's terms and privacy policy among them), so the shell's
// <noscript> summary for readers without scripts would only be a second heading before them.
const shell = readFileSync("dist/index.html", "utf8").replace(/\s*<!--[^>]*?scripts[\s\S]*?-->\s*<noscript>[\s\S]*?<\/noscript>/, "");
const root = '<div id="root"></div>';
if (!shell.includes(root) || shell.includes("<noscript>")) {
  console.error(`dist/index.html: no ${root}, or its <noscript> summary was not removed`);
  process.exit(1);
}
for (const route of routes) {
  const html = await render(route);
  if (!/<h1[\s>]/.test(html)) {
    console.error(`${route} rendered without a heading`);
    process.exit(1);
  }
  const file = join("dist/_pages", route === "/" ? "" : route, "index.html");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, shell.replace(root, `<div id="root" data-prerendered="${route}">${html}</div>`));
}
console.log(`Prerendered ${routes.length} public pages.`);
