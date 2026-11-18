import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// The site this build is for (shared/site.ts): Hookstreak unless SITE=rechbg. Реч БГ gets the translating JSX runtime
// (src/i18n), its own first import and its own output folder; Hookstreak's build is the plain one it always was.
const site = process.env.SITE === "rechbg" ? "rechbg" : "hookstreak";
const rechbg = site === "rechbg";
/** Реч БГ's fonts and settings load before the app (src/i18n/rechbg.ts). */
const siteEntry: Plugin = {
  name: "site-entry",
  transform(code, id) {
    return id.endsWith("/src/main.tsx") ? { code: `import "./i18n/rechbg";\n${code}`, map: null } : null;
  },
};
export default defineConfig(({ command }) => ({
  plugins: [react(rechbg ? { jsxImportSource: "@site-jsx" } : undefined), ...(rechbg ? [siteEntry] : [])],
  define: { __SITE__: JSON.stringify(site) },
  // Root-relative in the dev server, so the runtime and the app load the same copy of shared/i18n.ts.
  resolve: { alias: (rechbg ? { "@site-jsx": command === "serve" ? "/src/i18n" : fileURLToPath(new URL("./src/i18n", import.meta.url)) } : {}) as Record<string, string> },
  // The runtime is this project's source, not a dependency to pre-bundle: it shares shared/i18n.ts with the app.
  optimizeDeps: { exclude: rechbg ? ["@site-jsx/jsx-runtime", "@site-jsx/jsx-dev-runtime"] : [] },
  server: { proxy: { "/api": "http://localhost:8787" } },
  build: { sourcemap: false, ...(rechbg && { outDir: "dist-rechbg" }) },
}));
