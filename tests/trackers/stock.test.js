import { describe, it, expect, vi } from 'vitest';
import {
  normalizeSymbol,
  isTradingSession,
  parseTencentQuote,
  parseSinaQuote,
  fetchStockQuotes
} from '../../src/trackers/providers/stock.js';

describe('A-share Symbol Normalization', () => {
  it('should normalize six-digit symbols to lowercase with sh/sz/bj prefix', () => {
    // Shanghai
    expect(normalizeSymbol('600519')).toBe('sh600519');
    expect(normalizeSymbol('688001')).toBe('sh688001');
    expect(normalizeSymbol('900901')).toBe('sh900901');

    // Shenzhen
    expect(normalizeSymbol('000001')).toBe('sz000001');
    expect(normalizeSymbol('300001')).toBe('sz300001');
    expect(normalizeSymbol('200002')).toBe('sz200002');

    // Beijing (current 920 & legacy 43/83/87)
    expect(normalizeSymbol('920185')).toBe('bj920185');
    expect(normalizeSymbol('430002')).toBe('bj430002');
    expect(normalizeSymbol('835185')).toBe('bj835185');
    expect(normalizeSymbol('870001')).toBe('bj870001');
  });

  it('should preserve already normalized or prefixed symbols', () => {
    expect(normalizeSymbol('sh600519')).toBe('sh600519');
    expect(normalizeSymbol('SZ000001')).toBe('sz000001');
    expect(normalizeSymbol('bj920185')).toBe('bj920185');
  });

  it('should return null for invalid symbols', () => {
    expect(normalizeSymbol('123')).toBeNull();
    expect(normalizeSymbol('abcdef')).toBeNull();
    expect(normalizeSymbol('')).toBeNull();
    expect(normalizeSymbol(null)).toBeNull();
  });

  it('should normalize common exchange prefixes with colon', () => {
    expect(normalizeSymbol('SHA:603986')).toBe('sh603986');
    expect(normalizeSymbol('SH:603986')).toBe('sh603986');
    expect(normalizeSymbol('SSE:603986')).toBe('sh603986');
    expect(normalizeSymbol('SHE:000001')).toBe('sz000001');
    expect(normalizeSymbol('SZ:000001')).toBe('sz000001');
    expect(normalizeSymbol('SZSE:000001')).toBe('sz000001');
    expect(normalizeSymbol('BSE:920001')).toBe('bj920001');
    expect(normalizeSymbol('BJ:920001')).toBe('bj920001');

    // Test case and spacing tolerance
    expect(normalizeSymbol('  sha:603986  ')).toBe('sh603986');
    expect(normalizeSymbol('Sh:603986')).toBe('sh603986');
    expect(normalizeSymbol('SZSE : 000001')).toBe('sz000001');

    // Invalid prefixes/lengths should return null
    expect(normalizeSymbol('XYZ:603986')).toBeNull();
    expect(normalizeSymbol('SHA:60398')).toBeNull();
    expect(normalizeSymbol('SHA:6039867')).toBeNull();
  });
});

describe('Tencent UTF-8 Parsing', () => {
  it('should correctly parse Tencent UTF-8 quotes', () => {
    // Exactly 32 fields, timestamp at index 30
    const rawResponse = 'v_sh600519="1~贵州茅台~600519~1720.50~1710.00~1715.00~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~20260713153701~0";';
    const quotes = parseTencentQuote(rawResponse);
    expect(quotes).toHaveProperty('sh600519');
    const q = quotes['sh600519'];
    expect(q.symbol).toBe('sh600519');
    expect(q.latestPrice).toBe(1720.50);
    expect(q.yesterdayClose).toBe(1710.00);
    expect(q.timestamp).toBe('2026-07-13T15:37:01+08:00');
    expect(q.source).toBe('tencent');
  });

  it('should skip invalid, missing or negative values', () => {
    const invalidResponse = 'v_sh600519="1~贵州茅台~600519~-10.00~1710.00~1715.00~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~20260713153701~0";';
    expect(parseTencentQuote(invalidResponse)).toEqual({});
  });
});

describe('Byte-safe Sina Parsing', () => {
  it('should parse Sina quotes from bytes without GBK dependency', () => {
    // 32 fields, timestamp at index 30/31
    const fields = Array(33).fill('0');
    fields[0] = '平安银行';
    fields[2] = '11.15'; // yesterday close
    fields[3] = '11.25'; // latest
    fields[30] = '2026-07-13';
    fields[31] = '15:34:59';
    const rawStr = `var hq_str_sz000001="${fields.join(',')}";`;
    const bytes = new TextEncoder().encode(rawStr);
    
    const quotes = parseSinaQuote(bytes);
    expect(quotes).toHaveProperty('sz000001');
    const q = quotes['sz000001'];
    expect(q.symbol).toBe('sz000001');
    expect(q.latestPrice).toBe(11.25);
    expect(q.yesterdayClose).toBe(11.15);
    expect(q.timestamp).toBe('2026-07-13T15:34:59+08:00');
    expect(q.source).toBe('sina');
  });

  it('should skip invalid/suspended Sina values', () => {
    const rawStr = 'var hq_str_sz000001="平安银行,0.00,-11.15,0.00,...,2026-07-13,15:34:59,00";';
    const bytes = new TextEncoder().encode(rawStr);
    expect(parseSinaQuote(bytes)).toEqual({});
  });
});

describe('Trading Session Guard & Stale Quote Rejection', () => {
  it('should detect active trading sessions correctly', () => {
    // Monday 10:00 (Trading)
    const t1 = new Date('2026-07-13T10:00:00+08:00');
    expect(isTradingSession(t1)).toBe(true);

    // Monday 12:00 (Midday Break)
    const t2 = new Date('2026-07-13T12:00:00+08:00');
    expect(isTradingSession(t2)).toBe(false);

    // Monday 14:30 (Trading)
    const t3 = new Date('2026-07-13T14:30:00+08:00');
    expect(isTradingSession(t3)).toBe(true);

    // Monday 16:00 (Market Closed)
    const t4 = new Date('2026-07-13T16:00:00+08:00');
    expect(isTradingSession(t4)).toBe(false);

    // Saturday 10:00 (Weekend)
    const t5 = new Date('2026-07-18T10:00:00+08:00');
    expect(isTradingSession(t5)).toBe(false);
  });

  it('should reject quotes older than 24 hours (stale quote protection)', () => {
    const now = new Date('2026-07-13T10:00:00+08:00');
    
    // Fresh quote (same day, same hour)
    const q1 = {
      symbol: 'sh600519',
      latestPrice: 1700.00,
      yesterdayClose: 1710.00,
      timestamp: '2026-07-13T09:45:00+08:00',
      source: 'tencent'
    };
    
    // Stale quote (older than 24 hours)
    const q2 = {
      symbol: 'sh600519',
      latestPrice: 1700.00,
      yesterdayClose: 1710.00,
      timestamp: '2026-07-12T09:45:00+08:00',
      source: 'tencent'
    };

    const validateFreshness = (quote, relativeTo) => {
      const qTime = new Date(quote.timestamp).getTime();
      const relTime = relativeTo.getTime();
      return (relTime - qTime) <= 24 * 60 * 60 * 1000;
    };

    expect(validateFreshness(q1, now)).toBe(true);
    expect(validateFreshness(q2, now)).toBe(false);
  });
});

describe('Fallback Provider on Fetch Failure', () => {
  it('should fallback to Sina when Tencent fails', async () => {
    const mockFetch = vi.fn().mockImplementation(async (url) => {
      if (url.includes('sqt.gtimg.cn')) {
        return {
          status: 500,
          text: async () => 'Error'
        };
      }
      if (url.includes('sinajs.cn')) {
        const rawStr = 'var hq_str_sz000001="平安银行,11.20,11.15,11.25,11.30,11.10,11.25,11.26,2049389,22949028,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2026-07-13,15:34:59,00";';
        const bytes = new TextEncoder().encode(rawStr);
        return {
          status: 200,
          arrayBuffer: async () => bytes.buffer
        };
      }
    });

    const quotes = await fetchStockQuotes(['sz000001'], {
      fetchFn: mockFetch,
      relativeTo: new Date('2026-07-13T15:35:00+08:00')
    });
    expect(quotes).toHaveProperty('sz000001');
    expect(quotes['sz000001'].latestPrice).toBe(11.25);
    expect(quotes['sz000001'].source).toBe('sina');
  });
});

describe('Stock Review Blockers - Regression Tests', () => {
  it('should reject quotes from the previous day (previous-day rejection)', async () => {
    // Evaluation time: July 14th
    const relativeTo = new Date('2026-07-14T10:00:00+08:00');
    const mockFetch = vi.fn().mockImplementation(async (url) => {
      if (url.includes('sqt.gtimg.cn')) {
        // Tencent quote date is July 13th (previous day)
        return {
          status: 200,
          text: async () => 'v_sh600519="1~贵州茅台~600519~1700.00~1710.00~1715.00~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~20260713150000~0";'
        };
      }
      if (url.includes('sinajs.cn')) {
        // Sina quote date is July 13th (previous day)
        const fields = Array(33).fill('0');
        fields[0] = '贵州茅台';
        fields[2] = '1710.00';
        fields[3] = '1700.00';
        fields[30] = '2026-07-13';
        fields[31] = '15:00:00';
        const rawStr = `var hq_str_sh600519="${fields.join(',')}";`;
        const bytes = new TextEncoder().encode(rawStr);
        return {
          status: 200,
          arrayBuffer: async () => bytes.buffer
        };
      }
    });

    await expect(fetchStockQuotes(['sh600519'], { fetchFn: mockFetch, relativeTo }))
      .rejects.toThrow('All stock quote providers failed');
  });

  it('should reject future timestamps beyond clock skew tolerance (future rejection)', async () => {
    const relativeTo = new Date('2026-07-13T10:00:00+08:00');
    const mockFetch = vi.fn().mockImplementation(async (url) => {
      if (url.includes('sqt.gtimg.cn')) {
        // Quote timestamp is 5 minutes in future
        return {
          status: 200,
          text: async () => 'v_sh600519="1~贵州茅台~600519~1700.00~1710.00~1715.00~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~20260713100500~0";'
        };
      }
      if (url.includes('sinajs.cn')) {
        // Quote timestamp is 5 minutes in future
        const fields = Array(33).fill('0');
        fields[0] = '贵州茅台';
        fields[2] = '1710.00';
        fields[3] = '1700.00';
        fields[30] = '2026-07-13';
        fields[31] = '10:05:00';
        const rawStr = `var hq_str_sh600519="${fields.join(',')}";`;
        const bytes = new TextEncoder().encode(rawStr);
        return {
          status: 200,
          arrayBuffer: async () => bytes.buffer
        };
      }
    });

    await expect(fetchStockQuotes(['sh600519'], { fetchFn: mockFetch, relativeTo }))
      .rejects.toThrow('All stock quote providers failed');
  });

  it('should accept quotes during session within 120 mins but reject older (lunch-boundary acceptance)', async () => {
    // 13:00 is during trading session (lunch break ended)
    const relativeTo = new Date('2026-07-13T13:00:00+08:00');
    
    // Test case A: Quote from 11:30 (90 mins old) - should be accepted
    const mockFetchA = vi.fn().mockImplementation(async (url) => {
      if (url.includes('sqt.gtimg.cn')) {
        return {
          status: 200,
          text: async () => 'v_sh600519="1~贵州茅台~600519~1700.00~1710.00~1715.00~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~20260713113000~0";'
        };
      }
    });
    const quotesA = await fetchStockQuotes(['sh600519'], { fetchFn: mockFetchA, relativeTo });
    expect(quotesA).toHaveProperty('sh600519');

    // Test case B: Quote from 10:55 (125 mins old) - should be rejected
    const mockFetchB = vi.fn().mockImplementation(async (url) => {
      if (url.includes('sqt.gtimg.cn')) {
        return {
          status: 200,
          text: async () => 'v_sh600519="1~贵州茅台~600519~1700.00~1710.00~1715.00~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~20260713105500~0";'
        };
      }
      if (url.includes('sinajs.cn')) {
        const fields = Array(33).fill('0');
        fields[0] = '贵州茅台';
        fields[2] = '1710.00';
        fields[3] = '1700.00';
        fields[30] = '2026-07-13';
        fields[31] = '10:55:00';
        const rawStr = `var hq_str_sh600519="${fields.join(',')}";`;
        const bytes = new TextEncoder().encode(rawStr);
        return {
          status: 200,
          arrayBuffer: async () => bytes.buffer
        };
      }
    });
    await expect(fetchStockQuotes(['sh600519'], { fetchFn: mockFetchB, relativeTo }))
      .rejects.toThrow('All stock quote providers failed');
  });

  it('should skip Tencent rows whose code mismatches the response key', () => {
    // Key is sh600519 but fields[2] is 000001 (mismatch)
    const rawResponse = 'v_sh600519="1~贵州茅台~000001~1720.50~1710.00~1715.00~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~20260713153701~0";';
    expect(parseTencentQuote(rawResponse)).toEqual({});
  });

  it('keeps a valid Tencent quote when another requested row is malformed', async () => {
    const relativeTo = new Date('2026-07-13T10:00:00+08:00');
    const mockFetch = vi.fn().mockImplementation(async (url) => {
      if (url.includes('sqt.gtimg.cn')) {
        return {
          status: 200,
          text: async () =>
            'v_sh600519="1~贵州茅台~600519~1700.00~1710.00~1715.00~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~20260713100000~0";\n' +
            'v_sz000001="1~平安银行~600519~10.05~10.00~10.00~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~20260713100000~0";'
        };
      }
      if (url.includes('sinajs.cn')) {
        expect(url).toContain('sz000001');
        expect(url).not.toContain('sh600519');
        return {
          status: 200,
          arrayBuffer: async () => new TextEncoder().encode('var hq_str_sz000001="";').buffer
        };
      }
    });

    const quotes = await fetchStockQuotes(['sh600519', 'sz000001'], { fetchFn: mockFetch, relativeTo });

    expect(quotes['sh600519']).toMatchObject({ latestPrice: 1700, source: 'tencent' });
    expect(quotes).not.toHaveProperty('sz000001');
    expect(quotes.missingSymbols).toEqual(['sz000001']);
  });

  it('keeps a valid Sina quote when another requested row is malformed', async () => {
    const relativeTo = new Date('2026-07-13T10:00:00+08:00');
    const validFields = Array(33).fill('0');
    validFields[0] = '平安银行';
    validFields[2] = '10.00';
    validFields[3] = '10.05';
    validFields[30] = '2026-07-13';
    validFields[31] = '10:00:00';
    const mockFetch = vi.fn().mockImplementation(async (url) => {
      if (url.includes('sqt.gtimg.cn')) {
        return { status: 500, text: async () => 'Error' };
      }
      if (url.includes('sinajs.cn')) {
        const rawStr =
          'var hq_str_sh600519="malformed";\n' +
          `var hq_str_sz000001="${validFields.join(',')}";`;
        return {
          status: 200,
          arrayBuffer: async () => new TextEncoder().encode(rawStr).buffer
        };
      }
    });

    const quotes = await fetchStockQuotes(['sh600519', 'sz000001'], { fetchFn: mockFetch, relativeTo });

    expect(quotes['sz000001']).toMatchObject({ latestPrice: 10.05, source: 'sina' });
    expect(quotes).not.toHaveProperty('sh600519');
    expect(quotes.missingSymbols).toEqual(['sh600519']);
  });

  it('should query Sina for missing/invalid/stale Tencent quotes and merge (mixed Tencent+Sina merge)', async () => {
    const relativeTo = new Date('2026-07-13T10:00:00+08:00');
    
    // sh600519 is valid on Tencent
    // sz000001 is stale/invalid/missing on Tencent (represented as missing in Tencent response, or stale timestamp)
    const mockFetch = vi.fn().mockImplementation(async (url) => {
      if (url.includes('sqt.gtimg.cn')) {
        return {
          status: 200,
          text: async () => 
            'v_sh600519="1~贵州茅台~600519~1700.00~1710.00~1715.00~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~20260713100000~0";\n' +
            'v_sz000001="1~平安银行~000001~10.01~10.00~10.00~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~20260712100000~0";' // stale: July 12th
        };
      }
      if (url.includes('sinajs.cn')) {
        // We only request sz000001 from Sina since sh600519 was successfully fetched from Tencent
        expect(url).toContain('sz000001');
        expect(url).not.toContain('sh600519');
        
        const fields = Array(33).fill('0');
        fields[0] = '平安银行';
        fields[2] = '10.00';
        fields[3] = '10.05';
        fields[30] = '2026-07-13';
        fields[31] = '10:00:00';
        const rawStr = `var hq_str_sz000001="${fields.join(',')}";`;
        const bytes = new TextEncoder().encode(rawStr);
        return {
          status: 200,
          arrayBuffer: async () => bytes.buffer
        };
      }
    });

    const quotes = await fetchStockQuotes(['sh600519', 'sz000001'], { fetchFn: mockFetch, relativeTo });
    expect(quotes).toHaveProperty('sh600519');
    expect(quotes).toHaveProperty('sz000001');
    expect(quotes['sh600519'].latestPrice).toBe(1700.00);
    expect(quotes['sh600519'].source).toBe('tencent');
    expect(quotes['sz000001'].latestPrice).toBe(10.05);
    expect(quotes['sz000001'].source).toBe('sina');
  });

  describe('Stock Freshness Boundary Tests', () => {
    it('14:59 rejects 13:00', async () => {
      const relativeTo = new Date('2026-07-13T14:59:00+08:00');
      const mockFetch = vi.fn().mockImplementation(async (url) => {
        if (url.includes('sqt.gtimg.cn')) {
          return {
            status: 200,
            text: async () => 'v_sh600519="1~贵州茅台~600519~1700.00~1710.00~1715.00~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~20260713130000~0";'
          };
        }
      });
      await expect(fetchStockQuotes(['sh600519'], { fetchFn: mockFetch, relativeTo }))
        .rejects.toThrow('All stock quote providers failed');
    });

    it('10:00 rejects 09:30 older than 15m', async () => {
      const relativeTo = new Date('2026-07-13T10:00:00+08:00');
      const mockFetch = vi.fn().mockImplementation(async (url) => {
        if (url.includes('sqt.gtimg.cn')) {
          // Quote is from 09:40 (20 minutes old, older than 15m)
          return {
            status: 200,
            text: async () => 'v_sh600519="1~贵州茅台~600519~1700.00~1710.00~1715.00~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~20260713094000~0";'
          };
        }
      });
      await expect(fetchStockQuotes(['sh600519'], { fetchFn: mockFetch, relativeTo }))
        .rejects.toThrow('All stock quote providers failed');
    });

    it('13:05 accepts 11:30', async () => {
      const relativeTo = new Date('2026-07-13T13:05:00+08:00');
      const mockFetch = vi.fn().mockImplementation(async (url) => {
        if (url.includes('sqt.gtimg.cn')) {
          // Quote is from 11:30 (lunch reopening grace)
          return {
            status: 200,
            text: async () => 'v_sh600519="1~贵州茅台~600519~1700.00~1710.00~1715.00~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~20260713113000~0";'
          };
        }
      });
      const quotes = await fetchStockQuotes(['sh600519'], { fetchFn: mockFetch, relativeTo });
      expect(quotes).toHaveProperty('sh600519');
    });

    it('fresh 5m quotes pass', async () => {
      // morning session fresh quote
      const relMorning = new Date('2026-07-13T10:00:00+08:00');
      const mockFetchMorning = vi.fn().mockImplementation(async (url) => {
        return {
          status: 200,
          text: async () => 'v_sh600519="1~贵州茅台~600519~1700.00~1710.00~1715.00~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~20260713095500~0";'
        };
      });
      const qMorning = await fetchStockQuotes(['sh600519'], { fetchFn: mockFetchMorning, relativeTo: relMorning });
      expect(qMorning).toHaveProperty('sh600519');

      // afternoon grace fresh quote
      const relAfternoonGrace = new Date('2026-07-13T13:05:00+08:00');
      const mockFetchGrace = vi.fn().mockImplementation(async (url) => {
        return {
          status: 200,
          text: async () => 'v_sh600519="1~贵州茅台~600519~1700.00~1710.00~1715.00~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~20260713130000~0";'
        };
      });
      const qGrace = await fetchStockQuotes(['sh600519'], { fetchFn: mockFetchGrace, relativeTo: relAfternoonGrace });
      expect(qGrace).toHaveProperty('sh600519');

      // afternoon regular fresh quote
      const relAfternoon = new Date('2026-07-13T14:00:00+08:00');
      const mockFetchAfternoon = vi.fn().mockImplementation(async (url) => {
        return {
          status: 200,
          text: async () => 'v_sh600519="1~贵州茅台~600519~1700.00~1710.00~1715.00~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~20260713135500~0";'
        };
      });
      const qAfternoon = await fetchStockQuotes(['sh600519'], { fetchFn: mockFetchAfternoon, relativeTo: relAfternoon });
      expect(qAfternoon).toHaveProperty('sh600519');
    });
  });
});

