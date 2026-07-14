import { describe, it, expect, beforeEach, vi } from 'vitest';
import { D1Mock } from '../helpers/d1_mock.js';
import fs from 'fs';
import path from 'path';
import { processSubscription } from '../../src/rss/scheduler.js';
import { getRssSubscriptions, addRssSubscription } from '../../src/db.js';

const publicResolver = async () => ['93.184.216.34'];

describe('RSS Scheduler / Processor', () => {
  let db;

  beforeEach(() => {
    db = new D1Mock();
    const migrationSql = fs.readFileSync(
      path.resolve(__dirname, '../../migrations/0005_personal_info_hub.sql'),
      'utf8'
    );
    db.exec(migrationSql);
  });

  it('should establish first-subscription baseline and only enqueue the newest 1 entry', async () => {
    const feedXml = `
      <rss version="2.0">
        <channel>
          <title>Test Feed</title>
          <link>https://test.com</link>
          <item>
            <title>Baseline Item 1</title>
            <link>https://test.com/1</link>
            <guid>guid-1</guid>
            <pubDate>Mon, 13 Jul 2026 12:00:00 GMT</pubDate>
            <description>Item 1 description</description>
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

    await addRssSubscription(db, 'https://test.com/feed.xml', 'https://test.com/feed.xml', '', '', 10);
    const subs = await getRssSubscriptions(db);
    const sub = subs[0];

    const res = await processSubscription(db, sub, { DEEPSEEK_API_KEY: 'ds-key' }, { resolver: publicResolver, fetchFn: mockFetch });
    expect(res.success).toBe(true);

    // Entries should be persisted
    const { results: entries } = await db.prepare('SELECT * FROM rss_entries').all();
    expect(entries).toHaveLength(1);
    expect(entries[0].entry_key).toBe('guid-1');

    // Notification queue should contain exactly 1 notification (the newest one)
    const { results: notifications } = await db.prepare('SELECT * FROM notification_queue').all();
    expect(notifications).toHaveLength(1);
    expect(JSON.parse(notifications[0].payload_json).entryTitle).toBe('Baseline Item 1');

    // Last success/check timestamps should be updated
    const updatedSub = await db.prepare('SELECT * FROM rss_subscriptions WHERE id = ?').bind(sub.id).first();
    expect(updatedSub.last_success_at).not.toBe('');
    expect(updatedSub.last_checked_at).not.toBe('');
  });

  it('should enqueue notifications for new items in subsequent checks in chronological order', async () => {
    // 1. Establish baseline
    await addRssSubscription(db, 'https://test.com/feed.xml', 'https://test.com/feed.xml', '', '', 10);
    let subs = await getRssSubscriptions(db);
    let sub = subs[0];

    const baselineXml = `
      <rss version="2.0">
        <channel>
          <title>Test Feed</title>
          <link>https://test.com</link>
          <item>
            <title>Baseline Item 1</title>
            <link>https://test.com/1</link>
            <guid>guid-1</guid>
            <pubDate>Mon, 13 Jul 2026 12:00:00 GMT</pubDate>
          </item>
        </channel>
      </rss>
    `;

    const mockFetch = vi.fn().mockImplementation(async (url) => {
      return {
        status: 200,
        headers: new Headers({ 'content-type': 'application/rss+xml' }),
        text: async () => baselineXml
      };
    });

    await processSubscription(db, sub, {}, { resolver: publicResolver, fetchFn: mockFetch });

    // 2. Perform second check with 2 new items (unordered chronologically in XML)
    const secondXml = `
      <rss version="2.0">
        <channel>
          <title>Test Feed</title>
          <link>https://test.com</link>
          <item>
            <title>Newer Item 3</title>
            <link>https://test.com/3</link>
            <guid>guid-3</guid>
            <pubDate>Mon, 13 Jul 2026 14:00:00 GMT</pubDate>
            <description>Item 3 description</description>
          </item>
          <item>
            <title>Older Item 2</title>
            <link>https://test.com/2</link>
            <guid>guid-2</guid>
            <pubDate>Mon, 13 Jul 2026 13:00:00 GMT</pubDate>
            <description>Item 2 description</description>
          </item>
          <item>
            <title>Baseline Item 1</title>
            <link>https://test.com/1</link>
            <guid>guid-1</guid>
            <pubDate>Mon, 13 Jul 2026 12:00:00 GMT</pubDate>
          </item>
        </channel>
      </rss>
    `;

    const mockFetchSecond = vi.fn().mockImplementation(async (url) => {
      return {
        status: 200,
        headers: new Headers({ 'content-type': 'application/rss+xml' }),
        text: async () => secondXml
      };
    });

    subs = await getRssSubscriptions(db);
    sub = subs[0];

    const res = await processSubscription(db, sub, {}, { resolver: publicResolver, fetchFn: mockFetchSecond });
    expect(res.success).toBe(true);
    expect(res.count).toBe(2);

    // Notifications should be enqueued: Baseline Item 1 first, then Older Item 2, then Newer Item 3
    const { results: notifications } = await db.prepare('SELECT * FROM notification_queue ORDER BY id ASC').all();
    expect(notifications).toHaveLength(3);
    
    expect(JSON.parse(notifications[0].payload_json).entryTitle).toBe('Baseline Item 1');
    expect(JSON.parse(notifications[1].payload_json).entryTitle).toBe('Older Item 2');
    expect(JSON.parse(notifications[2].payload_json).entryTitle).toBe('Newer Item 3');
  });

  it('should fetch original page when content is insufficient and call DeepSeek', async () => {
    await addRssSubscription(db, 'https://test.com/feed.xml', 'https://test.com/feed.xml', '', '', 10);
    // Force set last_success_at to simulate a subsequent check
    await db.prepare("UPDATE rss_subscriptions SET last_success_at = '2026-07-13 12:00:00'").run();

    const shortContentXml = `
      <rss version="2.0">
        <channel>
          <title>Test Feed</title>
          <link>https://test.com</link>
          <item>
            <title>Short Content Item</title>
            <link>https://test.com/short</link>
            <guid>guid-short</guid>
            <pubDate>Mon, 13 Jul 2026 13:00:00 GMT</pubDate>
            <description>Too short description</description>
          </item>
        </channel>
      </rss>
    `;

    const mockFetch = vi.fn().mockImplementation(async (url) => {
      if (url === 'https://test.com/feed.xml') {
        return {
          status: 200,
          headers: new Headers({ 'content-type': 'application/rss+xml' }),
          text: async () => shortContentXml
        };
      }
      if (url === 'https://test.com/short') {
        return {
          status: 200,
          ok: true,
          headers: new Headers({ 'content-type': 'text/html' }),
          text: async () => '<html><body><article><p>' + 'Long extracted article body text '.repeat(20) + '</p></article></body></html>'
        };
      }
      if (url === 'https://api.deepseek.com/chat/completions') {
        return {
          status: 200,
          ok: true,
          json: async () => ({
            choices: [{ message: { content: 'This is the DeepSeek summary.' } }]
          })
        };
      }
    });

    const subs = await getRssSubscriptions(db);
    const sub = subs[0];

    const res = await processSubscription(db, sub, { DEEPSEEK_API_KEY: 'ds-key' }, { resolver: publicResolver, fetchFn: mockFetch });
    expect(res.success).toBe(true);

    // Verify DeepSeek was called with the long extracted body
    const deepseekCall = mockFetch.mock.calls.find(c => c[0] === 'https://api.deepseek.com/chat/completions');
    expect(deepseekCall).toBeDefined();
    const dsBody = JSON.parse(deepseekCall[1].body);
    expect(dsBody.messages[1].content).toContain('Long extracted article body text');

    // Verify notification payload has DeepSeek summary
    const { results: notifications } = await db.prepare('SELECT * FROM notification_queue').all();
    expect(notifications).toHaveLength(1);
    expect(JSON.parse(notifications[0].payload_json).summary).toBe('This is the DeepSeek summary.');
  });

  it('does not notify when a feed changes the GUID but keeps the same non-empty link', async () => {
    await addRssSubscription(db, 'https://test.com/feed.xml', 'https://test.com/feed.xml', '', '', 10);
    let [sub] = await getRssSubscriptions(db);
    const response = xml => ({
      status: 200,
      headers: new Headers({ 'content-type': 'application/rss+xml' }),
      text: async () => xml
    });
    const item = (guid, title, description) => `<rss><channel><title>Feed</title><item>
      <guid>${guid}</guid><link>https://test.com/same</link><title>${title}</title>
      <description>${description}</description></item></channel></rss>`;

    await processSubscription(db, sub, {}, {
      resolver: publicResolver,
      fetchFn: vi.fn().mockResolvedValue(response(item('old-guid', 'Old title', 'Old body')))
    });
    [sub] = await getRssSubscriptions(db);
    const secondFetch = vi.fn().mockResolvedValue(response(item('new-guid', 'Changed title', 'Changed body')));
    const result = await processSubscription(db, sub, {}, { resolver: publicResolver, fetchFn: secondFetch });

    expect(result.count).toBe(0);
    expect(secondFetch).toHaveBeenCalledTimes(1);
    expect((await db.prepare('SELECT * FROM rss_entries').all()).results).toHaveLength(1);
    expect((await db.prepare('SELECT * FROM notification_queue').all()).results).toHaveLength(1);
  });

  it('does not notify when GUID and link change but normalized article content is unchanged', async () => {
    await addRssSubscription(db, 'https://test.com/feed.xml', 'https://test.com/feed.xml', '', '', 10);
    let [sub] = await getRssSubscriptions(db);
    const feed = (guid, link, title, body) => `<rss><channel><title>Feed</title><item>
      <guid>${guid}</guid><link>${link}</link><title>${title}</title><description>${body}</description>
      </item></channel></rss>`;
    const fetchFeedXml = xml => vi.fn().mockResolvedValue({
      status: 200, headers: new Headers({ 'content-type': 'application/rss+xml' }), text: async () => xml
    });

    await processSubscription(db, sub, {}, {
      resolver: publicResolver,
      fetchFn: fetchFeedXml(feed('old-guid', 'https://test.com/old', 'Same   title', 'Same\nbody'))
    });
    [sub] = await getRssSubscriptions(db);
    const secondFetch = fetchFeedXml(feed('new-guid', 'https://test.com/new', 'Same title', 'Same body'));
    const result = await processSubscription(db, sub, {}, {
      resolver: publicResolver,
      fetchFn: secondFetch
    });

    expect(result.count).toBe(0);
    expect(secondFetch).toHaveBeenCalledTimes(1);
    expect((await db.prepare('SELECT * FROM rss_entries').all()).results).toHaveLength(1);
    expect((await db.prepare('SELECT * FROM notification_queue').all()).results).toHaveLength(1);
  });

  it('atomically claims concurrent overlapping processing so only one notification is queued', async () => {
    await addRssSubscription(db, 'https://test.com/feed.xml', 'https://test.com/feed.xml', '', '', 10);
    await db.prepare("UPDATE rss_subscriptions SET last_success_at = '2026-07-13 12:00:00'").run();
    const [sub] = await getRssSubscriptions(db);
    const longBody = 'A complete article body. '.repeat(12);
    const xml = `<rss><channel><title>Feed</title><item><guid>new-guid</guid>
      <link>https://test.com/new</link><title>New article</title><description>${longBody}</description>
      </item></channel></rss>`;
    const fetchFn = vi.fn().mockResolvedValue({
      status: 200, headers: new Headers({ 'content-type': 'application/rss+xml' }), text: async () => xml
    });

    const results = await Promise.all([
      processSubscription(db, sub, {}, { resolver: publicResolver, fetchFn }),
      processSubscription(db, sub, {}, { resolver: publicResolver, fetchFn })
    ]);

    expect(results.every(result => result.success)).toBe(true);
    expect(results.reduce((sum, result) => sum + result.count, 0)).toBe(1);
    expect((await db.prepare('SELECT * FROM rss_entries').all()).results).toHaveLength(1);
    expect((await db.prepare('SELECT * FROM notification_queue').all()).results).toHaveLength(1);
  });

  it('should not insert entry and should return failure if notification enqueue fails', async () => {
    await addRssSubscription(db, 'https://test.com/feed.xml', 'https://test.com/feed.xml', '', '', 10);
    await db.prepare("UPDATE rss_subscriptions SET last_success_at = '2026-07-13 12:00:00'").run();

    const secondXml = `
      <rss version="2.0">
        <channel>
          <title>Test Feed</title>
          <link>https://test.com</link>
          <item>
            <title>Newer Item 3</title>
            <link>https://test.com/3</link>
            <guid>guid-3</guid>
            <pubDate>Mon, 13 Jul 2026 14:00:00 GMT</pubDate>
          </item>
        </channel>
      </rss>
    `;

    const mockFetch = vi.fn().mockImplementation(async (url) => {
      return {
        status: 200,
        headers: new Headers({ 'content-type': 'application/rss+xml' }),
        text: async () => secondXml
      };
    });

    const subs = await getRssSubscriptions(db);
    const sub = subs[0];

    db.exec(`CREATE TRIGGER fail_rss_notification BEFORE INSERT ON notification_queue
      WHEN NEW.kind = 'rss' BEGIN SELECT RAISE(FAIL, 'queue transaction failed'); END;`);

    const res = await processSubscription(db, sub, {}, { resolver: publicResolver, fetchFn: mockFetch });
    expect(res.success).toBe(false);
    expect(res.error).toBeDefined();
    // Verify error is sanitized (no tokenized URLs / secrets)
    expect(res.error).not.toContain('secret-token');
    expect(res.error).not.toContain('secret123');

    // Entry should NOT be persisted
    const { results: entries } = await db.prepare("SELECT * FROM rss_entries WHERE entry_key = 'guid-3'").all();
    expect(entries).toHaveLength(0);

  });

  it('should bound new article processing per subscription per invocation (5/5/2)', async () => {
    // 1. Establish baseline
    await addRssSubscription(db, 'https://test.com/feed.xml', 'https://test.com/feed.xml', '', '', 10);
    const baselineXml = `
      <rss version="2.0">
        <channel>
          <title>Test Feed</title>
          <link>https://test.com</link>
          <item>
            <title>Baseline Item</title>
            <link>https://test.com/baseline</link>
            <guid>guid-baseline</guid>
            <pubDate>Mon, 13 Jul 2026 12:00:00 GMT</pubDate>
          </item>
        </channel>
      </rss>
    `;

    const mockFetchBaseline = vi.fn().mockImplementation(async () => {
      return {
        status: 200,
        headers: new Headers({ 'content-type': 'application/rss+xml' }),
        text: async () => baselineXml
      };
    });

    let subs = await getRssSubscriptions(db);
    let sub = subs[0];
    await processSubscription(db, sub, {}, { resolver: publicResolver, fetchFn: mockFetchBaseline });

    // Verify baseline was added
    let { results: baselineEntries } = await db.prepare("SELECT * FROM rss_entries").all();
    expect(baselineEntries).toHaveLength(1);

    // 2. Setup 12 new entries (chronologically distinct)
    const newItemsXml = `
      <rss version="2.0">
        <channel>
          <title>Test Feed</title>
          <link>https://test.com</link>
          <item>
            <title>Baseline Item</title>
            <link>https://test.com/baseline</link>
            <guid>guid-baseline</guid>
            <pubDate>Mon, 13 Jul 2026 12:00:00 GMT</pubDate>
          </item>
          ${Array.from({ length: 12 }, (_, i) => `
            <item>
              <title>Item ${i + 1}</title>
              <link>https://test.com/item-${i + 1}</link>
              <guid>guid-${i + 1}</guid>
              <pubDate>Mon, 13 Jul 2026 13:${i < 10 ? '0' + i : i}:00 GMT</pubDate>
            </item>
          `).join('')}
        </channel>
      </rss>
    `;

    const mockFetchNew = vi.fn().mockImplementation(async () => {
      return {
        status: 200,
        headers: new Headers({ 'content-type': 'application/rss+xml' }),
        text: async () => newItemsXml
      };
    });

    // Run 1: Should process 5 oldest unseen entries (Item 1 to Item 5)
    subs = await getRssSubscriptions(db);
    sub = subs[0];
    let res1 = await processSubscription(db, sub, { RSS_PROCESSING_LIMIT: '5' }, { resolver: publicResolver, fetchFn: mockFetchNew });
    expect(res1.success).toBe(true);
    expect(res1.count).toBe(5);

    let { results: run1Entries } = await db.prepare("SELECT * FROM rss_entries ORDER BY id ASC").all();
    expect(run1Entries).toHaveLength(6); // 1 baseline + 5 new
    expect(run1Entries.map(e => e.entry_key)).toEqual([
      'guid-baseline', 'guid-1', 'guid-2', 'guid-3', 'guid-4', 'guid-5'
    ]);

    // Check that nextCheckAt is scheduled promptly (less/equal to now) because of backlog
    let updatedSub = await db.prepare('SELECT * FROM rss_subscriptions WHERE id = ?').bind(sub.id).first();
    expect(new Date(updatedSub.next_check_at).getTime()).toBeLessThanOrEqual(Date.now());

    // Run 2: Should process next 5 unseen entries (Item 6 to Item 10)
    res1 = await processSubscription(db, updatedSub, { RSS_PROCESSING_LIMIT: '5' }, { resolver: publicResolver, fetchFn: mockFetchNew });
    expect(res1.success).toBe(true);
    expect(res1.count).toBe(5);

    let { results: run2Entries } = await db.prepare("SELECT * FROM rss_entries ORDER BY id ASC").all();
    expect(run2Entries).toHaveLength(11); // 1 baseline + 10 new
    expect(run2Entries.map(e => e.entry_key)).toEqual([
      'guid-baseline', 'guid-1', 'guid-2', 'guid-3', 'guid-4', 'guid-5',
      'guid-6', 'guid-7', 'guid-8', 'guid-9', 'guid-10'
    ]);

    updatedSub = await db.prepare('SELECT * FROM rss_subscriptions WHERE id = ?').bind(sub.id).first();
    expect(new Date(updatedSub.next_check_at).getTime()).toBeLessThanOrEqual(Date.now());

    // Run 3: Should process remaining 2 unseen entries (Item 11 and Item 12)
    res1 = await processSubscription(db, updatedSub, { RSS_PROCESSING_LIMIT: '5' }, { resolver: publicResolver, fetchFn: mockFetchNew });
    expect(res1.success).toBe(true);
    expect(res1.count).toBe(2);

    let { results: run3Entries } = await db.prepare("SELECT * FROM rss_entries ORDER BY id ASC").all();
    expect(run3Entries).toHaveLength(13); // 1 baseline + 12 new
    expect(run3Entries.map(e => e.entry_key)).toEqual([
      'guid-baseline', 'guid-1', 'guid-2', 'guid-3', 'guid-4', 'guid-5',
      'guid-6', 'guid-7', 'guid-8', 'guid-9', 'guid-10', 'guid-11', 'guid-12'
    ]);

    // Backlog cleared, next check should be in the future (interval_minutes = 10)
    updatedSub = await db.prepare('SELECT * FROM rss_subscriptions WHERE id = ?').bind(sub.id).first();
    expect(new Date(updatedSub.next_check_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('should sanitize entry links and image URLs, omitting unsafe ones before page fetch or formatting', async () => {
    await addRssSubscription(db, 'https://test.com/feed.xml', 'https://test.com/feed.xml', '', '', 10);
    await db.prepare("UPDATE rss_subscriptions SET last_success_at = '2026-07-13 12:00:00'").run();

    const unsafeXml = `
      <rss version="2.0">
        <channel>
          <title>Test Feed</title>
          <link>https://test.com</link>
          <item>
            <title>Unsafe Item</title>
            <link>javascript:alert(1)</link>
            <guid>guid-unsafe</guid>
            <pubDate>Mon, 13 Jul 2026 14:00:00 GMT</pubDate>
          </item>
          <item>
            <title>Unsafe Image Item</title>
            <link>https://test.com/safe-link</link>
            <guid>guid-unsafe-img</guid>
            <pubDate>Mon, 13 Jul 2026 15:00:00 GMT</pubDate>
            <description>Some description</description>
            <image>http://127.0.0.1/malicious.png</image>
          </item>
        </channel>
      </rss>
    `;

    const mockFetch = vi.fn().mockImplementation(async (url) => {
      if (url === 'https://test.com/feed.xml') {
        return {
          status: 200,
          headers: new Headers({ 'content-type': 'application/rss+xml' }),
          text: async () => unsafeXml
        };
      }
      return { status: 404 };
    });

    const subs = await getRssSubscriptions(db);
    const sub = subs[0];

    const res = await processSubscription(db, sub, {}, { resolver: publicResolver, fetchFn: mockFetch });
    expect(res.success).toBe(true);

    // Verify notification queue payloads
    const { results: notifications } = await db.prepare('SELECT * FROM notification_queue').all();
    expect(notifications).toHaveLength(2);

    const payloadUnsafe = JSON.parse(notifications[0].payload_json);
    expect(payloadUnsafe.link).toBe(''); // Omitted

    const payloadUnsafeImg = JSON.parse(notifications[1].payload_json);
    expect(payloadUnsafeImg.imageUrl).toBe(''); // Omitted
  });

  it('first check: should select entry with maximum publishedAt time when dates are valid', async () => {
    const feedXml = `
      <rss version="2.0">
        <channel>
          <title>Test Feed</title>
          <link>https://test.com</link>
          <item>
            <title>Item A</title>
            <link>https://test.com/a</link>
            <guid>guid-a</guid>
            <pubDate>Mon, 13 Jul 2026 12:00:00 GMT</pubDate>
          </item>
          <item>
            <title>Item B</title>
            <link>https://test.com/b</link>
            <guid>guid-b</guid>
            <pubDate>Mon, 13 Jul 2026 14:00:00 GMT</pubDate>
          </item>
          <item>
            <title>Item C</title>
            <link>https://test.com/c</link>
            <guid>guid-c</guid>
            <pubDate>Mon, 13 Jul 2026 13:00:00 GMT</pubDate>
          </item>
        </channel>
      </rss>
    `;
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({ 'content-type': 'application/rss+xml' }),
      text: async () => feedXml
    });
    await addRssSubscription(db, 'https://test.com/feed.xml', 'https://test.com/feed.xml', '', '', 10);
    const [sub] = await getRssSubscriptions(db);
    await processSubscription(db, sub, {}, { resolver: publicResolver, fetchFn: mockFetch });
    const { results: notifications } = await db.prepare('SELECT * FROM notification_queue').all();
    expect(notifications).toHaveLength(1);
    expect(JSON.parse(notifications[0].payload_json).entryTitle).toBe('Item B'); // max time
  });

  it('first check: should select first entry in source order when they have the same publishedAt time', async () => {
    const feedXml = `
      <rss version="2.0">
        <channel>
          <title>Test Feed</title>
          <link>https://test.com</link>
          <item>
            <title>Item A</title>
            <link>https://test.com/a</link>
            <guid>guid-a</guid>
            <pubDate>Mon, 13 Jul 2026 12:00:00 GMT</pubDate>
          </item>
          <item>
            <title>Item B</title>
            <link>https://test.com/b</link>
            <guid>guid-b</guid>
            <pubDate>Mon, 13 Jul 2026 12:00:00 GMT</pubDate>
          </item>
        </channel>
      </rss>
    `;
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({ 'content-type': 'application/rss+xml' }),
      text: async () => feedXml
    });
    await addRssSubscription(db, 'https://test.com/feed.xml', 'https://test.com/feed.xml', '', '', 10);
    const [sub] = await getRssSubscriptions(db);
    await processSubscription(db, sub, {}, { resolver: publicResolver, fetchFn: mockFetch });
    const { results: notifications } = await db.prepare('SELECT * FROM notification_queue').all();
    expect(notifications).toHaveLength(1);
    expect(JSON.parse(notifications[0].payload_json).entryTitle).toBe('Item A'); // first in source feed order
  });

  it('first check: should select first entry in source order when all entries have no date', async () => {
    const feedXml = `
      <rss version="2.0">
        <channel>
          <title>Test Feed</title>
          <link>https://test.com</link>
          <item>
            <title>Item A</title>
            <link>https://test.com/a</link>
            <guid>guid-a</guid>
          </item>
          <item>
            <title>Item B</title>
            <link>https://test.com/b</link>
            <guid>guid-b</guid>
          </item>
        </channel>
      </rss>
    `;
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({ 'content-type': 'application/rss+xml' }),
      text: async () => feedXml
    });
    await addRssSubscription(db, 'https://test.com/feed.xml', 'https://test.com/feed.xml', '', '', 10);
    const [sub] = await getRssSubscriptions(db);
    await processSubscription(db, sub, {}, { resolver: publicResolver, fetchFn: mockFetch });
    const { results: notifications } = await db.prepare('SELECT * FROM notification_queue').all();
    expect(notifications).toHaveLength(1);
    expect(JSON.parse(notifications[0].payload_json).entryTitle).toBe('Item A'); // first in source feed order
  });
});

