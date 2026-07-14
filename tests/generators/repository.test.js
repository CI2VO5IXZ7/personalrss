import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { D1Mock } from '../helpers/d1_mock.js';
import * as repo from '../../src/generators/core/repository.js';

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

describe('Generator Repository', () => {
  let db;

  beforeEach(() => {
    db = new D1Mock();
    applyAllMigrations(db);
  });

  describe('Instance CRUD and Validations', () => {
    it('validates providerType, instanceKey, and status', async () => {
      // Empty providerType
      await expect(repo.createInstance(db, { providerType: '', instanceKey: 'test' }))
        .rejects.toThrow('Invalid provider type');

      // Empty instanceKey
      await expect(repo.createInstance(db, { providerType: 'ig', instanceKey: '' }))
        .rejects.toThrow('Invalid instance key');

      // Invalid status
      await expect(repo.createInstance(db, { providerType: 'ig', instanceKey: 'test', status: 'invalid' }))
        .rejects.toThrow('Invalid status');
    });

    it('normalizes instanceKey to trim and lowercase, and configVersion=1', async () => {
      const instance = await repo.createInstance(db, {
        providerType: 'ig',
        instanceKey: '  Test_User  ',
        displayName: 'Test User',
        config: { customField: 'value' }
      });

      expect(instance.instanceKey).toBe('test_user');
      expect(instance.config).toEqual({ customField: 'value', configVersion: 1 });
      expect(instance.status).toBe('active');

      const retrieved = await repo.getInstance(db, instance.id);
      expect(retrieved.instanceKey).toBe('test_user');
      expect(retrieved.config).toEqual({ customField: 'value', configVersion: 1 });
    });

    it('does not swallow DB errors on duplicate (provider_type, instance_key)', async () => {
      await repo.createInstance(db, { providerType: 'ig', instanceKey: 'dup' });
      await expect(repo.createInstance(db, { providerType: 'ig', instanceKey: 'dup' }))
        .rejects.toThrow(/UNIQUE constraint failed/);
    });

    it('manages instances and auto-creates/manages status row', async () => {
      const inst = await repo.createInstance(db, {
        providerType: 'ig',
        instanceKey: 'user1',
        displayName: 'User One'
      });

      // Get by ID
      const retrieved = await repo.getInstance(db, inst.id);
      expect(retrieved.displayName).toBe('User One');

      // Get by Key
      const retrievedByKey = await repo.getInstanceByKey(db, 'ig', 'USER1'); // case normalization test
      expect(retrievedByKey.id).toBe(inst.id);

      // Verify status is auto-created
      const status = await repo.getStatus(db, inst.id);
      expect(status).not.toBeNull();
      expect(status.consecutiveFailures).toBe(0);

      // List instances
      const list = await repo.listInstances(db);
      expect(list).toHaveLength(1);

      // Update
      const updated = await repo.updateInstance(db, inst.id, {
        displayName: 'New Name',
        status: 'paused',
        config: { foo: 'bar' }
      });
      expect(updated).toBe(true);

      const retrievedAfter = await repo.getInstance(db, inst.id);
      expect(retrievedAfter.displayName).toBe('New Name');
      expect(retrievedAfter.status).toBe('paused');
      expect(retrievedAfter.config).toEqual({ foo: 'bar', configVersion: 1 });
    });

    it('performs atomic cascade delete and batch delete', async () => {
      const inst1 = await repo.createInstance(db, { providerType: 'ig', instanceKey: 'user1' });
      const inst2 = await repo.createInstance(db, { providerType: 'ig', instanceKey: 'user2' });

      // Save some items
      await repo.saveItem(db, inst1.id, { itemKey: 'item1', canonicalId: 'c1', link: 'l1', rawImages: [] });
      await repo.saveItem(db, inst2.id, { itemKey: 'item2', canonicalId: 'c2', link: 'l2', rawImages: [] });

      // Check item and status exist
      let items1 = await repo.getItems(db, inst1.id);
      expect(items1).toHaveLength(1);
      let status1 = await repo.getStatus(db, inst1.id);
      expect(status1).not.toBeNull();

      // Delete single instance
      const deleted1 = await repo.deleteInstance(db, inst1.id);
      expect(deleted1).toBe(true);

      expect(await repo.getInstance(db, inst1.id)).toBeNull();
      expect(await repo.getStatus(db, inst1.id)).toBeNull();
      expect(await repo.getItems(db, inst1.id)).toHaveLength(0);

      // Verify inst2 is still there
      expect(await repo.getInstance(db, inst2.id)).not.toBeNull();

      // Delete batch
      const deletedBatch = await repo.deleteInstances(db, [inst2.id]);
      expect(deletedBatch).toBe(1);
      expect(await repo.getInstance(db, inst2.id)).toBeNull();
    });

    // Blocker 1: createInstance status insert failure rollback test
    it('rolls back createInstance if status insertion fails', async () => {
      const originalPrepare = db.prepare;
      db.prepare = function (sql) {
        if (sql.includes('INSERT OR IGNORE INTO generator_status') || sql.includes('INSERT INTO generator_status')) {
          return {
            bind: () => ({
              run: async () => {
                throw new Error('Simulated status table insert failure');
              }
            })
          };
        }
        return originalPrepare.call(db, sql);
      };

      await expect(repo.createInstance(db, {
        providerType: 'ig',
        instanceKey: 'status_fail_test',
        displayName: 'Fail Test'
      })).rejects.toThrow('Simulated status table insert failure');

      db.prepare = originalPrepare;

      const instance = await repo.getInstanceByKey(db, 'ig', 'status_fail_test');
      expect(instance).toBeNull();
    });

    // Blocker 2: providerType and instanceKey boundary validation & normalization tests
    it('validates providerType and instanceKey in createInstance, getInstanceByKey, and listInstances', async () => {
      // Invalid/empty types in createInstance
      await expect(repo.createInstance(db, { providerType: 123, instanceKey: 'test' })).rejects.toThrow('Invalid provider type');
      await expect(repo.createInstance(db, { providerType: '', instanceKey: 'test' })).rejects.toThrow('Invalid provider type');
      await expect(repo.createInstance(db, { providerType: 'ig', instanceKey: null })).rejects.toThrow('Invalid instance key');
      await expect(repo.createInstance(db, { providerType: 'ig', instanceKey: '   ' })).rejects.toThrow('Invalid instance key');

      // Invalid/empty types in getInstanceByKey
      await expect(repo.getInstanceByKey(db, 123, 'test')).rejects.toThrow('Invalid provider type');
      await expect(repo.getInstanceByKey(db, '', 'test')).rejects.toThrow('Invalid provider type');
      await expect(repo.getInstanceByKey(db, 'ig', null)).rejects.toThrow('Invalid instance key');
      await expect(repo.getInstanceByKey(db, 'ig', '   ')).rejects.toThrow('Invalid instance key');

      // Invalid/empty types in listInstances
      await expect(repo.listInstances(db, { providerType: 123 })).rejects.toThrow('Invalid provider type');
      await expect(repo.listInstances(db, { providerType: '' })).rejects.toThrow('Invalid provider type');
      await expect(repo.listInstances(db, { providerType: '   ' })).rejects.toThrow('Invalid provider type');

      // Verify trim and lowercase
      const inst = await repo.createInstance(db, { providerType: '  IG  ', instanceKey: '  MyKey  ' });
      expect(inst.providerType).toBe('ig');
      expect(inst.instanceKey).toBe('mykey');

      const retrieved = await repo.getInstanceByKey(db, '  iG  ', '  mYkEy  ');
      expect(retrieved).not.toBeNull();
      expect(retrieved.id).toBe(inst.id);

      const list = await repo.listInstances(db, { providerType: '  Ig  ' });
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe(inst.id);
    });

    // Blocker 3: config only accepts plain JSON object
    it('validates config to accept only plain JSON objects', async () => {
      const inst1 = await repo.createInstance(db, { providerType: 'ig', instanceKey: 'c1', config: { a: 1 } });
      expect(inst1.config).toEqual({ a: 1, configVersion: 1 });

      const inst2 = await repo.createInstance(db, { providerType: 'ig', instanceKey: 'c2', config: '{"a": 2}' });
      expect(inst2.config).toEqual({ a: 2, configVersion: 1 });

      const inst3 = await repo.createInstance(db, { providerType: 'ig', instanceKey: 'c3' });
      expect(inst3.config).toEqual({ configVersion: 1 });

      // Invalid cases
      await expect(repo.createInstance(db, { providerType: 'ig', instanceKey: 'err1', config: [1, 2] })).rejects.toThrow('Invalid config type');
      await expect(repo.createInstance(db, { providerType: 'ig', instanceKey: 'err2', config: '[1, 2]' })).rejects.toThrow('Invalid config type');
      await expect(repo.createInstance(db, { providerType: 'ig', instanceKey: 'err3', config: 123 })).rejects.toThrow('Invalid config type');
      await expect(repo.createInstance(db, { providerType: 'ig', instanceKey: 'err4', config: '123' })).rejects.toThrow('Invalid config type');
      await expect(repo.createInstance(db, { providerType: 'ig', instanceKey: 'err5', config: 'true' })).rejects.toThrow('Invalid config type');
      await expect(repo.createInstance(db, { providerType: 'ig', instanceKey: 'err6', config: null })).rejects.toThrow('Invalid config type');
      await expect(repo.createInstance(db, { providerType: 'ig', instanceKey: 'err7', config: 'null' })).rejects.toThrow('Invalid config type');
    });

    // Blocker 4: deleteInstance/deleteInstances validation, batch fail closed, and rollback tests
    it('validates IDs in deleteInstance and deleteInstances', async () => {
      await expect(repo.deleteInstance(db, 'not_a_number')).rejects.toThrow('Invalid ID');
      await expect(repo.deleteInstance(db, -1)).rejects.toThrow('Invalid ID');
      await expect(repo.deleteInstance(db, 0)).rejects.toThrow('Invalid ID');
      await expect(repo.deleteInstance(db, 1.5)).rejects.toThrow('Invalid ID');

      await expect(repo.deleteInstances(db, ['not_a_number'])).rejects.toThrow('Invalid ID');
      await expect(repo.deleteInstances(db, [1, -2])).rejects.toThrow('Invalid ID');

      expect(await repo.deleteInstances(db, [])).toBe(0);

      const inst = await repo.createInstance(db, { providerType: 'ig', instanceKey: 'del_dup' });
      const deletedCount = await repo.deleteInstances(db, [inst.id, inst.id]);
      expect(deletedCount).toBe(1);
    });

    it('fails closed in deleteInstance and deleteInstances if db.batch is missing', async () => {
      const dbNoBatch = {
        prepare: () => ({
          bind: () => ({
            run: async () => ({ meta: { changes: 1 } })
          })
        })
      };

      await expect(repo.deleteInstance(dbNoBatch, 1)).rejects.toThrow('Database batch operation is not supported');
      await expect(repo.deleteInstances(dbNoBatch, [1])).rejects.toThrow('Database batch operation is not supported');
    });

    it('rolls back deleteInstances if a statement fails in the batch', async () => {
      const inst = await repo.createInstance(db, { providerType: 'ig', instanceKey: 'rollback_test' });

      const originalPrepare = db.prepare;
      db.prepare = function (sql) {
        if (sql.includes('DELETE FROM generator_instances')) {
          return {
            bind: () => ({
              run: async () => {
                throw new Error('Simulated database failure during instance delete');
              }
            })
          };
        }
        return originalPrepare.call(db, sql);
      };

      await expect(repo.deleteInstances(db, [inst.id])).rejects.toThrow('Simulated database failure during instance delete');

      db.prepare = originalPrepare;

      const retrieved = await repo.getInstance(db, inst.id);
      expect(retrieved).not.toBeNull();
      const status = await repo.getStatus(db, inst.id);
      expect(status).not.toBeNull();
    });
  });

  describe('Due Query', () => {
    it('queries active and due instances', async () => {
      const inst1 = await repo.createInstance(db, { providerType: 'ig', instanceKey: 'user1' });
      const inst2 = await repo.createInstance(db, { providerType: 'ig', instanceKey: 'user2' });
      const inst3 = await repo.createInstance(db, { providerType: 'ig', instanceKey: 'user3', status: 'paused' });

      // Set next_refresh_at
      const past = new Date(Date.now() - 10000).toISOString();
      const future = new Date(Date.now() + 10000).toISOString();

      await repo.updateInstance(db, inst1.id, { nextRefreshAt: past });
      await repo.updateInstance(db, inst2.id, { nextRefreshAt: future });
      await repo.updateInstance(db, inst3.id, { nextRefreshAt: past }); // but paused

      const due = await repo.getDueInstances(db, new Date().toISOString());
      // Should contain inst1 (due in past) but not inst2 (future) or inst3 (paused)
      expect(due.map(d => d.id)).toContain(inst1.id);
      expect(due.map(d => d.id)).not.toContain(inst2.id);
      expect(due.map(d => d.id)).not.toContain(inst3.id);
    });
  });

  describe('Status Management', () => {
    it('updates and retrieves status fields', async () => {
      const inst = await repo.createInstance(db, { providerType: 'ig', instanceKey: 'user1' });
      const updated = await repo.updateStatus(db, inst.id, {
        consecutiveFailures: 3,
        lastError: '429 Too Many Requests',
        lastAttemptAt: new Date('2026-07-14T03:00:00Z'),
        lastSuccessAt: new Date('2026-07-14T02:00:00Z'),
        lastResult: 'error',
        lastItemCount: 15,
        lastNewCount: 2,
        lastDurationMs: 450,
        lastAlertedFailureCount: 1
      });

      expect(updated).toBe(true);

      const status = await repo.getStatus(db, inst.id);
      expect(status.consecutiveFailures).toBe(3);
      expect(status.lastError).toBe('429 Too Many Requests');
      expect(status.lastAttemptAt).toBe('2026-07-14T03:00:00.000Z');
      expect(status.lastSuccessAt).toBe('2026-07-14T02:00:00.000Z');
      expect(status.lastResult).toBe('error');
      expect(status.lastItemCount).toBe(15);
      expect(status.lastNewCount).toBe(2);
      expect(status.lastDurationMs).toBe(450);
      expect(status.lastAlertedFailureCount).toBe(1);
    });
  });

  describe('Items management', () => {
    it('saves, retrieves and deduplicates items idempotently', async () => {
      const inst = await repo.createInstance(db, { providerType: 'ig', instanceKey: 'user1' });

      // Save new item
      const item1 = {
        itemKey: 'post1',
        canonicalId: 'canon1',
        contentHash: 'hash1',
        title: 'Title 1',
        descriptionHtml: '<p>Desc 1</p>',
        link: 'https://inst.com/p/1',
        publishedAt: new Date('2026-07-14T03:00:00Z'),
        mediaType: 'image',
        imageUrl: 'https://inst.com/img1.jpg',
        rawImages: ['img1.jpg']
      };

      const saved1 = await repo.saveItem(db, inst.id, item1);
      expect(saved1).toBe(true);

      // Save duplicate itemKey -> should be ignored, returning false, without throwing
      const savedDup = await repo.saveItem(db, inst.id, item1);
      expect(savedDup).toBe(false);

      // Empty canonicalId and empty contentHash do not conflict
      const itemEmpty = {
        itemKey: 'post_empty_1',
        canonicalId: '',
        contentHash: '',
        link: 'https://inst.com/p/empty1',
        rawImages: []
      };
      const itemEmpty2 = {
        itemKey: 'post_empty_2',
        canonicalId: '',
        contentHash: '',
        link: 'https://inst.com/p/empty2',
        rawImages: []
      };

      expect(await repo.saveItem(db, inst.id, itemEmpty)).toBe(true);
      expect(await repo.saveItem(db, inst.id, itemEmpty2)).toBe(true); // Should succeed!

      // Duplicate canonicalId (non-empty) -> should be ignored, returning false
      const itemDupCanon = {
        itemKey: 'post_other',
        canonicalId: 'canon1',
        contentHash: 'hash_other',
        link: 'https://inst.com/p/other',
        rawImages: []
      };
      expect(await repo.saveItem(db, inst.id, itemDupCanon)).toBe(false);

      // Retrieve items
      const items = await repo.getItems(db, inst.id);
      expect(items.map(i => i.itemKey)).toContain('post1');
      expect(items.map(i => i.itemKey)).toContain('post_empty_1');
      expect(items.map(i => i.itemKey)).toContain('post_empty_2');
      expect(items.map(i => i.itemKey)).not.toContain('post_other');

      const retrieved1 = items.find(i => i.itemKey === 'post1');
      expect(retrieved1.canonicalId).toBe('canon1');
      expect(retrieved1.contentHash).toBe('hash1');
      expect(retrieved1.rawImages).toEqual(['img1.jpg']);
    });

    it('enforces retention limit per instance', async () => {
      const inst = await repo.createInstance(db, { providerType: 'ig', instanceKey: 'user1' });

      // Save 5 items
      const items = Array.from({ length: 5 }, (_, i) => ({
        itemKey: `post_${i}`,
        canonicalId: `canon_${i}`,
        contentHash: `hash_${i}`,
        link: `https://inst.com/p/${i}`,
        publishedAt: new Date(Date.now() + i * 1000), // ascending order
        rawImages: []
      }));

      // Save with retentionLimit = 3
      const count = await repo.saveItems(db, inst.id, items, 3);
      expect(count).toBe(5);

      const remaining = await repo.getItems(db, inst.id, 10);
      expect(remaining).toHaveLength(3);
      // The latest 3 items should be index 4, 3, 2 (since they have the latest publishedAt)
      const keys = remaining.map(i => i.itemKey);
      expect(keys).toEqual(['post_4', 'post_3', 'post_2']);
    });

    // Blocker 5: saveItem & saveItems validation, retentionLimit checking, and rollback tests
    it('validates inputs in saveItem', async () => {
      const validItem = { itemKey: 'valid_key', rawImages: [] };

      // Invalid generatorId
      await expect(repo.saveItem(db, 'not_an_int', validItem)).rejects.toThrow('Invalid generator ID');
      await expect(repo.saveItem(db, -5, validItem)).rejects.toThrow('Invalid generator ID');

      // Invalid itemKey
      await expect(repo.saveItem(db, 1, { itemKey: '', rawImages: [] })).rejects.toThrow('Invalid item key');
      await expect(repo.saveItem(db, 1, { itemKey: null, rawImages: [] })).rejects.toThrow('Invalid item key');
      await expect(repo.saveItem(db, 1, { itemKey: 123, rawImages: [] })).rejects.toThrow('Invalid item key');

      // Invalid rawImages
      await expect(repo.saveItem(db, 1, { itemKey: 'k', rawImages: 'not_an_array' })).rejects.toThrow('Invalid rawImages');

      // Invalid publishedAt
      await expect(repo.saveItem(db, 1, { itemKey: 'k', rawImages: [], publishedAt: 'invalid_date' })).rejects.toThrow('Invalid publishedAt');
    });

    it('validates inputs in saveItems', async () => {
      const validItems = [{ itemKey: 'k', rawImages: [] }];

      // Invalid generatorId
      await expect(repo.saveItems(db, -1, validItems, 10)).rejects.toThrow('Invalid generator ID');

      // Invalid retentionLimit
      await expect(repo.saveItems(db, 1, validItems, 0)).rejects.toThrow('Invalid retention limit');
      await expect(repo.saveItems(db, 1, validItems, -5)).rejects.toThrow('Invalid retention limit');
      await expect(repo.saveItems(db, 1, validItems, 'not_int')).rejects.toThrow('Invalid retention limit');

      // Invalid item in list
      const invalidItems = [{ itemKey: '', rawImages: [] }];
      await expect(repo.saveItems(db, 1, invalidItems, 10)).rejects.toThrow('Invalid item key');
    });

    it('rolls back all inserts in saveItems if retention delete fails', async () => {
      const inst = await repo.createInstance(db, { providerType: 'ig', instanceKey: 'rollback_save_items' });

      const items = [
        { itemKey: 'item_r1', canonicalId: 'cr1', link: 'lr1', rawImages: [] },
        { itemKey: 'item_r2', canonicalId: 'cr2', link: 'lr2', rawImages: [] }
      ];

      const originalPrepare = db.prepare;
      db.prepare = function (sql) {
        if (sql.includes('DELETE FROM generator_items') && sql.includes('LIMIT')) {
          return {
            bind: () => ({
              run: async () => {
                throw new Error('Simulated database failure during retention delete');
              }
            })
          };
        }
        return originalPrepare.call(db, sql);
      };

      await expect(repo.saveItems(db, inst.id, items, 1))
        .rejects.toThrow('Simulated database failure during retention delete');

      db.prepare = originalPrepare;

      const remaining = await repo.getItems(db, inst.id);
      expect(remaining).toHaveLength(0);
    });
  });
});
