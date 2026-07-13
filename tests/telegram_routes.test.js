import { describe, it, expect, beforeEach, vi } from 'vitest';
import { D1Mock } from './helpers/d1_mock.js';
import fs from 'fs';
import path from 'path';
import app from '../src/index.js';
import { addRssSubscription, getRssSubscriptions } from '../src/db.js';

const publicResolver = async () => ['93.184.216.34'];

describe('Telegram Bot RSS Commands', () => {
  let db;

  beforeEach(() => {
    db = new D1Mock();
    const migrationSql = fs.readFileSync(
      path.resolve(__dirname, '../migrations/0005_personal_info_hub.sql'),
      'utf8'
    );
    db.exec(migrationSql);
  });

  const sendWebhookRequest = async (text, chatId = '12345') => {
    const payload = {
      message: {
        text,
        chat: { id: chatId, type: 'private' },
        from: { id: 'admin1' }
      }
    };
    const req = new Request('https://worker.local/telegram', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': 'secret-token'
      },
      body: JSON.stringify(payload)
    });
    const env = {
      DB: db,
      TELEGRAM_CHAT_ID: '12345',
      TELEGRAM_ADMIN_USER_ID: 'admin1',
      ADMIN_TOKEN: 'secret-token',
      TELEGRAM_BOT_TOKEN: 'bot-token',
      SAFE_FETCH_RESOLVER: publicResolver
    };
    const ctx = {
      waitUntil: vi.fn(async (promise) => {
        await promise;
      })
    };

    const res = await app.fetch(req, env, ctx);
    expect(res.status).toBe(200);
    return ctx.waitUntil.mock.calls[0]?.[0];
  };

  it('should handle /rss_add with direct feed URL', async () => {
    const feedXml = `
      <rss version="2.0">
        <channel>
          <title>Test RSS</title>
          <link>https://test.com</link>
        </channel>
      </rss>
    `;

    const mockFetch = vi.fn().mockImplementation(async (url) => {
      if (url.includes('sendMessage')) {
        return {
          status: 200,
          ok: true,
          json: async () => ({ ok: true })
        };
      }
      return {
        status: 200,
        headers: new Headers({ 'content-type': 'application/rss+xml' }),
        text: async () => feedXml
      };
    });

    globalThis.fetch = mockFetch;

    const promise = await sendWebhookRequest('/rss_add https://test.com/feed.xml');
    await promise;

    // Check D1 subscriptions
    const subs = await getRssSubscriptions(db);
    expect(subs).toHaveLength(1);
    expect(subs[0].title).toBe('Test RSS');
    expect(subs[0].feed_url).toBe('https://test.com/feed.xml');

    // Check Telegram response sent
    const msgCalls = mockFetch.mock.calls.filter(c => c[0].includes('sendMessage'));
    const successCall = msgCalls.find(c => JSON.parse(c[1].body).text.includes('成功'));
    expect(successCall).toBeDefined();
    const body = JSON.parse(successCall[1].body);
    expect(body.text).toContain('Test RSS');
  });

  it('should handle /rss_list', async () => {
    await addRssSubscription(db, 'https://test.com/feed', 'https://test.com/feed', 'https://test.com', 'My Feed', 15);

    const mockFetch = vi.fn().mockImplementation(async (url) => {
      return {
        status: 200,
        ok: true,
        json: async () => ({ ok: true })
      };
    });
    globalThis.fetch = mockFetch;

    const promise = await sendWebhookRequest('/rss_list');
    await promise;

    const msgCall = mockFetch.mock.calls.find(c => c[0].includes('sendMessage'));
    expect(msgCall).toBeDefined();
    const body = JSON.parse(msgCall[1].body);
    expect(body.text).toContain('My Feed');
    expect(body.text).toContain('15m');
  });

  it('should handle /rss_pause and /rss_resume', async () => {
    await addRssSubscription(db, 'https://test.com/feed', 'https://test.com/feed', 'https://test.com', 'My Feed', 15);
    const subs = await getRssSubscriptions(db);
    const id = subs[0].id;

    const mockFetch = vi.fn().mockImplementation(async (url) => {
      return {
        status: 200,
        ok: true,
        json: async () => ({ ok: true })
      };
    });
    globalThis.fetch = mockFetch;

    // Pause
    let promise = await sendWebhookRequest(`/rss_pause ${id}`);
    await promise;
    let currentSubs = await getRssSubscriptions(db);
    expect(currentSubs[0].status).toBe('paused');

    // Resume
    promise = await sendWebhookRequest(`/rss_resume ${id}`);
    await promise;
    currentSubs = await getRssSubscriptions(db);
    expect(currentSubs[0].status).toBe('active');
  });

  it('should handle /rss_remove', async () => {
    await addRssSubscription(db, 'https://test.com/feed', 'https://test.com/feed', 'https://test.com', 'My Feed', 15);
    const subs = await getRssSubscriptions(db);
    const id = subs[0].id;

    const mockFetch = vi.fn().mockImplementation(async (url) => {
      return {
        status: 200,
        ok: true,
        json: async () => ({ ok: true })
      };
    });
    globalThis.fetch = mockFetch;

    const promise = await sendWebhookRequest(`/rss_remove ${id}`);
    await promise;

    const currentSubs = await getRssSubscriptions(db);
    expect(currentSubs).toHaveLength(0);
  });

  it('should handle /rss_set_interval', async () => {
    await addRssSubscription(db, 'https://test.com/feed', 'https://test.com/feed', 'https://test.com', 'My Feed', 15);
    const subs = await getRssSubscriptions(db);
    const id = subs[0].id;

    const mockFetch = vi.fn().mockImplementation(async (url) => {
      return {
        status: 200,
        ok: true,
        json: async () => ({ ok: true })
      };
    });
    globalThis.fetch = mockFetch;

    const promise = await sendWebhookRequest(`/rss_set_interval ${id} 45`);
    await promise;

    const currentSubs = await getRssSubscriptions(db);
    expect(currentSubs[0].interval_minutes).toBe(45);
  });

  it('should handle /status with RSS and AI details', async () => {
    // Add some subscriptions
    await addRssSubscription(db, 'https://test1.com/feed', 'https://test1.com/feed', '', 'Feed 1', 10);
    const subs = await getRssSubscriptions(db);
    await db.prepare("UPDATE rss_subscriptions SET status = 'error' WHERE id = ?").bind(subs[0].id).run();

    // Add some notification items
    await db.prepare("INSERT INTO notification_queue (kind, dedupe_key, payload_json, status) VALUES ('rss', 'k1', '{}', 'pending')").run();
    await db.prepare("INSERT INTO notification_queue (kind, dedupe_key, payload_json, status) VALUES ('rss', 'k2', '{}', 'dead')").run();

    // Add daily usage
    const { getBeijingDate } = await import('../src/summary/deepseek.js');
    const dateStr = getBeijingDate();
    await db.prepare("INSERT INTO daily_usage (usage_date, usage_type, count) VALUES (?, 'deepseek_summary', 12)").bind(dateStr).run();

    const mockFetch = vi.fn().mockImplementation(async (url) => {
      return {
        status: 200,
        ok: true,
        json: async () => ({ ok: true })
      };
    });
    globalThis.fetch = mockFetch;

    const promise = await sendWebhookRequest('/status');
    await promise;

    const msgCall = mockFetch.mock.calls.find(c => c[0].includes('sendMessage'));
    expect(msgCall).toBeDefined();
    const body = JSON.parse(msgCall[1].body);
    expect(body.text).toContain('RSS 订阅');
    expect(body.text).toContain('异常：<b>1</b>');
    expect(body.text).toContain('积压 (pending)：<b>1</b>');
    expect(body.text).toContain('失败 (dead)：<b>1</b>');
    expect(body.text).toContain('今日已用：<b>12</b>');
  });

  it('should handle conversational /rss_add flow', async () => {
    const feedXml = `
      <rss version="2.0">
        <channel>
          <title>Conversational Feed</title>
          <link>https://conv.com</link>
        </channel>
      </rss>
    `;

    const mockFetch = vi.fn().mockImplementation(async (url) => {
      if (url.includes('sendMessage')) {
        return {
          status: 200,
          ok: true,
          json: async () => ({ ok: true })
        };
      }
      return {
        status: 200,
        headers: new Headers({ 'content-type': 'application/rss+xml' }),
        text: async () => feedXml
      };
    });
    globalThis.fetch = mockFetch;

    // 1. Send /rss_add without args to start session
    let promise = await sendWebhookRequest('/rss_add');
    await promise;

    // Verify session was created
    const { getBotSession } = await import('../src/db.js');
    let session = await getBotSession(db, '12345');
    expect(session).not.toBeNull();
    expect(session.flow).toBe('rss_add');
    expect(session.step).toBe('await_url');

    // Verify prompt message was sent
    let msgCalls = mockFetch.mock.calls.filter(c => c[0].includes('sendMessage'));
    expect(msgCalls).toHaveLength(1);
    expect(JSON.parse(msgCalls[0][1].body).text).toContain('请输入您要订阅');

    // 2. Send the URL
    mockFetch.mockClear();
    promise = await sendWebhookRequest('https://conv.com/feed.xml');
    await promise;

    // Verify subscription is saved and session is cleared
    const subs = await getRssSubscriptions(db);
    expect(subs).toHaveLength(1);
    expect(subs[0].title).toBe('Conversational Feed');

    session = await getBotSession(db, '12345');
    expect(session).toBeNull();

    // Verify success message sent
    msgCalls = mockFetch.mock.calls.filter(c => c[0].includes('sendMessage'));
    const successCall = msgCalls.find(c => JSON.parse(c[1].body).text.includes('成功'));
    expect(successCall).toBeDefined();
  });

  it('should reject unsafe discovered feed URLs during /rss_add flow', async () => {
    const htmlWithUnsafeFeed = `
      <html>
        <head>
          <link rel="alternate" type="application/rss+xml" title="Unsafe Feed" href="http://127.0.0.1/unsafe-feed.xml">
        </head>
        <body>Blog</body>
      </html>
    `;

    const mockFetch = vi.fn().mockImplementation(async (url) => {
      if (url.includes('sendMessage')) {
        return {
          status: 200,
          ok: true,
          json: async () => ({ ok: true })
        };
      }
      return {
        status: 200,
        headers: new Headers({ 'content-type': 'text/html' }),
        text: async () => htmlWithUnsafeFeed
      };
    });
    globalThis.fetch = mockFetch;

    // 1. Send /rss_add without args to start session
    let promise = await sendWebhookRequest('/rss_add');
    await promise;

    // 2. Send the page URL
    mockFetch.mockClear();
    promise = await sendWebhookRequest('https://safe-blog.com/index.html');
    await promise;

    // Verify subscription is NOT saved
    const subs = await getRssSubscriptions(db);
    expect(subs).toHaveLength(0);

    // Verify session is cleared
    const { getBotSession } = await import('../src/db.js');
    const session = await getBotSession(db, '12345');
    expect(session).toBeNull();

    // Verify reject/error message sent (should contain "不安全")
    const msgCalls = mockFetch.mock.calls.filter(c => c[0].includes('sendMessage'));
    const rejectCall = msgCalls.find(c => JSON.parse(c[1].body).text.includes('不安全'));
    expect(rejectCall).toBeDefined();
  });

  it('should redact sensitive query parameters in processAddRss access error messages sent to Telegram', async () => {
    const mockFetch = vi.fn().mockImplementation(async (url) => {
      if (url.includes('sendMessage')) {
        return {
          status: 200,
          ok: true,
          json: async () => ({ ok: true })
        };
      }
      return {
        status: 302,
        headers: new Headers({ 'location': 'http://127.0.0.1/feed?token=supersecret' })
      };
    });
    globalThis.fetch = mockFetch;

    const promise = await sendWebhookRequest('/rss_add https://example.com/start-feed');
    await promise;

    const msgCalls = mockFetch.mock.calls.filter(c => c[0].includes('sendMessage'));
    const errorCall = msgCalls.find(c => JSON.parse(c[1].body).text.includes('无法访问该链接'));
    expect(errorCall).toBeDefined();
    const body = JSON.parse(errorCall[1].body);

    expect(body.text).not.toContain('supersecret');
    expect(body.text).toContain('http://127.0.0.1/feed?token=***');
  });

  it('should redact sensitive query parameters in processAddRss parse error messages sent to Telegram', async () => {
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(async (url) => {
      if (url.includes('sendMessage')) {
        return {
          status: 200,
          ok: true,
          json: async () => ({ ok: true })
        };
      }
      callCount++;
      if (callCount === 1) {
        return {
          status: 200,
          headers: new Headers({ 'content-type': 'text/html' }),
          text: async () => `
            <html>
              <head>
                <link rel="alternate" type="application/rss+xml" href="https://example.com/feed?token=supersecret">
              </head>
            </html>
          `
        };
      }
      throw new Error('failed to parse feed from https://example.com/feed?token=supersecret');
    });
    globalThis.fetch = mockFetch;

    const promise = await sendWebhookRequest('/rss_add https://example.com/blog');
    await promise;

    const msgCalls = mockFetch.mock.calls.filter(c => c[0].includes('sendMessage'));
    const errorCall = msgCalls.find(c => JSON.parse(c[1].body).text.includes('订阅源解析失败'));
    expect(errorCall).toBeDefined();
    const body = JSON.parse(errorCall[1].body);

    expect(body.text).not.toContain('supersecret');
    expect(body.text).toContain('https://example.com/feed?token=***');
  });
});
