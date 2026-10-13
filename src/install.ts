import { useEffect, useState } from "react";

// The installable app (PWA): registers the service worker (public/sw.js) and offers "Install app". Chrome, Edge and
// Android announce they can install it (beforeinstallprompt), and the app shows its own button for that; Safari on
// iPhone and iPad has no such event, so people there get the steps (Share → Add to Home Screen).

type InstallPrompt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };
let deferred: InstallPrompt | null = null;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((f) => f());

/** Running as the installed app (home screen or app window), not in a browser tab. */
export const standalone = () =>
  typeof window !== "undefined" && (window.matchMedia?.("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true);
/** Safari on iPhone or iPad, where installing is Share → Add to Home Screen. */
const appleMobile = () =>
  typeof navigator !== "undefined" && (/iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));

/** Registers the service worker and listens for the browser's offer to install (once, at start-up). */
export function setUpInstall() {
  if (typeof window === "undefined") return;
  window.addEventListener("beforeinstallprompt", (e) => {
    // The app offers installing itself (in the sidebar) instead of the browser's own bar.
    e.preventDefault();
    deferred = e as InstallPrompt;
    changed();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    changed();
  });
  if (import.meta.env.PROD && "serviceWorker" in navigator)
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch(() => {});
    });
}

/**
 * Whether the app can be installed here, and how: `prompt` (the browser's own dialog), `steps` (iPhone and iPad), or
 * null (installed already, or a browser that can't).
 */
export function useInstall() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const f = () => setTick((n) => n + 1);
    listeners.add(f);
    return () => { listeners.delete(f); };
  }, []);
  const way: "prompt" | "steps" | null = standalone() ? null : deferred ? "prompt" : appleMobile() ? "steps" : null;
  const install = async () => {
    if (!deferred) return false;
    const offer = deferred;
    await offer.prompt();
    const { outcome } = await offer.userChoice;
    // An offer can be shown once; the browser makes a new one if it may ask again.
    deferred = null;
    changed();
    return outcome === "accepted";
  };
  return { way, install };
}
