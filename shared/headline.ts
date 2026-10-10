import { defaultLook } from "./overlay";
import type { StorySpec } from "./formats";
import type { VideoKind } from "./templates";

// The on-screen title of each video type (written by server/story.ts, edited in the editor): a POV line in white
// outline and a creature's name in big yellow all along, a white title card for the first seconds otherwise.
export function headlineFor(kind: VideoKind, text: string): StorySpec["headline"] {
  const line = text.trim().slice(0, 140);
  if (!line) return null;
  if (kind === "pov") return { text: /^pov\b/i.test(line) ? line : `POV: ${line}`.slice(0, 140), seconds: 0, look: { ...defaultLook(), position: "top", size: 0.9, color: "#ffffff", stroke: 5, strokeColor: "#000000", background: null } };
  if (kind === "mashup") return { text: line, seconds: 0, look: { ...defaultLook(), position: "top", size: 1.15, color: "#ffe14d", stroke: 6, strokeColor: "#000000", background: null, animation: "pop" } };
  return { text: line, seconds: kind === "backdrop" ? 4 : 3, look: { ...defaultLook(), position: "top", size: 0.95, color: "#111111", stroke: 0, strokeColor: "#000000", background: "#ffffff", animation: "pop" } };
}
