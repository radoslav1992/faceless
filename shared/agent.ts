// The assistant: a chat in which an agent makes videos with the app's own tools (server/agent.ts). It writes drafts,
// suggests music, sounds, clips, pictures and voices the owner can see and play in the chat, and makes videos; before
// anything that spends credits it shows what will be made and what it costs, and waits for the owner to confirm.
// Skills are named instructions the agent loads when a request fits them: the administrators' for everyone, and each
// owner's own. A test, for administrators, until AGENT_OPEN.

/** Whether everyone has the assistant (else administrators only: server/agent.ts, the menu). */
export const AGENT_OPEN = false;
/** The longest message a person sends. */
export const AGENT_MESSAGE_MAX = 4000;
/** A skill's limits, and how many a person keeps. */
export const SKILL_NAME_MAX = 60, SKILL_DESCRIPTION_MAX = 200, SKILL_BODY_MAX = 8000, SKILLS_MAX = 20;

/** Something to see or play in the chat. */
export type MediaItem = {
  /** Where it is from: the site's library, the owner's files, or the voices. */
  source: "library" | "file" | "voice";
  id: string;
  /** How it is shown: a picture, a video player or an audio player. */
  show: "image" | "video" | "audio";
  /** What it is, in a word: music, a sound, a clip, a picture, a voice, a file. */
  kind: string;
  name: string;
  url: string | null;
  thumb?: string | null;
  duration?: number;
  /** Why the agent suggests it. */
  note?: string;
};
/** A draft as the chat shows it. */
export type DraftCard = {
  type: "draft"; id: string; title: string; template: string; templateName: string; style: string; voice: string; seconds: number; credits: number;
  scenes: { text: string; picture: string }[];
};
export type Card =
  | { type: "media"; items: MediaItem[] }
  | DraftCard
  | { type: "video"; id: string; title: string }
  /** Answers the owner can tap instead of typing (a length, a voice, a style). */
  | { type: "replies"; options: string[] };

/** Something that spends credits, waiting for the owner's word. */
export type PendingAction = {
  /** The tool call it answers. */
  id: string;
  tool: string;
  /** What will be made, in a line. */
  summary: string;
  /** What it costs. */
  credits: number;
  status: "pending" | "confirmed" | "declined";
};
/** One step of the agent's work, as the chat shows it. */
export type Step = { tool: string; ok: boolean };
/** A chat's messages as the app shows them. */
export type ChatItem =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; text: string; steps: Step[]; cards: Card[]; actions: PendingAction[] };
/** What a turn sends while it works (server-sent events: one JSON object per `data:` line). */
export type TurnEvent =
  /** The model's words as it writes them; `text` then gives the whole message, and `undo` takes back what was streamed. */
  | { event: "delta"; text: string }
  | { event: "undo" }
  | { event: "text"; text: string }
  | { event: "step"; tool: string; state: "start" | "done" | "failed" }
  | { event: "card"; card: Card }
  | { event: "action"; action: PendingAction }
  | { event: "error"; message: string }
  | { event: "done"; items: ChatItem[]; title: string; waiting: boolean };

export type SkillView = { id: string; name: string; description: string; body: string; enabled: boolean; site: boolean };
