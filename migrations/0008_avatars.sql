-- On-screen presenters (shared/presenter.ts): avatars administrators add in Admin → Presenters from HeyGen (its stock
-- avatars, or the account's own by ID). `look_id` is the HeyGen avatar; `engines` the video engines it supports
-- (JSON), which decide the qualities offered. Hidden avatars (active=0) are not offered, but videos that have one
-- keep their presenter video. Each avatar's preview picture lives under avatars/{id}/.
CREATE TABLE avatars (
  id TEXT PRIMARY KEY,
  look_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  gender TEXT NOT NULL DEFAULT '' CHECK(gender IN ('female','male','')),
  engines TEXT NOT NULL DEFAULT '[]',
  preview_key TEXT,
  stock INTEGER NOT NULL DEFAULT 0 CHECK(stock IN (0,1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  sort INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX avatars_order ON avatars(active, sort, name);
CREATE TRIGGER avatar_cleanup AFTER DELETE ON avatars BEGIN INSERT OR IGNORE INTO cleanup_tasks(prefix,created_at) VALUES('avatars/'||OLD.id||'/',unixepoch()); END;
