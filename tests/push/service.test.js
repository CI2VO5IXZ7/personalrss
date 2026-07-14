import { describe, it, expect, beforeEach, vi } from 'vitest';
import { D1Mock } from '../helpers/d1_mock.js';
import fs from 'fs';
import path from 'path';
import {
  addSubscription,
  listSubscriptions,
  pauseSubscription,
  resumeSubscription,
  removeSubscription,
  refreshSubscription
} from '../../src/push/rss/service.js';
import { processDueSubscriptions, processSubscription } from '../../src/push/rss/scheduler.js';

const publicResolver = async () => ['93.184.216.34'];

describe('Push RSS Service & Scheduler Tests', () => {
  let db;

  beforeEach(() => {
    db = new D1Mock();
    const migrationSql = fs.readFileSync(
      path.resolve(__dirname, '../../migrations/0005_personal_info_hub.sql'),
      'utf8'
    );
    db.exec(migrationSql);
  });

  describe('CRUD Operations', () => {
    it('should add a subscription, perform first check, list, pause, resume, and refresh', async () => {
      const feedXml = `
        <rss version="2.0">
          <channel>
            <title>My Feed</title>
            <link>https://example.com</link>
            <item>
              <title>Item 1</title>
              <link>https://example.com/1</link>
              <guid>guid-1</guid>
              <pubDate>Mon, 13 Jul 2026 12:00:00 GMT</pubDate>
            </item>
            <item>
              <title>Item 2</title>
              <link>https://example.com/2</link>
              <guid>guid-2</guid>
              <pubDate>Mon, 13 Jul 2026 13:00:00 GMT</pubDate>
            </item>
          </channel>
        </rss>
      `;

      const mockFetch = vi.fn().mockImplementation(async (url) => {
        return {
          status: 200,
          headers: new Headers({ 'content-type': 'application/rss+xml' }),
          text: async () => feedXml
        };
      });

      // 1. Add subscription (which automatically triggers initial processSubscription baseline check)
      const addRes = await addSubscription(
        db,
        'https://example.com/feed.xml',
        { SAFE_FETCH_RESOLVER: publicResolver },
        { fetchFn: mockFetch, resolver: publicResolver }
      );

      expect(addRes.subscription).toBeDefined();
      expect(addRes.title).toBe('My Feed');
      expect(addRes.processResult.success).toBe(true);
      // Under new first check behavior: it should only process/enqueue the latest item (Item 2)
      expect(addRes.processResult.count).toBe(1);

      // Verify notification queue has exactly 1 notification for Item 2
      const { results: notifications } = await db.prepare('SELECT * FROM notification_queue').all();
      expect(notifications).toHaveLength(1);
      expect(JSON.parse(notifications[0].payload_json).entryTitle).toBe('Item 2');

      // Verify all items are in the rss_entries table as baseline
      const { results: entries } = await db.prepare('SELECT * FROM rss_entries').all();
      expect(entries).toHaveLength(2);

      // 2. List subscriptions
      const list = await listSubscriptions(db);
      expect(list).toHaveLength(1);
      expect(list[0].title).toBe('My Feed');
      expect(list[0].status).toBe('active');

      // 3. Pause subscription
      await pauseSubscription(db, list[0].id);
      const pausedSub = await db.prepare('SELECT * FROM rss_subscriptions WHERE id = ?').bind(list[0].id).first();
      expect(pausedSub.status).toBe('paused');

      // 4. Resume subscription
      await resumeSubscription(db, list[0].id);
      const resumedSub = await db.prepare('SELECT * FROM rss_subscriptions WHERE id = ?').bind(list[0].id).first();
      expect(resumedSub.status).toBe('active');

      // 5. Refresh subscription manually
      const refreshRes = await refreshSubscription(
        db,
        list[0].id,
        { SAFE_FETCH_RESOLVER: publicResolver },
        { fetchFn: mockFetch, resolver: publicResolver }
      );
      expect(refreshRes.success).toBe(true);
      expect(refreshRes.count).toBe(0); // No new items
    });

    it('should precisely delete pending/processing/failed queue items on removal but keep sent/dead history', async () => {
      // Setup a subscription
      await db.prepare(`
        INSERT INTO rss_subscriptions (id, feed_url, feed_url_redacted, status)
        VALUES (10, 'https://test.com/feed.xml', 'https://test.com/feed.xml', 'active')
      `).run();

      // Put different notification items in queue for subscription 10
      // 1. Pending RSS notification (should be deleted)
      await db.prepare(`
        INSERT INTO notification_queue (kind, dedupe_key, payload_json, status)
        VALUES ('rss', 'rss:10:entry1', '{}', 'pending')
      `).run();

      // 2. Processing RSS notification (should be deleted)
      await db.prepare(`
        INSERT INTO notification_queue (kind, dedupe_key, payload_json, status)
        VALUES ('rss', 'rss:10:entry2', '{}', 'processing')
      `).run();

      // 3. Failed RSS notification (simulated by status = 'failed') (should be deleted)
      await db.prepare(`
        INSERT INTO notification_queue (kind, dedupe_key, payload_json, status)
        VALUES ('rss', 'rss:10:entry3', '{}', 'failed')
      `).run();

      // 4. Sent RSS notification (should NOT be deleted)
      await db.prepare(`
        INSERT INTO notification_queue (kind, dedupe_key, payload_json, status)
        VALUES ('rss', 'rss:10:entry4', '{}', 'sent')
      `).run();

      // 5. Dead RSS notification (should NOT be deleted)
      await db.prepare(`
        INSERT INTO notification_queue (kind, dedupe_key, payload_json, status)
        VALUES ('rss', 'rss:10:entry5', '{}', 'dead')
      `).run();

      // 6. Another subscription's pending notification (should NOT be deleted)
      await db.prepare(`
        INSERT INTO notification_queue (kind, dedupe_key, payload_json, status)
        VALUES ('rss', 'rss:20:entry1', '{}', 'pending')
      `).run();

      // Setup some entries
      await db.prepare(`
        INSERT INTO rss_entries (subscription_id, entry_key)
        VALUES (10, 'entry1'), (10, 'entry2'), (20, 'entry1')
      `).run();

      // Perform removal
      const removeRes = await removeSubscription(db, 10);
      expect(removeRes).toBe(true);

      // Verify subscription 10 is deleted
      const sub = await db.prepare('SELECT * FROM rss_subscriptions WHERE id = 10').first();
      expect(sub).toBeNull();

      // Verify subscription 10 entries are deleted, but subscription 20 entry is kept
      const entries = await db.prepare('SELECT * FROM rss_entries').all();
      expect(entries.results).toHaveLength(1);
      expect(entries.results[0].subscription_id).toBe(20);

      // Verify queue contents:
      // rss:10:entry1 (pending) -> deleted
      // rss:10:entry2 (processing) -> deleted
      // rss:10:entry3 (failed) -> deleted
      // rss:10:entry4 (sent) -> kept
      // rss:10:entry5 (dead) -> kept
      // rss:20:entry1 (pending) -> kept
      const queueItems = await db.prepare('SELECT * FROM notification_queue ORDER BY dedupe_key').all();
      expect(queueItems.results).toHaveLength(3);
      expect(queueItems.results.map(q => q.dedupe_key)).toEqual([
        'rss:10:entry4',
        'rss:10:entry5',
        'rss:20:entry1'
      ]);
    });
  });

  describe('First Fetch Concurrency', () => {
    it('should only enqueue the newest item once even under concurrent overlapping first fetches', async () => {
      const feedXml = `
        <rss version="2.0">
          <channel>
            <title>Test Feed</title>
            <link>https://test.com</link>
            <item>
              <title>Old Item 1</title>
              <link>https://test.com/1</link>
              <guid>guid-1</guid>
              <pubDate>Mon, 13 Jul 2026 12:00:00 GMT</pubDate>
            </item>
            <item>
              <title>New Item 2</title>
              <link>https://test.com/2</link>
              <guid>guid-2</guid>
              <pubDate>Mon, 13 Jul 2026 13:00:00 GMT</pubDate>
            </item>
          </channel>
        </rss>
      `;

      const mockFetch = vi.fn().mockImplementation(async () => {
        return {
          status: 200,
          headers: new Headers({ 'content-type': 'application/rss+xml' }),
          text: async () => feedXml
        };
      });

      // Insert subscription manually in DB without check timestamps (simulating first fetch pending)
      await db.prepare(`
        INSERT INTO rss_subscriptions (id, feed_url, feed_url_redacted, status, interval_minutes)
        VALUES (1, 'https://test.com/feed.xml', 'https://test.com/feed.xml', 'active', 10)
      `).run();

      const sub = await db.prepare('SELECT * FROM rss_subscriptions WHERE id = 1').first();

      // Trigger two concurrent processSubscription calls
      const results = await Promise.all([
        processSubscription(db, sub, {}, { fetchFn: mockFetch, resolver: publicResolver }),
        processSubscription(db, sub, {}, { fetchFn: mockFetch, resolver: publicResolver })
      ]);

      // Both should return success
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(true);

      // Only one of them should successfully claim and enqueue the newest item (count = 1 for that run, 0 for the other)
      const totalCount = results[0].count + results[1].count;
      expect(totalCount).toBe(1);

      // Verify that notification_queue contains exactly 1 notification for newest item (guid-2)
      const { results: notifications } = await db.prepare('SELECT * FROM notification_queue').all();
      expect(notifications).toHaveLength(1);
      expect(JSON.parse(notifications[0].payload_json).entryTitle).toBe('New Item 2');
    });
  });

  describe('Scheduling Isolation', () => {
    it('should not block subsequent due subscriptions when one fails/throws', async () => {
      // Add two subscriptions
      await db.prepare(`
        INSERT INTO rss_subscriptions (id, feed_url, feed_url_redacted, status, next_check_at, interval_minutes)
        VALUES
          (1, 'https://test.com/fail.xml', 'https://test.com/fail.xml', 'active', '2026-07-13 12:00:00', 10),
          (2, 'https://test.com/success.xml', 'https://test.com/success.xml', 'active', '2026-07-13 12:00:00', 10)
      `).run();

      const failXml = 'This will trigger parsing error';
      const successXml = `
        <rss version="2.0">
          <channel>
            <title>Success Feed</title>
            <item><title>Good Item</title><guid>guid-good</guid></item>
          </channel>
        </rss>
      `;

      const mockFetch = vi.fn().mockImplementation(async (url) => {
        if (url === 'https://test.com/fail.xml') {
          return {
            status: 200,
            headers: new Headers({ 'content-type': 'application/rss+xml' }),
            text: async () => failXml
          };
        }
        return {
          status: 200,
          headers: new Headers({ 'content-type': 'application/rss+xml' }),
          text: async () => successXml
        };
      });

      // Run due subscriptions scheduling
      const count = await processDueSubscriptions(db, {}, { fetchFn: mockFetch, resolver: publicResolver });
      expect(count).toBe(2);

      // Verify subscription 1 check results (failed status/error)
      const sub1 = await db.prepare('SELECT * FROM rss_subscriptions WHERE id = 1').first();
      expect(sub1.last_error).not.toBe('');
      expect(sub1.consecutive_failures).toBe(1);

      // Verify subscription 2 was processed successfully despite subscription 1 failure
      const sub2 = await db.prepare('SELECT * FROM rss_subscriptions WHERE id = 2').first();
      expect(sub2.last_error).toBe('');
      expect(sub2.consecutive_failures).toBe(0);
      expect(sub2.last_success_at).not.toBe('');

      // Verify notification enqueued for sub 2 newest item
      const notifications = await db.prepare('SELECT * FROM notification_queue WHERE dedupe_key LIKE ?').bind('rss:2:%').all();
      expect(notifications.results).toHaveLength(1);
    });
  });

  describe('DeepSeek Degradation', () => {
    it('should fallback to original summary when DeepSeek API fails', async () => {
      await db.prepare(`
        INSERT INTO rss_subscriptions (id, feed_url, feed_url_redacted, status, last_success_at, interval_minutes)
        VALUES (1, 'https://test.com/feed.xml', 'https://test.com/feed.xml', 'active', '2026-07-13 12:00:00', 10)
      `).run();

      const feedXml = `
        <rss version="2.0">
          <channel>
            <title>My Feed</title>
            <item>
              <title>Item 1</title>
              <guid>guid-1</guid>
              <description>Original long description that needs summary</description>
            </item>
          </channel>
        </rss>
      `;

      const mockFetch = vi.fn().mockImplementation(async (url) => {
        if (url === 'https://test.com/feed.xml') {
          return {
            status: 200,
            headers: new Headers({ 'content-type': 'application/rss+xml' }),
            text: async () => feedXml
          };
        }
        if (url === 'https://api.deepseek.com/chat/completions') {
          // Simulate DeepSeek API Failure
          return {
            status: 500,
            ok: false,
            text: async () => 'Internal Server Error'
          };
        }
      });

      const sub = await db.prepare('SELECT * FROM rss_subscriptions WHERE id = 1').first();
      const res = await processSubscription(
        db,
        sub,
        { DEEPSEEK_API_KEY: 'ds-key' },
        { fetchFn: mockFetch, resolver: publicResolver }
      );

      expect(res.success).toBe(true);
      expect(res.count).toBe(1);

      // Verify notification queue has the item with original description as fallback
      const { results: notifications } = await db.prepare('SELECT * FROM notification_queue').all();
      expect(notifications).toHaveLength(1);
      expect(JSON.parse(notifications[0].payload_json).summary).toBe('Original long description that needs summary');
    });
  });
});
