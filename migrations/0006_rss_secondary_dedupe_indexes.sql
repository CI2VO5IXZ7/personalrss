-- Migration 0006: RSS secondary deduplication indexes

DELETE FROM rss_entries
WHERE link <> ''
  AND EXISTS (
    SELECT 1
    FROM rss_entries AS older
    WHERE older.subscription_id = rss_entries.subscription_id
      AND older.link = rss_entries.link
      AND older.id < rss_entries.id
  );

DELETE FROM rss_entries
WHERE content_hash <> ''
  AND EXISTS (
    SELECT 1
    FROM rss_entries AS older
    WHERE older.subscription_id = rss_entries.subscription_id
      AND older.content_hash = rss_entries.content_hash
      AND older.id < rss_entries.id
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_rss_entries_subscription_link_unique
  ON rss_entries(subscription_id, link) WHERE link <> '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_rss_entries_subscription_content_hash_unique
  ON rss_entries(subscription_id, content_hash) WHERE content_hash <> '';
