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

/** Starting points for Admin → Library's "Make a sound effect" (ElevenLabs): a description, a length and its details. */
export type SoundIdea = { name: string; prompt: string; seconds: number; category: (typeof soundCategories)[number]; tags: string };
export const soundIdeas: SoundIdea[] = [
  { name: "Airy Whoosh", prompt: "A fast, airy cinematic whoosh passing from left to right", seconds: 1, category: "Transition", tags: "whoosh, swoosh, fast" },
  { name: "Heavy Whoosh", prompt: "A deep, heavy whoosh with a low rumble, like a fast camera move", seconds: 1.5, category: "Transition", tags: "whoosh, deep, cinematic" },
  { name: "Quick Swish", prompt: "A short sharp swish, like a sword cutting the air", seconds: 0.6, category: "Transition", tags: "swish, sharp, short" },
  { name: "Map Whoosh", prompt: "A paper map unfolding quickly with a soft whoosh", seconds: 1, category: "Transition", tags: "paper, map, whoosh" },
  { name: "Cinematic Boom", prompt: "A deep cinematic boom with a long low tail", seconds: 3, category: "Impact", tags: "boom, hit, trailer" },
  { name: "Heavy Hit", prompt: "A hard punchy hit, like a heavy wooden door slamming", seconds: 1.5, category: "Impact", tags: "hit, slam, punch" },
  { name: "Tension Riser", prompt: "A tension riser that builds up and stops suddenly", seconds: 3, category: "Riser", tags: "riser, tension, build" },
  { name: "Soft Pop", prompt: "A soft bubbly pop", seconds: 0.5, category: "Pop", tags: "pop, bubble, light" },
  { name: "Campfire", prompt: "A crackling campfire with popping embers", seconds: 5, category: "Fire", tags: "fire, crackle, embers" },
  { name: "Ocean Waves", prompt: "Ocean waves crashing on a rocky shore", seconds: 5, category: "Water", tags: "ocean, waves, sea" },
  { name: "Thunderstorm", prompt: "Rolling thunder with heavy rain", seconds: 5, category: "Weather", tags: "thunder, rain, storm" },
  { name: "Crowd Cheer", prompt: "A large crowd cheering and clapping", seconds: 4, category: "Crowd", tags: "crowd, cheer, applause" },
  { name: "Battle Cannons", prompt: "Distant cannon fire and war drums", seconds: 4, category: "War", tags: "cannon, battle, drums" },
  { name: "Marching Army", prompt: "An army marching in boots on a dirt road", seconds: 4, category: "War", tags: "marching, army, soldiers" },
  { name: "Elephant", prompt: "An elephant trumpeting loudly", seconds: 2, category: "Animals", tags: "elephant, trumpet, animal" },
  { name: "City Street", prompt: "A busy city street with traffic and car horns", seconds: 5, category: "City", tags: "city, traffic, horns" },
  { name: "Steam Train", prompt: "An old steam train whistle and chugging", seconds: 4, category: "Machines", tags: "train, steam, whistle" },
  { name: "Creaking Door", prompt: "A wooden door creaking open slowly", seconds: 3, category: "Horror", tags: "door, creak, spooky" },
  { name: "Magic Sparkle", prompt: "A sparkling magical shimmer", seconds: 2, category: "Magic", tags: "magic, sparkle, shimmer" },
];
