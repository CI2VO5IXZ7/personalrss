import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { D1Mock } from '../helpers/d1_mock.js';
import { GeneratorRegistry } from '../../src/generators/registry.js';
import * as repo from '../../src/generators/core/repository.js';
import * as renderer from '../../src/generators/core/renderer.js';
import { GeneratorService } from '../../src/generators/core/service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '../..');
const migrationsDir = path.join(root, 'migrations');

function applyAllMigrations(db) {
  const files = [
    '0001_init.sql',
    '0002_fix_unique_constraint.sql',
    '0003_api_usage.sql',
    '0004_post_meta_and_crawl_status.sql',
    '0005_personal_info_hub.sql',
    '0006_rss_secondary_dedupe_indexes.sql',
    '0007_integrated_output_platform.sql'
  ];
  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    db.exec(sql);
  }
}

describe('Generator Service', () => {
  let db;
  let registry;
  let clock;
  let service;
  let fakeProvider;

  beforeEach(() => {
    db = new D1Mock();
    applyAllMigrations(db);

    clock = {
      currentTime: new Date('2026-07-14T04:00:00Z'),
      now() {
        return this.currentTime;
      }
    };

    fakeProvider = {
      type: 'fake',
      displayName: 'Fake Provider',
      validateConfig: vi.fn(async (config) => {
        if (config?.invalid) {
          throw new Error('Invalid config parameter: secret=secretToken');
        }
      }),
      fetchItems: vi.fn(async (instance, context) => {
        return {
          items: [
            { id: 'item1', content: 'content1', time: '2026-07-14T03:50:00Z' },
            { id: 'item2', content: 'content2', time: '2026-07-14T03:55:00Z' }
          ]
        };
      }),
      normalizeItem: vi.fn(async (rawItem, instance, context) => {
        return {
          itemKey: rawItem.id,
          title: `Title ${rawItem.id}`,
          descriptionHtml: `<p>${rawItem.content}</p>`,
          publishedAt: new Date(rawItem.time),
          link: `https://example.com/item/${rawItem.id}`
        };
      }),
      buildFeedMeta: vi.fn(async (instance, context) => {
        return {
          title: `Fake Feed: ${instance.displayName}`,
          description: 'Description of fake feed',
          link: `https://example.com/fake/${instance.instanceKey}`
        };
      })
    };

    registry = new GeneratorRegistry([fakeProvider]);
    service = new GeneratorService(registry, repo, renderer, clock);
  });

  describe('create', () => {
    it('validates config and creates instance, does not write to rss_subscriptions', async () => {
      const config = { valid: true };
      const instance = await service.create(db, 'fake', 'test_key', config, 'Display Name');

      expect(instance.providerType).toBe('fake');
      expect(instance.instanceKey).toBe('test_key');
      expect(instance.displayName).toBe('Display Name');
      expect(instance.config).toEqual({ valid: true, configVersion: 1 });
      expect(fakeProvider.validateConfig).toHaveBeenCalledWith(config, { db, instanceKey: 'test_key' });

      // Verify no Push coupling (rss_subscriptions should be empty)
      const { results } = await db.prepare('SELECT count(*) as count FROM rss_subscriptions').all();
      expect(results[0].count).toBe(0);
    });

    it('rejects invalid config and propagates the error', async () => {
      await expect(service.create(db, 'fake', 'test_key', { invalid: true }, 'Display Name'))
        .rejects.toThrow('Invalid config parameter: secret=secretToken');
    });

    it('rejects unsupported provider type', async () => {
      await expect(service.create(db, 'unsupported', 'test_key', {}, 'Display Name'))
        .rejects.toThrow('Unsupported generator provider type: unsupported');
    });
  });

  describe('list, get, pause, resume, remove', () => {
    it('manages lifecycle correctly', async () => {
      const inst = await service.create(db, 'fake', 'key1', {}, 'Name 1');

      // Get
      const retrieved = await service.get(db, inst.id);
      expect(retrieved.displayName).toBe('Name 1');

      // List
      const list = await service.list(db);
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe(inst.id);

      // Pause
      await service.pause(db, inst.id);
      const paused = await service.get(db, inst.id);
      expect(paused.status).toBe('paused');

      // Resume
      await service.resume(db, inst.id);
      const active = await service.get(db, inst.id);
      expect(active.status).toBe('active');

      // Remove
      await service.remove(db, inst.id);
      const deleted = await service.get(db, inst.id);
      expect(deleted).toBeNull();
    });
  });

  describe('refresh', () => {
    it('refreshes items, saves them atomically, and updates status and next_refresh_at', async () => {
      const inst = await service.create(db, 'fake', 'key1', {}, 'Name 1');

      const result = await service.refresh(db, inst.id);
      expect(result).toEqual({ itemCount: 2, newCount: 2 });

      // Verify next_refresh_at is default 10 minutes from now (clock.now() + 10 mins)
      const updatedInst = await service.get(db, inst.id);
      expect(updatedInst.nextRefreshAt).toBe('2026-07-14T04:10:00.000Z');

      // Verify status row
      const status = await repo.getStatus(db, inst.id);
      expect(status.lastResult).toBe('success');
      expect(status.lastError).toBe('');
      expect(status.consecutiveFailures).toBe(0);
      expect(status.lastItemCount).toBe(2);
      expect(status.lastNewCount).toBe(2);
      expect(status.lastSuccessAt).toBe('2026-07-14T04:00:00.000Z');

      // Verify saved items
      const items = await repo.getItems(db, inst.id);
      expect(items).toHaveLength(2);
      expect(items[0].itemKey).toBe('item2');
      expect(items[0].title).toBe('Title item2');
    });

    it('supports sync normalizeItem', async () => {
      fakeProvider.normalizeItem.mockImplementation((rawItem) => {
        return {
          itemKey: rawItem.id,
          title: `Sync ${rawItem.id}`,
          publishedAt: new Date(rawItem.time)
        };
      });

      const inst = await service.create(db, 'fake', 'key1', {}, 'Name 1');
      await service.refresh(db, inst.id);

      const items = await repo.getItems(db, inst.id);
      expect(items[0].title).toBe('Sync item2');
    });

    it('respects custom retention limits', async () => {
      const inst = await service.create(db, 'fake', 'key1', {}, 'Name 1');

      // Generate 5 items
      fakeProvider.fetchItems.mockImplementation(async () => ({
        items: Array.from({ length: 5 }, (_, i) => ({
          id: `id${i}`,
          content: `c${i}`,
          time: `2026-07-14T03:0${i}:00Z`
        }))
      }));

      // Refresh with retention limit = 3
      await service.refresh(db, inst.id, { retentionLimit: 3 });

      const items = await repo.getItems(db, inst.id);
      // Items should be capped at 3
      expect(items).toHaveLength(3);
    });

    it('redacts errors on failure, updates status, and propagates error', async () => {
      const inst = await service.create(db, 'fake', 'key1', {}, 'Name 1');

      fakeProvider.fetchItems.mockRejectedValueOnce(new Error('Failed to fetch from upstream: secret=superSecret; token=xyz'));

      await expect(service.refresh(db, inst.id))
        .rejects.toThrow('Failed to fetch from upstream: secret=superSecret; token=xyz');

      // Verify status is updated with redacted error message
      const status = await repo.getStatus(db, inst.id);
      expect(status.lastResult).toBe('error');
      expect(status.lastError).toBe('Failed to fetch from upstream: secret=***; token=***');
      expect(status.consecutiveFailures).toBe(1);

      // Verify next_refresh_at is still scheduled forward by 10 minutes to prevent stuckness
      const updatedInst = await service.get(db, inst.id);
      expect(updatedInst.nextRefreshAt).toBe('2026-07-14T04:10:00.000Z');
    });

    it('validates intervalMinutes and retentionLimit in refresh', async () => {
      const inst = await service.create(db, 'fake', 'key1', {}, 'Name 1');
      await expect(service.refresh(db, inst.id, { intervalMinutes: 0 }))
        .rejects.toThrow('intervalMinutes must be a positive integer');
      await expect(service.refresh(db, inst.id, { intervalMinutes: -1 }))
        .rejects.toThrow('intervalMinutes must be a positive integer');
      await expect(service.refresh(db, inst.id, { intervalMinutes: 1.5 }))
        .rejects.toThrow('intervalMinutes must be a positive integer');

      await expect(service.refresh(db, inst.id, { retentionLimit: 0 }))
        .rejects.toThrow('retentionLimit must be a positive integer');
      await expect(service.refresh(db, inst.id, { retentionLimit: -1 }))
        .rejects.toThrow('retentionLimit must be a positive integer');
      await expect(service.refresh(db, inst.id, { retentionLimit: 1.5 }))
        .rejects.toThrow('retentionLimit must be a positive integer');
    });

    it('throws contract error when fetchItems returns invalid shape', async () => {
      const inst = await service.create(db, 'fake', 'key1', {}, 'Name 1');

      fakeProvider.fetchItems.mockResolvedValueOnce(null);
      await expect(service.refresh(db, inst.id))
        .rejects.toThrow('Provider contract error');

      fakeProvider.fetchItems.mockResolvedValueOnce([]);
      await expect(service.refresh(db, inst.id))
        .rejects.toThrow('Provider contract error');

      fakeProvider.fetchItems.mockResolvedValueOnce({ items: null });
      await expect(service.refresh(db, inst.id))
        .rejects.toThrow('Provider contract error');

      fakeProvider.fetchItems.mockResolvedValueOnce({ items: 'not-an-array' });
      await expect(service.refresh(db, inst.id))
        .rejects.toThrow('Provider contract error');
    });

    it('updates lastResult to empty when 0 items returned, but success when non-empty, and updates lastSuccessAt in both cases', async () => {
      const inst = await service.create(db, 'fake', 'key1', {}, 'Name 1');

      // 0 items case
      fakeProvider.fetchItems.mockResolvedValueOnce({ items: [] });
      await service.refresh(db, inst.id);
      let status = await repo.getStatus(db, inst.id);
      expect(status.lastResult).toBe('empty');
      expect(status.lastSuccessAt).toBe('2026-07-14T04:00:00.000Z');

      // Non-zero items case
      fakeProvider.fetchItems.mockResolvedValueOnce({
        items: [{ id: 'item1', content: 'content1', time: '2026-07-14T03:50:00Z' }]
      });
      clock.currentTime = new Date('2026-07-14T04:05:00Z');
      await service.refresh(db, inst.id);
      status = await repo.getStatus(db, inst.id);
      expect(status.lastResult).toBe('success');
      expect(status.lastSuccessAt).toBe('2026-07-14T04:05:00.000Z');
    });

    it('saves items successfully but fails status update, enabling idempotent retry next round', async () => {
      const inst = await service.create(db, 'fake', 'key_retry', {}, 'Name Retry');

      // Return one item to save
      fakeProvider.fetchItems.mockResolvedValueOnce({
        items: [{ id: 'item_retry_1', content: 'retry content', time: '2026-07-14T03:50:00Z' }]
      });

      // Stub prepare to make status update fail
      const originalPrepare = db.prepare;
      db.prepare = function (sql) {
        if (sql.includes('UPDATE generator_status')) {
          return {
            bind: () => ({
              run: async () => {
                throw new Error('Database connection lost on status update');
              }
            })
          };
        }
        return originalPrepare.call(db, sql);
      };

      await expect(service.refresh(db, inst.id))
        .rejects.toThrow('Database connection lost on status update');

      db.prepare = originalPrepare;

      // Prove items were saved successfully (Transaction 1 committed)
      const items = await repo.getItems(db, inst.id);
      expect(items).toHaveLength(1);
      expect(items[0].itemKey).toBe('item_retry_1');

      // Prove nextRefreshAt is still null (Transaction 2 rolled back)
      const updatedInst = await service.get(db, inst.id);
      expect(updatedInst.nextRefreshAt).toBeNull();
    });
  });

  describe('getFeed', () => {
    it('renders standard RSS feed and allows reading paused instance but 404s on nonexistent', async () => {
      const inst = await service.create(db, 'fake', 'key1', {}, 'Name 1');
      await service.refresh(db, inst.id);

      const feedUrl = 'https://my-worker.example/feeds/1.xml';
      const xml = await service.getFeed(db, inst.id, feedUrl);

      expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
      expect(xml).toContain('<title><![CDATA[Fake Feed: Name 1]]></title>');
      expect(xml).toContain('<atom:link href="https://my-worker.example/feeds/1.xml" rel="self" type="application/rss+xml"/>');
      expect(xml).toContain('<item>');
      expect(xml).toContain('<title><![CDATA[Title item2]]></title>');

      // Pause instance
      await service.pause(db, inst.id);

      // It should still be readable!
      const xmlPaused = await service.getFeed(db, inst.id, feedUrl);
      expect(xmlPaused).not.toBeNull();
      expect(xmlPaused).toContain('<title><![CDATA[Fake Feed: Name 1]]></title>');

      // Nonexistent instance should return null (indicating 404)
      const nonexistentXml = await service.getFeed(db, 999, feedUrl);
      expect(nonexistentXml).toBeNull();
    });
  });
});
