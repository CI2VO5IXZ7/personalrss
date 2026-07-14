// Monitor Provider 静态注册表

import { validateMonitorProvider, MONITOR_PROVIDER_TYPE_PATTERN } from './core/contract.js';
import { stockProvider } from './providers/stock/index.js';

function normalizeType(type) {
  if (typeof type !== 'string') {
    return undefined;
  }
  const normalized = type.trim().toLowerCase();
  if (!MONITOR_PROVIDER_TYPE_PATTERN.test(normalized)) {
    return undefined;
  }
  return normalized;
}

export class MonitorRegistry {
  constructor(providers = []) {
    this.providers = new Map();
    for (const provider of providers) {
      this.register(provider);
    }
  }

  register(provider) {
    const valid = validateMonitorProvider(provider);

    if (this.providers.has(valid.type)) {
      throw new Error(`Monitor provider type already registered: ${valid.type}`);
    }

    this.providers.set(valid.type, Object.freeze({
      ...valid,
      displayName: valid.displayName.trim()
    }));
    return this;
  }

  get(type) {
    const normalized = normalizeType(type);
    if (normalized === undefined) {
      return undefined;
    }
    return this.providers.get(normalized);
  }

  has(type) {
    const normalized = normalizeType(type);
    if (normalized === undefined) {
      return false;
    }
    return this.providers.has(normalized);
  }

  list() {
    return Array.from(this.providers.values());
  }

  types() {
    return Array.from(this.providers.keys());
  }
}

export function createMonitorRegistry(providers = [stockProvider]) {
  return new MonitorRegistry(providers);
}
