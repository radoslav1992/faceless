import { useEffect, useRef, useState } from "react";
import { api } from "./lib";

// Style examples (Admin → Examples, server/examples.ts): a real video made with each faceless style, shown on its card
// in place of the drawing. At rest a card shows the video's cover; it plays, muted and looping, while hovered or
// focused, and on touch screens (or with `autoplay`) while it is in view. With reduced motion only hovering plays it.
// Cards play the example's preview (its first 8 seconds, small and silent: about 1 MB), or the video until it exists.

export type Example = { video: string; poster: string | null; preview: string | null; duration: number };
let request: Promise<Record<string, Example>> | null = null;
/** Each style's example by template id (empty until loaded, or when there are none), loaded once per page. */
export function useExamples() {
  const [examples, setExamples] = useState<Record<string, Example>>({});
  useEffect(() => {
    let live = true;
    request ??= api<{ examples: Record<string, Example> }>("/public/examples").then((r) => r.examples).catch(() => { request = null; return {}; });
    void request.then((e) => { if (live) setExamples(e); });
    return () => { live = false; };
  }, []);
  return examples;
}
/** After an administrator changes the examples. */
export const reloadExamples = () => { request = null; };

const media = (query: string) => typeof window !== "undefined" && !!window.matchMedia?.(query).matches;

export function ExampleVideo({ example, autoplay = false, className }: { example: Example; autoplay?: boolean; className?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    const watch = (autoplay || !media("(hover: hover)")) && !media("(prefers-reduced-motion: reduce)") && "IntersectionObserver" in window;
    let shown = false;
    const play = () => { video.play().catch(() => { /* not allowed yet, or the file is gone */ }); };
    // Leaving the card stops it, unless it plays because it is in view.
    const pause = () => { if (!(watch && shown)) video.pause(); };
    // The card it sits in (a link or a button) starts and stops it.
    const card = video.closest("a, button") ?? video.parentElement!;
    const cleanups: (() => void)[] = [];
    for (const [type, f] of [["pointerenter", play], ["pointerleave", pause], ["focusin", play], ["focusout", pause]] as const) {
      card.addEventListener(type, f);
      cleanups.push(() => card.removeEventListener(type, f));
    }
    if (watch) {
      const seen = new IntersectionObserver(([e]) => {
        shown = e.isIntersecting;
        if (shown) play();
        else video.pause();
      }, { threshold: 0.6 });
      seen.observe(video);
      cleanups.push(() => { seen.disconnect(); video.pause(); });
    }
    return () => cleanups.forEach((f) => f());
  }, [autoplay, example.video, example.preview]);
  // Without a cover, the first frame stands in for one.
  const src = example.preview ?? example.video;
  return (
    <video ref={ref} className={className} src={example.poster ? src : `${src}#t=0.1`} poster={example.poster ?? undefined}
      muted loop playsInline preload={example.poster ? "none" : "metadata"} aria-hidden="true" tabIndex={-1} />
  );
}
