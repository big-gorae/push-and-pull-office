CREATE TABLE IF NOT EXISTS authoring_workspace (
  owner_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  project_title TEXT NOT NULL,
  default_locale TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  generation TEXT NOT NULL,
  workspace_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, project_id)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS authoring_scene_changes (
  owner_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  scene_id TEXT NOT NULL,
  base_scene_hash TEXT NOT NULL,
  next_scene_hash TEXT NOT NULL,
  base_scene_json TEXT NOT NULL,
  next_scene_json TEXT NOT NULL,
  device_id TEXT NOT NULL,
  client_created_at TEXT NOT NULL,
  server_created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'superseded', 'applied', 'conflict', 'rejected')),
  reason TEXT,
  current_scene_json TEXT,
  current_scene_hash TEXT,
  PRIMARY KEY (owner_id, event_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_authoring_scene_changes_pending
  ON authoring_scene_changes (owner_id, project_id, status, server_created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_authoring_scene_changes_scene
  ON authoring_scene_changes (owner_id, project_id, scene_id, status);
--> statement-breakpoint
PRAGMA optimize;
