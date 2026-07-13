-- Migration 0005: Personal Information Hub Expansion

CREATE TABLE IF NOT EXISTS rss_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  feed_url TEXT NOT NULL UNIQUE,
  feed_url_redacted TEXT NOT NULL,
  site_url TEXT,
  title TEXT,
  status TEXT DEFAULT 'active', -- 'active' | 'paused' | 'error'
  interval_minutes INTEGER DEFAULT 10,
  next_check_at TEXT DEFAULT (datetime('now')),
  etag TEXT DEFAULT '',
  last_modified TEXT DEFAULT '',
  last_checked_at TEXT DEFAULT '',
  last_success_at TEXT DEFAULT '',
  consecutive_failures INTEGER DEFAULT 0,
  last_error TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_rss_subscriptions_status_next_check ON rss_subscriptions(status, next_check_at);
CREATE INDEX IF NOT EXISTS idx_rss_subscriptions_feed_url ON rss_subscriptions(feed_url);

CREATE TABLE IF NOT EXISTS rss_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id INTEGER NOT NULL,
  entry_key TEXT NOT NULL,
  guid TEXT DEFAULT '',
  link TEXT DEFAULT '',
  title TEXT DEFAULT '',
  published_at TEXT DEFAULT '',
  content_hash TEXT DEFAULT '',
  image_url TEXT DEFAULT '',
  discovered_at TEXT DEFAULT (datetime('now')),
  UNIQUE(subscription_id, entry_key)
);

CREATE INDEX IF NOT EXISTS idx_rss_entries_subscription_published ON rss_entries(subscription_id, published_at DESC);

CREATE TABLE IF NOT EXISTS notification_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL, -- 'rss' | 'stock' | 'system'
  dedupe_key TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'processing' | 'sent' | 'failed' | 'dead'
  attempts INTEGER DEFAULT 0,
  available_at TEXT DEFAULT (datetime('now')),
  processing_started_at TEXT,
  lease_token TEXT,
  lease_expires_at TEXT,
  sent_at TEXT,
  last_error TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_notification_queue_status_available ON notification_queue(status, available_at);

CREATE TABLE IF NOT EXISTS tracker_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_type TEXT NOT NULL,
  target_key TEXT NOT NULL,
  target_config_json TEXT NOT NULL,
  condition_type TEXT NOT NULL,
  condition_value REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', -- 'active' | 'paused' | 'triggered' | 'error'
  arm_version INTEGER NOT NULL DEFAULT 1,
  last_value REAL,
  last_observed_at TEXT,
  last_source TEXT,
  triggered_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tracker_rules_status ON tracker_rules(status);

CREATE TABLE IF NOT EXISTS tracker_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  value REAL,
  observed_at TEXT DEFAULT (datetime('now')),
  source TEXT,
  details_json TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tracker_events_rule_observed ON tracker_events(rule_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS bot_sessions (
  chat_id TEXT PRIMARY KEY,
  flow TEXT,
  step TEXT,
  data_json TEXT,
  expires_at TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_bot_sessions_expires ON bot_sessions(expires_at);

CREATE TABLE IF NOT EXISTS daily_usage (
  usage_date TEXT NOT NULL,
  usage_type TEXT NOT NULL,
  count INTEGER DEFAULT 0,
  PRIMARY KEY (usage_date, usage_type)
);
