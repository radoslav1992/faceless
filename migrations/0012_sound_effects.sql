-- Sound effects (shared/sounds.ts): the shared library gains short sounds ('sfx') that videos play over the voice: a
-- whoosh on every scene change (category "Transition") and a scene's own sound (fire, waves, a crowd), which the
-- writer picks and people change in the editor. Administrators add them in Admin → Library, uploaded or made with
-- ElevenLabs. SQLite can't change a CHECK constraint, so the table is rebuilt with its rows (as in 0004); nothing
-- references it.
DROP TRIGGER IF EXISTS library_cleanup;
CREATE TABLE library_items_next (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('music','clip','image','sfx')),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  object_key TEXT NOT NULL UNIQUE,
  thumb_key TEXT,
  mime TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  duration REAL NOT NULL DEFAULT 0,
  width INTEGER NOT NULL DEFAULT 0,
  height INTEGER NOT NULL DEFAULT 0,
  ai INTEGER NOT NULL DEFAULT 0 CHECK(ai IN (0,1)),
  source_asset TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  category TEXT NOT NULL DEFAULT ''
);
INSERT INTO library_items_next(id,kind,name,description,tags,object_key,thumb_key,mime,bytes,duration,width,height,ai,source_asset,active,created_at,category)
  SELECT id,kind,name,description,tags,object_key,thumb_key,mime,bytes,duration,width,height,ai,source_asset,active,created_at,category FROM library_items;
DROP TABLE library_items;
ALTER TABLE library_items_next RENAME TO library_items;
CREATE INDEX library_browse ON library_items(kind, active, created_at DESC);
CREATE TRIGGER library_cleanup AFTER DELETE ON library_items BEGIN INSERT OR IGNORE INTO cleanup_tasks(prefix,created_at) VALUES('library/'||OLD.id||'/',unixepoch()); END;
