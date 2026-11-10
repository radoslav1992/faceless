import type { TemplateId } from "./templates";
import { SECONDS_PER_CREDIT } from "./credits";
import { storyStyleIds } from "./story";

// The words of each public tool page (/tools/<slug>) beyond its title and description: what the videos are, ideas to
// start from and the questions people ask about that kind of video. All our own, and only what the app does: the
// writer's rules come from each template's brief (shared/templates.ts). The Worker also turns the questions into the
// page's FAQ structured data (shared/seo.ts).

export type ToolPageCopy = {
  /** What these videos are and what the generator does for them. */
  intro: string;
  /** Topics to start from (each opens Create with it); for Text to video, what can be pasted (not clickable). */
  ideas: readonly string[];
  faq: readonly (readonly [string, string])[];
};

const styles = storyStyleIds.length;

export const toolPageCopy: Partial<Record<TemplateId, ToolPageCopy>> = {
  scary: {
    intro: "Short horror stories are a classic faceless format: a calm first-person voice, an ordinary place that slowly turns wrong, and a last line that lands. Give the generator a one-line premise and it writes an original story with a slow build and a twist, draws every scene in a dark, cinematic style and adds an unsettling soundtrack.",
    ideas: ["The night shift at an empty motel", "A voicemail from my own number", "The house that has one extra door", "The last bus that skipped my stop", "My neighbour waves from an empty house", "Rules for the night guard at the old museum"],
    faq: [
      ["Are the stories original?", "Yes. Every story is written new from your premise, never a copied creepypasta or a retold film. You read the draft script before the video is made and can change any line."],
      ["How scary do they get?", "Suspense over gore: the writer builds dread and ends on a twist, and never describes graphic violence, so the videos suit a general audience."],
    ],
  },
  story: {
    intro: "For channels that post original short fiction: fantasy, mystery, sci-fi or heartwarming. Describe an idea in a line and the generator writes a story with a strong hook, one main character and a satisfying ending, then draws a new picture for every sentence and narrates it.",
    ideas: ["A lighthouse keeper's last night", "The robot that learned to lie", "A letter delivered 50 years late", "The last dragon applies for a job", "A town where every shadow runs late", "Two strangers who share the same dream"],
    faq: [
      ["Which genres can it write?", "Any you ask for: fantasy, mystery, adventure, sci-fi or heartwarming. Name the genre and tone in your idea, and pick an art style to match."],
      ["Do the characters look the same in every scene?", "As far as AI pictures allow, yes: a video's recurring characters and places get reference sheets first, and every scene is drawn from them, so the story looks like one film. In a series, the main character you describe is drawn once and every episode is drawn from that same picture."],
    ],
  },
  bedtime: {
    intro: "Bedtime story channels need a steady stream of gentle, original tales. Give it a character or a theme and it writes a calm story with simple words, a kind main character and a soft happy ending, illustrated in a storybook style and read by a warm voice over quiet music.",
    ideas: ["The little cloud who was afraid of rain", "A fox who collected lost buttons", "The moon's quiet night off", "A sleepy turtle who wanted to see the stars", "The teddy bear who guarded the night-light", "A raindrop's long journey home"],
    faq: [
      ["Are the stories suitable for young children?", "They are written to be: calm, kind and never frightening, with a gentle lesson. Watch each video before you share it, and when you post one to YouTube, mark it as made for kids; you choose that for every post."],
      ["Can a bedtime story be longer than a minute?", "Yes. Bedtime stories are 90 seconds by default and any video can run up to three minutes. A series can make a new one every evening."],
    ],
  },
  mythology: {
    intro: "Gods, monsters and heroes never run out of stories. Name a myth (Greek, Norse, Egyptian, Japanese or any other) and the generator retells it as a short, gripping story that names the culture it comes from and keeps to the traditional tale, painted in an oil style with an epic score.",
    ideas: ["Why Sisyphus pushes his boulder", "The wolf that will swallow the sun", "The trickster who stole fire", "How Thor lost his hammer", "Anansi and the box of stories", "The twelve labours of Heracles in one minute"],
    faq: [
      ["Does it stick to the original myths?", "The writer is asked to keep to the traditional tale and to name the culture it comes from. Many myths exist in several versions, so read the draft and adjust any detail before the video is made."],
      ["Can I make a mythology series?", "Yes. Start a series with Myths & legends and it writes and makes a new episode for every slot of your schedule."],
    ],
  },
  history: {
    intro: "History channels thrive on the moments textbooks skip. Give it a person, an event or a question and it tells a true story (who, where, what happened and why it still matters) in about a minute, with painted scenes and a cinematic score.",
    ideas: ["The emperor who declared war on the sea", "The soldier who kept fighting for 29 years", "How a typo shaped a map", "The Great Emu War", "Why the Eiffel Tower was meant to be temporary", "The library that changed how the world read"],
    faq: [
      ["How accurate are the history videos?", "The writer is told to use only well-documented facts and to say \"reportedly\" where historians disagree. AI can still make mistakes, so you see the script before anything is made and can check and edit every line."],
      ["Can I use my own history script?", "Yes. Paste it into Text to video and every sentence or two becomes a scene with its own picture, in the same painted style if you like."],
    ],
  },
  mysteries: {
    intro: "Unsolved mysteries keep people watching to the last second. Name a case and the generator lays out what is known, the leading theories and the question that remains, over vintage-style scenes and a mysterious soundtrack.",
    ideas: ["The village that vanished overnight", "A manuscript nobody can read", "Lights over a desert town", "The ghost ship found with no crew", "The ancient computer pulled from a shipwreck", "The sound from the deep ocean nobody could explain"],
    faq: [
      ["Are the mysteries real?", "Yes: the writer only uses real, well-documented cases and presents theories as theories. Check the draft before the video is made."],
      ["Does it name real people?", "It can mention public historical figures, but it never accuses real private people of anything."],
    ],
  },
  dayinlife: {
    intro: "POV shorts put the viewer in someone else's shoes. Name a job, an era or a wild situation and the generator writes it in the second person (\"You wake up before dawn…\") from morning to night, with vivid, accurate details, a “POV:” line on screen and a picture for every moment.",
    ideas: ["A Roman legionary", "A lighthouse keeper in 1890", "An astronaut on the space station", "A medieval blacksmith", "A chef on a Friday night rush", "You find a door in your basement"],
    faq: [
      ["What's the difference between a POV video and a story?", "A POV video speaks to the viewer as \"you\" and shows a “POV:” line on screen, so it feels like living the moment rather than hearing about it."],
      ["Can it do funny POV scenarios too?", "Yes. Describe a relatable or absurd situation, like \"POV: you wake up with your cat's thoughts in your head\", and it plays out moment by moment with a twist."],
    ],
  },
  facts: {
    intro: "Fun facts are one of the quickest ways to a short people watch to the end. Give it a theme and it picks several surprising, verifiable facts, explains each in a sentence or two and saves the best for last, with playful doodle pictures and an upbeat narrator. It never invents statistics.",
    ideas: ["Your body does this every night", "Animals that never sleep", "Everyday objects with secret purposes", "Facts that sound fake but aren't", "Things you didn't know about bananas", "What happens to your body in space"],
    faq: [
      ["Are the facts checked?", "The writer is told to use only verifiable facts and never to invent numbers, but AI can still get things wrong: read the draft script and correct anything before you make the video."],
      ["How long is a fun facts video?", "45 seconds by default, a good length for Shorts and Reels; you can choose anything up to three minutes."],
    ],
  },
  space: {
    intro: "Space and science shorts work when a huge idea lands in a single picture. Ask a question and the generator explains it simply and accurately with vivid comparisons, in cinematic scenes, ending on a thought that makes people look up.",
    ideas: ["What if the Moon disappeared", "The coldest place in the universe", "Why we can't see most of the universe", "How big a black hole really is", "What a day on Venus is like", "Why the sky is blue"],
    faq: [
      ["Is the science accurate?", "The writer aims for accurate, simple explanations with clear comparisons. AI can be wrong, so read the draft and fix anything before the video is made."],
      ["Can I make longer explainers?", `Yes: any video can run up to three minutes. Longer videos use more credits: one credit per started ${SECONDS_PER_CREDIT} seconds.`],
    ],
  },
  animals: {
    intro: "Animal channels have a near-endless list of topics. Name a creature and the generator tells what makes it extraordinary, with accurate facts and a sense of wonder, painted in soft watercolour and narrated warmly: a good fit for nature, kids and education channels.",
    ideas: ["The octopus has three hearts", "The bird that mimics chainsaws", "The fish that walks on land", "The tardigrade that survives in space", "Why flamingos are pink", "The shrimp that punches faster than a blink"],
    faq: [
      ["Can the videos be for kids?", "Yes, animal facts suit all ages. When a video is meant for children and you post it to YouTube, mark it as made for kids; you choose that for every post."],
      ["Can I choose another art style?", `Yes. Watercolour is the default; you can pick any of the ${styles} art styles before the video is made.`],
    ],
  },
  psychology: {
    intro: "Psychology shorts explain why people do what they do. Name an effect or a study and the generator explains it in plain words with an everyday example and how to use it, in clean illustrations. It sticks to well-established findings and never gives diagnoses or medical advice.",
    ideas: ["The spotlight effect", "Why we remember unfinished tasks", "The power of a name", "The bystander effect", "Why first impressions stick", "Why a deadline makes you work faster"],
    faq: [
      ["Does it give mental health advice?", "No. The videos explain well-established effects and studies for general interest; they never diagnose or give medical advice."],
      ["Which effects make good videos?", "Ones people recognise in themselves: the spotlight effect, the Zeigarnik effect, anchoring, social proof. Start from one of the ideas above."],
    ],
  },
  explained: {
    intro: "Explainer shorts take one complicated thing and make it click. Ask how something works and the generator explains it as if to a curious 12-year-old, built around one great analogy, with doodle pictures and a friendly voice.",
    ideas: ["How does Wi-Fi actually work", "Why prices go up", "What happens when you sleep", "How vaccines train your body", "What inflation really is", "How GPS knows where you are"],
    faq: [
      ["Who are the explainers for?", "Anyone curious: the writer explains at the level of a bright 12-year-old, which works for education channels, students and busy adults alike."],
      ["Can I explain my own product or topic?", "Yes. Describe it in the idea field, or paste your own script into Text to video to keep every word yours."],
    ],
  },
  philosophy: {
    intro: "Philosophy shorts turn big ideas into everyday wisdom. Name a thinker, a school or a thought experiment and the generator explains it in plain words with an everyday example, naming where the idea comes from, in a pencil-sketch style with a calm score.",
    ideas: ["The ship of Theseus", "What Marcus Aurelius wrote to himself", "Plato's cave in 60 seconds", "Stoicism for a bad day", "The trolley problem", "What Nietzsche meant by the abyss"],
    faq: [
      ["Is it only stoicism?", "No: any idea from philosophy (ethics, thought experiments, Eastern philosophy, existentialism) explained with an everyday example and the thinker it comes from."],
      ["Can I make a daily philosophy series?", "Yes. Start a series with Philosophy and choose your days and times; each episode is written and made a few hours before its slot."],
    ],
  },
  lifetips: {
    intro: "Life-tip shorts get saved and shared. Pick a theme and the generator gives practical, safe tips, each in a sentence or two with the most useful one last, in clean illustrations with an upbeat voice.",
    ideas: ["Kitchen tricks chefs use", "Pack a carry-on like a pro", "Make your phone battery last longer", "Cleaning tricks for small apartments", "Spend less on groceries", "Wake up on time without snoozing"],
    faq: [
      ["Are the tips safe to follow?", "The writer is told to give only practical, safe tips. Read the draft before you make the video and cut anything that doesn't suit your audience."],
      ["How many tips fit in one video?", "A handful in the default 45 seconds; choose a longer video for more."],
    ],
  },
  motivation: {
    intro: "Motivation channels live on lines worth remembering. Pick a lesson and the generator tells it through a short story or a vivid example (discipline, habits, mindset), ending on a line that sticks, with cinematic scenes and an inspiring soundtrack.",
    ideas: ["Why the first five minutes decide your day", "The two-day rule", "What a bamboo tree teaches about patience", "The 1% rule", "Why motivation fades and habits don't", "What a marathon runner does at mile 20"],
    faq: [
      ["Will the videos promise money or results?", "No. The writer focuses on practical lessons about habits and mindset and never promises riches or guaranteed results."],
      ["Can I post a motivational video every day?", "Yes. Start a series with daily slots; each episode is made a few hours before it goes out, and you can turn on review to approve each one first."],
    ],
  },
  mashup: {
    intro: "Brainrot mashups are deliberate nonsense: an animal fused with an object, a chant-worthy name, a ridiculous backstory and over-the-top claims, made in a glossy 3D-toy style. Pick an animal and an object and it does the rest: fast, funny and never mean.",
    ideas: ["A shark + a sneaker", "A frog + a toaster", "A giraffe + a trumpet", "A penguin + a vending machine", "A cat + a submarine", "An octopus + an umbrella"],
    faq: [
      ["What is a brainrot video?", "A short, deliberately absurd meme video: a made-up hybrid creature with a silly name the narrator chants, quick scenes and nonsense on purpose."],
      ["Can I change the character's name?", "The generator invents one from the animal and the object; you can change it, and any other line, in the draft before the video is made."],
    ],
  },
  storytime: {
    intro: "Storytime videos pair a question on a title card with a story told over a looping background clip, the format popular with Reddit-style story channels, here with original stories. Ask the question and it writes a casual, specific first-person answer with a turn in the middle and a satisfying ending, with bold word-by-word captions.",
    ideas: ["What decision quietly changed your life?", "What's the weirdest thing a stranger said to you?", "What did you learn too late?", "What's the most awkward thing that happened at your job?", "What small kindness do you still remember?", "What's a rule you broke and never regretted?"],
    faq: [
      ["Are the stories real posts from other people?", "No. Every story is fictional and original, written for you from the question, so you never repost anyone else's words."],
      ["Can I choose the background clip?", "Yes: pick any background clip from the library, and swap it before the video is made."],
    ],
  },
  script: {
    intro: "Already have a script? Paste it and every sentence or two becomes a scene with its own AI picture, narrated by a natural voice with word-by-word subtitles. Your words stay exactly as written; only the pictures are described.",
    ideas: ["A blog post or newsletter section", "A lesson or study notes", "A product update", "A short story you wrote", "A recipe, step by step", "A podcast segment worth retelling"],
    faq: [
      ["How long can my script be?", "Up to 2,400 characters, about two and a half minutes of narration."],
      ["Can I use my own voice?", "Yes. Upload your own recording instead of choosing an AI voice, and the scenes and subtitles follow it."],
    ],
  },
};
