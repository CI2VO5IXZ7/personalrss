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
