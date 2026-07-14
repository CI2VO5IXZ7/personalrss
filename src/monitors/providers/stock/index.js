import { normalizeMonitorEvent } from '../../core/contract.js';

export function normalizeSymbol(symbol) {
  if (!symbol) return null;
  const s = String(symbol).trim().toLowerCase();

  // Check if already prefixed
  const match = s.match(/^(sh|sz|bj)(\d{6})$/);
  if (match) {
    return match[0];
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

  // 5. Identify missing symbols after both attempts
  const missingSymbols = normalized.filter(sym => !finalQuotes[sym]);

  // 6. Only throw if no requested symbols are available
  if (Object.keys(finalQuotes).length === 0) {
    throw new Error('All stock quote providers failed');
  }

  // Expose missing symbols to engine
  Object.defineProperty(finalQuotes, 'missingSymbols', {
    value: missingSymbols,
    enumerable: false,
    writable: true,
    configurable: true
  });

  return finalQuotes;
}

function evaluateCondition(rule, value) {
  const price = typeof value === 'number' ? value : (value?.value ?? value?.latestPrice);
  if (price === undefined || price === null || isNaN(price)) {
    return false;
  }

  const conditionType = rule.conditionType ?? rule.condition_type;
  const conditionValue = rule.conditionValue ?? rule.condition_value;

  if (conditionType === 'gte') {
    return price >= conditionValue;
  } else if (conditionType === 'lte') {
    return price <= conditionValue;
  }

  return false;
}

export const stockProvider = {
  type: 'stock',
  displayName: 'A 股',

  validateTarget(config, context) {
    if (!config || typeof config !== 'object') return false;
    const code = config.code;
    return !!normalizeSymbol(code);
  },

  async fetchValues(targets, context = {}) {
    const symbols = targets.map(t => normalizeSymbol(t.code)).filter(Boolean);
    if (symbols.length === 0) return {};

    const quotes = await fetchStockQuotes(symbols, {
      fetchFn: context.fetchFn,
      relativeTo: context.relativeTo
    });

    const result = {};
    for (const sym of symbols) {
      if (quotes[sym]) {
        result[sym] = {
          value: quotes[sym].latestPrice,
          observedAt: quotes[sym].timestamp,
          source: quotes[sym].source,
          yesterdayClose: quotes[sym].yesterdayClose
        };
      }
    }
    return result;
  },

  evaluate(rule, value, context) {
    return evaluateCondition(rule, value);
  },

  formatEvent(rule, value, context) {
    const price = typeof value === 'number' ? value : (value?.value ?? value?.latestPrice);
    const observedAt = value?.observedAt ?? value?.timestamp ?? new Date().toISOString();
    const source = value?.source ?? '';
    const ruleId = rule.id ?? rule.ruleId;
    const armVersion = rule.armVersion ?? rule.arm_version ?? 1;
    const targetKey = rule.targetKey ?? rule.target_key;
    const conditionType = rule.conditionType ?? rule.condition_type;
    const conditionValue = rule.conditionValue ?? rule.condition_value;
    const eventKey = `stock:rule:${ruleId}:${armVersion}`;

    return normalizeMonitorEvent({
      providerType: 'stock',
      ruleId,
      armVersion,
      eventKey,
      occurredAt: observedAt,
      value: price,
      source,
      payload: {
        ruleId,
        armVersion,
        code: targetKey,
        conditionType,
        conditionValue,
        price,
        observedAt,
        source
      }
    });
  },

  normalizeValue(raw) {
    return parseFloat(raw);
  }
};
