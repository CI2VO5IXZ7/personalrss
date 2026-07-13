import {
  getTrackerRulesByStatus,
  atomicTriggerAndEnqueueStockNotification,
  addTrackerEvent
} from '../db.js';
import { enqueue } from '../notifications/queue.js';
import { fetchStockQuotes, isTradingSession, getAsiaShanghaiDateStr } from './providers/stock.js';

export async function evaluateRules(db, env, options = {}) {
  const fetchFn = options.fetchFn || fetch;
  const relativeTo = options.relativeTo || new Date();
  const forceTradingSession = options.forceTradingSession || false;

  // 1. Session Guard
  if (!forceTradingSession && !isTradingSession(relativeTo)) {
    return 0;
  }

  // 2. Fetch Active Rules
  const activeRules = await getTrackerRulesByStatus(db, 'active');
  if (activeRules.length === 0) {
    return 0;
  }

  // Group by code to batch queries
  const stockRules = activeRules.filter(r => r.provider_type === 'stock');
  if (stockRules.length === 0) {
    return 0;
  }

  const symbols = Array.from(new Set(stockRules.map(r => r.target_key)));
  
  let quotes = {};
  try {
    quotes = await fetchStockQuotes(symbols, { fetchFn, relativeTo });
  } catch (err) {
    console.error('[engine] fetchStockQuotes failed:', err.message);
    const dateStr = getAsiaShanghaiDateStr(relativeTo);
    await enqueue(db, {
      kind: 'system',
      dedupeKey: `stock_provider_failure:${dateStr}`,
      payload: {
        message: 'All stock quote providers failed. Stale quote protection active.'
      }
    });
    return 0;
  }

  // Expose missing symbols to engine so they generate a deduped system warning
  if (quotes.missingSymbols && quotes.missingSymbols.length > 0) {
    const dateStr = getAsiaShanghaiDateStr(relativeTo);
    const missingList = quotes.missingSymbols.join(', ');
    await enqueue(db, {
      kind: 'system',
      dedupeKey: `stock_missing_symbols:${dateStr}`,
      payload: {
        message: `Missing stock quotes for symbols: ${missingList}`
      }
    });
  }

  let triggeredCount = 0;

  for (const rule of stockRules) {
    const symbol = rule.target_key;
    const quote = quotes[symbol];
    if (!quote) continue;

    const latestPrice = quote.latestPrice;
    const conditionType = rule.condition_type;
    const conditionValue = rule.condition_value;

    let satisfied = false;
    if (conditionType === 'gte') {
      satisfied = latestPrice >= conditionValue;
    } else if (conditionType === 'lte') {
      satisfied = latestPrice <= conditionValue;
    }

    if (satisfied) {
      const payload = {
        ruleId: rule.id,
        armVersion: rule.arm_version,
        code: symbol,
        conditionType,
        conditionValue,
        price: latestPrice,
        observedAt: quote.timestamp,
        source: quote.source
      };
      const transitioned = await atomicTriggerAndEnqueueStockNotification(db, {
        ruleId: rule.id,
        armVersion: rule.arm_version,
        lastValue: latestPrice,
        lastObservedAt: quote.timestamp,
        lastSource: quote.source,
        payload
      });

      if (transitioned) {
        await addTrackerEvent(db, {
          ruleId: rule.id,
          eventType: 'trigger_pending',
          value: latestPrice,
          observedAt: quote.timestamp,
          source: quote.source,
          details: { conditionType, conditionValue }
        });

        triggeredCount++;
      }
    }
  }

  return triggeredCount;
}
