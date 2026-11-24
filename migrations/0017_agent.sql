-- The assistant (server/agent.ts, shared/agent.ts): chats with an agent that makes videos with the app's tools.
-- Additive: apply it before or after the code that uses it (without it the assistant answers that it isn't set up).

-- A chat. `busy_until` keeps two turns from running in one chat at once (a turn sets it and clears it).
CREATE TABLE agent_chats (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '', busy_until INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX agent_chats_user ON agent_chats(user_id, updated_at DESC);

-- Its messages in order, as the model's API has them (`content`: the blocks, and what the chat shows with them:
-- cards, steps, and the actions that wait for the owner's word). The model's thinking is never stored.
CREATE TABLE agent_messages (
  id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES agent_chats(id) ON DELETE CASCADE, user_id TEXT NOT NULL,
  seq INTEGER NOT NULL, role TEXT NOT NULL CHECK (role IN ('user','assistant')), content TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX agent_messages_chat ON agent_messages(chat_id, seq);

-- The drafts the agent wrote in a chat (a video's spec, not made yet): edited there or in the editor, then made.
CREATE TABLE agent_drafts (
  id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES agent_chats(id) ON DELETE CASCADE, user_id TEXT NOT NULL,
  template TEXT NOT NULL, spec TEXT NOT NULL, video_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX agent_drafts_user ON agent_drafts(user_id, id);

-- Skills: named instructions the agent loads when a request fits. `user_id` NULL: the administrators', for everyone.
CREATE TABLE agent_skills (
  id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, description TEXT NOT NULL, body TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX agent_skills_user ON agent_skills(user_id);
