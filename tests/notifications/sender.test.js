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
    await db.prepare("INSERT INTO rss_subscriptions (id, feed_url, feed_url_redacted, status) VALUES (1, 'url', 'url', 'active')").run();
    await enqueue(db, {
      kind: 'rss',
      dedupeKey: 'rss:1:key-1',
      payload: { subscriptionId: 1, feedTitle: 'Feed 1', entryTitle: 'Title 1', summary: 'Summary 1', link: 'https://link.com' }
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
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-13T08:00:00.000Z'));
    await db.prepare("INSERT INTO rss_subscriptions (id, feed_url, feed_url_redacted, status) VALUES (1, 'url', 'url', 'active')").run();
    await enqueue(db, {
      kind: 'rss',
      dedupeKey: 'rss:1:key-1',
      payload: { subscriptionId: 1, feedTitle: 'Feed 1', entryTitle: 'Title 1', summary: 'Summary 1', link: 'https://link.com' }
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
    
    expect(row.available_at).toBe('2026-07-13T08:00:25.000Z');
    vi.useRealTimers();
  });

  it('backs off the first non-429 failure by exactly 60 seconds', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-13T08:00:00.000Z'));
    await enqueue(db, {
      kind: 'system', dedupeKey: 'system:first-backoff', payload: { message: 'Alert' }
    });
    const mockFetch = vi.fn(async () => ({
      status: 500, ok: false, json: async () => ({ description: 'upstream failed' })
    }));

    await processNotificationBatch(db, {
      TELEGRAM_BOT_TOKEN: 'admin-token', TELEGRAM_CHAT_ID: 'admin-chat'
    }, { fetchFn: mockFetch, batchLimit: 1 });

    const row = await db.prepare('SELECT attempts, available_at FROM notification_queue').first();
    expect(row).toEqual({ attempts: 1, available_at: '2026-07-13T08:01:00.000Z' });
    vi.useRealTimers();
  });

  it('backs off the second non-429 failure by exactly 120 seconds', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-13T08:00:00.000Z'));
    await enqueue(db, {
      kind: 'system', dedupeKey: 'system:second-backoff', payload: { message: 'Alert' }
    });
    const mockFetch = vi.fn(async () => ({
      status: 500, ok: false, json: async () => ({ description: 'upstream failed' })
    }));
    const env = { TELEGRAM_BOT_TOKEN: 'admin-token', TELEGRAM_CHAT_ID: 'admin-chat' };

    await processNotificationBatch(db, env, { fetchFn: mockFetch, batchLimit: 1 });
    vi.setSystemTime(new Date('2026-07-13T08:01:00.000Z'));
    await processNotificationBatch(db, env, { fetchFn: mockFetch, batchLimit: 1 });

    const row = await db.prepare('SELECT attempts, available_at FROM notification_queue').first();
    expect(row).toEqual({ attempts: 2, available_at: '2026-07-13T08:03:00.000Z' });
    vi.useRealTimers();
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
        armVersion: 1,
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
        armVersion: 1,
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
        armVersion: 1,
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

  it('retries a system notification when admin Bot credentials are missing', async () => {
    await enqueue(db, {
      kind: 'system',
      dedupeKey: 'system:missing-admin-config',
      payload: { message: 'Operational alert' }
    });
    const mockFetch = vi.fn();

    const count = await processNotificationBatch(db, {
      PUSH_TELEGRAM_BOT_TOKEN: 'push-token',
      PUSH_TELEGRAM_CHANNEL_ID: 'push-channel'
    }, { fetchFn: mockFetch, batchLimit: 1 });

    expect(count).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
    const item = await db.prepare('SELECT status, attempts, last_error FROM notification_queue').first();
    expect(item.status).toBe('pending');
    expect(item.attempts).toBe(1);
    expect(item.last_error).toContain('admin Telegram credentials not configured');
  });

  it('completes a stale old-arm stock item without calling Telegram', async () => {
    const { addTrackerRule } = await import('../../src/db.js');
    await addTrackerRule(db, {
      providerType: 'stock', targetKey: 'sh600519', targetConfig: {},
      conditionType: 'gte', conditionValue: 1700, status: 'trigger_pending'
    });
    await db.prepare('UPDATE tracker_rules SET arm_version = 2 WHERE id = 1').run();
    await enqueue(db, {
      kind: 'stock', dedupeKey: 'stock:rule:1:1',
      payload: { ruleId: 1, armVersion: 1, code: 'sh600519', conditionType: 'gte', conditionValue: 1700, price: 1750 }
    });
    const mockFetch = vi.fn();

    const count = await processNotificationBatch(db, {
      PUSH_TELEGRAM_BOT_TOKEN: 'push-token', PUSH_TELEGRAM_CHANNEL_ID: 'push-channel'
    }, { fetchFn: mockFetch });

    expect(count).toBe(1);
    expect(mockFetch).not.toHaveBeenCalled();
    expect((await db.prepare('SELECT status FROM notification_queue').first()).status).toBe('sent');
    expect((await db.prepare('SELECT status FROM tracker_rules WHERE id = 1').first()).status).toBe('trigger_pending');
  });

  it('guards the post-send state update by status and arm version', async () => {
    const { addTrackerRule } = await import('../../src/db.js');
    await addTrackerRule(db, {
      providerType: 'stock', targetKey: 'sh600519', targetConfig: {},
      conditionType: 'gte', conditionValue: 1700, status: 'trigger_pending'
    });
    await enqueue(db, {
      kind: 'stock', dedupeKey: 'stock:rule:1:1',
      payload: { ruleId: 1, armVersion: 1, code: 'sh600519', conditionType: 'gte', conditionValue: 1700, price: 1750 }
    });
    const mockFetch = vi.fn(async () => {
      await db.prepare("UPDATE tracker_rules SET status = 'active', arm_version = 2 WHERE id = 1").run();
      return { status: 200, ok: true, json: async () => ({ ok: true }) };
    });

    await processNotificationBatch(db, {
      PUSH_TELEGRAM_BOT_TOKEN: 'push-token', PUSH_TELEGRAM_CHANNEL_ID: 'push-channel'
    }, { fetchFn: mockFetch });

    const rule = await db.prepare('SELECT status, arm_version FROM tracker_rules WHERE id = 1').first();
    expect(rule).toEqual({ status: 'active', arm_version: 2 });
    expect((await db.prepare('SELECT * FROM tracker_events').all()).results).toHaveLength(0);
    expect((await db.prepare('SELECT status FROM notification_queue').first()).status).toBe('sent');
  });

  it('should not lease or increment attempts of later items when a Telegram 429 occurs on the first item', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-13T08:00:00.000Z'));
    await db.prepare("INSERT INTO rss_subscriptions (id, feed_url, feed_url_redacted, status) VALUES (1, 'url1', 'url1', 'active')").run();
    await db.prepare("INSERT INTO rss_subscriptions (id, feed_url, feed_url_redacted, status) VALUES (2, 'url2', 'url2', 'active')").run();
    await db.prepare("INSERT INTO rss_subscriptions (id, feed_url, feed_url_redacted, status) VALUES (3, 'url3', 'url3', 'active')").run();
    // Enqueue 3 items
    await enqueue(db, {
      kind: 'rss',
      dedupeKey: 'rss:1:key-1',
      payload: { subscriptionId: 1, feedTitle: 'Feed 1', entryTitle: 'Title 1', summary: 'Summary 1', link: 'https://link.com' }
    });
    await enqueue(db, {
      kind: 'rss',
      dedupeKey: 'rss:2:key-2',
      payload: { subscriptionId: 2, feedTitle: 'Feed 2', entryTitle: 'Title 2', summary: 'Summary 2', link: 'https://link.com' }
    });
    await enqueue(db, {
      kind: 'rss',
      dedupeKey: 'rss:3:key-3',
      payload: { subscriptionId: 3, feedTitle: 'Feed 3', entryTitle: 'Title 3', summary: 'Summary 3', link: 'https://link.com' }
    });

    // Mock fetch to return 429 on the first request
    const mockFetch = vi.fn().mockImplementation(async (url) => {
      return {
        status: 429,
        ok: false,
        json: async () => ({
          ok: false,
          error_code: 429,
          description: 'Flood control active',
          parameters: { retry_after: 30 }
        })
      };
    });

    const count = await processNotificationBatch(
      db,
      { PUSH_TELEGRAM_BOT_TOKEN: 'push-token', PUSH_TELEGRAM_CHANNEL_ID: 'push-channel' },
      { fetchFn: mockFetch, batchLimit: 3 }
    );

    // processedCount should be 0 because the first one failed
    expect(count).toBe(0);

    // Verify all items in database
    const { results: rows } = await db.prepare('SELECT id, dedupe_key, status, attempts, last_error, available_at FROM notification_queue ORDER BY created_at ASC').all();
    expect(rows).toHaveLength(3);

    // First item: failed with 429, attempts incremented to 1, status reset to pending (or rescheduled)
    expect(rows[0].dedupe_key).toBe('rss:1:key-1');
    expect(rows[0].status).toBe('pending');
    expect(rows[0].attempts).toBe(1);
    expect(rows[0].last_error).toContain('Flood control active');
    expect(rows[0].available_at).toBe('2026-07-13T08:00:30.000Z');

    // Second and third items: untouched! attempts=0, status=pending, last_error=null
    expect(rows[1].dedupe_key).toBe('rss:2:key-2');
    expect(rows[1].status).toBe('pending');
    expect(rows[1].attempts).toBe(0);
    expect(rows[1].last_error).toBeNull();

    expect(rows[2].dedupe_key).toBe('rss:3:key-3');
    expect(rows[2].status).toBe('pending');
    expect(rows[2].attempts).toBe(0);
    expect(rows[2].last_error).toBeNull();
    vi.useRealTimers();
  });

  it('should process normal loop up to batchLimit', async () => {
    await db.prepare("INSERT INTO rss_subscriptions (id, feed_url, feed_url_redacted, status) VALUES (1, 'url1', 'url1', 'active')").run();
    await db.prepare("INSERT INTO rss_subscriptions (id, feed_url, feed_url_redacted, status) VALUES (2, 'url2', 'url2', 'active')").run();
    await db.prepare("INSERT INTO rss_subscriptions (id, feed_url, feed_url_redacted, status) VALUES (3, 'url3', 'url3', 'active')").run();
    await db.prepare("INSERT INTO rss_subscriptions (id, feed_url, feed_url_redacted, status) VALUES (4, 'url4', 'url4', 'active')").run();
    // Enqueue 4 items
    await enqueue(db, {
      kind: 'rss',
      dedupeKey: 'rss:1:key-1',
      payload: { subscriptionId: 1, feedTitle: 'Feed 1', entryTitle: 'Title 1', summary: 'Summary 1', link: 'https://link.com' }
    });
    await enqueue(db, {
      kind: 'rss',
      dedupeKey: 'rss:2:key-2',
      payload: { subscriptionId: 2, feedTitle: 'Feed 2', entryTitle: 'Title 2', summary: 'Summary 2', link: 'https://link.com' }
    });
    await enqueue(db, {
      kind: 'rss',
      dedupeKey: 'rss:3:key-3',
      payload: { subscriptionId: 3, feedTitle: 'Feed 3', entryTitle: 'Title 3', summary: 'Summary 3', link: 'https://link.com' }
    });
    await enqueue(db, {
      kind: 'rss',
      dedupeKey: 'rss:4:key-4',
      payload: { subscriptionId: 4, feedTitle: 'Feed 4', entryTitle: 'Title 4', summary: 'Summary 4', link: 'https://link.com' }
    });

    const mockFetch = vi.fn().mockImplementation(async (url) => {
      return {
        status: 200,
        ok: true,
        json: async () => ({ ok: true, result: { message_id: 111 } })
      };
    });

    // Run with batchLimit = 3
    const count = await processNotificationBatch(
      db,
      { PUSH_TELEGRAM_BOT_TOKEN: 'push-token', PUSH_TELEGRAM_CHANNEL_ID: 'push-channel' },
      { fetchFn: mockFetch, batchLimit: 3 }
    );

    // processedCount should be 3
    expect(count).toBe(3);

    // Verify item statuses: first 3 should be sent, the 4th should be pending with attempts=0
    const { results: rows } = await db.prepare('SELECT dedupe_key, status, attempts FROM notification_queue ORDER BY created_at ASC').all();
    expect(rows).toHaveLength(4);

    expect(rows[0].dedupe_key).toBe('rss:1:key-1');
    expect(rows[0].status).toBe('sent');
    expect(rows[0].attempts).toBe(1);

    expect(rows[1].dedupe_key).toBe('rss:2:key-2');
    expect(rows[1].status).toBe('sent');
    expect(rows[1].attempts).toBe(1);

    expect(rows[2].dedupe_key).toBe('rss:3:key-3');
    expect(rows[2].status).toBe('sent');
    expect(rows[2].attempts).toBe(1);

    expect(rows[3].dedupe_key).toBe('rss:4:key-4');
    expect(rows[3].status).toBe('pending');
    expect(rows[3].attempts).toBe(0);
  });

  describe('Pre-send subscription presence validation', () => {
    it('should skip sending and complete notification if subscription has been removed', async () => {
      await db.prepare("INSERT INTO rss_subscriptions (id, feed_url, feed_url_redacted, status) VALUES (10, 'url', 'url', 'active')").run();

      await enqueue(db, {
        kind: 'rss',
        dedupeKey: 'rss:10:entry1',
        payload: { subscriptionId: 10, feedTitle: 'Feed', entryTitle: 'Title', summary: 'Summary' }
      });

      await db.prepare("DELETE FROM rss_subscriptions WHERE id = 10").run();

      const mockFetch = vi.fn();

      const count = await processNotificationBatch(
        db,
        { PUSH_TELEGRAM_BOT_TOKEN: 'push-token', PUSH_TELEGRAM_CHANNEL_ID: 'push-channel' },
        { fetchFn: mockFetch }
      );

      expect(count).toBe(1);
      expect(mockFetch).not.toHaveBeenCalled();

      const { results } = await db.prepare('SELECT status FROM notification_queue').all();
      expect(results[0].status).toBe('sent');
    });

    it('should parse subscription ID from dedupe key if missing in payload', async () => {
      await db.prepare("INSERT INTO rss_subscriptions (id, feed_url, feed_url_redacted, status) VALUES (10, 'url', 'url', 'active')").run();

      await enqueue(db, {
        kind: 'rss',
        dedupeKey: 'rss:10:entry1',
        payload: { feedTitle: 'Feed', entryTitle: 'Title', summary: 'Summary' }
      });

      await db.prepare("DELETE FROM rss_subscriptions WHERE id = 10").run();

      const mockFetch = vi.fn();

      const count = await processNotificationBatch(
        db,
        { PUSH_TELEGRAM_BOT_TOKEN: 'push-token', PUSH_TELEGRAM_CHANNEL_ID: 'push-channel' },
        { fetchFn: mockFetch }
      );

      expect(count).toBe(1);
      expect(mockFetch).not.toHaveBeenCalled();

      const { results } = await db.prepare('SELECT status FROM notification_queue').all();
      expect(results[0].status).toBe('sent');
    });

    it('should fail closed and enter retry if subscription presence DB check fails', async () => {
      await db.prepare("INSERT INTO rss_subscriptions (id, feed_url, feed_url_redacted, status) VALUES (10, 'url', 'url', 'active')").run();

      await enqueue(db, {
        kind: 'rss',
        dedupeKey: 'rss:10:entry1',
        payload: { subscriptionId: 10, feedTitle: 'Feed', entryTitle: 'Title', summary: 'Summary' }
      });

      const originalPrepare = db.prepare;
      db.prepare = vi.fn().mockImplementation((sql, ...args) => {
        if (sql.includes('SELECT id FROM rss_subscriptions')) {
          throw new Error('D1 connection lost');
        }
        return originalPrepare.call(db, sql, ...args);
      });

      const mockFetch = vi.fn();

      const count = await processNotificationBatch(
        db,
        { PUSH_TELEGRAM_BOT_TOKEN: 'push-token', PUSH_TELEGRAM_CHANNEL_ID: 'push-channel' },
        { fetchFn: mockFetch }
      );

      expect(count).toBe(0);

      db.prepare = originalPrepare;

      const row = await db.prepare('SELECT status, last_error FROM notification_queue').first();
      expect(row.status).toBe('pending');
      expect(row.last_error).toContain('D1 connection lost');
    });

    it('should NOT skip sending if subscription is paused', async () => {
      await db.prepare("INSERT INTO rss_subscriptions (id, feed_url, feed_url_redacted, status) VALUES (10, 'url', 'url', 'paused')").run();

      await enqueue(db, {
        kind: 'rss',
        dedupeKey: 'rss:10:entry1',
        payload: { subscriptionId: 10, feedTitle: 'Feed', entryTitle: 'Title', summary: 'Summary' }
      });

      const mockFetch = vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        json: async () => ({ ok: true, result: { message_id: 111 } })
      });

      const count = await processNotificationBatch(
        db,
        { PUSH_TELEGRAM_BOT_TOKEN: 'push-token', PUSH_TELEGRAM_CHANNEL_ID: 'push-channel' },
        { fetchFn: mockFetch }
      );

      expect(count).toBe(1);
      expect(mockFetch).toHaveBeenCalled();
    });

    it('should handle concurrent remove-in-flight: skip sending leased item if subscription is removed during processing', async () => {
      await db.prepare("INSERT INTO rss_subscriptions (id, feed_url, feed_url_redacted, status) VALUES (10, 'url', 'url', 'active')").run();

      await enqueue(db, {
        kind: 'rss',
        dedupeKey: 'rss:10:entry1',
        payload: { subscriptionId: 10, feedTitle: 'Feed', entryTitle: 'Title', summary: 'Summary' }
      });

      const { results: leased } = await db.prepare(
        "UPDATE notification_queue SET status = 'processing', lease_token = 'token', lease_expires_at = datetime('now', '+300 seconds') RETURNING *"
      ).all();
      expect(leased).toHaveLength(1);

      await db.prepare("DELETE FROM rss_subscriptions WHERE id = 10").run();

      await db.prepare("UPDATE notification_queue SET status = 'pending', lease_token = NULL, lease_expires_at = NULL").run();

      const mockFetch = vi.fn();
      const count = await processNotificationBatch(
        db,
        { PUSH_TELEGRAM_BOT_TOKEN: 'push-token', PUSH_TELEGRAM_CHANNEL_ID: 'push-channel' },
        { fetchFn: mockFetch }
      );

      expect(count).toBe(1);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should log rss_subscription_removed_skip without dedupeKey', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await enqueue(db, {
        kind: 'rss',
        dedupeKey: 'rss:10:entry1',
        payload: { subscriptionId: 10, feedTitle: 'Feed', entryTitle: 'Title', summary: 'Summary' }
      });

      const mockFetch = vi.fn();
      await processNotificationBatch(
        db,
        { PUSH_TELEGRAM_BOT_TOKEN: 'push-token', PUSH_TELEGRAM_CHANNEL_ID: 'push-channel' },
        { fetchFn: mockFetch }
      );

      expect(consoleSpy).toHaveBeenCalled();
      const calls = consoleSpy.mock.calls;
      const skipLogCall = calls.find(call => call[0].includes('sender.rss_subscription_removed_skip'));
      expect(skipLogCall).toBeDefined();
      const parsedLog = JSON.parse(skipLogCall[0]);
      expect(parsedLog).toHaveProperty('notificationId');
      expect(parsedLog).toHaveProperty('subscriptionId', 10);
      expect(parsedLog).not.toHaveProperty('dedupeKey');
      expect(parsedLog).not.toHaveProperty('dedupe_key');
      consoleSpy.mockRestore();
    });

    it('should prioritize payload subscriptionId as a decimal string', async () => {
      await db.prepare("INSERT INTO rss_subscriptions (id, feed_url, feed_url_redacted, status) VALUES (15, 'url', 'url', 'active')").run();

      await enqueue(db, {
        kind: 'rss',
        dedupeKey: 'rss:10:entry1',
        payload: { subscriptionId: "15", feedTitle: 'Feed', entryTitle: 'Title', summary: 'Summary' }
      });

      const mockFetch = vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        json: async () => ({ ok: true, result: { message_id: 111 } })
      });

      const count = await processNotificationBatch(
        db,
        { PUSH_TELEGRAM_BOT_TOKEN: 'push-token', PUSH_TELEGRAM_CHANNEL_ID: 'push-channel' },
        { fetchFn: mockFetch }
      );

      expect(count).toBe(1);
      expect(mockFetch).toHaveBeenCalled();
    });

    it('should fallback to strictly parsing dedupe_key when payload subscriptionId is invalid', async () => {
      await db.prepare("INSERT INTO rss_subscriptions (id, feed_url, feed_url_redacted, status) VALUES (20, 'url', 'url', 'active')").run();

      await enqueue(db, {
        kind: 'rss',
        dedupeKey: 'rss:20:entry1',
        payload: { subscriptionId: "invalid_sub_id", feedTitle: 'Feed', entryTitle: 'Title', summary: 'Summary' }
      });

      const mockFetch = vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        json: async () => ({ ok: true, result: { message_id: 111 } })
      });

      const count = await processNotificationBatch(
        db,
        { PUSH_TELEGRAM_BOT_TOKEN: 'push-token', PUSH_TELEGRAM_CHANNEL_ID: 'push-channel' },
        { fetchFn: mockFetch }
      );

      expect(count).toBe(1);
      expect(mockFetch).toHaveBeenCalled();
    });

    it('should fail closed and enter retry when both payload subscriptionId and dedupe_key are invalid/missing', async () => {
      await enqueue(db, {
        kind: 'rss',
        dedupeKey: 'rss:invalid:entry1',
        payload: { subscriptionId: "invalid_sub_id", feedTitle: 'Feed', entryTitle: 'Title', summary: 'Summary' }
      });

      const mockFetch = vi.fn();

      const count = await processNotificationBatch(
        db,
        { PUSH_TELEGRAM_BOT_TOKEN: 'push-token', PUSH_TELEGRAM_CHANNEL_ID: 'push-channel' },
        { fetchFn: mockFetch }
      );

      expect(count).toBe(0);
      expect(mockFetch).not.toHaveBeenCalled();

      const row = await db.prepare('SELECT status, last_error, attempts FROM notification_queue').first();
      expect(row.status).toBe('pending');
      expect(row.attempts).toBe(1);
      expect(row.last_error).toContain('Invalid or missing subscriptionId');
    });

    it('should fail closed and enter retry if subscriptionId is negative or 0', async () => {
      await enqueue(db, {
        kind: 'rss',
        dedupeKey: 'rss:0:entry1',
        payload: { subscriptionId: 0, feedTitle: 'Feed', entryTitle: 'Title', summary: 'Summary' }
      });

      const mockFetch = vi.fn();

      const count = await processNotificationBatch(
        db,
        { PUSH_TELEGRAM_BOT_TOKEN: 'push-token', PUSH_TELEGRAM_CHANNEL_ID: 'push-channel' },
        { fetchFn: mockFetch }
      );

      expect(count).toBe(0);
      expect(mockFetch).not.toHaveBeenCalled();

      const row = await db.prepare('SELECT status, last_error, attempts FROM notification_queue').first();
      expect(row.status).toBe('pending');
      expect(row.attempts).toBe(1);
      expect(row.last_error).toContain('Invalid or missing subscriptionId');
    });
  });
});
