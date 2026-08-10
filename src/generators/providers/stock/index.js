// Stock Generator Provider
//
// 该 provider 将新浪/腾讯 A 股行情接口的实时报价转换为 generator 标准化 item。
//
// 抓取策略：优先腾讯行情接口，缺失/过期/无效的 symbol 回退新浪接口。
// 仅在交易时段（Asia/Shanghai 周一至周五 09:30-11:30、13:00-15:00）抓取；
// 非交易时段返回 { items: [], meta: { reason: 'market_closed' } }。

import { normalizeGeneratorItem } from '../../core/contract.js';
import { escapeHtml } from '../../../html.js';

export function normalizeSymbol(symbol) {
  if (!symbol) return null;
  const s = String(symbol).trim().toLowerCase();

  // Check if already prefixed
  const match = s.match(/^(sh|sz|bj)(\d{6})$/);
  if (match) {
    return match[0];
  }

  // Check for colon-prefixed symbols
  const colonMatch = s.match(/^(sha|sh|sse|she|sz|szse|bse|bj)\s*:\s*(\d{6})$/);
  if (colonMatch) {
    const [, prefix, code] = colonMatch;
    if (['sha', 'sh', 'sse'].includes(prefix)) {
      return 'sh' + code;
    }
    if (['she', 'sz', 'szse'].includes(prefix)) {
      return 'sz' + code;
    }
    if (['bse', 'bj'].includes(prefix)) {
      return 'bj' + code;
    }
  }

  // 6-digit numeric codes
  if (/^\d{6}$/.test(s)) {
    if (s.startsWith('920')) return 'bj' + s;
    if (s.startsWith('900')) return 'sh' + s;
    if (s.startsWith('6')) return 'sh' + s;
    if (s.startsWith('0') || s.startsWith('3') || s.startsWith('2')) return 'sz' + s;
    if (s.startsWith('4') || s.startsWith('8')) return 'bj' + s;
  }
  return null;
}

export function isTradingSession(time = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit'
  });

  const parts = formatter.formatToParts(time);
  const getVal = (type) => parts.find(p => p.type === type).value;

  const weekday = getVal('weekday');
  const hour = parseInt(getVal('hour'), 10);
  const minute = parseInt(getVal('minute'), 10);

  if (weekday === 'Sat' || weekday === 'Sun') {
    return false;
  }

  const timeInMinutes = hour * 60 + minute;
  const range1Start = 9 * 60 + 30; // 09:30
  const range1End = 11 * 60 + 30;  // 11:30
  const range2Start = 13 * 60 + 0; // 13:00
  const range2End = 15 * 60 + 0;  // 15:00

  return (timeInMinutes >= range1Start && timeInMinutes <= range1End) ||
         (timeInMinutes >= range2Start && timeInMinutes <= range2End);
}

export function getAsiaShanghaiDateStr(time) {
  const date = new Date(time);
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const parts = formatter.formatToParts(date);
  const year = parts.find(p => p.type === 'year').value;
  const month = parts.find(p => p.type === 'month').value;
  const day = parts.find(p => p.type === 'day').value;
  return `${year}-${month}-${day}`;
}

export function validateQuoteFreshness(qTimeStr, relativeTo) {
  const qTime = new Date(qTimeStr).getTime();
  const relTime = relativeTo.getTime();
  const CLOCK_SKEW_TOLERANCE_MS = 60 * 1000; // 60 seconds clock-skew tolerance

  // Reject future timestamps beyond clock skew tolerance
  if (qTime - relTime > CLOCK_SKEW_TOLERANCE_MS) {
    return false;
  }

  // Require calendar dates in Asia/Shanghai to be equal
  const qDateStr = getAsiaShanghaiDateStr(qTime);
  const relDateStr = getAsiaShanghaiDateStr(relTime);
  if (qDateStr !== relDateStr) {
    return false;
  }

  // During a trading session, enforce session-specific freshness rules
  if (isTradingSession(relativeTo)) {
    const ageMs = relTime - qTime;
    const fifteenMinsMs = 15 * 60 * 1000;

    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Shanghai',
      hour12: false,
      hour: '2-digit',
      minute: '2-digit'
    });
    const parts = formatter.formatToParts(relativeTo);
    const hour = parseInt(parts.find(p => p.type === 'hour').value, 10);
    const minute = parseInt(parts.find(p => p.type === 'minute').value, 10);
    const timeInMinutes = hour * 60 + minute;

    if (timeInMinutes >= 9 * 60 + 30 && timeInMinutes <= 11 * 60 + 30) {
      // morning session 09:30-11:30 require quote age <=15 minutes
      if (ageMs > fifteenMinsMs) {
        return false;
      }
    } else if (timeInMinutes >= 13 * 60 && timeInMinutes <= 13 * 60 + 15) {
      // during afternoon 13:00-13:15 permit either age <=15 minutes or a same-day quote from 11:25 onward (lunch reopening grace)
      const isFresh = ageMs <= fifteenMinsMs;

      const qDate = new Date(qTime);
      const qFormatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Shanghai',
        hour12: false,
        hour: '2-digit',
        minute: '2-digit'
      });
      const qParts = qFormatter.formatToParts(qDate);
      const qHour = parseInt(qParts.find(p => p.type === 'hour').value, 10);
      const qMinute = parseInt(qParts.find(p => p.type === 'minute').value, 10);
      const qTimeInMinutes = qHour * 60 + qMinute;

      const isLunchGrace = qTimeInMinutes >= (11 * 60 + 25);
      if (!isFresh && !isLunchGrace) {
        return false;
      }
    } else if (timeInMinutes > 13 * 60 + 15) {
      // after 13:15 require age <=15 minutes
      if (ageMs > fifteenMinsMs) {
        return false;
      }
    }
  }

  return true;
}

export function parseTencentQuote(text) {
  const quotes = {};
  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(2, eqIdx).trim(); // v_sh600519 -> sh600519
    let val = trimmed.slice(eqIdx + 1).trim();
    if (val.startsWith('"') && val.endsWith('";')) {
      val = val.slice(1, -2);
    } else if (val.startsWith('"') && val.endsWith('"')) {
      val = val.slice(1, -1);
    }
    const fields = val.split('~');
    if (fields.length < 31) continue;

    const name = fields[1];
    const code = fields[2];
    const latestPrice = parseFloat(fields[3]);
    const yesterdayClose = parseFloat(fields[4]);
    const tsStr = fields[30]; // YYYYMMDDHHMMSS

    if (!code || isNaN(latestPrice) || latestPrice <= 0 || isNaN(yesterdayClose) || yesterdayClose <= 0 || !tsStr || tsStr.length < 14) {
      continue;
    }

    // Verify fields[2] matches the six digits from the response key
    const keyDigits = key.slice(-6);
    if (code !== keyDigits) {
      continue;
    }

    const year = tsStr.slice(0, 4);
    const month = tsStr.slice(4, 6);
    const day = tsStr.slice(6, 8);
    const hour = tsStr.slice(8, 10);
    const minute = tsStr.slice(10, 12);
    const second = tsStr.slice(12, 14);
    const timestamp = `${year}-${month}-${day}T${hour}:${minute}:${second}+08:00`;

    quotes[key] = {
      symbol: key,
      name: name || '',
      latestPrice,
      yesterdayClose,
      timestamp,
      source: 'tencent'
    };
  }
  return quotes;
}

export function parseSinaQuote(bytes) {
  const text = new TextDecoder('utf-8').decode(bytes);
  const quotes = {};
  const lines = text.split('\n');
  let matchedAny = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/var hq_str_([a-z0-9]+)="([^"]*)"/);
    if (!match) continue;
    matchedAny = true;
    const key = match[1];
    const content = match[2];
    const fields = content.split(',');
    if (fields.length < 32) {
      continue;
    }

    const name = fields[0];
    const latestPrice = parseFloat(fields[3]);
    const yesterdayClose = parseFloat(fields[2]);
    const date = fields[30];
    const time = fields[31];

    if (isNaN(latestPrice) || latestPrice <= 0 || isNaN(yesterdayClose) || yesterdayClose <= 0 || !date || !time) {
      continue;
    }

    const timestamp = `${date}T${time}+08:00`;
    quotes[key] = {
      symbol: key,
      name: name || '',
      latestPrice,
      yesterdayClose,
      timestamp,
      source: 'sina'
    };
  }
  if (!matchedAny) {
    throw new Error('Sina quote response format invalid');
  }
  return quotes;
}

export async function fetchStockQuotes(symbols, options = {}) {
  const fetchFn = options.fetchFn || fetch;
  const relativeTo = options.relativeTo || new Date();

  if (!symbols || symbols.length === 0) return {};
  const normalized = symbols.map(s => normalizeSymbol(s)).filter(Boolean);
  if (normalized.length === 0) return {};

  const validatedTencent = {};

  // 1. Try Primary (Tencent)
  try {
    const url = `https://web.sqt.gtimg.cn/utf8/q=${normalized.join(',')}`;
    const res = await fetchFn(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0'
      }
    });
    if (res.status === 200) {
      const text = await res.text();
      const quotes = parseTencentQuote(text);
      for (const sym of normalized) {
        if (quotes[sym]) {
          const q = quotes[sym];
          if (validateQuoteFreshness(q.timestamp, relativeTo)) {
            validatedTencent[sym] = q;
          } else {
            console.warn(`[stock] Tencent quote stale/invalid for ${sym}: ${q.timestamp}`);
          }
        }
      }
    }
  } catch (err) {
    console.warn('[stock] Tencent primary fetch failed:', err.message);
  }

  // 2. Find missing/invalid/stale symbols from Tencent
  const missingFromTencent = normalized.filter(sym => !validatedTencent[sym]);
  const validatedSina = {};

  // 3. Try Fallback (Sina) for missing/invalid/stale symbols only
  if (missingFromTencent.length > 0) {
    try {
      const url = `https://hq.sinajs.cn/list=${missingFromTencent.join(',')}`;
      const res = await fetchFn(url, {
        headers: {
          'Referer': 'https://finance.sina.com.cn',
          'User-Agent': 'Mozilla/5.0'
        }
      });
      if (res.status === 200) {
        const buf = await res.arrayBuffer();
        const bytes = new Uint8Array(buf);
        const quotes = parseSinaQuote(bytes);
        for (const sym of missingFromTencent) {
          if (quotes[sym]) {
            const q = quotes[sym];
            if (validateQuoteFreshness(q.timestamp, relativeTo)) {
              validatedSina[sym] = q;
            } else {
              console.warn(`[stock] Sina quote stale/invalid for ${sym}: ${q.timestamp}`);
            }
          }
        }
      }
    } catch (err) {
      console.warn('[stock] Sina fallback fetch failed:', err.message);
    }
  }

  // 4. Merge results
  const finalQuotes = { ...validatedTencent, ...validatedSina };

  // 5. Only throw if no requested symbols are available
  if (Object.keys(finalQuotes).length === 0) {
    throw new Error('All stock quote providers failed');
  }

  return finalQuotes;
}

function isPlainObject(value) {
  return Object.prototype.toString.call(value) === '[object Object]';
}

function getCrypto(context) {
  return context?.crypto || globalThis.crypto;
}

async function computeContentHash({ title, descriptionHtml }, context) {
  const crypto = getCrypto(context);
  if (!crypto || typeof crypto.subtle?.digest !== 'function') {
    throw new Error('WebCrypto SHA-256 is not available');
  }

  const payload = JSON.stringify({ title, descriptionHtml });
  const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
  const bytes = new Uint8Array(buffer);
  let hex = '';
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, '0');
  }
  return hex;
}

function sinaStockUrl(symbol) {
  return `https://finance.sina.com.cn/realstock/company/${symbol}/nc.shtml`;
}

function formatSignedNumber(value, digits = 2) {
  const formatted = value.toFixed(digits);
  return value > 0 ? `+${formatted}` : formatted;
}

function buildQuoteDescriptionHtml(quote, name) {
  const change = quote.latestPrice - quote.yesterdayClose;
  const changePct = (change / quote.yesterdayClose) * 100;

  const rows = [
    ['名称', name],
    ['代码', quote.symbol],
    ['最新价', quote.latestPrice.toFixed(2)],
    ['昨收', quote.yesterdayClose.toFixed(2)],
    ['涨跌', formatSignedNumber(change)],
    ['涨跌幅', `${formatSignedNumber(changePct)}%`],
    ['时间', quote.timestamp],
    ['来源', quote.source]
  ];

  const body = rows
    .map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(String(value))}</td></tr>`)
    .join('');
  return `<table>${body}</table>`;
}

export const stockProvider = {
  type: 'stock',
  displayName: 'A股行情',

  validateConfig(config, context) {
    if (config !== undefined && !isPlainObject(config)) {
      throw new Error('Invalid config: must be a plain object or undefined');
    }

    const code = normalizeSymbol(context?.instanceKey);
    if (!code) {
      throw new Error('Invalid stock code');
    }

    return { ...(config || {}), code, configVersion: 1 };
  },

  async fetchItems(instance, context = {}) {
    if (!instance || typeof instance !== 'object' || Array.isArray(instance)) {
      throw new Error('Invalid instance');
    }

    const symbol = normalizeSymbol(instance.config?.code || instance.instanceKey);
    if (!symbol) {
      throw new Error('Invalid stock code');
    }

    const now = context.now ? new Date(context.now) : new Date();
    if (!isTradingSession(now)) {
      return { items: [], meta: { reason: 'market_closed' } };
    }

    const quotes = await fetchStockQuotes([symbol], {
      fetchFn: context.fetch || context.fetchFn,
      relativeTo: now
    });

    const quote = quotes[symbol];
    if (!quote) {
      return { items: [], meta: { reason: 'no_quote' } };
    }

    return { items: [quote], meta: {} };
  },

  async normalizeItem(raw, instance, context) {
    const quote = raw;
    const symbol = normalizeSymbol(quote?.symbol || instance?.config?.code || instance?.instanceKey);
    if (!symbol) {
      throw new Error('Invalid stock quote: missing symbol');
    }

    const name = quote.name || instance?.displayName || symbol;
    const title = `${name} ${quote.latestPrice}`;
    const descriptionHtml = buildQuoteDescriptionHtml(quote, name);
    const contentHash = await computeContentHash({ title, descriptionHtml }, context);

    return normalizeGeneratorItem({
      itemKey: symbol,
      canonicalId: symbol,
      contentHash,
      title,
      descriptionHtml,
      link: sinaStockUrl(symbol),
      publishedAt: new Date(),
      mediaType: '',
      rawImages: []
    });
  },

  buildFeedMeta(instance, context) {
    const symbol = normalizeSymbol(instance?.config?.code || instance?.instanceKey) || '';
    const name = String(instance?.displayName || '').trim() || symbol;

    return {
      title: `${name}(A股)`,
      link: symbol ? sinaStockUrl(symbol) : '',
      description: 'A股行情',
      language: 'zh-CN'
    };
  }
};
