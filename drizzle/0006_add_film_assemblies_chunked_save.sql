CREATE TABLE `film_assemblies` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `request_id` integer NOT NULL,
  `project_id` integer NOT NULL,
  `package_node_id` text NOT NULL DEFAULT '',
  `chunk_count` integer NOT NULL DEFAULT 0,
  `total_bytes` integer NOT NULL DEFAULT 0,
  `sha256` text NOT NULL DEFAULT '',
  `mime` text NOT NULL DEFAULT 'video/mp4',
  `status` text NOT NULL DEFAULT 'open',
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `film_assemblies_request_idx` ON `film_assemblies` (`request_id`);
--> statement-breakpoint
CREATE TABLE `film_chunks` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `assembly_id` integer NOT NULL,
  `idx` integer NOT NULL,
  `blob_key` text NOT NULL DEFAULT '',
  `byte_length` integer NOT NULL DEFAULT 0,
  `sha256` text NOT NULL DEFAULT '',
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `film_chunks_assembly_idx` ON `film_chunks` (`assembly_id`, `idx`);
