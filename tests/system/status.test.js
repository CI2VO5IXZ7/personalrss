import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { D1Mock } from '../helpers/d1_mock.js';
import { createGeneratorRegistry } from '../../src/generators/registry.js';
import { GeneratorService } from '../../src/generators/core/service.js';
import * as generatorRepo from '../../src/generators/core/repository.js';
import * as generatorRenderer from '../../src/generators/core/renderer.js';
import { createMonitorRegistry } from '../../src/monitors/registry.js';
import { MonitorService } from '../../src/monitors/core/service.js';
import {
  addSubscription as addPushSubscription,
  listSubscriptions as listPushSubscriptions,
  pauseSubscription as pausePushSubscription
} from '../../src/push/rss/service.js';
import { createStatusService } from '../../src/system/status.js';
import fs from 'fs';
import path from 'path';

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
    db.exec(fs.readFileSync(path.resolve(__dirname, '../../migrations', file), 'utf8'));
  }
}

describe('System Status Service', () => {
  let db;
  let generatorService;
  let monitorService;
  let pushService;
  let statusService;
  let env;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-13T07:40:00.000Z'));

    db = new D1Mock();
    applyAllMigrations(db);

    generatorService = new GeneratorService(createGeneratorRegistry(), generatorRepo, generatorRenderer);
    monitorService = new MonitorService(createMonitorRegistry());
    pushService = {
      listSubscriptions: () => listPushSubscriptions(db)
    };
    env = { DEEPSEEK_DAILY_LIMIT: '200' };
    statusService = createStatusService({ db, generatorService, monitorService, pushService, env });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('aggregates generator, monitor, push, queue, and DeepSeek usage without leaking URLs or tokens', async () => {
    const feedXml = `
      <rss version="2.0">
        <channel>
          <title>Test Feed</title>
          <link>https://test.com</link>
          <item><title>Item</title><guid>guid-1</guid></item>
        </channel>
      </rss>
    `;
    const mockFetch = vi.fn().mockImplementation((url) => {
      return Promise.resolve({
        status: 200,
        headers: new Headers({ 'content-type': 'application/rss+xml' }),
        text: async () => feedXml
      });
    });
    globalThis.fetch = mockFetch;

    // Generator
    await generatorService.create(db, 'instagram', 'jjlin', {}, 'JJ Lin');

    // Push
    await addPushSubscription(db, 'https://test.com/feed.xml', { SAFE_FETCH_RESOLVER: async () => ['93.184.216.34'] });

    // Monitor
    await monitorService.addStock(db, '600519', 'gte', 1800);
    await monitorService.pause(db, 1);

    // Queue
    await db.prepare(`INSERT INTO notification_queue (kind, dedupe_key, payload_json, status) VALUES ('rss', 'k1', '{}', 'pending')`).run();
    await db.prepare(`INSERT INTO notification_queue (kind, dedupe_key, payload_json, status) VALUES ('rss', 'k2', '{}', 'dead')`).run();

    // DeepSeek usage
    await db.prepare(`INSERT INTO daily_usage (usage_date, usage_type, count) VALUES ('2026-07-13', 'deepseek_summary', 12)`).run();

    const summary = await statusService.getSummary();

    expect(summary).toContain('Generator');
    expect(summary).toContain('总数：<b>1</b>');
    expect(summary).toContain('Monitor');
    expect(summary).toContain('Push RSS');
    expect(summary).toContain('DeepSeek');
    expect(summary).toContain('今日已用：<b>12</b>');
    expect(summary).not.toContain('https://');
    expect(summary).not.toContain('secret');
  });

  it('returns zero counts when no data exists', async () => {
    const summary = await statusService.getSummary();
    expect(summary).toContain('总数：<b>0</b>');
    expect(summary).toContain('今日已用：<b>0</b>');
  });
});
