import { describe, it, expect, beforeEach, vi } from 'vitest';
import { D1Mock } from '../helpers/d1_mock.js';
import fs from 'fs';
import path from 'path';
import { addTrackerRule, getTrackerRule, getTrackerRules, getTrackerEvents } from '../../src/db.js';
import { evaluateRules } from '../../src/trackers/engine.js';

describe('Stock Evaluation Engine', () => {
  let db;

  beforeEach(() => {
    db = new D1Mock();
    const migrationSql = fs.readFileSync(
      path.resolve(__dirname, '../../migrations/0005_personal_info_hub.sql'),
      'utf8'
    );
    db.exec(migrationSql);
  });

  it('should evaluate gte and lte boundaries correctly', async () => {
    // Add two rules
    await addTrackerRule(db, {
      providerType: 'stock',
      targetKey: 'sh600519',
      targetConfig: { code: '600519' },
      conditionType: 'gte',
      conditionValue: 1700.00
    });
    await addTrackerRule(db, {
      providerType: 'stock',
      targetKey: 'sz000001',
      targetConfig: { code: '000001' },
      conditionType: 'lte',
      conditionValue: 10.00
    });

    const mockFetch = vi.fn().mockImplementation(async (url) => {
      if (url.includes('sqt.gtimg.cn')) {
        // Tencent mock returning:
        // sh600519 = 1700.00 (exactly equal to gte target)
        // sz000001 = 10.01 (above lte target, not triggered)
        return {
          status: 200,
          text: async () => 
            'v_sh600519="1~贵州茅台~600519~1700.00~1710.00~1715.00~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~20260713100000~0";\n' +
            'v_sz000001="1~平安银行~000001~10.01~10.00~10.00~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~20260713100000~0";'
        };
      }
    });

    // Run evaluation (force within trading session for testing)
    const count = await evaluateRules(db, {}, {
      fetchFn: mockFetch,
      relativeTo: new Date('2026-07-13T10:00:00+08:00'),
      forceTradingSession: true
    });

    expect(count).toBe(1);

    // Verify rules status
    const rules = await getTrackerRules(db);
    const rule1 = rules.find(r => r.target_key === 'sh600519');
    const rule2 = rules.find(r => r.target_key === 'sz000001');

    expect(rule1.status).toBe('trigger_pending');
    expect(rule2.status).toBe('active');

    // Check event logged
    const events = await getTrackerEvents(db, rule1.id);
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe('trigger_pending');
    expect(events[0].value).toBe(1700.00);

    // Check notification queued
    const { results } = await db.prepare("SELECT * FROM notification_queue WHERE kind = 'stock'").all();
    expect(results).toHaveLength(1);
    const payload = JSON.parse(results[0].payload_json);
    expect(payload.price).toBe(1700.00);
    expect(payload.code).toBe('sh600519');
  });

  it('should rollback to active state if notification enqueue fails', async () => {
    await addTrackerRule(db, {
      providerType: 'stock',
      targetKey: 'sh600519',
      targetConfig: { code: '600519' },
      conditionType: 'gte',
      conditionValue: 1700.00
    });

    const mockFetch = vi.fn().mockImplementation(async (url) => {
      return {
        status: 200,
        text: async () => 'v_sh600519="1~贵州茅台~600519~1750.00~1710.00~1715.00~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~20260713100000~0";'
      };
    });

    // Mock enqueue to fail by injecting a failing prepare on D1 or breaking the database constraint
    // For TDD rollback, let's temporarily break the notification_queue insert by removing the table or altering it, 
    // or just let evaluation throw by making the database read-only/closed, or by mocking db.prepare to throw.
    const originalPrepare = db.prepare;
    db.prepare = function(sql) {
      if (sql.includes('INSERT OR IGNORE INTO notification_queue')) {
        return {
          bind: () => ({
            run: () => {
              throw new Error('Database write error');
            }
          })
        };
      }
      return originalPrepare.call(db, sql);
    };

    let errorThrown = false;
    try {
      await evaluateRules(db, {}, {
        fetchFn: mockFetch,
        relativeTo: new Date('2026-07-13T10:00:00+08:00'),
        forceTradingSession: true
      });
    } catch (e) {
      errorThrown = true;
    }

    expect(errorThrown).toBe(true);

    // Verify status was rolled back to active
    const rules = await getTrackerRules(db);
    expect(rules[0].status).toBe('active');

    // Verify no trigger_pending event remains
    const events = await getTrackerEvents(db, rules[0].id);
    expect(events).toHaveLength(0);
  });

  it('should enqueue a deduped daily system alert on dual-provider failure', async () => {
    // Add rule so we have an active one
    await addTrackerRule(db, {
      providerType: 'stock',
      targetKey: 'sh600519',
      targetConfig: { code: '600519' },
      conditionType: 'gte',
      conditionValue: 1700.00
    });

    const mockFetch = vi.fn().mockImplementation(async (url) => {
      // Both fail
      return {
        status: 500,
        text: async () => 'Internal Server Error'
      };
    });

    await evaluateRules(db, {}, {
      fetchFn: mockFetch,
      relativeTo: new Date('2026-07-13T10:00:00+08:00'),
      forceTradingSession: true
    });

    // Check system alert enqueued
    const { results } = await db.prepare("SELECT * FROM notification_queue WHERE kind = 'system'").all();
    expect(results).toHaveLength(1);
    expect(results[0].dedupe_key).toContain('stock_provider_failure:2026-07-13');
    const payload = JSON.parse(results[0].payload_json);
    expect(payload.message).toContain('failed');
    expect(payload.message).not.toContain('http');
    expect(payload.message).not.toContain('gtimg');
  });

  it('should enqueue a deduped daily system warning for missing symbols (one-symbol missing warning)', async () => {
    // Add two rules
    await addTrackerRule(db, {
      providerType: 'stock',
      targetKey: 'sh600519',
      targetConfig: { code: '600519' },
      conditionType: 'gte',
      conditionValue: 1700.00
    });
    await addTrackerRule(db, {
      providerType: 'stock',
      targetKey: 'sz000001',
      targetConfig: { code: '000001' },
      conditionType: 'gte',
      conditionValue: 10.00
    });

    const mockFetch = vi.fn().mockImplementation(async (url) => {
      if (url.includes('sqt.gtimg.cn')) {
        // Return only sh600519; sz000001 is missing/invalid
        return {
          status: 200,
          text: async () => 'v_sh600519="1~贵州茅台~600519~1750.00~1710.00~1715.00~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~20260713100000~0";'
        };
      }
      if (url.includes('sinajs.cn')) {
        // Fallback Sina also fails for sz000001
        return {
          status: 500,
          text: async () => 'Internal Error'
        };
      }
    });

    const count = await evaluateRules(db, {}, {
      fetchFn: mockFetch,
      relativeTo: new Date('2026-07-13T10:00:00+08:00'),
      forceTradingSession: true
    });

    // sh600519 should trigger, sz000001 is missing
    expect(count).toBe(1);

    // Check system warning enqueued for the missing symbol
    const { results } = await db.prepare("SELECT * FROM notification_queue WHERE kind = 'system'").all();
    expect(results).toHaveLength(1);
    expect(results[0].dedupe_key).toContain('stock_missing_symbols:2026-07-13');
    const payload = JSON.parse(results[0].payload_json);
    expect(payload.message).toContain('sz000001');
  });

  it('should support rearming by incrementing arm_version atomically (rearm second trigger)', async () => {
    const { getTrackerRule, updateTrackerRuleStatus } = await import('../../src/db.js');

    await addTrackerRule(db, {
      providerType: 'stock',
      targetKey: 'sh600519',
      targetConfig: { code: '600519' },
      conditionType: 'gte',
      conditionValue: 1700.00
    });

    const mockFetch = vi.fn().mockImplementation(async (url) => {
      return {
        status: 200,
        text: async () => 'v_sh600519="1~贵州茅台~600519~1750.00~1710.00~1715.00~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~20260713100000~0";'
      };
    });

    // 1st Trigger
    let count = await evaluateRules(db, {}, {
      fetchFn: mockFetch,
      relativeTo: new Date('2026-07-13T10:00:00+08:00'),
      forceTradingSession: true
    });
    expect(count).toBe(1);

    const ruleBefore = await getTrackerRule(db, 1);
    expect(ruleBefore.status).toBe('trigger_pending');
    expect(ruleBefore.arm_version).toBe(1);

    // Simulated sender marks it triggered
    await updateTrackerRuleStatus(db, 1, 'triggered');

    // Resume (which increments arm_version atomically)
    const resumed = await updateTrackerRuleStatus(db, 1, 'active');
    expect(resumed).toBe(true);

    const ruleAfter = await getTrackerRule(db, 1);
    expect(ruleAfter.status).toBe('active');
    expect(ruleAfter.arm_version).toBe(2);

    // 2nd Trigger
    count = await evaluateRules(db, {}, {
      fetchFn: mockFetch,
      relativeTo: new Date('2026-07-13T10:05:00+08:00'),
      forceTradingSession: true
    });
    expect(count).toBe(1);

    const ruleTriggeredAgain = await getTrackerRule(db, 1);
    expect(ruleTriggeredAgain.status).toBe('trigger_pending');
    expect(ruleTriggeredAgain.arm_version).toBe(2);

    // Check both notifications are enqueued (different dedupe keys because of arm_version)
    const { results } = await db.prepare("SELECT * FROM notification_queue WHERE kind = 'stock'").all();
    expect(results).toHaveLength(2);
    expect(results[0].dedupe_key).toBe('stock:rule:1:1');
    expect(results[1].dedupe_key).toBe('stock:rule:1:2');
  });

  it('should keep duplicate evaluations in the same arm idempotent (same-arm dedupe)', async () => {
    await addTrackerRule(db, {
      providerType: 'stock',
      targetKey: 'sh600519',
      targetConfig: { code: '600519' },
      conditionType: 'gte',
      conditionValue: 1700.00
    });

    const mockFetch = vi.fn().mockImplementation(async (url) => {
      return {
        status: 200,
        text: async () => 'v_sh600519="1~贵州茅台~600519~1750.00~1710.00~1715.00~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~20260713100000~0";'
      };
    });

    // 1st run
    let count = await evaluateRules(db, {}, {
      fetchFn: mockFetch,
      relativeTo: new Date('2026-07-13T10:00:00+08:00'),
      forceTradingSession: true
    });
    expect(count).toBe(1);

    // 2nd run (duplicate)
    count = await evaluateRules(db, {}, {
      fetchFn: mockFetch,
      relativeTo: new Date('2026-07-13T10:01:00+08:00'),
      forceTradingSession: true
    });
    expect(count).toBe(0); // Should not trigger again

    // Verify only one notification exists
    const { results } = await db.prepare("SELECT * FROM notification_queue WHERE kind = 'stock'").all();
    expect(results).toHaveLength(1);
    expect(results[0].dedupe_key).toBe('stock:rule:1:1');
  });

  it('should use Beijing date rather than UTC date for stock-provider daily warning dedupe (Beijing date)', async () => {
    // Add rule
    await addTrackerRule(db, {
      providerType: 'stock',
      targetKey: 'sh600519',
      targetConfig: { code: '600519' },
      conditionType: 'gte',
      conditionValue: 1700.00
    });

    const mockFetch = vi.fn().mockImplementation(async (url) => {
      return {
        status: 500,
        text: async () => 'Internal Error'
      };
    });

    // relativeTo is 2026-07-13T20:00:00Z which is 2026-07-14T04:00:00+08:00 (next day in Beijing)
    const relativeTo = new Date('2026-07-13T20:00:00Z');

    await evaluateRules(db, {}, {
      fetchFn: mockFetch,
      relativeTo,
      forceTradingSession: true
    });

    // Check system warning enqueued with Beijing date 2026-07-14
    const { results } = await db.prepare("SELECT * FROM notification_queue WHERE kind = 'system'").all();
    expect(results).toHaveLength(1);
    expect(results[0].dedupe_key).toBe('stock_provider_failure:2026-07-14');
  });
});
