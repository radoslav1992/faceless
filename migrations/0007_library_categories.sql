-- A library item's genre (music) or category (clips and pictures), from a suggested list or written by an
-- administrator; Admin → Library can have AI suggest it with the description and tags. People search by it too.
ALTER TABLE library_items ADD COLUMN category TEXT NOT NULL DEFAULT '';
