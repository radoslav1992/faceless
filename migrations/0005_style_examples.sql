-- An example video for each faceless style (shared/templates.ts), shown on its card in Create, on the home page and
-- on the tool pages. Administrators choose one of their own finished videos in Admin → Examples; it is copied, so the
-- example stays when the video is deleted. A new choice gets a new id (and new file addresses, cached for good).
CREATE TABLE style_examples (
  template TEXT PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  video_key TEXT NOT NULL,
  poster_key TEXT,
  duration REAL NOT NULL DEFAULT 0,
  -- The video it was copied from (NULL once that video is deleted).
  source_video TEXT REFERENCES videos(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
-- Each example's files live under examples/{id}/ (the video and its poster).
CREATE TRIGGER style_example_cleanup AFTER DELETE ON style_examples BEGIN INSERT OR IGNORE INTO cleanup_tasks(prefix,created_at) VALUES('examples/'||OLD.id||'/',unixepoch()); END;
