// Sound effects: short sounds from the shared library ('sfx', migrations/0012) that a narrated video plays over its
// voice and music — a whoosh on every scene change (a sound of the "Transition" category) and a scene's own sound
// (fire, waves, a crowd) when it starts. The writer picks them for a new video; people switch them off, change the
// volume or the whoosh, and add, change or remove each scene's sound in the editor. They are free: changing them
// only renders the video again.

/** Categories of sound effects; a "Transition" sound marks scene changes, the others belong to a scene. */
export const soundCategories = [
  "Transition", "Impact", "Pop", "Riser", "Nature", "Water", "Fire", "Weather", "Animals", "Crowd", "City", "Machines", "War", "Magic",
  "Horror", "Funny",
] as const;
export const TRANSITION_CATEGORY = "Transition";
export const isTransitionSound = (category: string | undefined) => (category || "").trim().toLowerCase() === TRANSITION_CATEGORY.toLowerCase();
/** How long a library sound effect may be (seconds). */
export const SOUND_MIN_SECONDS = 0.2, SOUND_MAX_SECONDS = 30;
/** Their default volume (of the file's own level), under a voice at full volume. */
export const SOUND_VOLUME = 0.6;
/** A whoosh starts this long before the scene change it marks, so its rush peaks on the cut. */
export const WHOOSH_LEAD = 0.3;
/** A whoosh plays at most this long. */
export const WHOOSH_MAX_SECONDS = 2;
/** A scene's sound plays from the scene's start, at most until this long after its end. */
export const SCENE_SOUND_TAIL = 0.5;
/** Sounds placed in one video at most (renderer/server.py MAX_SOUNDS). */
export const MAX_SOUNDS = 80;
