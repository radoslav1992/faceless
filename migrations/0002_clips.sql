-- Clips from long videos (shared/highlights.ts, server/highlights.ts): a long video's speech can be transcribed for
-- credits, as a run of kind 'speech' (at most one at a time per file). Videos of format 'highlight' need no change
-- (`videos.kind` has no CHECK).
--
-- SQLite cannot change a CHECK constraint, so `runs` is rebuilt with every row, index and trigger. No table references
-- runs, so dropping it cascades nowhere; D1 keeps foreign keys on, and defer_foreign_keys covers the moment the rows
-- are copied back. DROP TABLE fires no triggers, and the rows are copied back before the triggers are created, so no
-- credit is charged or refunded twice. The triggers of other tables that read runs (video_busy, user_busy) find the new
-- table by its name.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE runs_copy AS SELECT * FROM runs;
DROP TABLE runs;
CREATE TABLE runs (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, video_id TEXT REFERENCES videos(id) ON DELETE CASCADE, window_id TEXT NOT NULL REFERENCES usage_windows(id), idempotency_key TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'video' CHECK(kind IN ('video','speech')), credits INTEGER NOT NULL DEFAULT 0 CHECK(credits>=0), status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed')), phase TEXT, payload TEXT NOT NULL DEFAULT '{}', provider TEXT NOT NULL DEFAULT '{}', error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(user_id, idempotency_key));
INSERT INTO runs(id,user_id,video_id,window_id,idempotency_key,kind,credits,status,phase,payload,provider,error,created_at,updated_at)
  SELECT id,user_id,video_id,window_id,idempotency_key,kind,credits,status,phase,payload,provider,error,created_at,updated_at FROM runs_copy;
DROP TABLE runs_copy;
CREATE INDEX runs_user ON runs(user_id, created_at DESC);
CREATE INDEX runs_active ON runs(status, created_at);
CREATE UNIQUE INDEX one_active_run_per_video ON runs(video_id) WHERE status IN ('queued','running') AND video_id IS NOT NULL;
-- A file is transcribed for credits once at a time (two requests cannot both pay).
CREATE UNIQUE INDEX one_active_speech_per_asset ON runs(json_extract(payload,'$.assetId')) WHERE kind='speech' AND status IN ('queued','running');
CREATE INDEX runs_uncleared ON runs(updated_at) WHERE provider<>'{}';
CREATE TRIGGER run_active_limit BEFORE INSERT ON runs BEGIN
 SELECT RAISE(ABORT,'RUNS_BUSY') WHERE (SELECT COUNT(*) FROM runs WHERE user_id=NEW.user_id AND status IN ('queued','running'))>=20;
END;
CREATE TRIGGER run_credit_reserve BEFORE INSERT ON runs BEGIN
 SELECT RAISE(ABORT,'QUOTA_EXCEEDED') WHERE NOT EXISTS(SELECT 1 FROM usage_windows WHERE id=NEW.window_id AND user_id=NEW.user_id AND used+NEW.credits<=quota);
END;
CREATE TRIGGER run_credit_charge AFTER INSERT ON runs WHEN NEW.credits>0 BEGIN UPDATE usage_windows SET used=used+NEW.credits WHERE id=NEW.window_id; END;
CREATE TRIGGER run_refund AFTER UPDATE OF status ON runs WHEN NEW.status='failed' AND OLD.status IN ('queued','running') BEGIN
 UPDATE usage_windows SET used=MAX(0,used-NEW.credits) WHERE id=NEW.window_id;
END;

-- The Clips page lists the owner's video uploads with what was found in them.
CREATE INDEX videos_highlight_source ON videos(user_id, json_extract(spec,'$.source.assetId')) WHERE kind='highlight';
