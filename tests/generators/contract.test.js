import { describe, it, expect } from 'vitest';
import {
  validateGeneratorProvider,
  normalizeGeneratorItem,
  GENERATOR_PROVIDER_METHODS,
  NORMALIZED_ITEM_FIELDS,
  GENERATOR_PROVIDER_TYPE_PATTERN
} from '../../src/generators/core/contract.js';
import { createGeneratorRegistry } from '../../src/generators/registry.js';
import { instagramProvider } from '../../src/generators/providers/instagram/index.js';

function createMockProvider(overrides = {}) {
  return {
    type: 'mock',
    displayName: 'Mock Provider',
    validateConfig: () => true,
    fetchItems: async () => [],
    normalizeItem: (raw) => raw,
    buildFeedMeta: () => ({
      title: 'Mock Feed',
      link: 'https://example.com/mock',
      description: 'A mock feed'
    }),
    ...overrides
  };
}

describe('Generator Provider Contract', () => {
  it('declares the required provider methods', () => {
    expect(GENERATOR_PROVIDER_METHODS).toEqual([
      'validateConfig',
      'fetchItems',
      'normalizeItem',
      'buildFeedMeta'
    ]);
  });

  it('declares the normalized item fields per PRD', () => {
    expect(NORMALIZED_ITEM_FIELDS).toEqual([
      'itemKey',
      'canonicalId',
      'contentHash',
      'title',
      'descriptionHtml',
      'link',
      'publishedAt',
      'mediaType',
      'imageUrl',
      'rawImages'
    ]);
  });

  it('exposes the canonical type pattern', () => {
    expect(GENERATOR_PROVIDER_TYPE_PATTERN).toEqual(/^[a-z][a-z0-9_-]*$/);
  });

  it('accepts a valid provider with all required fields and methods', () => {
    const provider = createMockProvider();
    expect(validateGeneratorProvider(provider)).toBe(provider);
  });

  it('fails when provider is not an object', () => {
    expect(() => validateGeneratorProvider(null)).toThrow(/object/);
    expect(() => validateGeneratorProvider('mock')).toThrow(/object/);
    expect(() => validateGeneratorProvider([])).toThrow(/object/);
  });

  it('fails when provider type is missing or empty', () => {
    expect(() => validateGeneratorProvider({ ...createMockProvider(), type: undefined })).toThrow(/type/);
    expect(() => validateGeneratorProvider({ ...createMockProvider(), type: '' })).toThrow(/type/);
    expect(() => validateGeneratorProvider({ ...createMockProvider(), type: 123 })).toThrow(/type/);
  });

  it('fails when provider type is not canonical lowercase', () => {
    expect(() => validateGeneratorProvider({ ...createMockProvider(), type: 'Mock' })).toThrow(/type|canonical|lowercase/);
    expect(() => validateGeneratorProvider({ ...createMockProvider(), type: '1mock' })).toThrow(/type|canonical|lowercase/);
    expect(() => validateGeneratorProvider({ ...createMockProvider(), type: 'mock space' })).toThrow(/type|canonical|lowercase/);
    expect(() => validateGeneratorProvider({ ...createMockProvider(), type: 'mock.provider' })).toThrow(/type|canonical|lowercase/);
    expect(() => validateGeneratorProvider({ ...createMockProvider(), type: ' mock ' })).toThrow(/type|canonical|lowercase/);
  });

  it('fails when provider displayName is missing or empty', () => {
    expect(() => validateGeneratorProvider({ ...createMockProvider(), displayName: undefined })).toThrow(/displayName/);
    expect(() => validateGeneratorProvider({ ...createMockProvider(), displayName: '' })).toThrow(/displayName/);
    expect(() => validateGeneratorProvider({ ...createMockProvider(), displayName: '   ' })).toThrow(/displayName/);
  });

  it('fails with explicit error for each missing required method', () => {
    for (const method of GENERATOR_PROVIDER_METHODS) {
      const provider = createMockProvider();
      delete provider[method];
      expect(() => validateGeneratorProvider(provider)).toThrow(new RegExp(method));
    }
  });

  it('fails when a required method is not a function', () => {
    const provider = createMockProvider({ fetchItems: 'not-a-function' });
    expect(() => validateGeneratorProvider(provider)).toThrow(/fetchItems/);
  });

  it('rejects class providers whose methods live on the prototype', () => {
    class MockProvider {
      type = 'mock';
      displayName = 'Mock';
      validateConfig() { return true; }
      fetchItems() { return []; }
      normalizeItem(raw) { return raw; }
      buildFeedMeta() { return { title: 'Mock', link: 'https://example.com', description: '' }; }
    }

    expect(() => validateGeneratorProvider(new MockProvider())).toThrow(/own|method|prototype/);
  });
});

describe('Normalized Generator Item', () => {
  const baseRaw = {
    itemKey: 'mock-1',
    canonicalId: 'abc123',
    contentHash: 'sha256-deadbeef',
    title: 'Hello',
    descriptionHtml: '<p>World</p>',
    link: 'https://example.com/post/1',
    publishedAt: new Date('2026-07-14T03:00:00.000Z'),
    mediaType: 'image',
    imageUrl: 'https://example.com/img.jpg',
    rawImages: ['https://example.com/img.jpg']
  };

  it('normalizes a complete item with all PRD fields', () => {
    const item = normalizeGeneratorItem(baseRaw);
    expect(item.itemKey).toBe('mock-1');
    expect(item.canonicalId).toBe('abc123');
    expect(item.contentHash).toBe('sha256-deadbeef');
    expect(item.title).toBe('Hello');
    expect(item.descriptionHtml).toBe('<p>World</p>');
    expect(item.link).toBe('https://example.com/post/1');
    expect(item.publishedAt).toEqual(new Date('2026-07-14T03:00:00.000Z'));
    expect(item.mediaType).toBe('image');
    expect(item.imageUrl).toBe('https://example.com/img.jpg');
    expect(item.rawImages).toEqual(['https://example.com/img.jpg']);
  });

  it('normalizes string publishedAt to a Date', () => {
    const item = normalizeGeneratorItem({ ...baseRaw, publishedAt: '2026-07-14T03:00:00.000Z' });
    expect(item.publishedAt).toEqual(new Date('2026-07-14T03:00:00.000Z'));
  });

  it('sets sensible defaults for optional fields', () => {
    const item = normalizeGeneratorItem({
      itemKey: 'mock-2'
    });
    expect(item.title).toBe('');
    expect(item.descriptionHtml).toBe('');
    expect(item.mediaType).toBe('');
    expect(item.imageUrl).toBeUndefined();
    expect(item.rawImages).toEqual([]);
    expect(item.publishedAt).toBeUndefined();
    expect(item.canonicalId).toBe('');
    expect(item.contentHash).toBe('');
    expect(item.link).toBe('');
  });

  it('trims itemKey and rejects empty or whitespace-only itemKey', () => {
    expect(normalizeGeneratorItem({ ...baseRaw, itemKey: '  key-1  ' }).itemKey).toBe('key-1');
    expect(() => normalizeGeneratorItem({ ...baseRaw, itemKey: undefined })).toThrow(/itemKey/);
    expect(() => normalizeGeneratorItem({ ...baseRaw, itemKey: '' })).toThrow(/itemKey/);
    expect(() => normalizeGeneratorItem({ ...baseRaw, itemKey: '   ' })).toThrow(/itemKey/);
  });

  it('allows canonicalId, link, and contentHash to be missing or empty', () => {
    const item = normalizeGeneratorItem({
      itemKey: 'mock-3',
      canonicalId: '',
      link: '',
      contentHash: ''
    });
    expect(item.canonicalId).toBe('');
    expect(item.link).toBe('');
    expect(item.contentHash).toBe('');

    const missing = normalizeGeneratorItem({ itemKey: 'mock-3' });
    expect(missing.canonicalId).toBe('');
    expect(missing.link).toBe('');
    expect(missing.contentHash).toBe('');
  });

  it('trims canonicalId, link, and contentHash when present', () => {
    const item = normalizeGeneratorItem({
      itemKey: 'mock-4',
      canonicalId: '  abc  ',
      link: '  https://example.com  ',
      contentHash: '  hash  '
    });
    expect(item.canonicalId).toBe('abc');
    expect(item.link).toBe('https://example.com');
    expect(item.contentHash).toBe('hash');
  });

  it('fails when canonicalId, link, or contentHash are not strings', () => {
    expect(() => normalizeGeneratorItem({ ...baseRaw, canonicalId: 123 })).toThrow(/canonicalId/);
    expect(() => normalizeGeneratorItem({ ...baseRaw, link: 123 })).toThrow(/link/);
    expect(() => normalizeGeneratorItem({ ...baseRaw, contentHash: 123 })).toThrow(/contentHash/);
  });

  it('keeps title and description as strings', () => {
    expect(normalizeGeneratorItem({ itemKey: 'k', title: '  Hello  ' }).title).toBe('  Hello  ');
    expect(normalizeGeneratorItem({ itemKey: 'k', descriptionHtml: '<p>  World  </p>' }).descriptionHtml).toBe('<p>  World  </p>');
    expect(() => normalizeGeneratorItem({ itemKey: 'k', title: 123 })).toThrow(/title/);
    expect(() => normalizeGeneratorItem({ itemKey: 'k', descriptionHtml: 123 })).toThrow(/descriptionHtml/);
  });

  it('requires rawImages to be an array of strings', () => {
    expect(() => normalizeGeneratorItem({ itemKey: 'k', rawImages: 'not-array' })).toThrow(/rawImages/);
    expect(() => normalizeGeneratorItem({ itemKey: 'k', rawImages: ['url', 123] })).toThrow(/rawImages/);
    expect(normalizeGeneratorItem({ itemKey: 'k', rawImages: ['', ' ', 'url'] }).rawImages).toEqual(['', ' ', 'url']);
    expect(normalizeGeneratorItem({ itemKey: 'k', rawImages: [] }).rawImages).toEqual([]);
    expect(normalizeGeneratorItem({ itemKey: 'k' }).rawImages).toEqual([]);
  });

  it('preserves undefined for missing publishedAt and rejects invalid values', () => {
    expect(normalizeGeneratorItem({ itemKey: 'k' }).publishedAt).toBeUndefined();
    expect(normalizeGeneratorItem({ itemKey: 'k', publishedAt: null }).publishedAt).toBeUndefined();
    expect(normalizeGeneratorItem({ itemKey: 'k', publishedAt: '' }).publishedAt).toBeUndefined();
    expect(() => normalizeGeneratorItem({ itemKey: 'k', publishedAt: 123 })).toThrow(/publishedAt/);
    expect(() => normalizeGeneratorItem({ itemKey: 'k', publishedAt: 'invalid' })).toThrow(/publishedAt/);
    expect(() => normalizeGeneratorItem({ itemKey: 'k', publishedAt: new Date('invalid') })).toThrow(/publishedAt/);
  });
});

describe('Generator Registry', () => {
  it('can be created with an initial set of providers', () => {
    const provider = createMockProvider();
    const registry = createGeneratorRegistry([provider]);
    expect(registry.get('mock')).toBeDefined();
    expect(registry.has('mock')).toBe(true);
    expect(registry.list().map(p => p.type)).toEqual(['mock']);
  });

  it('enforces unique provider types by canonical type', () => {
    const registry = createGeneratorRegistry([createMockProvider()]);
    expect(() => registry.register(createMockProvider())).toThrow(/unique|already|mock/i);
  });

  it('validates providers before registering', () => {
    const registry = createGeneratorRegistry();
    expect(() => registry.register({ type: 'bad', displayName: 'Bad' })).toThrow(/validateConfig|own/);
  });

  it('does not modify existing providers when a new provider is registered', () => {
    const first = createMockProvider({ type: 'first', displayName: 'First' });
    const second = createMockProvider({ type: 'second', displayName: 'Second' });
    const registry = createGeneratorRegistry([first]);
    const firstFromRegistry = registry.get('first');

    registry.register(second);

    expect(registry.get('first')).toBe(firstFromRegistry);
    expect(registry.get('first').type).toBe('first');
    expect(registry.get('first').displayName).toBe('First');
    expect(registry.get('second').type).toBe('second');
  });

  it('returns undefined for unregistered provider types', () => {
    const registry = createGeneratorRegistry();
    expect(registry.get('unknown')).toBeUndefined();
    expect(registry.has('unknown')).toBe(false);
  });

  it('get and has normalize input by trimming and lowercasing', () => {
    const registry = createGeneratorRegistry([createMockProvider({ type: 'mock', displayName: '  Mock  ' })]);
    expect(registry.get('  MOCK  ').type).toBe('mock');
    expect(registry.get('Mock').displayName).toBe('Mock');
    expect(registry.has('  Mock  ')).toBe(true);
    expect(registry.has('unknown')).toBe(false);
    expect(registry.get('mock space')).toBeUndefined();
    expect(registry.has('')).toBe(false);
    expect(registry.has(123)).toBe(false);
  });

  it('stores a frozen provider whose methods are still callable', () => {
    const registry = createGeneratorRegistry([createMockProvider({ type: 'callable' })]);
    const provider = registry.get('callable');
    expect(provider.fetchItems()).toBeInstanceOf(Promise);
    expect(provider.validateConfig()).toBe(true);
  });

  it('rejects class providers because their methods are not own properties', () => {
    class MockProvider {
      type = 'class-mock';
      displayName = 'Class Mock';
      validateConfig() { return true; }
      fetchItems() { return []; }
      normalizeItem(raw) { return raw; }
      buildFeedMeta() { return { title: 'Class', link: 'https://example.com', description: '' }; }
    }

    const registry = createGeneratorRegistry();
    expect(() => registry.register(new MockProvider())).toThrow(/own|method|prototype/);
  });
});

describe('Default Instagram Provider Registry', () => {
  it('includes the Instagram provider by default', () => {
    const registry = createGeneratorRegistry();
    expect(registry.has('instagram')).toBe(true);
    expect(registry.get('instagram')).toBeDefined();
    expect(registry.get('Instagram')).toBe(registry.get('instagram'));
    expect(registry.types()).toContain('instagram');
  });

  it('allows explicit injection to isolate tests from the default set', () => {
    const registry = createGeneratorRegistry([]);
    expect(registry.has('instagram')).toBe(false);
    expect(registry.list()).toHaveLength(0);
  });

  it('can be created with a custom provider alongside the default Instagram provider', () => {
    const mock = createMockProvider({ type: 'mock', displayName: 'Mock' });
    const registry = createGeneratorRegistry([mock]);
    expect(registry.has('mock')).toBe(true);
    expect(registry.has('instagram')).toBe(false);
    expect(registry.types()).toEqual(['mock']);
  });

  it('validates the default Instagram provider against the contract', () => {
    expect(validateGeneratorProvider(instagramProvider)).toBe(instagramProvider);
  });
});
