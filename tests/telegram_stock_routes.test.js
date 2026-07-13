import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { D1Mock } from './helpers/d1_mock.js';
import fs from 'fs';
import path from 'path';
import app from '../src/index.js';
import { getTrackerRules, getTrackerRule } from '../src/db.js';

describe('Telegram Bot Stock Commands', () => {
  let db;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-13T07:40:00.000Z'));

    db = new D1Mock();
    const migrationSql = fs.readFileSync(
      path.resolve(__dirname, '../migrations/0005_personal_info_hub.sql'),
      'utf8'
    );
    db.exec(migrationSql);
  });

  afterEach(() => {
    vi.useRealTimers();
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
      TELEGRAM_BOT_TOKEN: 'bot-token'
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

  it('should handle /stock_quote command', async () => {
    const mockFetch = vi.fn().mockImplementation(async (url) => {
      if (url.includes('sqt.gtimg.cn')) {
        return {
          status: 200,
          text: async () => 'v_sh600519="1~贵州茅台~600519~1720.50~1710.00~1715.00~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~20260713153701~0";'
        };
      }
      return {
        status: 200,
        ok: true,
        json: async () => ({ ok: true })
      };
    });
    globalThis.fetch = mockFetch;

    const promise = await sendWebhookRequest('/stock_quote 600519');
    await promise;

    const msgCalls = mockFetch.mock.calls.filter(c => c[0].includes('sendMessage'));
    expect(msgCalls.length).toBeGreaterThanOrEqual(1);
    const quoteCall = msgCalls.find(c => JSON.parse(c[1].body).text.includes('最新价'));
    expect(quoteCall).toBeDefined();
    const body = JSON.parse(quoteCall[1].body);
    expect(body.text).toContain('1720.5');
    expect(body.text).toContain('0.61%'); // 涨跌幅
  });

  it('should handle /stock_add with direct args and immediate creation when not satisfied', async () => {
    const mockFetch = vi.fn().mockImplementation(async (url) => {
      if (url.includes('sqt.gtimg.cn')) {
        // current price 1720.50, target is 1800.00 (gte, not satisfied)
        return {
          status: 200,
          text: async () => 'v_sh600519="1~贵州茅台~600519~1720.50~1710.00~1715.00~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~20260713153701~0";'
        };
      }
      return {
        status: 200,
        ok: true,
        json: async () => ({ ok: true })
      };
    });
    globalThis.fetch = mockFetch;

    const promise = await sendWebhookRequest('/stock_add 600519 gte 1800');
    await promise;

    // Rule should be created immediately
    const rules = await getTrackerRules(db);
    expect(rules).toHaveLength(1);
    expect(rules[0].target_key).toBe('sh600519');
    expect(rules[0].condition_type).toBe('gte');
    expect(rules[0].condition_value).toBe(1800.00);
    expect(rules[0].status).toBe('active');

    const msgCalls = mockFetch.mock.calls.filter(c => c[0].includes('sendMessage'));
    const successCall = msgCalls.find(c => JSON.parse(c[1].body).text.includes('成功'));
    expect(successCall).toBeDefined();
  });

  it('should require confirmation during /stock_add if current price already satisfies target', async () => {
    const mockFetch = vi.fn().mockImplementation(async (url) => {
      if (url.includes('sqt.gtimg.cn')) {
        // current price 1720.50, target is 1700.00 (gte, satisfied!)
        return {
          status: 200,
          text: async () => 'v_sh600519="1~贵州茅台~600519~1720.50~1710.00~1715.00~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~20260713153701~0";'
        };
      }
      return {
        status: 200,
        ok: true,
        json: async () => ({ ok: true })
      };
    });
    globalThis.fetch = mockFetch;

    // Send command
    let promise = await sendWebhookRequest('/stock_add 600519 gte 1700');
    await promise;

    // Rule should NOT be created yet
    let rules = await getTrackerRules(db);
    expect(rules).toHaveLength(0);

    // Verify confirmation prompt was sent
    let msgCalls = mockFetch.mock.calls.filter(c => c[0].includes('sendMessage'));
    const confirmPromptCall = msgCalls.find(c => JSON.parse(c[1].body).text.includes('已满足'));
    expect(confirmPromptCall).toBeDefined();
    expect(JSON.parse(confirmPromptCall[1].body).text).toContain('是否确认');

    // Send confirmation
    mockFetch.mockClear();
    promise = await sendWebhookRequest('确认');
    await promise;

    // Rule should be created now
    rules = await getTrackerRules(db);
    expect(rules).toHaveLength(1);
    expect(rules[0].target_key).toBe('sh600519');
    expect(rules[0].status).toBe('active');

    // Success message sent
    msgCalls = mockFetch.mock.calls.filter(c => c[0].includes('sendMessage'));
    const successCall = msgCalls.find(c => JSON.parse(c[1].body).text.includes('成功'));
    expect(successCall).toBeDefined();
  });

  it('should handle conversational /stock_add flow from scratch', async () => {
    const mockFetch = vi.fn().mockImplementation(async (url) => {
      if (url.includes('sqt.gtimg.cn')) {
        return {
          status: 200,
          text: async () => 'v_sh600519="1~贵州茅台~600519~1720.50~1710.00~1715.00~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~20260713153701~0";'
        };
      }
      return {
        status: 200,
        ok: true,
        json: async () => ({ ok: true })
      };
    });
    globalThis.fetch = mockFetch;

    // 1. Send /stock_add to start flow
    let promise = await sendWebhookRequest('/stock_add');
    await promise;

    let msgCalls = mockFetch.mock.calls.filter(c => c[0].includes('sendMessage'));
    expect(msgCalls[0][1].body).toContain('请输入股票代码');

    // 2. Send code
    mockFetch.mockClear();
    promise = await sendWebhookRequest('600519');
    await promise;

    msgCalls = mockFetch.mock.calls.filter(c => c[0].includes('sendMessage'));
    const quoteInfoCall = msgCalls.find(c => JSON.parse(c[1].body).text.includes('当前价格'));
    expect(quoteInfoCall).toBeDefined();
    expect(JSON.parse(quoteInfoCall[1].body).text).toContain('请输入阈值条件');

    // 3. Send condition and target price (not satisfied)
    mockFetch.mockClear();
    promise = await sendWebhookRequest('gte 1800');
    await promise;

    const rules = await getTrackerRules(db);
    expect(rules).toHaveLength(1);
    expect(rules[0].target_key).toBe('sh600519');
    expect(rules[0].condition_type).toBe('gte');
    expect(rules[0].condition_value).toBe(1800.00);

    msgCalls = mockFetch.mock.calls.filter(c => c[0].includes('sendMessage'));
    const successCall = msgCalls.find(c => JSON.parse(c[1].body).text.includes('成功'));
    expect(successCall).toBeDefined();
  });

  it('should manage stock reminder lifecycle (list, pause, resume, remove)', async () => {
    const { addTrackerRule } = await import('../src/db.js');
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
        ok: true,
        json: async () => ({ ok: true })
      };
    });
    globalThis.fetch = mockFetch;

    // 1. List
    let promise = await sendWebhookRequest('/stock_list');
    await promise;
    let msgCalls = mockFetch.mock.calls.filter(c => c[0].includes('sendMessage'));
    expect(msgCalls[0][1].body).toContain('sh600519');
    expect(msgCalls[0][1].body).toContain('gte');

    // 2. Pause
    mockFetch.mockClear();
    const rules = await getTrackerRules(db);
    const ruleId = rules[0].id;
    promise = await sendWebhookRequest(`/stock_pause ${ruleId}`);
    await promise;
    let rule = await getTrackerRule(db, ruleId);
    expect(rule.status).toBe('paused');

    // 3. Resume
    mockFetch.mockClear();
    promise = await sendWebhookRequest(`/stock_resume ${ruleId}`);
    await promise;
    rule = await getTrackerRule(db, ruleId);
    expect(rule.status).toBe('active');

    // 4. Remove
    mockFetch.mockClear();
    promise = await sendWebhookRequest(`/stock_remove ${ruleId}`);
    await promise;
    const rulesAfter = await getTrackerRules(db);
    expect(rulesAfter).toHaveLength(0);
  });
});
