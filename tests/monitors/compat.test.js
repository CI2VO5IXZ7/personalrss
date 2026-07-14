import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { D1Mock } from '../helpers/d1_mock.js';
import { evaluateRules as newEvaluateRules } from '../../src/monitors/core/engine.js';
import { evaluateRules as oldEvaluateRules } from '../../src/trackers/engine.js';
import * as newStock from '../../src/monitors/providers/stock/index.js';
import * as oldStock from '../../src/trackers/providers/stock.js';
import { createMonitorRegistry } from '../../src/monitors/registry.js';
import { MonitorService } from '../../src/monitors/core/service.js';
import { addTrackerRule } from '../../src/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '../..');
const migrationsDir = path.join(root, 'migrations');

function applyMigration0005(db) {
  const sql = fs.readFileSync(path.join(migrationsDir, '0005_personal_info_hub.sql'), 'utf8');
  db.exec(sql);
}

describe('Monitor Compatibility', () => {
  it('exports the same engine function from both old and new paths', () => {
    expect(oldEvaluateRules).toBe(newEvaluateRules);
  });

  it('exports the same stock helpers from both old and new paths', () => {
    expect(oldStock.normalizeSymbol).toBe(newStock.normalizeSymbol);
    expect(oldStock.isTradingSession).toBe(newStock.isTradingSession);
    expect(oldStock.parseTencentQuote).toBe(newStock.parseTencentQuote);
    expect(oldStock.parseSinaQuote).toBe(newStock.parseSinaQuote);
    expect(oldStock.fetchStockQuotes).toBe(newStock.fetchStockQuotes);
    expect(oldStock.stockProvider).toBe(newStock.stockProvider);
  });

  it('old stock path re-exports the new provider contract', () => {
    expect(oldStock.stockProvider).toBeDefined();
    expect(oldStock.stockProvider.type).toBe('stock');
    expect(typeof oldStock.stockProvider.fetchValues).toBe('function');
    expect(typeof oldStock.stockProvider.evaluate).toBe('function');
    expect(typeof oldStock.stockProvider.formatEvent).toBe('function');
  });

  it('old engine path re-exports the new engine function', () => {
    expect(oldEvaluateRules).toBe(newEvaluateRules);
  });
});

describe('Monitor Service Compatibility with Engine', () => {
  let db;
  let service;
  let clock;

  beforeEach(() => {
    db = new D1Mock();
    applyMigration0005(db);

    clock = {
      currentTime: new Date('2026-07-13T10:00:00+08:00'),
      now() { return this.currentTime; }
    };

    service = new MonitorService({ registry: createMonitorRegistry(), clock });
  });

  it('service-created rule can be evaluated by the engine and produces trigger_pending + queue', async () => {
    await service.addStock(db, '600519', 'gte', 1700);

    const mockFetch = vi.fn().mockImplementation(async (url) => {
      if (url.includes('sqt.gtimg.cn')) {
        return {
          status: 200,
          text: async () => 'v_sh600519="1~贵州茅台~600519~1750.00~1710.00~1715.00~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~20260713100000~0";'
        };
      }
    });

    const count = await newEvaluateRules(db, {}, {
      fetchFn: mockFetch,
      relativeTo: new Date('2026-07-13T10:00:00+08:00'),
      forceTradingSession: true
    });

    expect(count).toBe(1);

    const rule = await service.get(db, 1);
    expect(rule.status).toBe('trigger_pending');
    expect(rule.armVersion).toBe(1);

    const { results } = await db.prepare("SELECT * FROM notification_queue WHERE kind = 'stock'").all();
    expect(results).toHaveLength(1);
    expect(results[0].dedupe_key).toBe('stock:rule:1:1');
  });

  it('rules created via addTrackerRule and via service behave the same in engine', async () => {
    await addTrackerRule(db, {
      providerType: 'stock',
      targetKey: 'sh600519',
      targetConfig: { code: '600519' },
      conditionType: 'gte',
      conditionValue: 1700
    });

    await service.addStock(db, '600519', 'gte', 1700);

    const mockFetch = vi.fn().mockImplementation(async (url) => {
      if (url.includes('sqt.gtimg.cn')) {
        return {
          status: 200,
          text: async () =>
            'v_sh600519="1~贵州茅台~600519~1750.00~1710.00~1715.00~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~20260713100000~0";'
        };
      }
    });

    const count = await newEvaluateRules(db, {}, {
      fetchFn: mockFetch,
      relativeTo: new Date('2026-07-13T10:00:00+08:00'),
      forceTradingSession: true
    });

    expect(count).toBe(2);

    const { results } = await db.prepare("SELECT * FROM notification_queue WHERE kind = 'stock'").all();
    expect(results).toHaveLength(2);
  });

  it('registry can be created with stock and used by service', () => {
    const registry = createMonitorRegistry();
    const svc = new MonitorService(registry, clock);
    expect(svc.registry.get('stock')).toBe(registry.get('stock'));
  });
});
