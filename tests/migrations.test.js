import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = path.join(root, 'migrations');

function readMigration(name) {
  return fs.readFileSync(path.join(migrationsDir, name), 'utf8');
}

function applyMigrations(db, names) {
  for (const name of names) db.exec(readMigration(name));
}

function rssEntryIndexes(db) {
  return db.prepare(
    `SELECT name, sql FROM sqlite_master
     WHERE type = 'index' AND tbl_name = 'rss_entries'
     ORDER BY name`
  ).all();
}

const through0005 = [
  '0001_init.sql',
  '0002_fix_unique_constraint.sql',
  '0003_api_usage.sql',
  '0004_post_meta_and_crawl_status.sql',
  '0005_personal_info_hub.sql'
];

const secondaryIndexNames = [
  'idx_rss_entries_subscription_content_hash_unique',
  'idx_rss_entries_subscription_link_unique'
];

describe('RSS secondary dedupe index migrations', () => {
  it('keeps the committed 0005 migration free of later RSS dedupe indexes', () => {
    const migration0005 = readMigration('0005_personal_info_hub.sql');

    for (const indexName of secondaryIndexNames) {
      expect(migration0005).not.toContain(indexName);
    }
  });

  it('applies all migrations to a fresh database with partial unique indexes', () => {
    const db = new DatabaseSync(':memory:');
    const migrations = [...through0005, '0006_rss_secondary_dedupe_indexes.sql'];

    applyMigrations(db, migrations);

    const indexes = rssEntryIndexes(db).filter(({ name }) => secondaryIndexNames.includes(name));
    expect(indexes.map(({ name }) => name)).toEqual(secondaryIndexNames);
    expect(indexes.find(({ name }) => name.endsWith('link_unique')).sql).toContain("WHERE link <> ''");
    expect(indexes.find(({ name }) => name.endsWith('content_hash_unique')).sql).toContain("WHERE content_hash <> ''");
  });

  it('deduplicates an already-0005 database before adding indexes and is safe to reapply', () => {
    const db = new DatabaseSync(':memory:');
    applyMigrations(db, through0005);
    expect(rssEntryIndexes(db).map(({ name }) => name)).not.toEqual(
      expect.arrayContaining(secondaryIndexNames)
    );

    db.exec(`
      INSERT INTO rss_subscriptions (id, feed_url, feed_url_redacted)
      VALUES (1, 'https://example.com/one.xml', 'one'),
             (2, 'https://example.com/two.xml', 'two');

      INSERT INTO rss_entries (id, subscription_id, entry_key, link, content_hash)
      VALUES (1, 1, 'oldest-link', 'https://example.com/shared', 'hash-link-oldest'),
             (2, 1, 'newer-link', 'https://example.com/shared', 'hash-link-newer'),
             (3, 1, 'oldest-hash', 'https://example.com/hash-oldest', 'shared-hash'),
             (4, 1, 'newer-hash', 'https://example.com/hash-newer', 'shared-hash'),
             (5, 1, 'empty-fields-one', '', ''),
             (6, 1, 'empty-fields-two', '', ''),
             (7, 2, 'other-subscription', 'https://example.com/shared', 'shared-hash');
    `);

    const migration0006 = readMigration('0006_rss_secondary_dedupe_indexes.sql');
    db.exec(migration0006);

    expect(db.prepare('SELECT id FROM rss_entries ORDER BY id').all()).toEqual([
      { id: 1 },
      { id: 3 },
      { id: 5 },
      { id: 6 },
      { id: 7 }
    ]);
    expect(rssEntryIndexes(db).map(({ name }) => name)).toEqual(
      expect.arrayContaining(secondaryIndexNames)
    );

    expect(() => db.exec(`
      INSERT INTO rss_entries (subscription_id, entry_key, link, content_hash)
      VALUES (1, 'duplicate-link-after-upgrade', 'https://example.com/shared', 'new-hash');
    `)).toThrow(/UNIQUE constraint failed: rss_entries\.subscription_id, rss_entries\.link/);
    expect(() => db.exec(`
      INSERT INTO rss_entries (subscription_id, entry_key, link, content_hash)
      VALUES (1, 'duplicate-hash-after-upgrade', 'https://example.com/new', 'shared-hash');
    `)).toThrow(/UNIQUE constraint failed: rss_entries\.subscription_id, rss_entries\.content_hash/);

    db.exec(migration0006);
    expect(db.prepare('SELECT id FROM rss_entries ORDER BY id').all()).toEqual([
      { id: 1 },
      { id: 3 },
      { id: 5 },
      { id: 6 },
      { id: 7 }
    ]);
  });
});

describe('Generator and Integrated Output Platform migrations (0007)', () => {
  const migrations0007 = [
    '0001_init.sql',
    '0002_fix_unique_constraint.sql',
    '0003_api_usage.sql',
    '0004_post_meta_and_crawl_status.sql',
    '0005_personal_info_hub.sql',
    '0006_rss_secondary_dedupe_indexes.sql',
    '0007_integrated_output_platform.sql'
  ];

  it('applies all migrations to a fresh database successfully', () => {
    const db = new DatabaseSync(':memory:');
    applyMigrations(db, migrations0007);

    // Verify tables exist
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(r => r.name);
    expect(tables).toContain('generator_instances');
    expect(tables).toContain('generator_items');
    expect(tables).toContain('generator_status');
    expect(tables).toContain('accounts');
    expect(tables).toContain('posts_cache');
    expect(tables).toContain('crawl_status');

    // Verify indexes exist
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map(r => r.name);
    expect(indexes).toContain('idx_generator_instances_active_due');
    expect(indexes).toContain('idx_generator_items_published');
    expect(indexes).toContain('idx_generator_items_canonical_unique');
    expect(indexes).toContain('idx_generator_items_content_hash_unique');
  });

  it('preserves existing tables and data when upgrading from 0006 to 0007', () => {
    const db = new DatabaseSync(':memory:');
    const migrations0006 = migrations0007.slice(0, -1);
    applyMigrations(db, migrations0006);

    // Insert legacy data
    db.exec(`
      INSERT INTO accounts (platform, user_id, display_name) VALUES ('ig', 'test_user', 'Test Display');
      INSERT INTO posts_cache (platform, user_id, post_id, canonical_id, date, link, image, description)
      VALUES ('ig', 'test_user', 'post123', 'post123', '2026-07-14T03:00:00Z', 'https://inst.com/123', 'https://inst.com/img.jpg', 'hello');
      INSERT INTO crawl_status (platform, user_id, consecutive_failures) VALUES ('ig', 'test_user', 0);

      INSERT INTO tracker_rules (provider_type, target_key, target_config_json, condition_type, condition_value, status, arm_version)
      VALUES ('stock', 'AAPL', '{"gte": 150}', 'price', 150.0, 'active', 1);
      INSERT INTO tracker_events (rule_id, event_type, value, observed_at, source)
      VALUES (1, 'price', 155.5, '2026-07-14T03:00:00Z', 'source');

      INSERT INTO rss_subscriptions (feed_url, feed_url_redacted) VALUES ('https://rss.com/feed', 'feed');
      INSERT INTO rss_entries (subscription_id, entry_key, link, content_hash) VALUES (1, 'key1', 'https://rss.com/1', 'hash1');

      INSERT INTO notification_queue (kind, dedupe_key, payload_json, status)
      VALUES ('rss', 'dedupe-pending', '{"msg":"test-pending"}', 'pending'),
             ('rss', 'dedupe-processing', '{"msg":"test-processing"}', 'processing'),
             ('rss', 'dedupe-failed', '{"msg":"test-failed"}', 'failed'),
             ('rss', 'dedupe-dead', '{"msg":"test-dead"}', 'dead'),
             ('rss', 'dedupe-sent', '{"msg":"test-sent"}', 'sent');
      INSERT INTO bot_sessions (chat_id, flow, step, data_json) VALUES ('12345', 'setup', 'step1', '{"step":1}');
      INSERT INTO daily_usage (usage_date, usage_type, count) VALUES ('2026-07-14', 'api', 5);
    `);

    // Verify they exist before migration 0007
    const countBefore = (table) => db.prepare('SELECT count(*) as count FROM ' + table).get().count;
    expect(countBefore('accounts')).toBe(1);
    expect(countBefore('posts_cache')).toBe(1);
    expect(countBefore('crawl_status')).toBe(1);
    expect(countBefore('tracker_rules')).toBe(1);
    expect(countBefore('tracker_events')).toBe(1);
    expect(countBefore('rss_subscriptions')).toBe(1);
    expect(countBefore('rss_entries')).toBe(1);
    expect(countBefore('notification_queue')).toBe(5);
    expect(countBefore('bot_sessions')).toBe(1);
    expect(countBefore('daily_usage')).toBe(1);

    // Apply 0007
    db.exec(readMigration('0007_integrated_output_platform.sql'));

    // Verify new tables exist
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(r => r.name);
    expect(tables).toContain('generator_instances');

    // Verify all data is preserved row-by-row
    expect(db.prepare('SELECT * FROM accounts').all()).toEqual([
      { id: 1, platform: 'ig', user_id: 'test_user', display_name: 'Test Display', created_at: expect.any(String) }
    ]);
    expect(db.prepare('SELECT * FROM posts_cache').all()).toEqual([
      { id: 1, platform: 'ig', user_id: 'test_user', post_id: 'post123', canonical_id: 'post123', title: '', date: '2026-07-14T03:00:00Z', link: 'https://inst.com/123', image: 'https://inst.com/img.jpg', description: 'hello', raw_images: '[]', media_type: '', content_hash: '', fetched_at: expect.any(String) }
    ]);
    expect(db.prepare('SELECT * FROM crawl_status').all()).toEqual([
      { id: 1, platform: 'ig', user_id: 'test_user', last_attempt_at: null, last_success_at: null, last_result: '', last_error: '', last_error_at: null, consecutive_failures: 0, last_post_count: 0, last_new_count: 0, last_empty_reason: '', last_duration_ms: 0, last_alerted_failure_count: 0, updated_at: expect.any(String) }
    ]);
    expect(db.prepare('SELECT * FROM tracker_rules').all()).toEqual([
      { id: 1, provider_type: 'stock', target_key: 'AAPL', target_config_json: '{"gte": 150}', condition_type: 'price', condition_value: 150, status: 'active', arm_version: 1, last_value: null, last_observed_at: null, last_source: null, triggered_at: null, created_at: expect.any(String), updated_at: expect.any(String) }
    ]);
    expect(db.prepare('SELECT * FROM tracker_events').all()).toEqual([
      { id: 1, rule_id: 1, event_type: 'price', value: 155.5, observed_at: '2026-07-14T03:00:00Z', source: 'source', details_json: null, created_at: expect.any(String) }
    ]);
    expect(db.prepare('SELECT * FROM rss_subscriptions').all()).toEqual([
      { id: 1, feed_url: 'https://rss.com/feed', feed_url_redacted: 'feed', site_url: null, title: null, status: 'active', interval_minutes: 10, next_check_at: expect.any(String), etag: '', last_modified: '', last_checked_at: '', last_success_at: '', consecutive_failures: 0, last_error: '', created_at: expect.any(String), updated_at: expect.any(String) }
    ]);
    expect(db.prepare('SELECT * FROM rss_entries').all()).toEqual([
      { id: 1, subscription_id: 1, entry_key: 'key1', guid: '', link: 'https://rss.com/1', title: '', published_at: '', content_hash: 'hash1', image_url: '', discovered_at: expect.any(String) }
    ]);
    expect(db.prepare('SELECT * FROM notification_queue ORDER BY id').all()).toEqual([
      { id: 1, kind: 'rss', dedupe_key: 'dedupe-pending', payload_json: '{"msg":"test-pending"}', status: 'pending', attempts: 0, available_at: expect.any(String), processing_started_at: null, lease_token: null, lease_expires_at: null, sent_at: null, last_error: null, created_at: expect.any(String) },
      { id: 2, kind: 'rss', dedupe_key: 'dedupe-processing', payload_json: '{"msg":"test-processing"}', status: 'processing', attempts: 0, available_at: expect.any(String), processing_started_at: null, lease_token: null, lease_expires_at: null, sent_at: null, last_error: null, created_at: expect.any(String) },
      { id: 3, kind: 'rss', dedupe_key: 'dedupe-failed', payload_json: '{"msg":"test-failed"}', status: 'failed', attempts: 0, available_at: expect.any(String), processing_started_at: null, lease_token: null, lease_expires_at: null, sent_at: null, last_error: null, created_at: expect.any(String) },
      { id: 4, kind: 'rss', dedupe_key: 'dedupe-dead', payload_json: '{"msg":"test-dead"}', status: 'dead', attempts: 0, available_at: expect.any(String), processing_started_at: null, lease_token: null, lease_expires_at: null, sent_at: null, last_error: null, created_at: expect.any(String) },
      { id: 5, kind: 'rss', dedupe_key: 'dedupe-sent', payload_json: '{"msg":"test-sent"}', status: 'sent', attempts: 0, available_at: expect.any(String), processing_started_at: null, lease_token: null, lease_expires_at: null, sent_at: null, last_error: null, created_at: expect.any(String) }
    ]);
    expect(db.prepare('SELECT * FROM bot_sessions').all()).toEqual([
      { chat_id: '12345', flow: 'setup', step: 'step1', data_json: '{"step":1}', expires_at: null, updated_at: expect.any(String) }
    ]);
    expect(db.prepare('SELECT * FROM daily_usage').all()).toEqual([
      { usage_date: '2026-07-14', usage_type: 'api', count: 5 }
    ]);
  });
});
