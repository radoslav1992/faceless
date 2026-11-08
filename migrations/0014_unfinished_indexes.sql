-- Indexes for the maintenance queries that look for unfinished work every few minutes, which otherwise read every
-- video or file: videos still being made or failed (publishing.ts dispatchDue, every minute while a post is due;
-- maintenance.ts reconcileRuns, every five minutes) and uploads not finished, not checked or failed (maintenance.ts
-- expireUploads, hourly). A video's status sits after its large `spec`, so reading every video also read each spec.
--
-- Partial, so they leave out the ready videos and files (nearly all of them) and stay small. SQLite uses a partial
-- index only when one of the query's own conditions is written exactly like one of the index's OR-ed conditions, so
-- each WHERE repeats the statuses as those queries spell them (one IN list with all of them would never be used).
-- tests/ops.test.ts checks the query plans of what maintenance runs.
--
-- Indexes only: the code already running works the same with or without them.
CREATE INDEX videos_unfinished ON videos(render_status, updated_at) WHERE render_status IN ('queued','running') OR render_status='failed';
CREATE INDEX media_unfinished ON media_assets(status, updated_at) WHERE status='uploading' OR status='checking' OR status='failed';
