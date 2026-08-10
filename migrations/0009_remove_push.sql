-- Remove Push subsystem tables (rss subscriptions, entries, notification queue)
DROP TABLE IF EXISTS rss_subscriptions;
DROP TABLE IF EXISTS rss_entries;
DROP TABLE IF EXISTS notification_queue;
