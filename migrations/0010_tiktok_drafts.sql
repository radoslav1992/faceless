-- TikTok drafts (server/social/tiktok.ts): until TikTok audits the app for Direct Post, videos go to the creator's
-- TikTok inbox as drafts, which they finish and post in the TikTok app. Such a publication ends 'published' with
-- draft=1 once TikTok has delivered it to the inbox: it has no post link and no stats.
ALTER TABLE publications ADD COLUMN draft INTEGER NOT NULL DEFAULT 0 CHECK(draft IN (0,1));
