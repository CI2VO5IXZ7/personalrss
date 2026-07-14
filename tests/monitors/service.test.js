import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { D1Mock } from '../helpers/d1_mock.js';
import { MonitorService } from '../../src/monitors/core/service.js';
import { createMonitorRegistry } from '../../src/monitors/registry.js';
import { getTrackerRule } from '../../src/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '../..');
const migrationsDir = path.join(root, 'migrations');

function applyMigration0005(db) {
  const sql = fs.readFileSync(path.join(migrationsDir, '0005_personal_info_hub.sql'), 'utf8');
  db.exec(sql);
}

function mockFetchForQuote(symbol, price, timestamp = '20260713100000') {
  return vi.fn().mockImplementation(async (url) => {
    if (url.includes('sqt.gtimg.cn')) {
      return {
        status: 200,
        text: async () => `v_${symbol}="1~\u8d35\u5dde\u8305\u53f0~${symbol.slice(-6)}~${price.toFixed(2)}~1710.00~1715.00~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~${timestamp}~0";`
      };
    }
  });
}

describe('Monitor Service', () => {
  let db;
  let service;
  let clock;

  beforeEach(() => {
    db = new D1Mock();
    applyMigration0005(db);

    clock = {
      currentTime: new Date('2026-07-13T10:00:00+08:00'),
      now() {
        return this.currentTime;
      }
    };

    service = new MonitorService({ registry: createMonitorRegistry(), clock });
  });

  describe('addStock', () => {
    it('creates a stock rule and returns a mapped rule object', async () => {
      const rule = await service.addStock(db, '600519', 'gte', 1700);

      expect(rule.providerType).toBe('stock');
      expect(rule.targetKey).toBe('sh600519');
      expect(rule.targetConfig).toEqual({ code: 'sh600519' });
      expect(rule.conditionType).toBe('gte');
      expect(rule.conditionValue).toBe(1700);
      expect(rule.status).toBe('active');
      expect(rule.armVersion).toBe(1);
      expect(rule.id).toBe(1);
    });

    it('normalizes already-prefixed codes', async () => {
      const rule = await service.addStock(db, 'SZ000001', 'lte', 10);
      expect(rule.targetKey).toBe('sz000001');
      expect(rule.conditionType).toBe('lte');
    });

    it('rejects invalid stock codes', async () => {
      await expect(service.addStock(db, '123', 'gte', 1700)).rejects.toThrow(/Invalid stock code/);
      await expect(service.addStock(db, '', 'gte', 1700)).rejects.toThrow(/Invalid stock code/);
      await expect(service.addStock(db, null, 'gte', 1700)).rejects.toThrow(/Invalid stock code/);
    });

    it('rejects invalid condition types', async () => {
      await expect(service.addStock(db, '600519', 'gt', 1700)).rejects.toThrow(/Invalid condition type/);
      await expect(service.addStock(db, '600519', 'change_pct', 5)).rejects.toThrow(/Invalid condition type/);
    });

    it('rejects non-positive condition values', async () => {
      await expect(service.addStock(db, '600519', 'gte', 0)).rejects.toThrow(/Invalid condition value/);
      await expect(service.addStock(db, '600519', 'gte', -10)).rejects.toThrow(/Invalid condition value/);
      await expect(service.addStock(db, '600519', 'gte', 'abc')).rejects.toThrow(/Invalid condition value/);
    });

    it('does not add change_pct or duplicate reminder semantics', async () => {
      const rule = await service.addStock(db, '600519', 'gte', 1700);
      expect(rule.conditionType).not.toBe('change_pct');

      const row = await getTrackerRule(db, rule.id);
      expect(row.condition_type).toBe('gte');
      expect(row.condition_value).toBe(1700);
      expect(row.status).toBe('active');
    });
  });

  describe('list, get, pause, resume, remove', () => {
    it('manages stock rule lifecycle without changing trigger state semantics', async () => {
      const added = await service.addStock(db, '600519', 'gte', 1700);

      const retrieved = await service.get(db, added.id);
      expect(retrieved.targetKey).toBe('sh600519');

      const list = await service.list(db);
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe(added.id);

      const paused = await service.pause(db, added.id);
      expect(paused).toBe(true);
      const pausedRule = await service.get(db, added.id);
      expect(pausedRule.status).toBe('paused');
      expect(pausedRule.armVersion).toBe(1);

      const resumed = await service.resume(db, added.id);
      expect(resumed).toBe(true);
      const activeRule = await service.get(db, added.id);
      expect(activeRule.status).toBe('active');
      expect(activeRule.armVersion).toBe(2);

      const removed = await service.remove(db, added.id);
      expect(removed).toBe(true);
      const gone = await service.get(db, added.id);
      expect(gone).toBeNull();

      const events = await db.prepare('SELECT * FROM tracker_events').all();
      expect(events.results).toHaveLength(0);
    });

    it('list filters by providerType when requested', async () => {
      await service.addStock(db, '600519', 'gte', 1700);
      const all = await service.list(db);
      expect(all).toHaveLength(1);
      const stockOnly = await service.list(db, { providerType: 'stock' });
      expect(stockOnly).toHaveLength(1);
      const empty = await service.list(db, { providerType: 'unknown' });
      expect(empty).toHaveLength(0);
    });
  });

  describe('getQuote', () => {
    it('returns a quote for a valid stock code', async () => {
      const mockFetch = mockFetchForQuote('sh600519', 1700);
      const quote = await service.getQuote(db, '600519', {
        fetchFn: mockFetch,
        relativeTo: new Date('2026-07-13T10:00:00+08:00')
      });

      expect(quote.symbol).toBe('sh600519');
      expect(quote.price).toBe(1700);
      expect(quote.yesterdayClose).toBe(1710);
      expect(quote.source).toBe('tencent');
      expect(quote.observedAt).toBe('2026-07-13T10:00:00+08:00');
    });

    it('rejects invalid stock codes', async () => {
      await expect(service.getQuote(db, '123')).rejects.toThrow(/Invalid stock code/);
    });

    it('throws when no fresh quote is available', async () => {
      const mockFetch = vi.fn().mockImplementation(async () => ({ status: 500, text: async () => 'Error' }));
      await expect(service.getQuote(db, '600519', {
        fetchFn: mockFetch,
        relativeTo: new Date('2026-07-13T10:00:00+08:00')
      })).rejects.toThrow(/All stock quote providers failed/);
    });

    it('uses the clock when relativeTo is not provided', async () => {
      const mockFetch = mockFetchForQuote('sh600519', 1700);
      const quote = await service.getQuote(db, '600519', { fetchFn: mockFetch });
      expect(quote.symbol).toBe('sh600519');
      expect(quote.price).toBe(1700);
    });
  });

  describe('provider interaction', () => {
    it('uses the registry to fetch a stock quote', async () => {
      const mockFetch = mockFetchForQuote('sh600519', 1750);
      const provider = service.registry.get('stock');
      const values = await provider.fetchValues([{ code: '600519' }], {
        fetchFn: mockFetch,
        relativeTo: new Date('2026-07-13T10:00:00+08:00')
      });

      expect(values['sh600519'].value).toBe(1750);
    });

    it('evaluates a gte condition correctly', () => {
      const provider = service.registry.get('stock');
      const rule = { conditionType: 'gte', conditionValue: 1700 };
      expect(provider.evaluate(rule, { value: 1750 })).toBe(true);
      expect(provider.evaluate(rule, { value: 1699.99 })).toBe(false);
      expect(provider.evaluate(rule, 1700)).toBe(true);
    });

    it('evaluates an lte condition correctly', () => {
      const provider = service.registry.get('stock');
      const rule = { conditionType: 'lte', conditionValue: 10 };
      expect(provider.evaluate(rule, { value: 9.5 })).toBe(true);
      expect(provider.evaluate(rule, { value: 10.01 })).toBe(false);
    });

    it('does not support change_pct condition', () => {
      const provider = service.registry.get('stock');
      const rule = { conditionType: 'change_pct', conditionValue: 5 };
      expect(provider.evaluate(rule, { value: 1700 })).toBe(false);
    });

    it('formats a standard monitor event', () => {
      const provider = service.registry.get('stock');
      const rule = { id: 1, arm_version: 2, target_key: 'sh600519', condition_type: 'gte', condition_value: 1700 };
      const value = { value: 1750, observedAt: '2026-07-13T10:00:00+08:00', source: 'tencent' };
      const event = provider.formatEvent(rule, value);

      expect(event.providerType).toBe('stock');
      expect(event.ruleId).toBe(1);
      expect(event.armVersion).toBe(2);
      expect(event.eventKey).toBe('stock:rule:1:2');
      expect(event.value).toBe(1750);
      expect(event.source).toBe('tencent');
      expect(event.payload.code).toBe('sh600519');
      expect(event.payload.conditionType).toBe('gte');
      expect(event.payload.conditionValue).toBe(1700);
      expect(event.payload.price).toBe(1750);
    });
  });
});
