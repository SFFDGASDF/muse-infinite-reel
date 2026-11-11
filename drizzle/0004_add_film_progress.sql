ALTER TABLE film_requests ADD COLUMN progress_done INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE film_requests ADD COLUMN progress_stage TEXT NOT NULL DEFAULT '';
