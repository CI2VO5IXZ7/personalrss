// Generator Repository Implementation

function normalizeAndValidateString(val, name) {
  if (typeof val !== 'string') {
    throw new Error(`Invalid ${name}`);
  }
  const normalized = val.trim().toLowerCase();
  if (normalized === '') {
    throw new Error(`Invalid ${name}`);
  }
  return normalized;
}

function normalizeConfig(config) {
  if (config === undefined) {
    return { configVersion: 1 };
  }
  let parsed = config;
  if (typeof config === 'string') {
    try {
      parsed = JSON.parse(config);
    } catch (e) {
      throw new Error('Invalid config JSON');
    }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || Object.prototype.toString.call(parsed) !== '[object Object]') {
    throw new Error('Invalid config type');
  }
  const finalConfig = { ...parsed };
  finalConfig.configVersion = 1;
  return finalConfig;
}

export async function createInstance(db, { providerType, instanceKey, displayName, config, status }) {
  if (status !== undefined && status !== 'active' && status !== 'paused') {
    throw new Error('Invalid status');
  }
  const normalizedProvider = normalizeAndValidateString(providerType, 'provider type');
  const normalizedKey = normalizeAndValidateString(instanceKey, 'instance key');
  const finalConfig = normalizeConfig(config);
  const configJson = JSON.stringify(finalConfig);
  const finalStatus = status || 'active';

  if (typeof db.batch !== 'function') {
    throw new Error('Database batch operation is not supported');
  }

  const stmt1 = db.prepare(
    `INSERT INTO generator_instances (provider_type, instance_key, display_name, config_json, status, next_refresh_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(normalizedProvider, normalizedKey, displayName || '', configJson, finalStatus, null);

  const stmt2 = db.prepare(
    `INSERT OR IGNORE INTO generator_status (generator_id, consecutive_failures, last_item_count, last_new_count, last_duration_ms, last_alerted_failure_count)
     SELECT id, 0, 0, 0, 0, 0 FROM generator_instances WHERE provider_type = ? AND instance_key = ?`
  ).bind(normalizedProvider, normalizedKey);

  const results = await db.batch([stmt1, stmt2]);
  const id = results[0].meta.last_row_id;

  return {
    id,
    providerType: normalizedProvider,
    instanceKey: normalizedKey,
    displayName: displayName || '',
    config: finalConfig,
    status: finalStatus,
    nextRefreshAt: null
  };
}

export async function getInstance(db, id) {
  const row = await db.prepare(
    `SELECT id, provider_type as providerType, instance_key as instanceKey,
            display_name as displayName, config_json as configJson, status, next_refresh_at as nextRefreshAt,
            created_at as createdAt, updated_at as updatedAt
     FROM generator_instances WHERE id = ?`
  ).bind(id).first();

  if (!row) return null;
  return {
    id: row.id,
    providerType: row.providerType,
    instanceKey: row.instanceKey,
    displayName: row.displayName,
    config: JSON.parse(row.configJson),
    status: row.status,
    nextRefreshAt: row.nextRefreshAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

export async function getInstanceByKey(db, providerType, instanceKey) {
  const normalizedProvider = normalizeAndValidateString(providerType, 'provider type');
  const normalizedKey = normalizeAndValidateString(instanceKey, 'instance key');
  const row = await db.prepare(
    `SELECT id, provider_type as providerType, instance_key as instanceKey,
            display_name as displayName, config_json as configJson, status, next_refresh_at as nextRefreshAt,
            created_at as createdAt, updated_at as updatedAt
     FROM generator_instances WHERE provider_type = ? AND instance_key = ?`
  ).bind(normalizedProvider, normalizedKey).first();

  if (!row) return null;
  return {
    id: row.id,
    providerType: row.providerType,
    instanceKey: row.instanceKey,
    displayName: row.displayName,
    config: JSON.parse(row.configJson),
    status: row.status,
    nextRefreshAt: row.nextRefreshAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

export async function listInstances(db, { providerType, status } = {}) {
  let sql = `SELECT id, provider_type as providerType, instance_key as instanceKey,
                    display_name as displayName, config_json as configJson, status, next_refresh_at as nextRefreshAt,
                    created_at as createdAt, updated_at as updatedAt
             FROM generator_instances`;
  const conditions = [];
  const params = [];

  if (providerType !== undefined) {
    const normalizedProvider = normalizeAndValidateString(providerType, 'provider type');
    conditions.push('provider_type = ?');
    params.push(normalizedProvider);
  }
  if (status) {
    if (status !== 'active' && status !== 'paused') {
      throw new Error('Invalid status filter');
    }
    conditions.push('status = ?');
    params.push(status);
  }

  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }
  sql += ' ORDER BY created_at DESC';

  const { results } = await db.prepare(sql).bind(...params).all();
  return (results || []).map(row => ({
    id: row.id,
    providerType: row.providerType,
    instanceKey: row.instanceKey,
    displayName: row.displayName,
    config: JSON.parse(row.configJson),
    status: row.status,
    nextRefreshAt: row.nextRefreshAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }));
}

export async function updateInstance(db, id, updates = {}) {
  const { displayName, config, status, nextRefreshAt } = updates;
  const fields = [];
  const params = [];

  if (displayName !== undefined) {
    fields.push('display_name = ?');
    params.push(displayName || '');
  }
  if (config !== undefined) {
    const finalConfig = normalizeConfig(config);
    fields.push('config_json = ?');
    params.push(JSON.stringify(finalConfig));
  }
  if (status !== undefined) {
    if (status !== 'active' && status !== 'paused') {
      throw new Error('Invalid status');
    }
    fields.push('status = ?');
    params.push(status);
  }
  if (nextRefreshAt !== undefined) {
    fields.push('next_refresh_at = ?');
    params.push(nextRefreshAt instanceof Date ? nextRefreshAt.toISOString() : nextRefreshAt);
  }

  if (fields.length === 0) return false;

  fields.push("updated_at = datetime('now')");
  params.push(id);

  const sql = `UPDATE generator_instances SET ${fields.join(', ')} WHERE id = ?`;
  const result = await db.prepare(sql).bind(...params).run();
  return result.meta.changes > 0;
}

export async function deleteInstance(db, id) {
  if (typeof db.batch !== 'function') {
    throw new Error('Database batch operation is not supported');
  }
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error('Invalid ID');
  }
  const deletedCount = await deleteInstances(db, [id]);
  return deletedCount > 0;
}

export async function deleteInstances(db, ids) {
  if (typeof db.batch !== 'function') {
    throw new Error('Database batch operation is not supported');
  }
  if (!Array.isArray(ids)) {
    throw new Error('IDs must be an array');
  }
  if (ids.length === 0) return 0;

  const uniqueIds = [];
  const seen = new Set();
  for (const id of ids) {
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error('Invalid ID');
    }
    if (!seen.has(id)) {
      seen.add(id);
      uniqueIds.push(id);
    }
  }

  const placeholders = uniqueIds.map(() => '?').join(',');
  const statements = [
    db.prepare(`DELETE FROM generator_status WHERE generator_id IN (${placeholders})`).bind(...uniqueIds),
    db.prepare(`DELETE FROM generator_items WHERE generator_id IN (${placeholders})`).bind(...uniqueIds),
    db.prepare(`DELETE FROM generator_instances WHERE id IN (${placeholders})`).bind(...uniqueIds)
  ];

  const results = await db.batch(statements);
  return results[2].meta.changes;
}

export async function getDueInstances(db, nowStr) {
  const current = nowStr || new Date().toISOString();
  const { results } = await db.prepare(
    `SELECT id, provider_type as providerType, instance_key as instanceKey,
            display_name as displayName, config_json as configJson, status, next_refresh_at as nextRefreshAt,
            created_at as createdAt, updated_at as updatedAt
     FROM generator_instances
     WHERE status = 'active'
       AND (next_refresh_at IS NULL OR next_refresh_at = '' OR next_refresh_at <= ?)
     ORDER BY next_refresh_at ASC, id ASC`
  ).bind(current).all();

  return (results || []).map(row => ({
    id: row.id,
    providerType: row.providerType,
    instanceKey: row.instanceKey,
    displayName: row.displayName,
    config: JSON.parse(row.configJson),
    status: row.status,
    nextRefreshAt: row.nextRefreshAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }));
}

export async function getStatus(db, generatorId) {
  const row = await db.prepare(
    `SELECT generator_id as generatorId, last_attempt_at as lastAttemptAt, last_success_at as lastSuccessAt,
            last_result as lastResult, last_error as lastError, consecutive_failures as consecutiveFailures,
            last_item_count as lastItemCount, last_new_count as lastNewCount, last_duration_ms as lastDurationMs,
            last_alerted_failure_count as lastAlertedFailureCount, updated_at as updatedAt
     FROM generator_status WHERE generator_id = ?`
  ).bind(generatorId).first();
  return row || null;
}

export async function updateStatus(db, generatorId, updates = {}) {
  const fields = [];
  const params = [];

  const mapping = {
    lastAttemptAt: 'last_attempt_at',
    lastSuccessAt: 'last_success_at',
    lastResult: 'last_result',
    lastError: 'last_error',
    consecutiveFailures: 'consecutive_failures',
    lastItemCount: 'last_item_count',
    lastNewCount: 'last_new_count',
    lastDurationMs: 'last_duration_ms',
    lastAlertedFailureCount: 'last_alerted_failure_count'
  };

  for (const [key, col] of Object.entries(mapping)) {
    if (updates[key] !== undefined) {
      fields.push(`${col} = ?`);
      let val = updates[key];
      if (val instanceof Date) val = val.toISOString();
      params.push(val);
    }
  }

  if (fields.length === 0) return false;

  fields.push("updated_at = datetime('now')");
  params.push(generatorId);

  const sql = `UPDATE generator_status SET ${fields.join(', ')} WHERE generator_id = ?`;
  const result = await db.prepare(sql).bind(...params).run();
  return result.meta.changes > 0;
}

export async function updateRefreshState(db, id, { nextRefreshAt, statusUpdates }) {
  if (typeof db.batch !== 'function') {
    throw new Error('Database batch operation is not supported');
  }
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error('Invalid generator ID');
  }

  const allowedFields = {
    lastAttemptAt: 'last_attempt_at',
    lastSuccessAt: 'last_success_at',
    lastResult: 'last_result',
    lastError: 'last_error',
    consecutiveFailures: 'consecutive_failures',
    lastItemCount: 'last_item_count',
    lastNewCount: 'last_new_count',
    lastDurationMs: 'last_duration_ms',
    lastAlertedFailureCount: 'last_alerted_failure_count'
  };

  const statusFields = [];
  const statusParams = [];

  for (const [key, val] of Object.entries(statusUpdates || {})) {
    if (!Object.hasOwn(allowedFields, key)) {
      throw new Error(`Invalid status field: ${key}`);
    }
    const colName = allowedFields[key];
    statusFields.push(`${colName} = ?`);
    let boundVal = val;
    if (boundVal instanceof Date) {
      if (isNaN(boundVal.getTime())) {
        throw new Error(`Invalid Date object for field ${key}`);
      }
      boundVal = boundVal.toISOString();
    }

    // Value validation
    if (key === 'lastResult') {
      if (boundVal !== 'success' && boundVal !== 'failed' && boundVal !== 'empty' && boundVal !== 'error') {
        throw new Error(`Invalid lastResult value: ${boundVal}`);
      }
    }
    if (key === 'consecutiveFailures' || key === 'lastItemCount' || key === 'lastNewCount' || key === 'lastDurationMs' || key === 'lastAlertedFailureCount') {
      if (boundVal !== null && boundVal !== undefined && (!Number.isInteger(boundVal) || boundVal < 0)) {
        throw new Error(`Invalid numeric value for field ${key}: ${boundVal}`);
      }
    }
    if (key === 'lastAttemptAt' || key === 'lastSuccessAt') {
      if (boundVal !== null && boundVal !== undefined && typeof boundVal === 'string') {
        const parsed = new Date(boundVal);
        if (isNaN(parsed.getTime())) {
          throw new Error(`Invalid date string for field ${key}: ${boundVal}`);
        }
      }
    }
    statusParams.push(boundVal);
  }

  statusFields.push("updated_at = datetime('now')");
  statusParams.push(id);
  const statusSql = `UPDATE generator_status SET ${statusFields.join(', ')} WHERE generator_id = ?`;

  let nextRefreshAtStr = null;
  if (nextRefreshAt instanceof Date) {
    if (isNaN(nextRefreshAt.getTime())) {
      throw new Error('Invalid nextRefreshAt Date');
    }
    nextRefreshAtStr = nextRefreshAt.toISOString();
  } else if (typeof nextRefreshAt === 'string') {
    const parsed = new Date(nextRefreshAt);
    if (isNaN(parsed.getTime())) {
      throw new Error('Invalid nextRefreshAt date string');
    }
    nextRefreshAtStr = nextRefreshAt;
  } else if (nextRefreshAt !== null && nextRefreshAt !== undefined) {
    throw new Error('Invalid nextRefreshAt value type');
  }

  const statements = [
    db.prepare(
      `UPDATE generator_instances SET next_refresh_at = ?, updated_at = datetime('now') WHERE id = ?`
    ).bind(nextRefreshAtStr, id),
    db.prepare(statusSql).bind(...statusParams)
  ];

  const results = await db.batch(statements);
  return results[0].meta.changes > 0;
}


export async function saveItem(db, generatorId, item) {
  if (!Number.isInteger(generatorId) || generatorId <= 0) {
    throw new Error('Invalid generator ID');
  }
  if (!item || !item.itemKey || typeof item.itemKey !== 'string' || item.itemKey.trim() === '') {
    throw new Error('Invalid item key');
  }
  if (!Array.isArray(item.rawImages)) {
    throw new Error('Invalid rawImages');
  }
  if (item.publishedAt !== undefined && item.publishedAt !== null && item.publishedAt !== '') {
    const d = new Date(item.publishedAt);
    if (isNaN(d.getTime())) {
      throw new Error('Invalid publishedAt');
    }
  }

  const rawImagesJson = JSON.stringify(item.rawImages || []);
  let publishedAtStr = '';
  if (item.publishedAt) {
    publishedAtStr = item.publishedAt instanceof Date ? item.publishedAt.toISOString() : String(item.publishedAt);
  }

  const result = await db.prepare(
    `INSERT OR IGNORE INTO generator_items (
      generator_id, item_key, canonical_id, content_hash, title,
      description_html, link, published_at, media_type, image_url,
      raw_images_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    generatorId,
    item.itemKey,
    item.canonicalId || '',
    item.contentHash || '',
    item.title || '',
    item.descriptionHtml || '',
    item.link || '',
    publishedAtStr,
    item.mediaType || '',
    item.imageUrl || '',
    rawImagesJson
  ).run();

  return result.meta.changes > 0;
}

export async function saveItems(db, generatorId, items, retentionLimit = 100) {
  if (!Number.isInteger(generatorId) || generatorId <= 0) {
    throw new Error('Invalid generator ID');
  }
  if (!Number.isInteger(retentionLimit) || retentionLimit <= 0) {
    throw new Error('Invalid retention limit');
  }
  if (!Array.isArray(items)) {
    throw new Error('Items must be an array');
  }
  if (items.length === 0) return 0;

  for (const item of items) {
    if (!item || !item.itemKey || typeof item.itemKey !== 'string' || item.itemKey.trim() === '') {
      throw new Error('Invalid item key');
    }
    if (!Array.isArray(item.rawImages)) {
      throw new Error('Invalid rawImages');
    }
    if (item.publishedAt !== undefined && item.publishedAt !== null && item.publishedAt !== '') {
      const d = new Date(item.publishedAt);
      if (isNaN(d.getTime())) {
        throw new Error('Invalid publishedAt');
      }
    }
  }

  if (typeof db.batch !== 'function') {
    throw new Error('Database batch operation is not supported');
  }

  const statements = [];
  for (const item of items) {
    const rawImagesJson = JSON.stringify(item.rawImages || []);
    let publishedAtStr = '';
    if (item.publishedAt) {
      publishedAtStr = item.publishedAt instanceof Date ? item.publishedAt.toISOString() : String(item.publishedAt);
    }

    statements.push(
      db.prepare(
        `INSERT OR IGNORE INTO generator_items (
          generator_id, item_key, canonical_id, content_hash, title,
          description_html, link, published_at, media_type, image_url,
          raw_images_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        generatorId,
        item.itemKey,
        item.canonicalId || '',
        item.contentHash || '',
        item.title || '',
        item.descriptionHtml || '',
        item.link || '',
        publishedAtStr,
        item.mediaType || '',
        item.imageUrl || '',
        rawImagesJson
      )
    );
  }

  statements.push(
    db.prepare(
      `DELETE FROM generator_items
       WHERE generator_id = ?
         AND id NOT IN (
           SELECT id FROM generator_items
           WHERE generator_id = ?
           ORDER BY published_at DESC, fetched_at DESC, id DESC
           LIMIT ?
         )`
    ).bind(generatorId, generatorId, retentionLimit)
  );

  const results = await db.batch(statements);

  let insertedCount = 0;
  for (let i = 0; i < items.length; i++) {
    insertedCount += results[i].meta?.changes || 0;
  }

  return insertedCount;
}

export async function getItems(db, generatorId, limit = 50) {
  const { results } = await db.prepare(
    `SELECT id, generator_id as generatorId, item_key as itemKey, canonical_id as canonicalId,
            content_hash as contentHash, title, description_html as descriptionHtml, link,
            published_at as publishedAt, media_type as mediaType, image_url as imageUrl,
            raw_images_json as rawImagesJson, fetched_at as fetchedAt
     FROM generator_items
     WHERE generator_id = ?
     ORDER BY published_at DESC, fetched_at DESC, id DESC
     LIMIT ?`
  ).bind(generatorId, limit).all();

  return (results || []).map(row => ({
    id: row.id,
    generatorId: row.generatorId,
    itemKey: row.itemKey,
    canonicalId: row.canonicalId,
    contentHash: row.contentHash,
    title: row.title,
    descriptionHtml: row.descriptionHtml,
    link: row.link,
    publishedAt: row.publishedAt,
    mediaType: row.mediaType,
    imageUrl: row.imageUrl,
    rawImages: JSON.parse(row.rawImagesJson || '[]'),
    fetchedAt: row.fetchedAt
  }));
}
