import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { D1Mock } from './helpers/d1_mock.js';
import fs from 'fs';
import path from 'path';
import app from '../src/index.js';
import { getBotSession } from '../src/db.js';
import { GeneratorService } from '../src/generators/core/service.js';

const publicResolver = async () => ['93.184.216.34'];

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
    db.exec(fs.readFileSync(path.resolve(__dirname, '../migrations', file), 'utf8'));
  }
}

function makeImageFetch(username = 'jjlin') {
  return vi.fn().mockImplementation((url) => {
    if (typeof url === 'string' && url.includes('sendMessage')) {
      return Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve({ ok: true }) });
    }
    const parsed = new URL(url);
    const user = parsed.searchParams.get('username');
    if (user === 'failprofile') {
      return Promise.resolve({ ok: false, status: 500 });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        data: {
          user: {
            edge_owner_to_timeline_media: {
              edges: [{
                node: {
                  id: 'img_1',
                  shortcode: 'sc1',
                  taken_at_timestamp: 1700000000,
                  display_url: 'https://scontent.cdninstagram.com/img.jpg',
                  thumbnail_src: 'https://scontent.cdninstagram.com/img.jpg',
                  is_video: false,
                  edge_media_to_caption: {
                    edges: [{ node: { text: 'Hello world' } }]
                  }
                }
              }]
            }
          }
        }
      })
    });
  });
}

function makeFeedXml() {
  return `
    <rss version="2.0">
      <channel>
        <title>Test Feed</title>
        <link>https://test.com</link>
        <item>
          <title>Old Item</title>
          <link>https://test.com/1</link>
          <guid>guid-1</guid>
          <pubDate>Mon, 13 Jul 2026 12:00:00 GMT</pubDate>
        </item>
        <item>
          <title>New Item</title>
          <link>https://test.com/2</link>
          <guid>guid-2</guid>
          <pubDate>Mon, 13 Jul 2026 13:00:00 GMT</pubDate>
        </item>
      </channel>
    </rss>
  `;
}

function makeStockFetch(price = '1720.50') {
  return vi.fn().mockImplementation((url) => {
    if (url.includes('sqt.gtimg.cn')) {
      return Promise.resolve({
        status: 200,
        text: async () => `v_sh600519="1~贵州茅台~600519~${price}~1710.00~1715.00~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~20260713153701~0";`
      });
    }
    return Promise.resolve({ status: 200, ok: true, json: async () => ({ ok: true }) });
  });
}

describe('Telegram Production Command Namespace', () => {
  let db;
  let env;
  let ctx;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-13T07:40:00.000Z'));

    db = new D1Mock();
    applyAllMigrations(db);

    env = {
      DB: db,
      TELEGRAM_CHAT_ID: '12345',
      TELEGRAM_ADMIN_USER_ID: 'admin1',
      ADMIN_TOKEN: 'secret-token',
      TELEGRAM_BOT_TOKEN: 'bot-token',
      BASE_URL: 'https://worker.example',
      SAFE_FETCH_RESOLVER: publicResolver,
      CACHE_MAX_POSTS: '100'
    };

    ctx = {
      waitUntil: vi.fn(async (promise) => await promise)
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const sendWebhook = async (text) => {
    const payload = {
      message: {
        text,
        chat: { id: '12345', type: 'private' },
        from: { id: 'admin1' }
      }
    };
    const req = new Request('https://worker.local/telegram', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': '930bbdc51b6aed5c2a5678fd6e28dee7a05e8a4b643cfc0b4427c3efb86c0d94'
      },
      body: JSON.stringify(payload)
    });
    const res = await app.fetch(req, env, ctx);
    expect(res.status).toBe(200);
    return ctx.waitUntil.mock.calls[ctx.waitUntil.mock.calls.length - 1]?.[0];
  };

  const getLastMessageText = (mockFetch) => {
    const calls = mockFetch.mock.calls.filter(c => typeof c[0] === 'string' && c[0].includes('sendMessage'));
    if (calls.length === 0) return null;
    return JSON.parse(calls[calls.length - 1][1].body).text;
  };

  it('creates an Instagram Generator with /gen_add, refreshes, and does not auto-push', async () => {
    const mockFetch = makeImageFetch();
    globalThis.fetch = mockFetch;

    const promise = await sendWebhook('/gen_add instagram jjlin');
    await promise;

    const lastText = getLastMessageText(mockFetch);
    expect(lastText).toContain('Generator 创建成功');
    expect(lastText).toContain('/feeds/1.xml');
    expect(lastText).toContain('/push_add rss');
    expect(lastText).not.toContain('/rss/ig/');

    const { results: instances } = await db.prepare('SELECT * FROM generator_instances').all();
    expect(instances).toHaveLength(1);
    expect(instances[0].provider_type).toBe('instagram');
    expect(instances[0].instance_key).toBe('jjlin');

    const { results: subs } = await db.prepare('SELECT * FROM rss_subscriptions').all();
    expect(subs).toHaveLength(0);

    const { results: queue } = await db.prepare('SELECT * FROM notification_queue').all();
    expect(queue).toHaveLength(0);
  });

  it('lists, feeds, refreshes, pauses, resumes, and removes Generators', async () => {
    const mockFetch = makeImageFetch();
    globalThis.fetch = mockFetch;

    await (await sendWebhook('/gen_add instagram jjlin'));

    // list
    mockFetch.mockClear();
    await (await sendWebhook('/gen_list'));
    expect(getLastMessageText(mockFetch)).toContain('jjlin');

    // feed
    mockFetch.mockClear();
    await (await sendWebhook('/gen_feed 1'));
    expect(getLastMessageText(mockFetch)).toContain('/feeds/1.xml');

    // refresh
    mockFetch.mockClear();
    await (await sendWebhook('/gen_refresh 1'));
    expect(getLastMessageText(mockFetch)).toContain('刷新完成');

    // pause
    mockFetch.mockClear();
    await (await sendWebhook('/gen_pause 1'));
    let inst = await db.prepare('SELECT * FROM generator_instances WHERE id = 1').first();
    expect(inst.status).toBe('paused');

    // resume
    mockFetch.mockClear();
    await (await sendWebhook('/gen_resume 1'));
    inst = await db.prepare('SELECT * FROM generator_instances WHERE id = 1').first();
    expect(inst.status).toBe('active');

    // remove
    mockFetch.mockClear();
    await (await sendWebhook('/gen_remove 1'));
    inst = await db.prepare('SELECT * FROM generator_instances WHERE id = 1').first();
    expect(inst).toBeNull();
  });

  it('adds an internal RSS feed to Push with /push_add rss and only pushes the latest 1 item', async () => {
    const feedXml = makeFeedXml();
    const mockFetch = vi.fn().mockImplementation((url) => {
      if (url.includes('sendMessage')) {
        return Promise.resolve({ status: 200, ok: true, json: async () => ({ ok: true }) });
      }
      return Promise.resolve({
        status: 200,
        headers: new Headers({ 'content-type': 'application/rss+xml' }),
        text: async () => feedXml
      });
    });
    globalThis.fetch = mockFetch;

    const internalFeed = 'https://worker.example/feeds/1.xml';
    await (await sendWebhook(`/push_add rss ${internalFeed}`));

    const { results: subs } = await db.prepare('SELECT * FROM rss_subscriptions').all();
    expect(subs).toHaveLength(1);

    const { results: entries } = await db.prepare('SELECT * FROM rss_entries').all();
    expect(entries).toHaveLength(2);

    const { results: queue } = await db.prepare('SELECT * FROM notification_queue').all();
    expect(queue).toHaveLength(1);
    expect(JSON.parse(queue[0].payload_json).entryTitle).toBe('New Item');

    const lastText = getLastMessageText(mockFetch);
    expect(lastText).toContain('已添加 Push RSS');
    expect(lastText).toContain('首次已推送最新 <b>1</b> 篇');
  });

  it('manages Push subscriptions lifecycle with /push_list, pause, resume, refresh, remove', async () => {
    const feedXml = makeFeedXml();
    const mockFetch = vi.fn().mockImplementation((url) => {
      if (url.includes('sendMessage')) {
        return Promise.resolve({ status: 200, ok: true, json: async () => ({ ok: true }) });
      }
      return Promise.resolve({
        status: 200,
        headers: new Headers({ 'content-type': 'application/rss+xml' }),
        text: async () => feedXml
      });
    });
    globalThis.fetch = mockFetch;

    await (await sendWebhook('/push_add rss https://example.com/feed.xml'));
    const sub = await db.prepare('SELECT * FROM rss_subscriptions').first();

    mockFetch.mockClear();
    await (await sendWebhook('/push_list'));
    expect(getLastMessageText(mockFetch)).toContain('Test Feed');

    await (await sendWebhook(`/push_pause ${sub.id}`));
    let row = await db.prepare('SELECT * FROM rss_subscriptions WHERE id = ?').bind(sub.id).first();
    expect(row.status).toBe('paused');

    await (await sendWebhook(`/push_resume ${sub.id}`));
    row = await db.prepare('SELECT * FROM rss_subscriptions WHERE id = ?').bind(sub.id).first();
    expect(row.status).toBe('active');

    await (await sendWebhook(`/push_refresh ${sub.id}`));

    await (await sendWebhook(`/push_remove ${sub.id}`));
    row = await db.prepare('SELECT * FROM rss_subscriptions WHERE id = ?').bind(sub.id).first();
    expect(row).toBeNull();
  });

  it('creates a stock rule with /monitor_add stock full args', async () => {
    const mockFetch = makeStockFetch('1720.50');
    globalThis.fetch = mockFetch;

    await (await sendWebhook('/monitor_add stock 600519 gte 1800'));

    const { results: rules } = await db.prepare('SELECT * FROM tracker_rules').all();
    expect(rules).toHaveLength(1);
    expect(rules[0].target_key).toBe('sh600519');
    expect(rules[0].condition_type).toBe('gte');
    expect(rules[0].condition_value).toBe(1800);

    const lastText = getLastMessageText(mockFetch);
    expect(lastText).toContain('已添加股票提醒规则');
    expect(lastText).toContain('sh600519');
  });

  it('quotes a stock with /monitor_quote and manages rule lifecycle', async () => {
    const mockFetch = makeStockFetch('1720.50');
    globalThis.fetch = mockFetch;

    await (await sendWebhook('/monitor_add stock 600519 gte 1800'));
    const rule = await db.prepare('SELECT * FROM tracker_rules').first();

    mockFetch.mockClear();
    await (await sendWebhook('/monitor_quote stock 600519'));
    const quoteText = getLastMessageText(mockFetch);
    expect(quoteText).toContain('1720.5');
    expect(quoteText).toContain('0.61%');

    await (await sendWebhook(`/monitor_pause ${rule.id}`));
    let row = await db.prepare('SELECT * FROM tracker_rules WHERE id = ?').bind(rule.id).first();
    expect(row.status).toBe('paused');

    await (await sendWebhook(`/monitor_resume ${rule.id}`));
    row = await db.prepare('SELECT * FROM tracker_rules WHERE id = ?').bind(rule.id).first();
    expect(row.status).toBe('active');

    mockFetch.mockClear();
    await (await sendWebhook(`/monitor_remove ${rule.id}`));
    row = await db.prepare('SELECT * FROM tracker_rules WHERE id = ?').bind(rule.id).first();
    expect(row).toBeNull();
  });

  it('keeps the /monitor_add conversational session flow when args are incomplete', async () => {
    const mockFetch = makeStockFetch('1720.50');
    globalThis.fetch = mockFetch;

    await (await sendWebhook('/monitor_add'));
    let session = await getBotSession(db, '12345');
    expect(session).not.toBeNull();
    expect(session.flow).toBe('monitor_add');
    expect(session.step).toBe('await_code');

    await (await sendWebhook('600519'));
    session = await getBotSession(db, '12345');
    expect(session.step).toBe('await_condition_price');

    await (await sendWebhook('gte 1800'));
    session = await getBotSession(db, '12345');
    expect(session).toBeNull();

    const { results: rules } = await db.prepare('SELECT * FROM tracker_rules').all();
    expect(rules).toHaveLength(1);
    expect(rules[0].target_key).toBe('sh600519');
    expect(rules[0].condition_value).toBe(1800);
  });

  it('shows /help without old commands and /status without URLs or tokens', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ status: 200, ok: true, json: async () => ({ ok: true }) });
    globalThis.fetch = mockFetch;

    await (await sendWebhook('/help'));
    const helpText = getLastMessageText(mockFetch);
    expect(helpText).toContain('/gen_add');
    expect(helpText).toContain('/monitor_add');
    expect(helpText).toContain('/push_add');
    expect(helpText).not.toContain('/start');
    expect(helpText).not.toContain('/add_ig');
    expect(helpText).not.toContain('/rss_add');
    expect(helpText).not.toContain('/stock_');
    expect(helpText).not.toContain('/refresh');

    mockFetch.mockClear();
    await (await sendWebhook('/status'));
    const statusText = getLastMessageText(mockFetch);
    expect(statusText).toContain('Generator');
    expect(statusText).toContain('Monitor');
    expect(statusText).toContain('Push RSS');
    expect(statusText).toContain('DeepSeek');
    expect(statusText).not.toContain('https://');
    expect(statusText).not.toContain(env.ADMIN_TOKEN);
    expect(statusText).not.toContain(env.TELEGRAM_BOT_TOKEN);
  });

  it('rejects old commands as unknown and performs zero DB writes or external fetches', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ status: 200, ok: true, json: async () => ({ ok: true }) });
    globalThis.fetch = mockFetch;

    const oldCommands = [
      '/add_ig test', '/remove_ig test', '/rss_add https://example.com',
      '/stock_add 600519 gte 1800', '/refresh', '/purge_ig',
      '/start', '/start unknown'
    ];
    for (const text of oldCommands) {
      await (await sendWebhook(text));
      const lastText = getLastMessageText(mockFetch);
      expect(lastText).toContain('未知命令');
    }

    expect(mockFetch).toHaveBeenCalledTimes(oldCommands.length);
    const externalCalls = mockFetch.mock.calls.filter(c => !c[0].includes('sendMessage'));
    expect(externalCalls).toHaveLength(0);

    const { results: instances } = await db.prepare('SELECT * FROM generator_instances').all();
    expect(instances).toHaveLength(0);
    const { results: subs } = await db.prepare('SELECT * FROM rss_subscriptions').all();
    expect(subs).toHaveLength(0);
    const { results: rules } = await db.prepare('SELECT * FROM tracker_rules').all();
    expect(rules).toHaveLength(0);
  });

  it('cancels an active session with /cancel', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ status: 200, ok: true, json: async () => ({ ok: true }) });
    globalThis.fetch = mockFetch;

    await (await sendWebhook('/monitor_add'));
    let session = await getBotSession(db, '12345');
    expect(session).not.toBeNull();

    await (await sendWebhook('/cancel'));
    session = await getBotSession(db, '12345');
    expect(session).toBeNull();
  });

  it('strictly validates positive integer IDs rejecting invalid formats like 1x, 01, +1', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ status: 200, ok: true, json: async () => ({ ok: true }) });
    globalThis.fetch = mockFetch;

    const invalidIds = ['1x', '01', '+1', '-1', '0', 'abc'];
    for (const id of invalidIds) {
      await (await sendWebhook(`/gen_feed ${id}`));
      expect(getLastMessageText(mockFetch)).toContain('用法：/gen_feed &lt;id&gt;');
      mockFetch.mockClear();

      await (await sendWebhook(`/gen_refresh ${id}`));
      expect(getLastMessageText(mockFetch)).toContain('用法：/gen_refresh &lt;id&gt;');
      mockFetch.mockClear();

      await (await sendWebhook(`/gen_pause ${id}`));
      expect(getLastMessageText(mockFetch)).toContain('用法：/gen_pause &lt;id&gt;');
      mockFetch.mockClear();
    }
  });

  it('falls back CACHE_MAX_POSTS to 100 if invalid', async () => {
    const mockFetch = makeImageFetch();
    globalThis.fetch = mockFetch;

    const spy = vi.spyOn(GeneratorService.prototype, 'refresh');

    const invalidVals = ['abc', '01', '+1', '0', '-5', '1x', ''];
    for (const val of invalidVals) {
      env.CACHE_MAX_POSTS = val;
      await db.prepare("INSERT INTO generator_instances (id, provider_type, instance_key, config_json, status, display_name, created_at, updated_at) VALUES (1, 'instagram', 'test', '{}', 'active', 'test', '2026-07-13T07:40:00Z', '2026-07-13T07:40:00Z')").run();

      spy.mockClear();
      const promise = await sendWebhook('/gen_refresh 1');
      await promise;

      expect(spy).toHaveBeenCalled();
      const lastCallArgs = spy.mock.calls[0][2];
      expect(lastCallArgs.retentionLimit).toBe(100);

      await db.prepare("DELETE FROM generator_instances").run();
    }

    env.CACHE_MAX_POSTS = '50';
    await db.prepare("INSERT INTO generator_instances (id, provider_type, instance_key, config_json, status, display_name, created_at, updated_at) VALUES (1, 'instagram', 'test', '{}', 'active', 'test', '2026-07-13T07:40:00Z', '2026-07-13T07:40:00Z')").run();
    spy.mockClear();
    const promise = await sendWebhook('/gen_refresh 1');
    await promise;
    expect(spy).toHaveBeenCalled();
    const lastCallArgs = spy.mock.calls[0][2];
    expect(lastCallArgs.retentionLimit).toBe(50);

    spy.mockRestore();
  });
});
