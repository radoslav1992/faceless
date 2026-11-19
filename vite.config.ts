import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { rechbgShell } from "./sites/rechbg/shell";

// The site this build is for (shared/site.ts, docs/SITES.md): Hookstreak unless SITE=rechbg. Реч БГ gets the
// translating JSX runtime (src/i18n), its own shell and files (sites/rechbg) and its own output folder; Hookstreak's
// build is the plain one it always was.
const site = process.env.SITE === "rechbg" ? "rechbg" : "hookstreak";
const rechbg = site === "rechbg";
export default defineConfig(({ command }) => ({
  plugins: [react(rechbg ? { jsxImportSource: "@site-jsx" } : undefined), ...(rechbg ? rechbgShell() : [])],
  define: { __SITE__: JSON.stringify(site) },
  // Root-relative in the dev server, so the runtime and the app load the same copy of shared/i18n.ts.
  resolve: { alias: (rechbg ? { "@site-jsx": command === "serve" ? "/src/i18n" : fileURLToPath(new URL("./src/i18n", import.meta.url)) } : {}) as Record<string, string> },
  // The runtime is this project's source, not a dependency to pre-bundle: it shares shared/i18n.ts with the app.
  optimizeDeps: { exclude: rechbg ? ["@site-jsx/jsx-runtime", "@site-jsx/jsx-dev-runtime"] : [] },
  server: { proxy: { "/api": "http://localhost:8787" } },
  build: { sourcemap: false, ...(rechbg && { outDir: "dist-rechbg" }) },
}));
