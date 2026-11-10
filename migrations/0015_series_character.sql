-- A series' main character as it was drawn: the character reference sheet (shared/story.ts characterSheetPrompt) of the
-- first episode that needed it, kept as a file of the series' own (a picture of no video, so it outlives that episode)
-- and used by every later episode instead of a new drawing, so the character looks the same from episode to episode
-- (server/characters.ts). `character_key` is the sheet's key (the fingerprint of its description and art style): a
-- series whose character or style changed draws a new one with its next episode.
--
-- Safe to apply before or after deploying the code: without the columns each episode draws its own sheet, as before.
ALTER TABLE series ADD COLUMN character_asset TEXT REFERENCES media_assets(id) ON DELETE SET NULL;
ALTER TABLE series ADD COLUMN character_key TEXT;
-- The picture goes with its series (and its R2 object with it: media_cleanup).
CREATE TRIGGER series_character_cleanup AFTER DELETE ON series WHEN OLD.character_asset IS NOT NULL BEGIN DELETE FROM media_assets WHERE id=OLD.character_asset; END;
