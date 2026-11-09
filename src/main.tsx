import React from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "@fontsource-variable/inter";
import "@fontsource-variable/bricolage-grotesque";
import "./style.css";
import { App } from "./App";
import { ToastProvider } from "./ui";
import { setUpInstall } from "./install";

setUpInstall();
// A deploy replaces hashed chunks: reload once to fetch the new ones instead of showing a blank page.
window.addEventListener("vite:preloadError", (event) => {
  try {
    if (Date.now() - Number(sessionStorage.getItem("hss-chunk-reload") || 0) < 60_000) return;
    sessionStorage.setItem("hss-chunk-reload", String(Date.now()));
  } catch { /* storage unavailable */ }
  event.preventDefault();
  window.location.reload();
});

const container = document.getElementById("root")!;
const app = (
  <React.StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <App />
      </ToastProvider>
    </BrowserRouter>
  </React.StrictMode>
);
// A public page arrives already rendered (scripts/prerender.mjs): the app takes over that markup instead of drawing the
// page again, when it is this page's (anything else, such as an old copy, is drawn afresh).
if (container.dataset.prerendered === (window.location.pathname.replace(/\/+$/, "") || "/")) hydrateRoot(container, app);
else createRoot(container).render(app);
