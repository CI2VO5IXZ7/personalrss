import { describe, it, expect, beforeEach, vi } from 'vitest';
import { D1Mock } from '../helpers/d1_mock.js';
import fs from 'fs';
import path from 'path';
import { enqueue } from '../../src/notifications/queue.js';
import { processNotificationBatch, formatRssNotification } from '../../src/notifications/sender.js';

describe('Notification Sender / Consumer', () => {
  let db;

  beforeEach(() => {
    db = new D1Mock();
    const migrationSql = fs.readFileSync(
      path.resolve(__dirname, '../../migrations/0005_personal_info_hub.sql'),
      'utf8'
    );
    db.exec(migrationSql);
  });

  it('should format RSS notification with HTML escaping', () => {
    const payload = {
      feedTitle: 'My <Feed>',
      entryTitle: 'Item & Title',
      summary: 'Short summary with <b>tags</b>',
      link: 'https://example.com/1?a=1&b=2'
    };

    const text = formatRssNotification(payload);
    expect(text).toContain('📰 <b>My &lt;Feed&gt;</b>');
    expect(text).toContain('<b>Item &amp; Title</b>');
    expect(text).toContain('Short summary with &lt;b&gt;tags&lt;/b&gt;');
    expect(text).toContain('href="https://example.com/1?a=1&amp;b=2"');
  });

  it('should process notification batch successfully', async () => {
    await enqueue(db, {
      kind: 'rss',
      dedupeKey: 'key-1',
      payload: { feedTitle: 'Feed 1', entryTitle: 'Title 1', summary: 'Summary 1', link: 'https://link.com' }
    });

    const mockFetch = vi.fn().mockImplementation(async (url) => {
      return {
        status: 200,
        ok: true,
        json: async () => ({ ok: true, result: { message_id: 111 } })
      };
    });

    const count = await processNotificationBatch(
      db,
      { PUSH_TELEGRAM_BOT_TOKEN: 'push-token', PUSH_TELEGRAM_CHANNEL_ID: 'push-channel' },
      { fetchFn: mockFetch }
    );

    expect(count).toBe(1);

    // Verify it is completed (sent)
    const { results } = await db.prepare('SELECT status FROM notification_queue').all();
    expect(results[0].status).toBe('sent');
  });

  it('should fail and retry on Telegram 429 rate limit with correct backoff', async () => {
    await enqueue(db, {
      kind: 'rss',
      dedupeKey: 'key-1',
      payload: { feedTitle: 'Feed 1', entryTitle: 'Title 1', summary: 'Summary 1', link: 'https://link.com' }
    });

    const mockFetch = vi.fn().mockImplementation(async (url) => {
      return {
        status: 429,
        ok: false,
        json: async () => ({
          ok: false,
          error_code: 429,
          description: 'Too Many Requests: retry after 25',
          parameters: { retry_after: 25 }
        })
      };
    });

    const count = await processNotificationBatch(
      db,
      { PUSH_TELEGRAM_BOT_TOKEN: 'push-token', PUSH_TELEGRAM_CHANNEL_ID: 'push-channel' },
      { fetchFn: mockFetch }
    );

    expect(count).toBe(0);

    // Verify it is back to pending and has available_at set in the future
    const row = await db.prepare('SELECT status, last_error, available_at, attempts FROM notification_queue').first();
    expect(row.status).toBe('pending');
    expect(row.last_error).toContain('Too Many Requests');
    expect(row.attempts).toBe(1);
    
    // Difference between available_at and now should be approx 25s
    const availableTime = new Date(row.available_at).getTime();
    const diff = (availableTime - Date.now()) / 1000;
    expect(diff).toBeGreaterThan(20);
    expect(diff).toBeLessThan(30);
  });

  it('should format stock notifications correctly', async () => {
    const { formatStockNotification } = await import('../../src/notifications/sender.js');
    const payload = {
      code: 'sh600519',
      conditionType: 'gte',
      conditionValue: 1700.00,
      price: 1705.50,
      observedAt: '2026-07-13T10:00:00+08:00',
      source: 'tencent'
    };
    const text = formatStockNotification(payload);
    expect(text).toContain('个股提醒: sh600519');
    expect(text).toContain('最新价: <b>1705.5</b>');
    expect(text).toContain('条件: 最新价 ≥ 1700');
    expect(text).toContain('时间: 2026-07-13T10:00:00+08:00');
    expect(text).toContain('数据源: tencent');
  });

  it('should process stock notification and transition rule status', async () => {
    // Add rule in trigger_pending status
    const { addTrackerRule, getTrackerRule } = await import('../../src/db.js');
    await addTrackerRule(db, {
      providerType: 'stock',
      targetKey: 'sh600519',
      targetConfig: { code: '600519' },
      conditionType: 'gte',
      conditionValue: 1700.00,
      status: 'trigger_pending'
    });
    const rules = await db.prepare("SELECT id FROM tracker_rules").all();
    const ruleId = rules.results[0].id;

    await enqueue(db, {
      kind: 'stock',
      dedupeKey: 'stock-key-1',
      payload: {
        ruleId,
        code: 'sh600519',
        conditionType: 'gte',
        conditionValue: 1700.00,
        price: 1705.50,
        observedAt: '2026-07-13T10:00:00+08:00',
        source: 'tencent'
      }
    });

    const mockFetch = vi.fn().mockImplementation(async (url) => {
      return {
        status: 200,
        ok: true,
        json: async () => ({ ok: true, result: { message_id: 111 } })
      };
    });

    const count = await processNotificationBatch(
      db,
      { PUSH_TELEGRAM_BOT_TOKEN: 'push-token', PUSH_TELEGRAM_CHANNEL_ID: 'push-channel' },
      { fetchFn: mockFetch }
    );

    expect(count).toBe(1);

    // Rule status should be updated to triggered
    const rule = await getTrackerRule(db, ruleId);
    expect(rule.status).toBe('triggered');
  });

  it('should handle autoPause condition in stock notification', async () => {
    const { addTrackerRule, getTrackerRule } = await import('../../src/db.js');
    await addTrackerRule(db, {
      providerType: 'stock',
      targetKey: 'sh600519',
      targetConfig: { code: '600519' },
      conditionType: 'gte',
      conditionValue: 1700.00,
      status: 'trigger_pending'
    });
    const rules = await db.prepare("SELECT id FROM tracker_rules").all();
    const ruleId = rules.results[0].id;

    await enqueue(db, {
      kind: 'stock',
      dedupeKey: 'stock-key-2',
      payload: {
        ruleId,
        code: 'sh600519',
        conditionType: 'gte',
        conditionValue: 1700.00,
        price: 1705.50,
        observedAt: '2026-07-13T10:00:00+08:00',
        source: 'tencent',
        autoPause: true
      }
    });

    const mockFetch = vi.fn().mockImplementation(async (url) => {
      return {
        status: 200,
        ok: true,
        json: async () => ({ ok: true })
      };
    });

    await processNotificationBatch(
      db,
      { PUSH_TELEGRAM_BOT_TOKEN: 'push-token', PUSH_TELEGRAM_CHANNEL_ID: 'push-channel' },
      { fetchFn: mockFetch }
    );

    // Rule status should be updated to paused
    const rule = await getTrackerRule(db, ruleId);
    expect(rule.status).toBe('paused');
  });

  it('should keep rule trigger_pending on notification send failure', async () => {
    const { addTrackerRule, getTrackerRule } = await import('../../src/db.js');
    await addTrackerRule(db, {
      providerType: 'stock',
      targetKey: 'sh600519',
      targetConfig: { code: '600519' },
      conditionType: 'gte',
      conditionValue: 1700.00,
      status: 'trigger_pending'
    });
    const rules = await db.prepare("SELECT id FROM tracker_rules").all();
    const ruleId = rules.results[0].id;

    await enqueue(db, {
      kind: 'stock',
      dedupeKey: 'stock-key-3',
      payload: {
        ruleId,
        code: 'sh600519',
        conditionType: 'gte',
        conditionValue: 1700.00,
        price: 1705.50,
        observedAt: '2026-07-13T10:00:00+08:00',
        source: 'tencent'
      }
    });

    const mockFetch = vi.fn().mockImplementation(async (url) => {
      return {
        status: 500,
        ok: false,
        json: async () => ({ ok: false })
      };
    });

    const count = await processNotificationBatch(
      db,
      { PUSH_TELEGRAM_BOT_TOKEN: 'push-token', PUSH_TELEGRAM_CHANNEL_ID: 'push-channel' },
      { fetchFn: mockFetch }
    );

    expect(count).toBe(0);

    // Rule status should remain trigger_pending
    const rule = await getTrackerRule(db, ruleId);
    expect(rule.status).toBe('trigger_pending');
  });

  it('should throw on unknown notification kinds and not complete silently', async () => {
    await enqueue(db, {
      kind: 'unknown_kind',
      dedupeKey: 'unknown-key',
      payload: { test: true }
    });

    const mockFetch = vi.fn().mockImplementation(async (url) => {
      return {
        status: 200,
        ok: true
      };
    });

    const count = await processNotificationBatch(
      db,
      { PUSH_TELEGRAM_BOT_TOKEN: 'push-token', PUSH_TELEGRAM_CHANNEL_ID: 'push-channel' },
      { fetchFn: mockFetch }
    );

    expect(count).toBe(0);

    const { results } = await db.prepare('SELECT status, last_error FROM notification_queue WHERE kind = \'unknown_kind\'').all();
    expect(results[0].status).toBe('pending'); // goes back to pending/failed, not sent!
    expect(results[0].last_error).toContain('Unknown notification kind');
  });
});
