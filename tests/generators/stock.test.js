import { describe, it, expect, vi } from 'vitest';
import { validateGeneratorProvider } from '../../src/generators/core/contract.js';
import {
  stockProvider,
  normalizeSymbol,
  isTradingSession,
  parseTencentQuote,
  parseSinaQuote,
  fetchStockQuotes
} from '../../src/generators/providers/stock/index.js';

// 2026-08-10 is a Monday in Asia/Shanghai
const TRADING_NOW = new Date('2026-08-10T10:00:00+08:00');
const TENCENT_TS = '20260810095900'; // 2026-08-10 09:59:00 +08:00
const SINA_DATE = '2026-08-10';
const SINA_TIME = '09:59:00';

function buildTencentLine(symbol, name, code, price, yesterdayClose, ts = TENCENT_TS) {
  const fields = new Array(45).fill('0');
  fields[1] = name;
  fields[2] = code;
  fields[3] = String(price);
  fields[4] = String(yesterdayClose);
  fields[30] = ts;
  return `v_${symbol}="~${fields.slice(1).join('~')}";`;
}

function buildSinaLine(symbol, name, price, yesterdayClose, date = SINA_DATE, time = SINA_TIME) {
  const fields = new Array(33).fill('0');
  fields[0] = name;
  fields[2] = String(yesterdayClose);
  fields[3] = String(price);
  fields[30] = date;
  fields[31] = time;
  return `var hq_str_${symbol}="${fields.join(',')}";`;
}

function tencentResponse(text) {
  return { status: 200, text: async () => text };
}

function sinaResponse(text) {
  const bytes = new TextEncoder().encode(text);
  return { status: 200, arrayBuffer: async () => bytes.buffer };
}

describe('normalizeSymbol', () => {
  it('accepts already-prefixed symbols', () => {
    expect(normalizeSymbol('sh600519')).toBe('sh600519');
    expect(normalizeSymbol('SZ000001')).toBe('sz000001');
    expect(normalizeSymbol('bj920001')).toBe('bj920001');
  });

  it('infers exchange prefixes from 6-digit codes', () => {
    expect(normalizeSymbol('600519')).toBe('sh600519');
    expect(normalizeSymbol('900901')).toBe('sh900901');
    expect(normalizeSymbol('000001')).toBe('sz000001');
    expect(normalizeSymbol('300750')).toBe('sz300750');
    expect(normalizeSymbol('920001')).toBe('bj920001');
  });

  it('normalizes colon-prefixed symbols', () => {
    expect(normalizeSymbol('SSE:600519')).toBe('sh600519');
    expect(normalizeSymbol('szse:000001')).toBe('sz000001');
  });

  it('rejects invalid codes', () => {
    expect(normalizeSymbol('')).toBe(null);
    expect(normalizeSymbol(null)).toBe(null);
    expect(normalizeSymbol('AAPL')).toBe(null);
    expect(normalizeSymbol('12345')).toBe(null);
  });
});

describe('isTradingSession', () => {
  it('returns true during morning and afternoon sessions', () => {
    expect(isTradingSession(new Date('2026-08-10T10:00:00+08:00'))).toBe(true);
    expect(isTradingSession(new Date('2026-08-10T14:00:00+08:00'))).toBe(true);
  });

  it('returns false during lunch break and outside hours', () => {
    expect(isTradingSession(new Date('2026-08-10T12:00:00+08:00'))).toBe(false);
    expect(isTradingSession(new Date('2026-08-10T20:00:00+08:00'))).toBe(false);
    expect(isTradingSession(new Date('2026-08-10T09:00:00+08:00'))).toBe(false);
  });

  it('returns false on weekends', () => {
    expect(isTradingSession(new Date('2026-08-08T10:00:00+08:00'))).toBe(false);
    expect(isTradingSession(new Date('2026-08-09T10:00:00+08:00'))).toBe(false);
  });
});

describe('quote parsers', () => {
  it('parses Tencent quotes including name', () => {
    const text = buildTencentLine('sh600519', '贵州茅台', '600519', 1700, 1690);
    const quotes = parseTencentQuote(text);

    expect(quotes.sh600519).toMatchObject({
      symbol: 'sh600519',
      name: '贵州茅台',
      latestPrice: 1700,
      yesterdayClose: 1690,
      timestamp: '2026-08-10T09:59:00+08:00',
      source: 'tencent'
    });
  });

  it('skips Tencent quotes whose code does not match the response key', () => {
    const text = buildTencentLine('sh600519', '贵州茅台', '000001', 1700, 1690);
    expect(parseTencentQuote(text)).toEqual({});
  });

  it('parses Sina quotes including name', () => {
    const bytes = new TextEncoder().encode(buildSinaLine('sz000001', '平安银行', 12.5, 12.4));
    const quotes = parseSinaQuote(bytes);

    expect(quotes.sz000001).toMatchObject({
      symbol: 'sz000001',
      name: '平安银行',
      latestPrice: 12.5,
      yesterdayClose: 12.4,
      timestamp: '2026-08-10T09:59:00+08:00',
      source: 'sina'
    });
  });

  it('throws when the Sina response format is invalid', () => {
    expect(() => parseSinaQuote(new TextEncoder().encode('garbage'))).toThrow('Sina quote response format invalid');
  });
});

describe('fetchStockQuotes', () => {
  it('returns validated Tencent quotes without calling the Sina fallback', async () => {
    const fetchFn = vi.fn(async () => tencentResponse(buildTencentLine('sh600519', '贵州茅台', '600519', 1700, 1690)));

    const quotes = await fetchStockQuotes(['600519'], { fetchFn, relativeTo: TRADING_NOW });

    expect(quotes.sh600519?.source).toBe('tencent');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0][0]).toContain('web.sqt.gtimg.cn');
  });

  it('falls back to Sina for symbols missing from Tencent', async () => {
    const fetchFn = vi.fn(async (url) => {
      if (url.includes('gtimg.cn')) return tencentResponse('');
      return sinaResponse(buildSinaLine('sz000001', '平安银行', 12.5, 12.4));
    });

    const quotes = await fetchStockQuotes(['000001'], { fetchFn, relativeTo: TRADING_NOW });

    expect(quotes.sz000001?.source).toBe('sina');
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('rejects stale quotes and throws when no provider yields fresh data', async () => {
    const staleTs = '20260807095900'; // previous trading day
    const fetchFn = vi.fn(async (url) => {
      if (url.includes('gtimg.cn')) {
        return tencentResponse(buildTencentLine('sh600519', '贵州茅台', '600519', 1700, 1690, staleTs));
      }
      return sinaResponse(buildSinaLine('sh600519', '贵州茅台', 1700, 1690, '2026-08-07', '09:59:00'));
    });

    await expect(fetchStockQuotes(['600519'], { fetchFn, relativeTo: TRADING_NOW }))
      .rejects.toThrow('All stock quote providers failed');
  });

  it('returns an empty object for empty or invalid input', async () => {
    expect(await fetchStockQuotes([], {})).toEqual({});
    expect(await fetchStockQuotes(['AAPL'], {})).toEqual({});
  });
});

describe('stockProvider', () => {
  it('passes the generator provider contract', () => {
    expect(() => validateGeneratorProvider(stockProvider)).not.toThrow();
    expect(stockProvider.type).toBe('stock');
    expect(stockProvider.displayName).toBe('A股行情');
  });

  describe('validateConfig', () => {
    it('normalizes the stock code from instanceKey', () => {
      const config = stockProvider.validateConfig(undefined, { instanceKey: '600519' });
      expect(config).toEqual({ code: 'sh600519', configVersion: 1 });
    });

    it('rejects invalid stock codes', () => {
      expect(() => stockProvider.validateConfig(undefined, { instanceKey: 'AAPL' }))
        .toThrow('Invalid stock code');
    });

    it('rejects non-plain-object configs', () => {
      expect(() => stockProvider.validateConfig('nope', { instanceKey: '600519' }))
        .toThrow('Invalid config');
    });
  });

  describe('fetchItems', () => {
    const instance = { instanceKey: 'sh600519', config: { code: 'sh600519', configVersion: 1 } };

    it('returns market_closed outside trading sessions without fetching', async () => {
      const fetchFn = vi.fn();
      const result = await stockProvider.fetchItems(instance, {
        now: new Date('2026-08-09T10:00:00+08:00'), // Sunday
        fetch: fetchFn
      });

      expect(result).toEqual({ items: [], meta: { reason: 'market_closed' } });
      expect(fetchFn).not.toHaveBeenCalled();
    });

    it('returns the quote as a single item during trading sessions', async () => {
      const fetchFn = vi.fn(async () => tencentResponse(buildTencentLine('sh600519', '贵州茅台', '600519', 1700, 1690)));

      const result = await stockProvider.fetchItems(instance, {
        now: TRADING_NOW,
        fetch: fetchFn
      });

      expect(result.meta).toEqual({});
      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toMatchObject({ symbol: 'sh600519', latestPrice: 1700 });
    });

    it('propagates provider failures', async () => {
      const fetchFn = vi.fn(async () => ({ status: 500, text: async () => '' }));

      await expect(stockProvider.fetchItems(instance, { now: TRADING_NOW, fetch: fetchFn }))
        .rejects.toThrow('All stock quote providers failed');
    });
  });

  describe('normalizeItem', () => {
    const instance = { instanceKey: 'sh600519', config: { code: 'sh600519' }, displayName: '贵州茅台' };
    const quote = {
      symbol: 'sh600519',
      name: '贵州茅台',
      latestPrice: 1700,
      yesterdayClose: 1690,
      timestamp: '2026-08-10T09:59:00+08:00',
      source: 'tencent'
    };

    it('converts a quote into a generator item', async () => {
      const item = await stockProvider.normalizeItem(quote, instance, {});

      expect(item.itemKey).toBe('sh600519');
      expect(item.canonicalId).toBe('sh600519');
      expect(item.title).toBe('贵州茅台 1700');
      expect(item.link).toBe('https://finance.sina.com.cn/realstock/company/sh600519/nc.shtml');
      expect(item.publishedAt).toBeInstanceOf(Date);
      expect(item.contentHash).toMatch(/^[a-f0-9]{64}$/);
      expect(item.descriptionHtml).toContain('<table>');
      expect(item.descriptionHtml).toContain('贵州茅台');
      expect(item.descriptionHtml).toContain('1700.00');
      expect(item.descriptionHtml).toContain('+10.00');
    });

    it('changes contentHash when the price changes', async () => {
      const item1 = await stockProvider.normalizeItem(quote, instance, {});
      const item2 = await stockProvider.normalizeItem({ ...quote, latestPrice: 1701 }, instance, {});

      expect(item1.contentHash).not.toBe(item2.contentHash);
    });
  });

  describe('buildFeedMeta', () => {
    it('builds feed metadata from the instance display name', () => {
      const meta = stockProvider.buildFeedMeta(
        { instanceKey: 'sh600519', config: { code: 'sh600519' }, displayName: '贵州茅台' },
        {}
      );

      expect(meta).toEqual({
        title: '贵州茅台(A股)',
        link: 'https://finance.sina.com.cn/realstock/company/sh600519/nc.shtml',
        description: 'A股行情',
        language: 'zh-CN'
      });
    });

    it('falls back to the symbol when no display name is set', () => {
      const meta = stockProvider.buildFeedMeta({ instanceKey: '600519', config: {} }, {});

      expect(meta.title).toBe('sh600519(A股)');
      expect(meta.link).toBe('https://finance.sina.com.cn/realstock/company/sh600519/nc.shtml');
    });
  });
});
