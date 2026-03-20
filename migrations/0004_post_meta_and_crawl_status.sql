-- Add canonical/content metadata to posts_cache and create crawl_status table

CREATE TABLE IF NOT EXISTS posts_cache_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  user_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  canonical_id TEXT DEFAULT '',
  content_hash TEXT DEFAULT '',
  media_type TEXT DEFAULT '',
  title TEXT DEFAULT '',
  description TEXT DEFAULT '',
  link TEXT DEFAULT '',
  image TEXT DEFAULT '',
  date TEXT DEFAULT '',
  raw_images TEXT DEFAULT '[]',
  fetched_at TEXT DEFAULT (datetime('now')),
  UNIQUE(platform, user_id, post_id)
);

INSERT OR IGNORE INTO posts_cache_new (
  id, platform, user_id, post_id, canonical_id, content_hash, media_type,
  title, description, link, image, date, raw_images, fetched_at
)
SELECT
  id, platform, user_id, post_id, post_id, '', '',
  title, description, link, image, date, raw_images, fetched_at
FROM posts_cache;

DROP TABLE IF EXISTS posts_cache;
ALTER TABLE posts_cache_new RENAME TO posts_cache;

CREATE INDEX IF NOT EXISTS idx_posts_platform_user ON posts_cache(platform, user_id);
CREATE INDEX IF NOT EXISTS idx_posts_date ON posts_cache(date DESC);
CREATE INDEX IF NOT EXISTS idx_posts_canonical ON posts_cache(platform, user_id, canonical_id);
CREATE INDEX IF NOT EXISTS idx_posts_content_hash ON posts_cache(platform, user_id, content_hash);

CREATE TABLE IF NOT EXISTS crawl_status (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  user_id TEXT NOT NULL,
  last_attempt_at TEXT,
  last_success_at TEXT,
  last_result TEXT DEFAULT '',
  last_error TEXT DEFAULT '',
  last_error_at TEXT,
  consecutive_failures INTEGER DEFAULT 0,
  last_post_count INTEGER DEFAULT 0,
  last_new_count INTEGER DEFAULT 0,
  last_empty_reason TEXT DEFAULT '',
  last_duration_ms INTEGER DEFAULT 0,
  last_alerted_failure_count INTEGER DEFAULT 0,
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(platform, user_id)
);

CREATE INDEX IF NOT EXISTS idx_crawl_status_result ON crawl_status(last_result, consecutive_failures DESC);
