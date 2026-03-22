// D1 Database operations for Social RSS Bridge

import { stripHtml } from './html.js';

function safeParseJson(value, fallback) {
  try {
    return JSON.parse(value || '');
  } catch {
    return fallback;
  }
}

function normalizeWhitespace(value = '') {
  return String(value).replace(/\s+/g, ' ').trim();
}

function isCaseInsensitivePlatform(platform) {
  return platform === 'instagram' || platform === 'ig';
}

function normalizeUserId(platform, userId = '') {
  const normalized = String(userId).trim();
  return isCaseInsensitivePlatform(platform) ? normalized.toLowerCase() : normalized;
}

function hashString(input) {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function toSecondBucket(date) {
  const time = new Date(date || '').getTime();
  if (Number.isNaN(time)) return '';
  return String(Math.floor(time / 1000));
}

function extractAssetSignature(url) {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    return parsed.pathname.split('/').filter(Boolean).slice(-2).join('/');
  } catch {
    return '';
  }
}

function inferMediaType(post) {
  if (post.media_type) return post.media_type;
  if ((post.description || '').includes('<video')) return 'video';
  return (post.raw_images || []).length > 0 || post.image ? 'image' : 'unknown';
}

export function buildContentHash(platform, userId, post) {
  const titleSeed = normalizeWhitespace(post.title || stripHtml(post.description || '').split('\n')[0] || '').toLowerCase();
  const dateSeed = toSecondBucket(post.date);
  const assetSeed = extractAssetSignature(post.image || post.raw_images?.[0] || '');

  if (platform === 'xhs') {
    return `xhs:${hashString(`${userId}|${titleSeed}|${dateSeed}|${assetSeed}`)}`;
  }

  return `${platform}:${hashString(`${userId}|${post.link || post.id || ''}|${dateSeed}`)}`;
}

function enrichPostForStorage(platform, userId, post) {
  const rawImages = Array.isArray(post.raw_images) ? post.raw_images : [];
  const canonicalId = post.canonical_id || post.id || post.post_id || '';
  const mediaType = inferMediaType({ ...post, raw_images: rawImages });

  return {
    ...post,
    raw_images: rawImages,
    canonical_id: canonicalId,
    media_type: mediaType,
    content_hash: post.content_hash || buildContentHash(platform, userId, {
      ...post,
      raw_images: rawImages,
      media_type: mediaType
    })
  };
}

function rowScore(row) {
  const rawImages = safeParseJson(row.raw_images, []);
  let score = 0;

  if ((row.media_type || '').includes('video') || (row.description || '').includes('<video')) score += 1000;
  score += rawImages.length * 10;
  score += (row.description || '').length;
  if (row.image) score += 5;
  if (row.canonical_id && row.canonical_id === row.post_id) score += 20;

  return score;
}

// ─── Accounts ────────────────────────────────────────────────────────────────

export async function getAccounts(db) {
  try {
    const { results } = await db.prepare('SELECT * FROM accounts ORDER BY created_at DESC').all();
    return results || [];
  } catch { return []; }
}

export async function getAccountsByPlatform(db, platform) {
  try {
    const { results } = await db.prepare(
      'SELECT * FROM accounts WHERE platform = ? ORDER BY created_at DESC'
    ).bind(platform).all();

    if (!isCaseInsensitivePlatform(platform)) {
      return results || [];
    }

    const deduped = [];
    const seen = new Set();
    for (const row of results || []) {
      const key = normalizeUserId(platform, row.user_id);
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(row);
    }
    return deduped;
  } catch { return []; }
}

export async function getAccount(db, platform, userId) {
  try {
    const normalizedUserId = normalizeUserId(platform, userId);
    if (isCaseInsensitivePlatform(platform)) {
      const row = await db.prepare(
        `SELECT * FROM accounts
         WHERE platform = ? AND LOWER(user_id) = ?
         ORDER BY CASE WHEN user_id = ? THEN 0 ELSE 1 END, created_at DESC
         LIMIT 1`
      ).bind(platform, normalizedUserId, normalizedUserId).first();

      return row || null;
    }

    return await db.prepare('SELECT * FROM accounts WHERE platform = ? AND user_id = ?')
      .bind(platform, normalizedUserId).first();
  } catch { return null; }
}

export async function addAccount(db, platform, userId, displayName = '') {
  try {
    const normalizedUserId = normalizeUserId(platform, userId);
    const storedUserId = String(userId).trim();
    if (isCaseInsensitivePlatform(platform)) {
      const existing = await getAccount(db, platform, normalizedUserId);
      if (existing) return false;
    }

    const result = await db.prepare('INSERT OR IGNORE INTO accounts (platform, user_id, display_name) VALUES (?, ?, ?)')
      .bind(platform, isCaseInsensitivePlatform(platform) ? storedUserId : normalizedUserId, displayName).run();
    return result.meta.changes > 0;
  } catch (e) {
    console.error('[db] addAccount error:', e.message);
    return false;
  }
}

export async function removeAccount(db, platform, userId) {
  try {
    const cachePlatform = platform === 'instagram' ? 'ig' : 'xhs';
    const normalizedUserId = normalizeUserId(platform, userId);
    let result;

    if (isCaseInsensitivePlatform(platform)) {
      result = await db.prepare('DELETE FROM accounts WHERE platform = ? AND LOWER(user_id) = ?')
        .bind(platform, normalizedUserId).run();
    } else {
      result = await db.prepare('DELETE FROM accounts WHERE platform = ? AND user_id = ?')
        .bind(platform, normalizedUserId).run();
    }

    await clearCachedPosts(db, cachePlatform, userId);
    if (isCaseInsensitivePlatform(cachePlatform)) {
      await db.prepare('DELETE FROM crawl_status WHERE platform = ? AND LOWER(user_id) = ?')
        .bind(cachePlatform, normalizeUserId(cachePlatform, userId)).run().catch(() => {});
    } else {
      await db.prepare('DELETE FROM crawl_status WHERE platform = ? AND user_id = ?')
        .bind(cachePlatform, normalizeUserId(cachePlatform, userId)).run().catch(() => {});
    }
    return result.meta.changes > 0;
  } catch (e) {
    console.error('[db] removeAccount error:', e.message);
    return false;
  }
}

// ─── Posts Cache ──────────────────────────────────────────────────────────────

export async function getCachedPostIds(db, platform, userId) {
  try {
    const normalizedUserId = normalizeUserId(platform, userId);
    const stmt = isCaseInsensitivePlatform(platform)
      ? db.prepare('SELECT post_id, canonical_id, content_hash FROM posts_cache WHERE platform = ? AND LOWER(user_id) = ?')
      : db.prepare('SELECT post_id, canonical_id, content_hash FROM posts_cache WHERE platform = ? AND user_id = ?');

    const { results } = await stmt.bind(platform, normalizedUserId).all();

    const ids = new Set();
    for (const row of results || []) {
      if (row.post_id) ids.add(row.post_id);
      if (row.canonical_id) ids.add(row.canonical_id);
      if (row.content_hash) ids.add(row.content_hash);
    }
    return ids;
  } catch { return new Set(); }
}

export async function getCachedPosts(db, platform, userId, limit = 50) {
  try {
    const normalizedUserId = normalizeUserId(platform, userId);
    const stmt = isCaseInsensitivePlatform(platform)
      ? db.prepare('SELECT * FROM posts_cache WHERE platform = ? AND LOWER(user_id) = ? ORDER BY date DESC, fetched_at DESC, id DESC LIMIT ?')
      : db.prepare('SELECT * FROM posts_cache WHERE platform = ? AND user_id = ? ORDER BY date DESC, fetched_at DESC, id DESC LIMIT ?');

    const { results } = await stmt.bind(platform, normalizedUserId, limit).all();
    return results || [];
  } catch { return []; }
}

export async function clearCachedPosts(db, platform, userId) {
  try {
    const normalizedUserId = normalizeUserId(platform, userId);
    const stmt = isCaseInsensitivePlatform(platform)
      ? db.prepare('DELETE FROM posts_cache WHERE platform = ? AND LOWER(user_id) = ?')
      : db.prepare('DELETE FROM posts_cache WHERE platform = ? AND user_id = ?');

    const result = await stmt.bind(platform, normalizedUserId).run();
    return result.meta.changes || 0;
  } catch (e) {
    console.error('[db] clearCachedPosts error:', e.message);
    return 0;
  }
}

export async function clearCachedPostsByPlatform(db, platform) {
  try {
    const result = await db.prepare('DELETE FROM posts_cache WHERE platform = ?')
      .bind(platform).run();
    return result.meta.changes || 0;
  } catch (e) {
    console.error('[db] clearCachedPostsByPlatform error:', e.message);
    return 0;
  }
}

export async function dedupeCachedPosts(db, platform, userId) {
  try {
    const normalizedUserId = normalizeUserId(platform, userId);
    const stmt = isCaseInsensitivePlatform(platform)
      ? db.prepare('SELECT * FROM posts_cache WHERE platform = ? AND LOWER(user_id) = ? ORDER BY fetched_at DESC, id DESC')
      : db.prepare('SELECT * FROM posts_cache WHERE platform = ? AND user_id = ? ORDER BY fetched_at DESC, id DESC');

    const { results } = await stmt.bind(platform, normalizedUserId).all();

    const rows = results || [];
    const keepByKey = new Map();
    const deleteIds = [];
    const updateBatch = [];

    for (const row of rows) {
      const post = rowToPost(row);
      const enriched = enrichPostForStorage(platform, userId, post);
      const key = platform === 'xhs'
        ? enriched.content_hash
        : (enriched.canonical_id || row.post_id);

      if (!key) continue;

      if (row.canonical_id !== enriched.canonical_id || row.content_hash !== enriched.content_hash || row.media_type !== enriched.media_type) {
        updateBatch.push(
          db.prepare(
            'UPDATE posts_cache SET canonical_id = ?, content_hash = ?, media_type = ? WHERE id = ?'
          ).bind(enriched.canonical_id, enriched.content_hash, enriched.media_type, row.id)
        );
      }

      const current = { row, score: rowScore({ ...row, media_type: enriched.media_type }) };
      const existing = keepByKey.get(key);

      if (!existing) {
        keepByKey.set(key, current);
        continue;
      }

      if (current.score > existing.score) {
        deleteIds.push(existing.row.id);
        keepByKey.set(key, current);
      } else {
        deleteIds.push(row.id);
      }
    }

    if (updateBatch.length) await db.batch(updateBatch);
    if (deleteIds.length) {
      await db.batch(deleteIds.map(id => db.prepare('DELETE FROM posts_cache WHERE id = ?').bind(id)));
    }

    return deleteIds.length;
  } catch (e) {
    console.error('[db] dedupeCachedPosts error:', e.message);
    return 0;
  }
}

export async function cleanupCachedPosts(db, platform, userId, keepLimit = 100) {
  if (!keepLimit || keepLimit < 1) return 0;

  try {
    const normalizedUserId = normalizeUserId(platform, userId);
    const stmt = isCaseInsensitivePlatform(platform)
      ? db.prepare(
        `SELECT id FROM posts_cache
         WHERE platform = ? AND LOWER(user_id) = ?
         ORDER BY date DESC, fetched_at DESC, id DESC
         LIMIT -1 OFFSET ?`
      )
      : db.prepare(
        `SELECT id FROM posts_cache
         WHERE platform = ? AND user_id = ?
         ORDER BY date DESC, fetched_at DESC, id DESC
         LIMIT -1 OFFSET ?`
      );

    const { results } = await stmt.bind(platform, normalizedUserId, keepLimit).all();

    const staleRows = results || [];
    if (!staleRows.length) return 0;

    await db.batch(staleRows.map(row => db.prepare('DELETE FROM posts_cache WHERE id = ?').bind(row.id)));
    return staleRows.length;
  } catch (e) {
    console.error('[db] cleanupCachedPosts error:', e.message);
    return 0;
  }
}

export async function upsertPosts(db, platform, userId, posts, options = {}) {
  const keepLimit = Number.isFinite(options.keepLimit) ? options.keepLimit : 100;
  const normalizedUserId = normalizeUserId(platform, userId);
  if (!posts || posts.length === 0) {
    const dedupedCount = await dedupeCachedPosts(db, platform, normalizedUserId);
    const trimmedCount = await cleanupCachedPosts(db, platform, normalizedUserId, keepLimit);
    return { total: 0, newCount: 0, dedupedCount, trimmedCount };
  }

  try {
    const existingIds = await getCachedPostIds(db, platform, normalizedUserId);
    const preparedPosts = posts.map(post => enrichPostForStorage(platform, normalizedUserId, post));
    const newCount = preparedPosts.filter(p => !existingIds.has(p.id || p.post_id || '')).length;

    const stmt = db.prepare(
      `INSERT OR REPLACE INTO posts_cache (
         platform, user_id, post_id, canonical_id, content_hash, media_type,
         title, description, link, image, date, raw_images, fetched_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
    );

    const batch = preparedPosts.map(p => stmt.bind(
      platform,
      normalizedUserId,
      p.id || p.post_id || '',
      p.canonical_id || '',
      p.content_hash || '',
      p.media_type || '',
      p.title || '',
      p.description || '',
      p.link || '',
      p.image || '',
      p.date || '',
      JSON.stringify(p.raw_images || [])
    ));

    await db.batch(batch);

    const dedupedCount = await dedupeCachedPosts(db, platform, normalizedUserId);
    const trimmedCount = await cleanupCachedPosts(db, platform, normalizedUserId, keepLimit);

    return { total: preparedPosts.length, newCount, dedupedCount, trimmedCount };
  } catch (e) {
    console.error('[db] upsertPosts error:', e.message);
    return { total: posts.length, newCount: 0, dedupedCount: 0, trimmedCount: 0 };
  }
}

export async function getLastFetchTime(db, platform, userId) {
  try {
    const normalizedUserId = normalizeUserId(platform, userId);
    const stmt = isCaseInsensitivePlatform(platform)
      ? db.prepare('SELECT fetched_at FROM posts_cache WHERE platform = ? AND LOWER(user_id) = ? ORDER BY fetched_at DESC LIMIT 1')
      : db.prepare('SELECT fetched_at FROM posts_cache WHERE platform = ? AND user_id = ? ORDER BY fetched_at DESC LIMIT 1');

    const row = await stmt.bind(platform, normalizedUserId).first();
    return row?.fetched_at || null;
  } catch { return null; }
}

export async function isCacheStale(db, platform, userId, ttlMinutes) {
  const lastFetch = await getLastFetchTime(db, platform, userId);
  if (!lastFetch) return true;
  const age = Date.now() - new Date(lastFetch + 'Z').getTime();
  return age > ttlMinutes * 60 * 1000;
}

// ─── Crawl Status ─────────────────────────────────────────────────────────────

export async function getCrawlStatus(db, platform, userId) {
  try {
    const normalizedUserId = normalizeUserId(platform, userId);
    const stmt = isCaseInsensitivePlatform(platform)
      ? db.prepare('SELECT * FROM crawl_status WHERE platform = ? AND LOWER(user_id) = ?')
      : db.prepare('SELECT * FROM crawl_status WHERE platform = ? AND user_id = ?');

    return await stmt.bind(platform, normalizedUserId).first();
  } catch { return null; }
}

export async function getCrawlStatuses(db) {
  try {
    const { results } = await db.prepare(
      'SELECT * FROM crawl_status ORDER BY platform, user_id'
    ).all();
    return results || [];
  } catch { return []; }
}

export async function markCrawlSuccess(db, platform, userId, status) {
  try {
    const normalizedUserId = normalizeUserId(platform, userId);
    await db.prepare(
      `INSERT INTO crawl_status (
         platform, user_id, last_attempt_at, last_success_at, last_result,
         last_error, last_error_at, consecutive_failures, last_post_count,
         last_new_count, last_empty_reason, last_duration_ms,
         last_alerted_failure_count, updated_at
       )
       VALUES (?, ?, datetime('now'), datetime('now'), ?, '', NULL, 0, ?, ?, ?, ?, 0, datetime('now'))
       ON CONFLICT(platform, user_id) DO UPDATE SET
         last_attempt_at = datetime('now'),
         last_success_at = datetime('now'),
         last_result = excluded.last_result,
         last_error = '',
         last_error_at = NULL,
         consecutive_failures = 0,
         last_post_count = excluded.last_post_count,
         last_new_count = excluded.last_new_count,
         last_empty_reason = excluded.last_empty_reason,
         last_duration_ms = excluded.last_duration_ms,
         last_alerted_failure_count = 0,
         updated_at = datetime('now')`
    ).bind(
      platform,
      normalizedUserId,
      status.result || 'updated',
      status.postCount || 0,
      status.newCount || 0,
      status.emptyReason || '',
      status.durationMs || 0
    ).run();
  } catch (e) {
    console.error('[db] markCrawlSuccess error:', e.message);
  }
}

export async function markCrawlFailure(db, platform, userId, status) {
  try {
    const normalizedUserId = normalizeUserId(platform, userId);
    await db.prepare(
      `INSERT INTO crawl_status (
         platform, user_id, last_attempt_at, last_success_at, last_result,
         last_error, last_error_at, consecutive_failures, last_post_count,
         last_new_count, last_empty_reason, last_duration_ms,
         last_alerted_failure_count, updated_at
       )
       VALUES (?, ?, datetime('now'), NULL, 'error', ?, datetime('now'), 1, 0, 0, '', ?, 0, datetime('now'))
       ON CONFLICT(platform, user_id) DO UPDATE SET
         last_attempt_at = datetime('now'),
         last_result = 'error',
         last_error = excluded.last_error,
         last_error_at = datetime('now'),
         consecutive_failures = crawl_status.consecutive_failures + 1,
         last_duration_ms = excluded.last_duration_ms,
         updated_at = datetime('now')`
    ).bind(
      platform,
      normalizedUserId,
      status.error || 'Unknown error',
      status.durationMs || 0
    ).run();
  } catch (e) {
    console.error('[db] markCrawlFailure error:', e.message);
  }
}

export async function setFailureAlertCount(db, platform, userId, count) {
  try {
    const normalizedUserId = normalizeUserId(platform, userId);
    await db.prepare(
      `INSERT INTO crawl_status (
         platform, user_id, last_attempt_at, last_success_at, last_result,
         last_error, last_error_at, consecutive_failures, last_post_count,
         last_new_count, last_empty_reason, last_duration_ms,
         last_alerted_failure_count, updated_at
       )
       VALUES (?, ?, NULL, NULL, '', '', NULL, 0, 0, 0, '', 0, ?, datetime('now'))
       ON CONFLICT(platform, user_id) DO UPDATE SET
         last_alerted_failure_count = excluded.last_alerted_failure_count,
         updated_at = datetime('now')`
    ).bind(platform, normalizedUserId, count).run();
  } catch (e) {
    console.error('[db] setFailureAlertCount error:', e.message);
  }
}

// ─── Settings ────────────────────────────────────────────────────────────────

export async function getSetting(db, key) {
  try {
    const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
    return row?.value || null;
  } catch { return null; }
}

export async function setSetting(db, key, value) {
  try {
    await db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind(key, value).run();
  } catch (e) { console.error('[db] setSetting error:', e.message); }
}

// ─── API Usage Tracking ─────────────────────────────────────────────────────

export async function trackApiCall(db, endpoint) {
  try {
    // 使用北京时间日期
    const now = new Date(Date.now() + 8 * 3600 * 1000);
    const date = now.toISOString().slice(0, 10);
    await db.prepare(
      `INSERT INTO api_usage (date, endpoint, calls) VALUES (?, ?, 1)
       ON CONFLICT(date, endpoint) DO UPDATE SET calls = calls + 1`
    ).bind(date, endpoint).run();
  } catch (e) {
    console.error('[db] trackApiCall error:', e.message);
  }
}

export async function getApiUsage(db, days = 7) {
  try {
    const now = new Date(Date.now() + 8 * 3600 * 1000);
    const since = new Date(now.getTime() - days * 86400000).toISOString().slice(0, 10);
    const { results } = await db.prepare(
      `SELECT date, endpoint, calls FROM api_usage WHERE date >= ? ORDER BY date DESC, endpoint`
    ).bind(since).all();
    return results || [];
  } catch { return []; }
}

export async function getApiUsageSummary(db, days = 7) {
  try {
    const now = new Date(Date.now() + 8 * 3600 * 1000);
    const since = new Date(now.getTime() - days * 86400000).toISOString().slice(0, 10);
    const { results } = await db.prepare(
      `SELECT date, SUM(calls) as total_calls FROM api_usage WHERE date >= ? GROUP BY date ORDER BY date DESC`
    ).bind(since).all();
    return results || [];
  } catch { return []; }
}

// ─── Helper: convert cached rows to RSS post objects ─────────────────────────

export function rowToPost(row) {
  return {
    id: row.post_id,
    canonical_id: row.canonical_id || row.post_id,
    content_hash: row.content_hash || '',
    media_type: row.media_type || '',
    title: row.title,
    description: row.description,
    link: row.link,
    image: row.image,
    date: row.date,
    raw_images: safeParseJson(row.raw_images, [])
  };
}
