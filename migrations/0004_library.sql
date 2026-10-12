-- The shared library gains pictures (scenes can show them), a description people search by, and `ai` for files made
-- with AI (videos that use one are disclosed as AI-made when they are published, like the owner's AI pictures).
-- Administrators fill it in Admin → Library: uploads, or their own media (an AI picture or clip they made) with its
-- details. SQLite can't change a CHECK constraint, so the table is rebuilt with its rows; nothing references it.
DROP TRIGGER IF EXISTS library_cleanup;
CREATE TABLE library_items_next (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('music','clip','image')),
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
  -- The administrator's media file it was copied from (NULL: uploaded), so a file isn't added twice.
  source_asset TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
INSERT INTO library_items_next(id,kind,name,tags,object_key,thumb_key,mime,bytes,duration,width,height,active,created_at)
  SELECT id,kind,name,tags,object_key,thumb_key,mime,bytes,duration,width,height,active,created_at FROM library_items;
DROP TABLE library_items;
ALTER TABLE library_items_next RENAME TO library_items;
CREATE INDEX library_browse ON library_items(kind, active, created_at DESC);
-- Each item's files live under library/{id}/ (the file and its thumbnail).
CREATE TRIGGER library_cleanup AFTER DELETE ON library_items BEGIN INSERT OR IGNORE INTO cleanup_tasks(prefix,created_at) VALUES('library/'||OLD.id||'/',unixepoch()); END;
