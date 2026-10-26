-- YouTube API Services policies (server/youtube-data.ts): what YouTube tells us is kept only while we can
-- refresh it. A connected channel's details are read again every week (profile_at: when they last were), and each
-- YouTube post carries the creator's own "made for kids" answer (NULL: not given, YouTube applies the channel's
-- setting).
ALTER TABLE social_accounts ADD COLUMN profile_at INTEGER;
ALTER TABLE publications ADD COLUMN made_for_kids INTEGER CHECK(made_for_kids IN (0,1));
