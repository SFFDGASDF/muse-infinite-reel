CREATE TABLE film_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  package_node_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued',
  shots_json TEXT NOT NULL DEFAULT '[]',
  shot_count INTEGER NOT NULL DEFAULT 0,
  film_blob_key TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX film_requests_project_idx ON film_requests (project_id, id);
