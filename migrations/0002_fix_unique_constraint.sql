-- Fix posts_cache unique constraint: include user_id to prevent cross-account conflicts

-- Step 1: Create new table with correct constraint
CREATE TABLE IF NOT EXISTS posts_cache_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  user_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  title TEXT DEFAULT '',
  description TEXT DEFAULT '',
  link TEXT DEFAULT '',
  image TEXT DEFAULT '',
  date TEXT DEFAULT '',
  raw_images TEXT DEFAULT '[]',
  fetched_at TEXT DEFAULT (datetime('now')),
  UNIQUE(platform, user_id, post_id)
);

-- Step 2: Copy existing data
INSERT OR IGNORE INTO posts_cache_new (id, platform, user_id, post_id, title, description, link, image, date, raw_images, fetched_at)
  SELECT id, platform, user_id, post_id, title, description, link, image, date, raw_images, fetched_at
  FROM posts_cache;

-- Step 3: Drop old table and rename
DROP TABLE IF EXISTS posts_cache;
ALTER TABLE posts_cache_new RENAME TO posts_cache;

-- Step 4: Recreate indexes
CREATE INDEX IF NOT EXISTS idx_posts_platform_user ON posts_cache(platform, user_id);
CREATE INDEX IF NOT EXISTS idx_posts_date ON posts_cache(date DESC);
