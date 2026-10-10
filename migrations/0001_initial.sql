PRAGMA foreign_keys = ON;

-- Accounts ---------------------------------------------------------------------------------------------------------
CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL, password_hash TEXT NOT NULL, verified INTEGER NOT NULL DEFAULT 0, stripe_customer TEXT UNIQUE, created_at INTEGER NOT NULL);
CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX sessions_expires ON sessions(expires_at);
CREATE TABLE auth_tokens (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK(kind IN ('verify','reset')), expires_at INTEGER NOT NULL);
CREATE INDEX auth_tokens_user ON auth_tokens(user_id);
CREATE INDEX auth_tokens_expires ON auth_tokens(expires_at);
CREATE TABLE rate_limits (key TEXT PRIMARY KEY, hits INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX rate_limits_expires ON rate_limits(expires_at);
-- Evidence of accepted terms; kept after the account is deleted (no foreign key), then removed by retention.
CREATE TABLE terms_acceptances (user_id TEXT NOT NULL, version TEXT NOT NULL, accepted_at INTEGER NOT NULL, account_deleted_at INTEGER, PRIMARY KEY(user_id, version));
CREATE INDEX terms_acceptances_deleted ON terms_acceptances(account_deleted_at) WHERE account_deleted_at IS NOT NULL;
CREATE TABLE contact_messages (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, topic TEXT NOT NULL, message TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX contact_messages_created ON contact_messages(created_at);
-- R2 keys (or key prefixes) still to delete; drained by maintenance.
CREATE TABLE cleanup_tasks (prefix TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
CREATE INDEX cleanup_tasks_created ON cleanup_tasks(created_at);
CREATE INDEX users_unconfirmed ON users(created_at) WHERE verified=0;

-- Billing ----------------------------------------------------------------------------------------------------------
CREATE TABLE subscriptions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, plan TEXT NOT NULL, status TEXT NOT NULL, period_start INTEGER NOT NULL, period_end INTEGER NOT NULL, cancel_at_period_end INTEGER NOT NULL DEFAULT 0, event_created INTEGER NOT NULL DEFAULT 0);
CREATE INDEX subscriptions_user ON subscriptions(user_id);
CREATE TABLE stripe_status (subscription_id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, status TEXT NOT NULL, fetched_at INTEGER NOT NULL);
CREATE TABLE stripe_reconciled (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, checked_at INTEGER NOT NULL);
CREATE TABLE billing_events (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
CREATE INDEX billing_events_created ON billing_events(created_at);
CREATE TABLE checkout_intents (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, plan TEXT NOT NULL, intent_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX checkout_intents_expires ON checkout_intents(expires_at);
-- One usage window per paid month (user:subscription:period_start, plus :n for the n-th month of a yearly period) or
-- the lasting free window (user:trial). `quota`/`used` are credits: the plan's monthly credits, `carried` over from the
-- month before (unused credits roll over, server/billing.ts) and `topped` up with credit packs bought in that month.
CREATE TABLE usage_windows (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, plan TEXT, quota INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0 CHECK(used>=0), carried INTEGER NOT NULL DEFAULT 0, topped INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT 0);
CREATE INDEX usage_windows_user ON usage_windows(user_id, created_at);
-- The free allowance is once per mailbox, also across deleted accounts (keyed HMAC of the mailbox).
CREATE TABLE trial_history (email_hash TEXT PRIMARY KEY, used INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0);
CREATE INDEX trial_history_updated ON trial_history(updated_at);
-- Credit packs bought with a one-time Stripe Checkout payment (one row per paid session; `window_id`: where they were
-- added). `refunded`: the pack's unused credits were taken back after a refund.
CREATE TABLE credit_topups (session_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, pack TEXT NOT NULL, credits INTEGER NOT NULL CHECK(credits>0), amount INTEGER NOT NULL, currency TEXT NOT NULL DEFAULT 'usd', payment_intent TEXT, window_id TEXT, refunded INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE INDEX credit_topups_user ON credit_topups(user_id, created_at);
CREATE INDEX credit_topups_payment ON credit_topups(payment_intent);
CREATE TABLE media_limits (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, max_bytes INTEGER NOT NULL);
-- The consumer's express request, given before a first checkout, for the plan to start at once (CRD Art. 14(3) and
-- 16(m)): one row per Stripe Checkout session, with the version of the text agreed to. No foreign key to users: kept
-- as evidence after the account is deleted (`account_deleted_at`), then removed by retention.
CREATE TABLE checkout_consents (
 session_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, plan TEXT NOT NULL, version TEXT NOT NULL,
 created_at INTEGER NOT NULL, completed_at INTEGER, confirmed_at INTEGER, account_deleted_at INTEGER
);
CREATE INDEX checkout_consents_user ON checkout_consents(user_id);
CREATE INDEX checkout_consents_pending ON checkout_consents(completed_at) WHERE confirmed_at IS NULL;
CREATE INDEX checkout_consents_deleted ON checkout_consents(account_deleted_at) WHERE account_deleted_at IS NOT NULL;
-- A withdrawal handled by an administrator: the plan ends, its credits stop, and what was paid comes back less the
-- share of the month's credits used. Amounts in cents of `currency`. One per subscription; kept as evidence (no foreign
-- key), then removed by retention.
CREATE TABLE withdrawals (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL, subscription_id TEXT NOT NULL UNIQUE, currency TEXT NOT NULL DEFAULT 'usd',
 paid INTEGER NOT NULL CHECK(paid>=0), refund INTEGER NOT NULL CHECK(refund>=0), refunded INTEGER NOT NULL DEFAULT 0,
 used INTEGER NOT NULL, quota INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('started','completed','refund_failed')), error TEXT,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX withdrawals_recent ON withdrawals(created_at);
CREATE TRIGGER evidence_account_deleted BEFORE DELETE ON users BEGIN
 UPDATE terms_acceptances SET account_deleted_at=unixepoch() WHERE user_id=OLD.id AND account_deleted_at IS NULL;
 UPDATE checkout_consents SET account_deleted_at=unixepoch() WHERE user_id=OLD.id AND account_deleted_at IS NULL;
END;

-- Social accounts ----------------------------------------------------------------------------------------------------
-- `credentials` is AES-GCM encrypted JSON (TOKEN_ENCRYPTION_KEY); never returned to the browser.
CREATE TABLE social_accounts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, platform TEXT NOT NULL CHECK(platform IN ('tiktok','instagram','youtube')), external_id TEXT NOT NULL, name TEXT NOT NULL, handle TEXT, avatar_url TEXT, credentials TEXT NOT NULL, expires_at INTEGER, status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','expired','revoked')), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(user_id, platform, external_id));
CREATE INDEX social_accounts_status ON social_accounts(status, updated_at);
-- A connection under way: single-use, short-lived, bound to the user who started it; `back`: the app page to return to.
CREATE TABLE oauth_states (state_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, platform TEXT NOT NULL, verifier TEXT NOT NULL, back TEXT NOT NULL DEFAULT '/app/channels', expires_at INTEGER NOT NULL);
CREATE INDEX oauth_states_expires ON oauth_states(expires_at);

-- Series: a faceless channel on autopilot --------------------------------------------------------------------------
-- `template`: its faceless style (shared/templates.ts). `settings` (shared/series.ts): the owner's prompt, language, voice, art style, music, length, subtitles, the channels
-- it posts to, the posting schedule, autopilot or review, e-mail notices. The cron makes the episode of `next_slot`
-- ahead of time (server/series.ts); `blocked` says why the last slot was skipped (no videos or credits left, writer
-- failures), `failures` counts failed attempts at the current slot.
CREATE TABLE series (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, template TEXT NOT NULL, settings TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused')), next_slot INTEGER, attempted_at INTEGER, failures INTEGER NOT NULL DEFAULT 0, blocked TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX series_user ON series(user_id, created_at);
CREATE INDEX series_due ON series(status, next_slot);

-- Videos and their generation runs -----------------------------------------------------------------------------------
-- A video of a series is made for one posting slot (`slot_at`); one made by hand has none. `kind` is its video type
-- (shared/templates.ts). `status` is the review state (autopilot episodes are approved when they are made);
-- `render_status` the state of the finished media.
CREATE TABLE videos (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, series_id TEXT REFERENCES series(id) ON DELETE SET NULL, kind TEXT NOT NULL DEFAULT 'story', slot_at INTEGER, spec TEXT NOT NULL, hook TEXT NOT NULL DEFAULT '', caption TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')), render_status TEXT NOT NULL DEFAULT 'queued' CHECK(render_status IN ('queued','running','ready','failed')), render_error TEXT, video_asset TEXT, cover_asset TEXT, duration REAL NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1, notified_at INTEGER, reviewed_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX videos_user ON videos(user_id, created_at DESC);
CREATE INDEX videos_series ON videos(series_id, created_at DESC);
CREATE UNIQUE INDEX videos_series_slot ON videos(series_id, slot_at) WHERE series_id IS NOT NULL AND slot_at IS NOT NULL;

-- A run generates (AI pictures and clips, the voice) and renders a video. Credits are reserved in the same transaction
-- as the insert and refunded exactly once when it fails.
CREATE TABLE runs (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, video_id TEXT REFERENCES videos(id) ON DELETE CASCADE, window_id TEXT NOT NULL REFERENCES usage_windows(id), idempotency_key TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'video' CHECK(kind IN ('video')), credits INTEGER NOT NULL DEFAULT 0 CHECK(credits>=0), status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed')), phase TEXT, payload TEXT NOT NULL DEFAULT '{}', provider TEXT NOT NULL DEFAULT '{}', error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(user_id, idempotency_key));
CREATE INDEX runs_user ON runs(user_id, created_at DESC);
CREATE INDEX runs_active ON runs(status, created_at);
CREATE UNIQUE INDEX one_active_run_per_video ON runs(video_id) WHERE status IN ('queued','running') AND video_id IS NOT NULL;
-- Finished runs whose provider state (tickets, input-link token, voice timings) has not been cleared yet.
CREATE INDEX runs_uncleared ON runs(updated_at) WHERE provider<>'{}';
CREATE TRIGGER run_active_limit BEFORE INSERT ON runs BEGIN
 SELECT RAISE(ABORT,'RUNS_BUSY') WHERE (SELECT COUNT(*) FROM runs WHERE user_id=NEW.user_id AND status IN ('queued','running'))>=20;
END;
CREATE TRIGGER run_credit_reserve BEFORE INSERT ON runs BEGIN
 SELECT RAISE(ABORT,'QUOTA_EXCEEDED') WHERE NOT EXISTS(SELECT 1 FROM usage_windows WHERE id=NEW.window_id AND user_id=NEW.user_id AND used+NEW.credits<=quota);
END;
CREATE TRIGGER run_credit_charge AFTER INSERT ON runs WHEN NEW.credits>0 BEGIN UPDATE usage_windows SET used=used+NEW.credits WHERE id=NEW.window_id; END;
CREATE TRIGGER run_refund AFTER UPDATE OF status ON runs WHEN NEW.status='failed' AND OLD.status IN ('queued','running') BEGIN
 UPDATE usage_windows SET used=MAX(0,used-NEW.credits) WHERE id=NEW.window_id;
END;

-- Media ------------------------------------------------------------------------------------------------------------
-- Uploads, AI pictures and clips, voices and rendered outputs. Files generated for a video belong to it (video_id) and
-- go with it.
CREATE TABLE media_assets (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, video_id TEXT REFERENCES videos(id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK(kind IN ('upload','ai_image','ai_clip','voice','render','cover')), name TEXT NOT NULL, object_key TEXT NOT NULL UNIQUE, mime TEXT NOT NULL, bytes INTEGER NOT NULL DEFAULT 0, duration REAL NOT NULL DEFAULT 0, width INTEGER NOT NULL DEFAULT 0, height INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'ready' CHECK(status IN ('uploading','checking','ready','failed')), upload_id TEXT, meta TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX media_user ON media_assets(user_id, created_at DESC);
CREATE INDEX media_video ON media_assets(video_id);
CREATE TRIGGER media_storage_limit BEFORE INSERT ON media_assets BEGIN
 SELECT RAISE(ABORT,'STORAGE_FULL') WHERE NEW.bytes + COALESCE((SELECT SUM(bytes) FROM media_assets WHERE user_id=NEW.user_id),0) > COALESCE((SELECT max_bytes FROM media_limits WHERE user_id=NEW.user_id),0);
END;
CREATE TRIGGER media_file_limit BEFORE INSERT ON media_assets BEGIN
 SELECT RAISE(ABORT,'STORAGE_FULL') WHERE (SELECT COUNT(*) FROM media_assets WHERE user_id=NEW.user_id)>=5000;
END;
CREATE TRIGGER media_cleanup AFTER DELETE ON media_assets BEGIN INSERT OR IGNORE INTO cleanup_tasks(prefix,created_at) VALUES(OLD.object_key,unixepoch()); END;
CREATE TABLE media_parts (asset_id TEXT NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE, part INTEGER NOT NULL, etag TEXT NOT NULL, bytes INTEGER NOT NULL, PRIMARY KEY(asset_id, part));
-- The shared library administrators fill: background music (tagged with moods) and short video clips scenes can use.
-- Videos reference them without a copy.
CREATE TABLE library_items (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('music','clip')), name TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '', object_key TEXT NOT NULL UNIQUE, thumb_key TEXT, mime TEXT NOT NULL, bytes INTEGER NOT NULL, duration REAL NOT NULL DEFAULT 0, width INTEGER NOT NULL DEFAULT 0, height INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
-- Each item's files live under library/{id}/ (the file and its thumbnail).
CREATE TRIGGER library_cleanup AFTER DELETE ON library_items BEGIN INSERT OR IGNORE INTO cleanup_tasks(prefix,created_at) VALUES('library/'||OLD.id||'/',unixepoch()); END;

-- Publishing -------------------------------------------------------------------------------------------------------
-- A disconnected account leaves its published history (account_id NULL, `account_name` kept). `private`: posted so only
-- the account sees it (TikTok, YouTube). The counts are the network's lifetime numbers for the published video (NULL:
-- not read, or not reported by the network).
CREATE TABLE publications (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE, account_id TEXT REFERENCES social_accounts(id) ON DELETE SET NULL, account_name TEXT NOT NULL DEFAULT '', platform TEXT NOT NULL, scheduled_at INTEGER NOT NULL, private INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled','publishing','published','failed','canceled')), attempts INTEGER NOT NULL DEFAULT 0, token TEXT, ticket TEXT, external_id TEXT, url TEXT, error TEXT, claimed_at INTEGER, published_at INTEGER, views INTEGER, likes INTEGER, comments INTEGER, shares INTEGER, saves INTEGER, metrics_at INTEGER, metrics_checked_at INTEGER, metrics_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX publications_due ON publications(status, scheduled_at);
CREATE INDEX publications_user ON publications(user_id, scheduled_at);
CREATE INDEX publications_video ON publications(video_id);
CREATE INDEX publications_published ON publications(status, published_at);
-- Publications that still hold a media-link token or a provider ticket (published ones drop both at once).
CREATE INDEX publications_spent ON publications(updated_at) WHERE token IS NOT NULL OR ticket IS NOT NULL;
CREATE UNIQUE INDEX publication_once ON publications(video_id, account_id) WHERE status IN ('scheduled','publishing','published');

-- API access ------------------------------------------------------------------------------------------------------
-- Personal API keys for the REST API and the MCP server (server/api.ts): only a SHA-256 of the key is stored.
CREATE TABLE api_keys (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL, last_used_at INTEGER, created_at INTEGER NOT NULL);
CREATE INDEX api_keys_user ON api_keys(user_id, created_at);

-- Operations -------------------------------------------------------------------------------------------------------
-- Small records kept by maintenance (the last hourly run, failed stages, the last operator alert, the last Stripe
-- reconciliation), and provider work or storage cleanup set aside for a manual check.
CREATE TABLE operations_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE manual_reviews (area TEXT NOT NULL, ref TEXT NOT NULL, request_id TEXT, reason TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(area, ref));
CREATE INDEX manual_reviews_recent ON manual_reviews(created_at);

-- Nothing in progress is deleted from under its worker.
CREATE TRIGGER video_busy BEFORE DELETE ON videos WHEN EXISTS(SELECT 1 FROM runs WHERE video_id=OLD.id AND status IN ('queued','running')) OR EXISTS(SELECT 1 FROM publications WHERE video_id=OLD.id AND status='publishing') BEGIN SELECT RAISE(ABORT,'VIDEO_BUSY'); END;
CREATE TRIGGER account_busy BEFORE DELETE ON social_accounts WHEN EXISTS(SELECT 1 FROM publications WHERE account_id=OLD.id AND status='publishing') BEGIN SELECT RAISE(ABORT,'ACCOUNT_BUSY'); END;
CREATE TRIGGER user_busy BEFORE DELETE ON users WHEN EXISTS(SELECT 1 FROM runs WHERE user_id=OLD.id AND status IN ('queued','running')) OR EXISTS(SELECT 1 FROM publications WHERE user_id=OLD.id AND status='publishing') BEGIN SELECT RAISE(ABORT,'USER_BUSY'); END;
CREATE TRIGGER user_cleanup BEFORE DELETE ON users BEGIN INSERT OR IGNORE INTO cleanup_tasks(prefix,created_at) VALUES('media/'||OLD.id||'/',unixepoch()); END;
