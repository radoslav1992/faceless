import { useRadioKeys } from "./CaptionPickers";
import { StyleArt } from "../art";
import { storyStyleIds, storyStyles, type StoryStyle } from "../../shared/story";

// The picture styles of a video, each with its small drawn sample (src/art.tsx), as a radio group.

/** The picture style for every scene: a radio group of drawn samples (arrow keys move the choice). */
export function StoryStylePicker({ value, onChange }: { value: StoryStyle; onChange: (style: StoryStyle) => void }) {
  const radio = useRadioKeys(storyStyleIds, value, onChange);
  return (
    <div className="story-styles" role="radiogroup" aria-label="Picture style">
      {storyStyleIds.map((s, i) => (
        <button key={s} type="button" className="story-style" {...radio(s, i)} aria-label={`${storyStyles[s].name}: ${storyStyles[s].short}`}>
          <StyleArt style={s} />
          <span className="style-name">{storyStyles[s].name}</span>
        </button>
      ))}
    </div>
  );
}
