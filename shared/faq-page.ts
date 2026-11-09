import { languages } from "./series";
import { homeFaq } from "./faq";

// The FAQ page's questions: the home page's and a few more (the page, and its structured data in the Worker).

/** The FAQ page: the home page's questions and a few more. */
export const faqPage: [string, string][] = [
  ...homeFaq,
  ["Which languages can the narration use?", `${languages.length} languages, from English, Spanish and Portuguese to German, Polish, Turkish, Greek and Ukrainian. Subtitles follow the narration.`],
  ["Who owns the videos?", "You do. You can use everything you make commercially, on any channel. The scripts and pictures are generated new for each video."],
  ["Are the videos marked as AI-generated?", "Yes, where the networks ask for it: the files carry AI metadata, and TikTok and YouTube get their AI-content labels when we post for you."],
  ["How long does a video take?", "Usually a few minutes: the script, the voice, a picture for every scene, then the render. Series episodes are made hours ahead of their slot."],
  ["Can I cancel any time?", "Yes, in Billing. Your plan runs to the end of the period you paid for, and your videos stay downloadable."],
];
