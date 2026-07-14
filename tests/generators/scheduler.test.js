import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { D1Mock } from '../helpers/d1_mock.js';
import { GeneratorRegistry } from '../../src/generators/registry.js';
import * as repo from '../../src/generators/core/repository.js';
import * as renderer from '../../src/generators/core/renderer.js';
import { GeneratorService } from '../../src/generators/core/service.js';
import { runDueGenerators } from '../../src/generators/core/scheduler.js';

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

describe('Generator Scheduler', () => {
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
      validateConfig: vi.fn(),
      fetchItems: vi.fn(async () => ({ items: [] })),
      normalizeItem: vi.fn(async (item) => item),
      buildFeedMeta: vi.fn(async () => ({ title: 'Fake' }))
    };

    registry = new GeneratorRegistry([fakeProvider]);
    service = new GeneratorService(registry, repo, renderer, clock);
  });

  it('handles empty due instances list gracefully', async () => {
    const result = await runDueGenerators(db, service);
    expect(result).toEqual({
      attempted: 0,
      succeeded: 0,
      failed: 0,
      errorsRedacted: []
    });
  });

  it('schedules and executes due instances with correct results', async () => {
    const inst1 = await service.create(db, 'fake', 'key1', {}, 'Inst 1');
    const inst2 = await service.create(db, 'fake', 'key2', {}, 'Inst 2');

    // Make sure they are due (next_refresh_at is null initially)
    const result = await runDueGenerators(db, service);
    expect(result.attempted).toBe(2);
    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.errorsRedacted).toHaveLength(0);

    // Verify next refresh times are updated
    const updated1 = await service.get(db, inst1.id);
    const updated2 = await service.get(db, inst2.id);
    expect(updated1.nextRefreshAt).toBe('2026-07-14T04:10:00.000Z');
    expect(updated2.nextRefreshAt).toBe('2026-07-14T04:10:00.000Z');

    // Running again with current clock time should result in 0 attempts
    const result2 = await runDueGenerators(db, service);
    expect(result2.attempted).toBe(0);
  });

  it('runs with concurrency limit', async () => {
    await service.create(db, 'fake', 'key1', {}, 'Inst 1');
    await service.create(db, 'fake', 'key2', {}, 'Inst 2');
    await service.create(db, 'fake', 'key3', {}, 'Inst 3');

    let activeCount = 0;
    let maxActiveCount = 0;

    fakeProvider.fetchItems.mockImplementation(async () => {
      activeCount++;
      maxActiveCount = Math.max(maxActiveCount, activeCount);
      // Introduce a tiny delay to allow concurrency overlap
      await new Promise(resolve => setTimeout(resolve, 20));
      activeCount--;
      return { items: [] };
    });

    // Run scheduler with concurrency 2
    const result = await runDueGenerators(db, service, { concurrency: 2 });
    expect(result.attempted).toBe(3);
    expect(result.succeeded).toBe(3);
    expect(maxActiveCount).toBeLessThanOrEqual(2);
  });

  it('isolates failures: one instance failing does not block others', async () => {
    const inst1 = await service.create(db, 'fake', 'key1', {}, 'Inst 1');
    const inst2 = await service.create(db, 'fake', 'key2', {}, 'Inst 2');
    const inst3 = await service.create(db, 'fake', 'key3', {}, 'Inst 3');

    // Make inst2 fail, inst1 and inst3 succeed
    fakeProvider.fetchItems.mockImplementation(async (instance) => {
      if (instance.id === inst2.id) {
        throw new Error('Fake fetch failure: token=abcSecret');
      }
      return { items: [] };
    });

    const result = await runDueGenerators(db, service);
    expect(result.attempted).toBe(3);
    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.errorsRedacted).toHaveLength(1);
    expect(result.errorsRedacted[0]).toEqual({
      id: inst2.id,
      providerType: 'fake',
      instanceKey: 'key2',
      error: 'Fake fetch failure: token=***'
    });

    // Verify inst2 status is updated as failed in database
    const status2 = await repo.getStatus(db, inst2.id);
    expect(status2.lastResult).toBe('error');
    expect(status2.lastError).toBe('Fake fetch failure: token=***');

    // Verify inst1 and inst3 succeeded in database
    const status1 = await repo.getStatus(db, inst1.id);
    expect(status1.lastResult).toBe('empty');
  });

  it('validates options in runDueGenerators', async () => {
    await expect(runDueGenerators(db, service, { concurrency: 0 }))
      .rejects.toThrow('concurrency must be a positive integer');
    await expect(runDueGenerators(db, service, { concurrency: -1 }))
      .rejects.toThrow('concurrency must be a positive integer');
    await expect(runDueGenerators(db, service, { concurrency: 1.5 }))
      .rejects.toThrow('concurrency must be a positive integer');

    await expect(runDueGenerators(db, service, { intervalMinutes: 0 }))
      .rejects.toThrow('intervalMinutes must be a positive integer');
    await expect(runDueGenerators(db, service, { retentionLimit: 0 }))
      .rejects.toThrow('retentionLimit must be a positive integer');
  });

  it('performs a shallow copy of context for each instance task to ensure isolation', async () => {
    await service.create(db, 'fake', 'key1', {}, 'Inst 1');
    await service.create(db, 'fake', 'key2', {}, 'Inst 2');

    const contextsSeen = [];
    fakeProvider.fetchItems.mockImplementation(async (instance, context) => {
      contextsSeen.push(context);
      return { items: [] };
    });

    const baseContext = { db, customVal: 'hello' };
    await runDueGenerators(db, service, { context: baseContext });

    expect(contextsSeen).toHaveLength(2);
    expect(contextsSeen[0]).not.toBe(baseContext);
    expect(contextsSeen[1]).not.toBe(baseContext);
    expect(contextsSeen[0]).not.toBe(contextsSeen[1]);
    expect(contextsSeen[0].customVal).toBe('hello');
    expect(contextsSeen[1].customVal).toBe('hello');
  });

  it('throws an error if due query result is not an array', async () => {
    const originalRepository = service.repository;
    service.repository = {
      ...originalRepository,
      getDueInstances: async () => null
    };

    await expect(runDueGenerators(db, service))
      .rejects.toThrow('due results must be an array');

    service.repository = originalRepository;
  });
});
