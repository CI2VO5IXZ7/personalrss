-- Migration 0007: Integrated Output Platform Generator Tables
CREATE TABLE IF NOT EXISTS generator_instances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_type TEXT NOT NULL,
  instance_key TEXT NOT NULL,
  display_name TEXT DEFAULT '',
  config_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  next_refresh_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(provider_type, instance_key)
);

CREATE TABLE IF NOT EXISTS generator_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  generator_id INTEGER NOT NULL,
  item_key TEXT NOT NULL,
  canonical_id TEXT DEFAULT '',
  content_hash TEXT DEFAULT '',
  title TEXT DEFAULT '',
  description_html TEXT DEFAULT '',
  link TEXT DEFAULT '',
  published_at TEXT DEFAULT '',
  media_type TEXT DEFAULT '',
  image_url TEXT DEFAULT '',
  raw_images_json TEXT DEFAULT '[]',
  fetched_at TEXT DEFAULT (datetime('now')),
  UNIQUE(generator_id, item_key)
);

CREATE TABLE IF NOT EXISTS generator_status (
  generator_id INTEGER PRIMARY KEY,
  last_attempt_at TEXT,
  last_success_at TEXT,
  last_result TEXT DEFAULT '',
  last_error TEXT DEFAULT '',
  consecutive_failures INTEGER DEFAULT 0,
  last_item_count INTEGER DEFAULT 0,
  last_new_count INTEGER DEFAULT 0,
  last_duration_ms INTEGER DEFAULT 0,
  last_alerted_failure_count INTEGER DEFAULT 0,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_generator_instances_active_due
  ON generator_instances(next_refresh_at) WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_generator_items_published
  ON generator_items(generator_id, published_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_generator_items_canonical_unique
  ON generator_items(generator_id, canonical_id) WHERE canonical_id <> '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_generator_items_content_hash_unique
  ON generator_items(generator_id, content_hash) WHERE content_hash <> '';
