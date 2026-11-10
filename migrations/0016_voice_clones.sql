-- Cloned voices: a customer's own voice, made from a sample they uploaded (ElevenLabs Instant Voice Cloning, in the
-- operator's ElevenLabs account) and offered to that customer alone (server/voice-clones.ts). A table of their own,
-- never a row of `voices`: nothing that lists the voices everyone can choose, or that administrators manage, can
-- ever show one. `id` is the public ID videos and series keep ("clone-" and 12 hex digits); `provider_id` the
-- ElevenLabs voice; `preview_key` a short sample spoken by the clone, in the owner's own folder.
CREATE TABLE voice_clones (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  preview_key TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX voice_clones_user ON voice_clones(user_id, created_at);
-- ElevenLabs voices still to delete there (a deleted clone, a deleted account, a clone that could not be saved):
-- tried at once and then hourly until ElevenLabs confirms (a person's voice must not stay behind in the account).
CREATE TABLE voice_removals (provider_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
-- The owner's statement, given before a voice is cloned, that the voice is theirs or that they have the speaker's
-- permission: the version of the text agreed to (shared/voices.ts), nothing of the voice itself. No foreign keys: kept
-- as evidence after the clone or the account is deleted (`ended_at`), then removed by retention.
CREATE TABLE voice_consents (voice_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, version TEXT NOT NULL, created_at INTEGER NOT NULL, ended_at INTEGER);
CREATE INDEX voice_consents_ended ON voice_consents(ended_at) WHERE ended_at IS NOT NULL;
-- A clone that goes (deleted by its owner, or with the account) takes its ElevenLabs voice and its sample with it.
CREATE TRIGGER voice_clone_deleted AFTER DELETE ON voice_clones BEGIN
  INSERT OR IGNORE INTO voice_removals(provider_id,created_at) VALUES (OLD.provider_id,unixepoch());
  INSERT OR IGNORE INTO cleanup_tasks(prefix,created_at) SELECT OLD.preview_key,unixepoch() WHERE OLD.preview_key IS NOT NULL;
  UPDATE voice_consents SET ended_at=unixepoch() WHERE voice_id=OLD.id AND ended_at IS NULL;
END;
-- The same for a deleted account, before its rows go (the sample goes with the account's folder: user_cleanup).
CREATE TRIGGER voice_clones_account_deleted BEFORE DELETE ON users BEGIN
  INSERT OR IGNORE INTO voice_removals(provider_id,created_at) SELECT provider_id,unixepoch() FROM voice_clones WHERE user_id=OLD.id;
  UPDATE voice_consents SET ended_at=unixepoch() WHERE user_id=OLD.id AND ended_at IS NULL;
END;
