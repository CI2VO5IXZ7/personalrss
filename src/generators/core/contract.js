// Generator Provider 契约与标准化 Item 校验/规范化

export const GENERATOR_PROVIDER_METHODS = [
  'validateConfig',
  'fetchItems',
  'normalizeItem',
  'buildFeedMeta'
];

export const NORMALIZED_ITEM_FIELDS = [
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
];

export const GENERATOR_PROVIDER_TYPE_PATTERN = /^[a-z][a-z0-9_-]*$/;

function assertOwnString(provider, key) {
  if (!Object.hasOwn(provider, key) || typeof provider[key] !== 'string') {
    throw new Error(`Generator provider must have a non-empty string ${key}`);
  }
}

export function validateGeneratorProvider(provider) {
  if (!provider || typeof provider !== 'object' || Array.isArray(provider)) {
    throw new Error('Generator provider must be an object');
  }

  assertOwnString(provider, 'type');
  if (!GENERATOR_PROVIDER_TYPE_PATTERN.test(provider.type)) {
    throw new Error(`Generator provider type must be a canonical lowercase string matching ${GENERATOR_PROVIDER_TYPE_PATTERN.source}`);
  }

  assertOwnString(provider, 'displayName');
  if (provider.displayName.trim() === '') {
    throw new Error('Generator provider must have a non-empty string displayName');
  }

  for (const method of GENERATOR_PROVIDER_METHODS) {
    if (!Object.hasOwn(provider, method) || typeof provider[method] !== 'function') {
      throw new Error(`Generator provider type "${provider.type}" is missing required own method: ${method}`);
    }
  }

  return provider;
}

function parsePublishedAt(value) {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (value instanceof Date) {
    if (isNaN(value.getTime())) {
      throw new Error('Generator item publishedAt must be a valid Date or date string');
    }
    return value;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') {
      return undefined;
    }
    const parsed = new Date(trimmed);
    if (isNaN(parsed.getTime())) {
      throw new Error('Generator item publishedAt must be a valid Date or date string');
    }
    return parsed;
  }

  throw new Error('Generator item publishedAt must be a valid Date or date string');
}

function normalizeOptionalString(value, name) {
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value !== 'string') {
    throw new Error(`Generator item ${name} must be a string`);
  }
  return value.trim();
}

function normalizeOptionalStringOrUndefined(value, name) {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(`Generator item ${name} must be a string`);
  }
  return value;
}

export function normalizeGeneratorItem(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Generator item must be an object');
  }

  const itemKey = normalizeOptionalString(input.itemKey, 'itemKey');
  if (itemKey === '') {
    throw new Error('Generator item missing required field: itemKey');
  }

  const canonicalId = normalizeOptionalString(input.canonicalId, 'canonicalId');
  const contentHash = normalizeOptionalString(input.contentHash, 'contentHash');
  const link = normalizeOptionalString(input.link, 'link');

  if (input.title !== undefined && input.title !== null && typeof input.title !== 'string') {
    throw new Error('Generator item title must be a string');
  }

  if (input.descriptionHtml !== undefined && input.descriptionHtml !== null && typeof input.descriptionHtml !== 'string') {
    throw new Error('Generator item descriptionHtml must be a string');
  }

  if (input.mediaType !== undefined && input.mediaType !== null && typeof input.mediaType !== 'string') {
    throw new Error('Generator item mediaType must be a string');
  }

  const imageUrl = normalizeOptionalStringOrUndefined(input.imageUrl, 'imageUrl');

  if (input.rawImages !== undefined && input.rawImages !== null) {
    if (!Array.isArray(input.rawImages)) {
      throw new Error('Generator item rawImages must be an array of strings');
    }
    for (const rawImage of input.rawImages) {
      if (typeof rawImage !== 'string') {
        throw new Error('Generator item rawImages must be an array of strings');
      }
    }
  }

  const publishedAt = parsePublishedAt(input.publishedAt);

  return {
    itemKey,
    canonicalId,
    contentHash,
    title: input.title ?? '',
    descriptionHtml: input.descriptionHtml ?? '',
    link,
    publishedAt,
    mediaType: input.mediaType ?? '',
    imageUrl,
    rawImages: input.rawImages ?? []
  };
}
