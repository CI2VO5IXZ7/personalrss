// Monitor Provider 契约与标准化 Event 校验/规范化

export const MONITOR_PROVIDER_METHODS = [
  'validateTarget',
  'fetchValues',
  'evaluate',
  'formatEvent'
];

export const MONITOR_EVENT_FIELDS = [
  'providerType',
  'ruleId',
  'armVersion',
  'eventKey',
  'occurredAt',
  'value',
  'source',
  'payload'
];

export const MONITOR_PROVIDER_TYPE_PATTERN = /^[a-z][a-z0-9_-]*$/;

function normalizeOptionalString(value, name) {
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value !== 'string') {
    throw new Error(`Monitor event ${name} must be a string`);
  }
  return value.trim();
}

function assertOwnString(provider, key) {
  if (!Object.hasOwn(provider, key) || typeof provider[key] !== 'string') {
    throw new Error(`Monitor provider must have a non-empty string ${key}`);
  }
}

function parseDate(value) {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (value instanceof Date) {
    if (isNaN(value.getTime())) {
      throw new Error('Monitor event occurredAt must be a valid Date or date string');
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
      throw new Error('Monitor event occurredAt must be a valid Date or date string');
    }
    return parsed;
  }

  throw new Error('Monitor event occurredAt must be a valid Date or date string');
}

export function validateMonitorProvider(provider) {
  if (!provider || typeof provider !== 'object' || Array.isArray(provider)) {
    throw new Error('Monitor provider must be an object');
  }

  assertOwnString(provider, 'type');
  if (!MONITOR_PROVIDER_TYPE_PATTERN.test(provider.type)) {
    throw new Error(`Monitor provider type must be a canonical lowercase string matching ${MONITOR_PROVIDER_TYPE_PATTERN.source}`);
  }

  assertOwnString(provider, 'displayName');
  if (provider.displayName.trim() === '') {
    throw new Error('Monitor provider must have a non-empty string displayName');
  }

  for (const method of MONITOR_PROVIDER_METHODS) {
    if (!Object.hasOwn(provider, method) || typeof provider[method] !== 'function') {
      throw new Error(`Monitor provider type "${provider.type}" is missing required own method: ${method}`);
    }
  }

  return provider;
}

export function normalizeMonitorEvent(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Monitor event must be an object');
  }

  const providerType = normalizeOptionalString(
    input.providerType ?? input.provider_type,
    'providerType'
  );
  if (providerType === '') {
    throw new Error('Monitor event missing required field: providerType');
  }

  const ruleId = typeof input.ruleId === 'number' ? input.ruleId : Number(input.ruleId);
  if (!Number.isFinite(ruleId)) {
    throw new Error('Monitor event ruleId must be a number');
  }

  const armVersion = typeof input.armVersion === 'number'
    ? input.armVersion
    : Number(input.armVersion ?? 1);
  if (!Number.isInteger(armVersion) || armVersion < 1) {
    throw new Error('Monitor event armVersion must be a positive integer');
  }

  const eventKey = normalizeOptionalString(
    input.eventKey ?? input.event_key,
    'eventKey'
  );
  if (eventKey === '') {
    throw new Error('Monitor event missing required field: eventKey');
  }

  const occurredAt = parseDate(input.occurredAt ?? input.occurred_at);
  if (occurredAt === undefined) {
    throw new Error('Monitor event missing required field: occurredAt');
  }

  if (input.value === undefined || input.value === null) {
    throw new Error('Monitor event missing required field: value');
  }
  const value = typeof input.value === 'number' ? input.value : Number(input.value);
  if (!Number.isFinite(value)) {
    throw new Error('Monitor event value must be a number');
  }

  if (input.payload !== undefined && (typeof input.payload !== 'object' || Array.isArray(input.payload))) {
    throw new Error('Monitor event payload must be a plain object');
  }

  const source = normalizeOptionalString(input.source, 'source');
  const payload = input.payload ?? {};

  return {
    providerType,
    ruleId,
    armVersion,
    eventKey,
    occurredAt,
    value,
    source,
    payload
  };
}
