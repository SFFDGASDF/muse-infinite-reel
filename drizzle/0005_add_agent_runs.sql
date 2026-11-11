CREATE TABLE `agent_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`instruction` text DEFAULT '' NOT NULL,
	`target_duration` integer DEFAULT 0 NOT NULL,
	`aspect` text DEFAULT '16:9' NOT NULL,
	`style` text DEFAULT '' NOT NULL,
	`mode` text DEFAULT 'auto' NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`progress_done` integer DEFAULT 0 NOT NULL,
	`progress_total` integer DEFAULT 0 NOT NULL,
	`progress_stage` text DEFAULT '' NOT NULL,
	`package_node_id` text DEFAULT '' NOT NULL,
	`film_request_id` integer DEFAULT 0 NOT NULL,
	`music_mood` text DEFAULT '' NOT NULL,
	`error` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
