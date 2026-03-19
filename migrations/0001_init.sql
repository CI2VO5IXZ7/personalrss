-- Social RSS Bridge D1 Schema

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,          -- 'instagram' or 'xiaohongshu'
  user_id TEXT NOT NULL,           -- username for IG, userId for XHS
  display_name TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(platform, user_id)
);

CREATE TABLE IF NOT EXISTS posts_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  user_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  title TEXT DEFAULT '',
  description TEXT DEFAULT '',
  link TEXT DEFAULT '',
  image TEXT DEFAULT '',
  date TEXT DEFAULT '',
  raw_images TEXT DEFAULT '[]',    -- JSON array of image URLs
  fetched_at TEXT DEFAULT (datetime('now')),
  UNIQUE(platform, post_id)
);

CREATE INDEX IF NOT EXISTS idx_posts_platform_user ON posts_cache(platform, user_id);
CREATE INDEX IF NOT EXISTS idx_posts_date ON posts_cache(date DESC);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT DEFAULT ''
);
