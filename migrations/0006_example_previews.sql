-- A short preview of each style example: the first 8 seconds at 540 × 960, without sound (about 1 MB), made by the
-- renderer after the example is chosen. The style cards play it; the full video stays at its own address. Until it
-- is made (or when it couldn't be, after three tries) the cards play the full video.
ALTER TABLE style_examples ADD COLUMN preview_key TEXT;
-- The renderer container working on it (server/renderer.ts slots), while it is being made.
ALTER TABLE style_examples ADD COLUMN preview_slot INTEGER;
ALTER TABLE style_examples ADD COLUMN preview_tries INTEGER NOT NULL DEFAULT 0;
