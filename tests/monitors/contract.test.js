import { describe, it, expect } from 'vitest';
import {
  validateMonitorProvider,
  normalizeMonitorEvent,
  MONITOR_PROVIDER_METHODS,
  MONITOR_EVENT_FIELDS,
  MONITOR_PROVIDER_TYPE_PATTERN
} from '../../src/monitors/core/contract.js';
import { createMonitorRegistry } from '../../src/monitors/registry.js';
import { stockProvider } from '../../src/monitors/providers/stock/index.js';

function createMockProvider(overrides = {}) {
  return {
    type: 'mock',
    displayName: 'Mock Monitor',
    validateTarget: () => true,
    fetchValues: async () => ({}),
    evaluate: () => false,
    formatEvent: () => ({
      providerType: 'mock',
      ruleId: 1,
      armVersion: 1,
      eventKey: 'mock:1:1',
      occurredAt: new Date(),
      value: 1,
      source: '',
      payload: {}
    }),
    ...overrides
  };
}

describe('Monitor Provider Contract', () => {
  it('declares the required provider methods', () => {
    expect(MONITOR_PROVIDER_METHODS).toEqual([
      'validateTarget',
      'fetchValues',
      'evaluate',
      'formatEvent'
    ]);
  });

  it('declares the normalized event fields per PRD', () => {
    expect(MONITOR_EVENT_FIELDS).toEqual([
      'providerType',
      'ruleId',
      'armVersion',
      'eventKey',
      'occurredAt',
      'value',
      'source',
      'payload'
    ]);
  });

  it('exposes the canonical type pattern', () => {
    expect(MONITOR_PROVIDER_TYPE_PATTERN).toEqual(/^[a-z][a-z0-9_-]*$/);
  });

  it('accepts a valid provider with all required fields and methods', () => {
    const provider = createMockProvider();
    expect(validateMonitorProvider(provider)).toBe(provider);
  });

  it('fails when provider is not an object', () => {
    expect(() => validateMonitorProvider(null)).toThrow(/object/);
    expect(() => validateMonitorProvider('mock')).toThrow(/object/);
    expect(() => validateMonitorProvider([])).toThrow(/object/);
  });

  it('fails when provider type is missing or empty', () => {
    expect(() => validateMonitorProvider({ ...createMockProvider(), type: undefined })).toThrow(/type/);
    expect(() => validateMonitorProvider({ ...createMockProvider(), type: '' })).toThrow(/type/);
    expect(() => validateMonitorProvider({ ...createMockProvider(), type: 123 })).toThrow(/type/);
  });

  it('fails when provider type is not canonical lowercase', () => {
    expect(() => validateMonitorProvider({ ...createMockProvider(), type: 'Mock' })).toThrow(/type|canonical|lowercase/);
    expect(() => validateMonitorProvider({ ...createMockProvider(), type: '1mock' })).toThrow(/type|canonical|lowercase/);
    expect(() => validateMonitorProvider({ ...createMockProvider(), type: 'mock space' })).toThrow(/type|canonical|lowercase/);
    expect(() => validateMonitorProvider({ ...createMockProvider(), type: 'mock.provider' })).toThrow(/type|canonical|lowercase/);
    expect(() => validateMonitorProvider({ ...createMockProvider(), type: ' mock ' })).toThrow(/type|canonical|lowercase/);
  });

  it('fails when provider displayName is missing or empty', () => {
    expect(() => validateMonitorProvider({ ...createMockProvider(), displayName: undefined })).toThrow(/displayName/);
    expect(() => validateMonitorProvider({ ...createMockProvider(), displayName: '' })).toThrow(/displayName/);
    expect(() => validateMonitorProvider({ ...createMockProvider(), displayName: '   ' })).toThrow(/displayName/);
  });

  it('fails with explicit error for each missing required method', () => {
    for (const method of MONITOR_PROVIDER_METHODS) {
      const provider = createMockProvider();
      delete provider[method];
      expect(() => validateMonitorProvider(provider)).toThrow(new RegExp(method));
    }
  });

  it('fails when a required method is not a function', () => {
    const provider = createMockProvider({ evaluate: 'not-a-function' });
    expect(() => validateMonitorProvider(provider)).toThrow(/evaluate/);
  });

  it('rejects class providers whose methods live on the prototype', () => {
    class MockProvider {
      type = 'mock';
      displayName = 'Mock';
      validateTarget() { return true; }
      fetchValues() { return {}; }
      evaluate() { return false; }
      formatEvent() { return { providerType: 'mock', ruleId: 1, armVersion: 1, eventKey: 'mock:1:1', occurredAt: new Date(), value: 1, source: '', payload: {} }; }
    }

    expect(() => validateMonitorProvider(new MockProvider())).toThrow(/own|method|prototype/);
  });
});

describe('Normalized Monitor Event', () => {
  const baseEvent = {
    providerType: 'stock',
    ruleId: 1,
    armVersion: 2,
    eventKey: 'stock:rule:1:2',
    occurredAt: new Date('2026-07-14T03:00:00.000Z'),
    value: 1700,
    source: 'tencent',
    payload: { code: 'sh600519' }
  };

  it('normalizes a complete event with all PRD fields', () => {
    const event = normalizeMonitorEvent(baseEvent);
    expect(event.providerType).toBe('stock');
    expect(event.ruleId).toBe(1);
    expect(event.armVersion).toBe(2);
    expect(event.eventKey).toBe('stock:rule:1:2');
    expect(event.occurredAt).toEqual(new Date('2026-07-14T03:00:00.000Z'));
    expect(event.value).toBe(1700);
    expect(event.source).toBe('tencent');
    expect(event.payload).toEqual({ code: 'sh600519' });
  });

  it('normalizes string occurredAt to a Date', () => {
    const event = normalizeMonitorEvent({ ...baseEvent, occurredAt: '2026-07-14T03:00:00.000Z' });
    expect(event.occurredAt).toEqual(new Date('2026-07-14T03:00:00.000Z'));
  });

  it('sets defaults for optional fields', () => {
    const event = normalizeMonitorEvent({
      providerType: 'stock',
      ruleId: 1,
      eventKey: 'stock:rule:1:1',
      occurredAt: '2026-07-14T03:00:00.000Z',
      value: 1700
    });
    expect(event.armVersion).toBe(1);
    expect(event.source).toBe('');
    expect(event.payload).toEqual({});
  });

  it('rejects missing or invalid required fields', () => {
    expect(() => normalizeMonitorEvent({ ...baseEvent, providerType: undefined })).toThrow(/providerType/);
    expect(() => normalizeMonitorEvent({ ...baseEvent, ruleId: 'abc' })).toThrow(/ruleId/);
    expect(() => normalizeMonitorEvent({ ...baseEvent, armVersion: 0 })).toThrow(/armVersion/);
    expect(() => normalizeMonitorEvent({ ...baseEvent, eventKey: '' })).toThrow(/eventKey/);
    expect(() => normalizeMonitorEvent({ ...baseEvent, occurredAt: undefined })).toThrow(/occurredAt/);
    expect(() => normalizeMonitorEvent({ ...baseEvent, value: undefined })).toThrow(/value/);
    expect(() => normalizeMonitorEvent({ ...baseEvent, value: 'abc' })).toThrow(/value/);
    expect(() => normalizeMonitorEvent({ ...baseEvent, payload: [] })).toThrow(/payload/);
  });

  it('trims providerType, eventKey, and source', () => {
    const event = normalizeMonitorEvent({
      ...baseEvent,
      providerType: '  stock  ',
      eventKey: '  stock:rule:1:2  ',
      source: '  tencent  '
    });
    expect(event.providerType).toBe('stock');
    expect(event.eventKey).toBe('stock:rule:1:2');
    expect(event.source).toBe('tencent');
  });
});

describe('Monitor Registry', () => {
  it('can be created with an initial set of providers', () => {
    const provider = createMockProvider();
    const registry = createMonitorRegistry([provider]);
    expect(registry.get('mock')).toBeDefined();
    expect(registry.has('mock')).toBe(true);
    expect(registry.list().map(p => p.type)).toEqual(['mock']);
  });

  it('enforces unique provider types by canonical type', () => {
    const registry = createMonitorRegistry([createMockProvider()]);
    expect(() => registry.register(createMockProvider())).toThrow(/unique|already|mock/i);
  });

  it('validates providers before registering', () => {
    const registry = createMonitorRegistry();
    expect(() => registry.register({ type: 'bad', displayName: 'Bad' })).toThrow(/validateTarget|own/);
  });

  it('does not modify existing providers when a new provider is registered', () => {
    const first = createMockProvider({ type: 'first', displayName: 'First' });
    const second = createMockProvider({ type: 'second', displayName: 'Second' });
    const registry = createMonitorRegistry([first]);
    const firstFromRegistry = registry.get('first');

    registry.register(second);

    expect(registry.get('first')).toBe(firstFromRegistry);
    expect(registry.get('first').type).toBe('first');
    expect(registry.get('first').displayName).toBe('First');
    expect(registry.get('second').type).toBe('second');
  });

  it('returns undefined for unregistered provider types', () => {
    const registry = createMonitorRegistry();
    expect(registry.get('unknown')).toBeUndefined();
    expect(registry.has('unknown')).toBe(false);
  });

  it('get and has normalize input by trimming and lowercasing', () => {
    const registry = createMonitorRegistry([createMockProvider({ type: 'mock', displayName: '  Mock  ' })]);
    expect(registry.get('  MOCK  ').type).toBe('mock');
    expect(registry.get('Mock').displayName).toBe('Mock');
    expect(registry.has('  Mock  ')).toBe(true);
    expect(registry.has('unknown')).toBe(false);
    expect(registry.get('mock space')).toBeUndefined();
    expect(registry.has('')).toBe(false);
    expect(registry.has(123)).toBe(false);
  });

  it('stores a frozen provider whose methods are still callable', () => {
    const registry = createMonitorRegistry([createMockProvider({ type: 'callable' })]);
    const provider = registry.get('callable');
    expect(provider.fetchValues()).toBeInstanceOf(Promise);
    expect(provider.validateTarget()).toBe(true);
  });

  it('rejects class providers because their methods are not own properties', () => {
    class MockProvider {
      type = 'class-mock';
      displayName = 'Class Mock';
      validateTarget() { return true; }
      fetchValues() { return {}; }
      evaluate() { return false; }
      formatEvent() { return { providerType: 'mock', ruleId: 1, armVersion: 1, eventKey: 'mock:1:1', occurredAt: new Date(), value: 1, source: '', payload: {} }; }
    }

    const registry = createMonitorRegistry();
    expect(() => registry.register(new MockProvider())).toThrow(/own|method|prototype/);
  });
});

describe('Default Stock Provider Registry', () => {
  it('includes the stock provider by default', () => {
    const registry = createMonitorRegistry();
    expect(registry.has('stock')).toBe(true);
    expect(registry.get('stock')).toBeDefined();
    expect(registry.get('Stock')).toBe(registry.get('stock'));
    expect(registry.types()).toContain('stock');
  });

  it('allows explicit injection to isolate tests from the default set', () => {
    const registry = createMonitorRegistry([]);
    expect(registry.has('stock')).toBe(false);
    expect(registry.list()).toHaveLength(0);
  });

  it('can be created with a custom provider instead of the default stock provider', () => {
    const mock = createMockProvider({ type: 'mock', displayName: 'Mock' });
    const registry = createMonitorRegistry([mock]);
    expect(registry.has('mock')).toBe(true);
    expect(registry.has('stock')).toBe(false);
    expect(registry.types()).toEqual(['mock']);
  });

  it('validates the default stock provider against the contract', () => {
    expect(validateMonitorProvider(stockProvider)).toBe(stockProvider);
  });
});
