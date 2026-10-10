import type { StoryStyle } from "./story";

// Video types and the gallery of faceless styles built on them. A video type ("kind") decides how a video is written
// and drawn; a template is a ready-made starting point (a niche and its look) people pick in Create, for a series or on
// the public tool pages. `brief` goes to the script writer as data about the video, never as the owner's instructions.

export const videoKinds = ["story", "pov", "mashup", "script", "backdrop"] as const;
export type VideoKind = (typeof videoKinds)[number];
export const kindInfo: Record<VideoKind, { name: string; short: string }> = {
  story: { name: "AI story", short: "A narrated story with a new AI picture for every sentence." },
  pov: { name: "POV", short: "First-person scenes with a “POV:” title on screen." },
  mashup: { name: "Brainrot mashup", short: "An absurd animal-and-object character with its own chant." },
  script: { name: "Text to video", short: "Your own words, narrated and illustrated scene by scene." },
  backdrop: { name: "Storytime", short: "A title card, then the story narrated over a looping background clip." },
};

export const categories = [
  { id: "stories", name: "AI image stories" },
  { id: "pov", name: "POV" },
  { id: "facts", name: "Facts & explainers" },
  { id: "surreal", name: "Surreal & memes" },
  { id: "storytime", name: "Storytime" },
  { id: "script", name: "Your script" },
] as const;
export type CategoryId = (typeof categories)[number]["id"];

export type Template = {
  name: string; category: CategoryId; kind: VideoKind; short: string; brief: string;
  /** Example topics (shown as suggestions; the first one is the prompt field's placeholder). */
  examples: readonly string[];
  style: StoryStyle; voice: string; seconds: number; music: string; popular?: boolean;
  /** A public tool page (/tools/<slug>) with its own title and description. */
  tool?: { slug: string; title: string; description: string; icon: string };
};

export const templates = {
  motivation: {
    name: "Motivational stories", category: "stories", kind: "story", short: "Short lessons that stick", popular: true,
    brief: "One clear, practical lesson about discipline, habits or mindset, told through a short story or a vivid example, ending on a line worth remembering. No promises of riches or guaranteed results.",
    examples: ["Why the first five minutes decide your day", "The two-day rule", "What a bamboo tree teaches about patience"],
    style: "cinematic", voice: "brian", seconds: 45, music: "inspiring",
  },
  scary: {
    name: "Scary stories", category: "stories", kind: "story", short: "Original short horror tales", popular: true,
    brief: "An original, short scary story told in the first person: an ordinary situation that turns eerie, slow build-up, a chilling twist in the last line. Suspense over gore; never graphic violence.",
    examples: ["The night shift at an empty motel", "A voicemail from my own number", "The house that has one extra door"],
    style: "dark", voice: "brian", seconds: 60, music: "dark",
    tool: { slug: "scary-story-video", title: "AI scary story video generator", description: "Turn a one-line idea into a narrated horror short with eerie AI pictures, a slow build and a twist at the end.", icon: "ghost" },
  },
  story: {
    name: "AI story", category: "stories", kind: "story", short: "Fantasy, mystery or uplifting tales",
    brief: "A captivating original short story in the genre the owner asks for (fantasy, mystery, adventure, sci-fi, heartwarming), with a strong hook, one clear main character and a satisfying twist or ending.",
    examples: ["A lighthouse keeper's last night", "The robot that learned to lie", "A letter delivered 50 years late"],
    style: "anime", voice: "george", seconds: 60, music: "mysterious",
    tool: { slug: "story-video", title: "AI story video generator", description: "Give it a story idea and get a narrated short with a new picture for every sentence: fantasy, mystery or uplifting.", icon: "book-open" },
  },
  bedtime: {
    name: "Bedtime stories", category: "stories", kind: "story", short: "Gentle tales for little ones",
    brief: "A calm, kind bedtime story for young children with a gentle lesson: simple words, a friendly main character, a soft happy ending. Nothing frightening.",
    examples: ["The little cloud who was afraid of rain", "A fox who collected lost buttons", "The moon's quiet night off"],
    style: "storybook", voice: "matilda", seconds: 90, music: "calm",
  },
  mythology: {
    name: "Myths & legends", category: "stories", kind: "story", short: "Gods, monsters and heroes",
    brief: "A myth or legend from any culture retold as a gripping short story, naming the culture it comes from and keeping to the traditional tale.",
    examples: ["Why Sisyphus pushes his boulder", "The wolf that will swallow the sun", "The trickster who stole fire"],
    style: "oil", voice: "george", seconds: 60, music: "epic",
  },
  history: {
    name: "History stories", category: "stories", kind: "story", short: "Moments history books skip",
    brief: "A true, surprising moment from history told as a short story: who, where, what happened and why it still matters. Only well-documented facts; say 'reportedly' where historians disagree.",
    examples: ["The emperor who declared war on the sea", "The soldier who kept fighting for 29 years", "How a typo shaped a map"],
    style: "oil", voice: "george", seconds: 60, music: "epic",
  },
  mysteries: {
    name: "Unsolved mysteries", category: "stories", kind: "story", short: "Unexplained places and events",
    brief: "A real, well-documented unexplained mystery (a place, an object, a historical event): what is known, the leading theories, and the question that remains. Never accuse real private people.",
    examples: ["The village that vanished overnight", "A manuscript nobody can read", "Lights over a desert town"],
    style: "vintage", voice: "eric", seconds: 60, music: "mysterious",
  },
  random: {
    name: "Surprise me", category: "stories", kind: "story", short: "A new kind of story every time",
    brief: "A captivating original short story on a different theme every time (adventure, mystery, humour, sci-fi, heartwarming), with a strong hook and a satisfying twist.",
    examples: ["Anything", "A twist ending", "Something heartwarming"],
    style: "anime", voice: "george", seconds: 60, music: "mysterious",
  },
  dayinlife: {
    name: "Day in the life POV", category: "pov", kind: "pov", short: "Live one day as someone else", popular: true,
    brief: "A second-person day in the life of someone from another time or an unusual job ('You wake up before dawn…'), from morning to night, with vivid, accurate details of what they see, do and feel.",
    examples: ["A Roman legionary", "A lighthouse keeper in 1890", "An astronaut on the space station"],
    style: "cinematic", voice: "will", seconds: 60, music: "ambient",
    tool: { slug: "pov-video", title: "AI POV video generator", description: "Write a scenario — a job, an era, a wild situation — and get a first-person POV short with a “POV:” title and matching scenes.", icon: "eye" },
  },
  povscenario: {
    name: "POV scenarios", category: "pov", kind: "pov", short: "Relatable and wild situations",
    brief: "A second-person POV scenario ('POV: you…') that plays out moment by moment with a twist, relatable or absurd, light-hearted, ending on a punchline.",
    examples: ["You wake up with your cat's thoughts in your head", "You're the last person who still uses a fax machine", "You find a door in your basement"],
    style: "toy3d", voice: "liam", seconds: 30, music: "playful",
  },
  facts: {
    name: "Fun facts", category: "facts", kind: "story", short: "Did-you-know in under a minute", popular: true,
    brief: "Several surprising, verifiable facts on one theme, each explained in a sentence or two, building to the most surprising one last. No invented statistics.",
    examples: ["Your body does this every night", "Animals that never sleep", "Everyday objects with secret purposes"],
    style: "doodle", voice: "jessica", seconds: 45, music: "upbeat",
  },
  space: {
    name: "Space & science", category: "facts", kind: "story", short: "The universe, explained",
    brief: "A mind-bending science or space topic explained simply and accurately with vivid comparisons, ending with a thought that makes the viewer look up.",
    examples: ["What if the Moon disappeared", "The coldest place in the universe", "Why we can't see most of the universe"],
    style: "cinematic", voice: "will", seconds: 60, music: "ambient",
  },
  animals: {
    name: "Animal facts", category: "facts", kind: "story", short: "Nature's strangest creatures",
    brief: "One remarkable animal and what makes it extraordinary, explained with accurate facts and a sense of wonder.",
    examples: ["The octopus has three hearts", "The bird that mimics chainsaws", "The fish that walks on land"],
    style: "watercolor", voice: "sarah", seconds: 45, music: "playful",
  },
  psychology: {
    name: "Psychology", category: "facts", kind: "story", short: "Why people do what they do",
    brief: "One well-established psychological effect or study explained simply with an everyday example and how to use it; no diagnoses or medical advice.",
    examples: ["The spotlight effect", "Why we remember unfinished tasks", "The power of a name"],
    style: "flat", voice: "alice", seconds: 45, music: "ambient",
  },
  explained: {
    name: "Explained simply", category: "facts", kind: "story", short: "Complex things, made easy",
    brief: "Explain one complex thing (technology, economics, the body, how things work) as if to a curious 12-year-old, with one great analogy.",
    examples: ["How does Wi-Fi actually work", "Why prices go up", "What happens when you sleep"],
    style: "doodle", voice: "chris", seconds: 60, music: "playful",
  },
  philosophy: {
    name: "Philosophy", category: "facts", kind: "story", short: "Big ideas in plain words",
    brief: "One idea from philosophy (stoicism, ethics, thought experiments) explained in plain words with an everyday example, naming the thinker it comes from.",
    examples: ["The ship of Theseus", "What Marcus Aurelius wrote to himself", "Plato's cave in 60 seconds"],
    style: "sketch", voice: "george", seconds: 60, music: "calm",
  },
  lifetips: {
    name: "Life tips", category: "facts", kind: "story", short: "Small tricks, big difference",
    brief: "Practical, safe and useful tips on one everyday theme (home, cooking, travel, productivity), each a sentence or two, the most useful one last.",
    examples: ["Kitchen tricks chefs use", "Pack a carry-on like a pro", "Make your phone battery last longer"],
    style: "flat", voice: "laura", seconds: 45, music: "upbeat",
  },
  mashup: {
    name: "Brainrot mashup", category: "surreal", kind: "mashup", short: "Animal + object = chaos", popular: true,
    brief: "An absurd original creature that fuses an animal and an object, with a silly made-up name the narrator chants, a ridiculous backstory and over-the-top claims; fast, funny, nonsense on purpose, never mean.",
    examples: ["A shark + a sneaker", "A frog + a toaster", "A giraffe + a trumpet"],
    style: "toy3d", voice: "laura", seconds: 30, music: "playful",
    tool: { slug: "brainrot-video", title: "AI brainrot mashup generator", description: "Pick an animal and an object: get an absurd hybrid character with a chant-worthy name and a vertical meme video.", icon: "sparkles" },
  },
  surreal: {
    name: "Surreal tales", category: "surreal", kind: "story", short: "Dreamlike and strange",
    brief: "A short surreal tale with dream logic: impossible places, strange rules treated as normal, a calm narrator and an uncanny last line.",
    examples: ["The town where it rains upwards", "A library that reads you", "The staircase that only goes down on Tuesdays"],
    style: "watercolor", voice: "eric", seconds: 45, music: "mysterious",
  },
  storytime: {
    name: "Storytime", category: "storytime", kind: "backdrop", short: "Title card + story over a background", popular: true,
    brief: "A gripping first-person storytime answer to the title question: casual, honest, specific, with a turn in the middle and a satisfying or funny ending. Entirely fictional and original.",
    examples: ["What decision quietly changed your life?", "What's the weirdest thing a stranger said to you?", "What did you learn too late?"],
    style: "cinematic", voice: "sarah", seconds: 60, music: "none",
    tool: { slug: "storytime-video", title: "Storytime video maker", description: "A question on a title card, then the story narrated with bold captions over a looping background clip.", icon: "message-square" },
  },
  script: {
    name: "Text to video", category: "script", kind: "script", short: "Your words, illustrated",
    brief: "The owner's own script, split into scenes; only the pictures are described.",
    examples: ["Paste your script here. Every sentence or two becomes a scene with its own picture."],
    style: "cinematic", voice: "george", seconds: 60, music: "auto",
    tool: { slug: "text-to-video", title: "Text to video AI generator", description: "Paste a script and get a faceless video: an AI voiceover, a matching picture for every sentence and timed captions.", icon: "file-text" },
  },
  custom: {
    name: "Your own topic", category: "stories", kind: "story", short: "Describe the videos you want",
    brief: "Videos about the owner's topic, described in the prompt.",
    examples: ["Daily tips for new dog owners", "Stories from ancient Rome", "Football's greatest comebacks"],
    style: "doodle", voice: "george", seconds: 45, music: "auto",
  },
} as const satisfies Record<string, Template>;
export type TemplateId = keyof typeof templates;
export const templateIds = Object.keys(templates) as TemplateId[];
export const templateOf = (id: string): Template => (templates as Record<string, Template>)[id] ?? templates.custom;
export const isTemplate = (id: string): id is TemplateId => id in templates;
/** Templates a series can run on (every one but a script, which needs the owner's words each time). */
export const seriesTemplates = templateIds.filter((id) => templates[id].kind !== "script");
/** The public tool pages. */
export const tools = templateIds.filter((id) => !!(templates[id] as Template).tool).map((id) => ({ id, ...(templates[id] as Template).tool! }));
export const toolBySlug = (slug: string) => tools.find((t) => t.slug === slug);
