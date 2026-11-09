import { PRODUCT } from "./brand";

// The home page's questions. The FAQ page asks them too (shared/faq-page.ts), and the Worker gives that page's to search
// engines as structured data. Kept apart from the FAQ page's own questions, which need the language list, so the home
// page (in the entry bundle) does not load it.

export const homeFaq: [string, string][] = [
  ["Do I have to make the videos myself?", `No. Pick a style and a topic once and ${PRODUCT.name} writes the script, records the voice, draws a picture for every sentence, adds subtitles and music, and renders the video. You can also make single videos whenever you like.`],
  ["Can I edit a video before it goes out?", "Yes. Every video opens in the editor: change the words, redo a picture, swap the voice, music or subtitle style, or move scenes on the timeline. Edits to text and timing are free."],
  ["Does it post to my accounts?", "Yes, to YouTube: connect your channel and your Shorts post straight to it, now or on your schedule, with the title, description, privacy and \"made for kids\" answer you choose. Posting to TikTok and Instagram Reels is coming soon; until then, download those videos (you get an e-mail when each one is made) and upload them yourself."],
  ["Can I choose when my videos are made?", "Yes. Each series has its own days, times and time zone. Every episode is made several hours ahead of its slot."],
  ["Can I see upcoming videos before their slot?", "Yes. The series page lists the coming slots and the episodes already made for them, with their status. You get an e-mail when each one is ready, and you can turn on review to approve each one."],
  ["Can I download my videos?", "Always. Every video downloads as a 1080 × 1920 MP4, on every plan, including the free trial."],
  ["Can I turn my podcast or stream into clips?", "Yes. Upload the video or paste a link to it — a link to the file, or a Dropbox or Google Drive link (up to 10 minutes on the free trial, up to 2 hours on paid plans) — and we find the moments that stand on their own, give each a virality score, and make the ones you choose into vertical clips that cut to whoever is talking, with captions. A clip costs 1 credit per started minute."],
];
