CREATE TABLE IF NOT EXISTS authoring_catalog (
  owner_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  localization_key TEXT NOT NULL,
  locale TEXT NOT NULL,
  value TEXT NOT NULL,
  value_hash TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  generation TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, project_id, localization_key, locale)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS authoring_changes (
  owner_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  localization_key TEXT NOT NULL,
  locale TEXT NOT NULL,
  base_value TEXT NOT NULL,
  base_value_hash TEXT NOT NULL,
  next_value TEXT NOT NULL,
  device_id TEXT NOT NULL,
  client_created_at TEXT NOT NULL,
  server_created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'superseded', 'applied', 'conflict', 'rejected')),
  reason TEXT,
  current_value TEXT,
  current_value_hash TEXT,
  PRIMARY KEY (owner_id, event_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_authoring_changes_pending
  ON authoring_changes (owner_id, project_id, status, server_created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_authoring_changes_key
  ON authoring_changes (owner_id, project_id, localization_key, locale, status);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_authoring_catalog_generation
  ON authoring_catalog (owner_id, project_id, generation);
--> statement-breakpoint
PRAGMA optimize;
