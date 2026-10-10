import { useEffect, useMemo, useState, type ReactNode } from "react";
import { StyleArt } from "../art";
import type { StoryStyle } from "../../shared/story";
import type { VideoKind } from "../../shared/templates";

// A phone showing a drawn sample of a video: the style's picture (moving slowly), its on-screen title and the
// subtitles a few words at a time with a key word in green. Drawings and words only: never a fake result.

const reduced = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
/** Words of `text` in groups of three, a key word (*between stars*) in green. */
function groups(text: string) {
  const words = text.split(/\s+/).filter(Boolean), out: string[][] = [];
  for (let i = 0; i < words.length; i += 3) out.push(words.slice(i, i + 3));
  return out.length ? out : [[""]];
}
export function Captions({ text, color = "#fff", accent = "var(--brand)" }: { text: string; color?: string; accent?: string }) {
  const parts = useMemo(() => groups(text), [text]);
  const [n, setN] = useState(0);
  useEffect(() => {
    setN(0);
    if (reduced() || parts.length < 2) return;
    const id = setInterval(() => setN((x) => (x + 1) % parts.length), 900);
    return () => clearInterval(id);
  }, [parts]);
  return (
    <p className="ph-cap" style={{ color }} aria-hidden="true">
      {parts[n].map((w, i) => {
        const key = /^\*.*\*[.,!?]?$/.test(w);
        const clean = w.replace(/\*/g, "");
        return <span key={i}>{i ? " " : ""}{key ? <b style={{ color: accent }}>{clean}</b> : clean}</span>;
      })}
    </p>
  );
}

export function SamplePhone({ style, title, caption, kind = "story", label, children, backdrop, color }: {
  style?: StoryStyle; title?: string; caption: string; kind?: VideoKind; label?: string; children?: ReactNode; color?: string;
  /** A CSS backdrop class (storytime) instead of a drawn picture. */
  backdrop?: string;
}) {
  const titleClass = kind === "pov" ? "ph-title pov" : kind === "mashup" ? "ph-title loud" : "ph-title";
  return (
    <div className="phone" role="img" aria-label={label || [title, caption.replace(/\*/g, "")].filter(Boolean).join(" — ")}>
      {backdrop ? <div className={`backdrop ${backdrop}`} /> : style && <StyleArt style={style} />}
      {title && <p className={titleClass} aria-hidden="true">{title}</p>}
      <Captions text={caption} color={color} />
      {children}
    </div>
  );
}

/** The home page's sample reel: one per video type, all drawn. */
export const reel: { style: StoryStyle; kind: VideoKind; title: string; caption: string }[] = [
  { style: "dark", kind: "story", title: "The motel with no guests", caption: "Room 13 was *always* booked, but nobody ever checked in." },
  { style: "oil", kind: "story", title: "The emperor who fought the sea", caption: "He ordered his army to *attack* the waves." },
  { style: "toy3d", kind: "mashup", title: "Sneakorino Sharkalino", caption: "Half shark, half sneaker, and *faster* than your Wi-Fi." },
  { style: "cinematic", kind: "pov", title: "POV: you keep a lighthouse in 1890", caption: "The lamp must *never* go out. Not even tonight." },
  { style: "watercolor", kind: "story", title: "Three hearts, blue blood", caption: "An octopus has *three* hearts, and one stops when it swims." },
];
