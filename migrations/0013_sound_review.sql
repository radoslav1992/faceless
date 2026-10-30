-- Sound effects made with ElevenLabs while a video was written, because the library had none that fit a scene
-- (server/sounds.ts): `review` 1 until an administrator approves one for everyone (Admin → Library) or switches it
-- off. Until then it is offered only to the person whose video it was made for (`made_for`); once that account is
-- deleted, to nobody.
ALTER TABLE library_items ADD COLUMN review INTEGER NOT NULL DEFAULT 0 CHECK(review IN (0,1));
ALTER TABLE library_items ADD COLUMN made_for TEXT REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX library_review ON library_items(made_for) WHERE review = 1;
