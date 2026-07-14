import {
  addTrackerRule,
  getTrackerRule,
  getTrackerRules,
  updateTrackerRuleStatus,
  removeTrackerRule
} from '../../db.js';
import { normalizeSymbol } from '../providers/stock/index.js';
import { createMonitorRegistry } from '../registry.js';

function parseTargetConfig(json) {
  try {
    return JSON.parse(json || '{}');
  } catch {
    return {};
  }
}

function mapRule(row) {
  return {
    id: row.id,
    providerType: row.provider_type,
    targetKey: row.target_key,
    targetConfig: parseTargetConfig(row.target_config_json),
    conditionType: row.condition_type,
    conditionValue: row.condition_value,
    status: row.status,
    armVersion: row.arm_version,
    lastValue: row.last_value,
    lastObservedAt: row.last_observed_at,
    lastSource: row.last_source,
    triggeredAt: row.triggered_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export class MonitorService {
  constructor(registry, clock) {
    if (registry && typeof registry === 'object' && !registry.get && registry.registry) {
      const opts = registry;
      this.registry = opts.registry;
      this.clock = opts.clock;
    } else {
      this.registry = registry;
      this.clock = clock;
    }

    if (!this.clock) {
      this.clock = { now: () => new Date() };
    }

    if (!this.registry) {
      this.registry = createMonitorRegistry();
    }
  }

  async addStock(db, code, conditionType, conditionValue) {
    const provider = this.registry.get('stock');
    if (!provider) {
      throw new Error('Unsupported monitor provider type: stock');
    }

    const rawCode = String(code || '').trim();
    if (!provider.validateTarget({ code: rawCode })) {
      throw new Error(`Invalid stock code: ${code}`);
    }

    const normalizedCode = normalizeSymbol(rawCode);
    const normalizedCondition = String(conditionType || '').trim().toLowerCase();
    if (normalizedCondition !== 'gte' && normalizedCondition !== 'lte') {
      throw new Error(`Invalid condition type: ${conditionType}. Must be 'gte' or 'lte'.`);
    }

    const targetValue = parseFloat(conditionValue);
    if (isNaN(targetValue) || targetValue <= 0) {
      throw new Error(`Invalid condition value: ${conditionValue}. Must be a positive number.`);
    }

    const ok = await addTrackerRule(db, {
      providerType: 'stock',
      targetKey: normalizedCode,
      targetConfig: { code: normalizedCode },
      conditionType: normalizedCondition,
      conditionValue: targetValue,
      status: 'active'
    });

    if (!ok) {
      throw new Error('Failed to add stock rule');
    }

    const rules = await getTrackerRules(db);
    const created = rules
      .filter(r =>
        r.provider_type === 'stock' &&
        r.target_key === normalizedCode &&
        r.condition_type === normalizedCondition &&
        r.condition_value === targetValue &&
        r.status === 'active'
      )
      .sort((a, b) => b.id - a.id)[0];

    return created ? mapRule(created) : null;
  }

  async list(db, filters = {}) {
    const rules = await getTrackerRules(db);
    let result = rules.map(mapRule);
    if (filters.providerType) {
      result = result.filter(r => r.providerType === filters.providerType);
    }
    return result;
  }

  async get(db, id) {
    const row = await getTrackerRule(db, id);
    return row ? mapRule(row) : null;
  }

  async pause(db, id) {
    return await updateTrackerRuleStatus(db, id, 'paused');
  }

  async resume(db, id) {
    return await updateTrackerRuleStatus(db, id, 'active');
  }

  async remove(db, id) {
    return await removeTrackerRule(db, id);
  }

  async getQuote(db, code, context = {}) {
    const provider = this.registry.get('stock');
    if (!provider) {
      throw new Error('Unsupported monitor provider type: stock');
    }

    const rawCode = String(code || '').trim();
    if (!provider.validateTarget({ code: rawCode })) {
      throw new Error(`Invalid stock code: ${code}`);
    }

    const normalizedCode = normalizeSymbol(rawCode);
    const ctx = {
      fetchFn: context.fetchFn ?? globalThis.fetch,
      relativeTo: context.relativeTo ?? this.clock.now(),
      ...context
    };

    const values = await provider.fetchValues([{ code: normalizedCode }], ctx);
    const quote = values[normalizedCode];
    if (!quote) {
      throw new Error(`No quote available for ${normalizedCode}`);
    }

    return {
      symbol: normalizedCode,
      price: quote.value,
      yesterdayClose: quote.yesterdayClose,
      observedAt: quote.observedAt,
      source: quote.source
    };
  }
}
