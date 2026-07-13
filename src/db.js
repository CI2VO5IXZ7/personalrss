// D1 Database operations for Social RSS Bridge

function safeParseJson(value, fallback) {
  try {
    return JSON.parse(value || '');
  } catch {
    return fallback;
  }
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

function inferMediaType(post) {
  if (post.media_type) return post.media_type;
  if ((post.description || '').includes('<video')) return 'video';
  return (post.raw_images || []).length > 0 || post.image ? 'image' : 'unknown';
}

export function buildContentHash(platform, userId, post) {
  const dateSeed = toSecondBucket(post.date);
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
    const cachePlatform = 'ig';
    const normalizedUserId = normalizeUserId(platform, userId);

    const result = await db.prepare('DELETE FROM accounts WHERE platform = ? AND LOWER(user_id) = ?')
      .bind(platform, normalizedUserId).run();

    await clearCachedPosts(db, cachePlatform, userId);
    await db.prepare('DELETE FROM crawl_status WHERE platform = ? AND LOWER(user_id) = ?')
      .bind(cachePlatform, normalizeUserId(cachePlatform, userId)).run().catch(() => {});

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
      const key = enriched.canonical_id || row.post_id;

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

// ─── RSS Subscriptions ────────────────────────────────────────────────────────

export async function addRssSubscription(db, feedUrl, feedUrlRedacted, siteUrl, title, intervalMinutes = 10) {
  try {
    const result = await db.prepare(
      `INSERT OR IGNORE INTO rss_subscriptions (feed_url, feed_url_redacted, site_url, title, interval_minutes, next_check_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`
    ).bind(feedUrl, feedUrlRedacted, siteUrl, title, intervalMinutes).run();
    return result.meta.changes > 0;
  } catch (e) {
    console.error('[db] addRssSubscription error:', e.message);
    return false;
  }
}

export async function getRssSubscriptions(db) {
  try {
    const { results } = await db.prepare('SELECT * FROM rss_subscriptions ORDER BY created_at DESC').all();
    return results || [];
  } catch (e) {
    console.error('[db] getRssSubscriptions error:', e.message);
    return [];
  }
}

export async function getRssSubscription(db, id) {
  try {
    return await db.prepare('SELECT * FROM rss_subscriptions WHERE id = ?').bind(id).first();
  } catch (e) {
    console.error('[db] getRssSubscription error:', e.message);
    return null;
  }
}

export async function getRssSubscriptionByUrl(db, feedUrl) {
  try {
    return await db.prepare('SELECT * FROM rss_subscriptions WHERE feed_url = ?').bind(feedUrl).first();
  } catch (e) {
    console.error('[db] getRssSubscriptionByUrl error:', e.message);
    return null;
  }
}

export async function removeRssSubscription(db, id) {
  try {
    await db.prepare('DELETE FROM rss_entries WHERE subscription_id = ?').bind(id).run();
    const result = await db.prepare('DELETE FROM rss_subscriptions WHERE id = ?').bind(id).run();
    return result.meta.changes > 0;
  } catch (e) {
    console.error('[db] removeRssSubscription error:', e.message);
    return false;
  }
}

export async function pauseRssSubscription(db, id) {
  try {
    const result = await db.prepare("UPDATE rss_subscriptions SET status = 'paused', updated_at = datetime('now') WHERE id = ?")
      .bind(id).run();
    return result.meta.changes > 0;
  } catch (e) {
    console.error('[db] pauseRssSubscription error:', e.message);
    return false;
  }
}

export async function resumeRssSubscription(db, id) {
  try {
    const result = await db.prepare("UPDATE rss_subscriptions SET status = 'active', next_check_at = datetime('now'), updated_at = datetime('now') WHERE id = ?")
      .bind(id).run();
    return result.meta.changes > 0;
  } catch (e) {
    console.error('[db] resumeRssSubscription error:', e.message);
    return false;
  }
}

export async function updateRssSubscriptionInterval(db, id, intervalMinutes) {
  try {
    const result = await db.prepare("UPDATE rss_subscriptions SET interval_minutes = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(intervalMinutes, id).run();
    return result.meta.changes > 0;
  } catch (e) {
    console.error('[db] updateRssSubscriptionInterval error:', e.message);
    return false;
  }
}

export async function updateRssSubscriptionCheck(db, id, fields = {}) {
  try {
    const query = `
      UPDATE rss_subscriptions
      SET status = ?,
          etag = ?,
          last_modified = ?,
          last_checked_at = ?,
          last_success_at = ?,
          consecutive_failures = ?,
          last_error = ?,
          next_check_at = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `;
    const result = await db.prepare(query).bind(
      fields.status || 'active',
      fields.etag || '',
      fields.lastModified || '',
      fields.lastCheckedAt || '',
      fields.lastSuccessAt || '',
      fields.consecutiveFailures || 0,
      fields.lastError || '',
      fields.nextCheckAt || '',
      id
    ).run();
    return result.meta.changes > 0;
  } catch (e) {
    console.error('[db] updateRssSubscriptionCheck error:', e.message);
    return false;
  }
}

export async function getDueRssSubscriptions(db, limit = 10) {
  try {
    const { results } = await db.prepare(
      `SELECT * FROM rss_subscriptions
       WHERE status = 'active' AND (next_check_at IS NULL OR next_check_at <= datetime('now'))
       ORDER BY next_check_at ASC
       LIMIT ?`
    ).bind(limit).all();
    return results || [];
  } catch (e) {
    console.error('[db] getDueRssSubscriptions error:', e.message);
    return [];
  }
}

// ─── RSS Entries ──────────────────────────────────────────────────────────────

export async function hasRssEntry(db, subscriptionId, entryKey, link = '', contentHash = '') {
  try {
    const row = await db.prepare(
      `SELECT id FROM rss_entries
       WHERE subscription_id = ? AND (
         entry_key = ?
         OR (? <> '' AND link = ?)
         OR (? <> '' AND content_hash = ?)
       )`
    ).bind(subscriptionId, entryKey, link, link, contentHash, contentHash).first();
    return !!row;
  } catch (e) {
    console.error('[db] hasRssEntry error:', e.message);
    return false;
  }
}

export async function addRssEntry(db, subscriptionId, entry) {
  try {
    const result = await db.prepare(
      `INSERT OR IGNORE INTO rss_entries (subscription_id, entry_key, guid, link, title, published_at, content_hash, image_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      subscriptionId,
      entry.entryKey,
      entry.guid || '',
      entry.link || '',
      entry.title || '',
      entry.publishedAt || '',
      entry.contentHash || '',
      entry.imageUrl || ''
    ).run();
    return result.meta.changes > 0;
  } catch (e) {
    console.error('[db] addRssEntry error:', e.message);
    return false;
  }
}

export async function atomicClaimAndEnqueueRssNotification(db, subscriptionId, entry, payload) {
  const link = entry.link || '';
  const contentHash = entry.contentHash || '';
  const payloadJson = typeof payload === 'object' ? JSON.stringify(payload) : payload;
  const results = await db.batch([
    db.prepare(
      `INSERT INTO rss_entries
         (subscription_id, entry_key, guid, link, title, published_at, content_hash, image_url)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?
       WHERE NOT EXISTS (
         SELECT 1 FROM rss_entries
         WHERE subscription_id = ? AND (
           entry_key = ?
           OR (? <> '' AND link = ?)
           OR (? <> '' AND content_hash = ?)
         )
       )`
    ).bind(
      subscriptionId,
      entry.entryKey,
      entry.guid || '',
      link,
      entry.title || '',
      entry.publishedAt || '',
      contentHash,
      entry.imageUrl || '',
      subscriptionId,
      entry.entryKey,
      link,
      link,
      contentHash,
      contentHash
    ),
    db.prepare(
      `INSERT INTO notification_queue (kind, dedupe_key, payload_json, status, available_at)
       SELECT 'rss', ?, ?, 'pending', ?
       WHERE changes() > 0`
    ).bind(`rss:${subscriptionId}:${entry.entryKey}`, payloadJson, new Date().toISOString())
  ]);
  return (results[0]?.meta?.changes || 0) > 0;
}

// ─── Bot Sessions ────────────────────────────────────────────────────────────

export async function getBotSession(db, chatId) {
  try {
    const row = await db.prepare('SELECT * FROM bot_sessions WHERE chat_id = ?').bind(String(chatId)).first();
    if (!row) return null;

    // Check expiration
    if (row.expires_at && new Date(row.expires_at) < new Date()) {
      await clearBotSession(db, chatId);
      return null;
    }
    return row;
  } catch (e) {
    console.error('[db] getBotSession error:', e.message);
    return null;
  }
}

export async function setBotSession(db, chatId, flow, step, data, expiresAt) {
  try {
    const dataJson = typeof data === 'object' ? JSON.stringify(data) : data;
    const result = await db.prepare(
      `INSERT OR REPLACE INTO bot_sessions (chat_id, flow, step, data_json, expires_at, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`
    ).bind(String(chatId), flow, step, dataJson, expiresAt || null).run();
    return result.meta.changes > 0;
  } catch (e) {
    console.error('[db] setBotSession error:', e.message);
    return false;
  }
}

export async function clearBotSession(db, chatId) {
  try {
    const result = await db.prepare('DELETE FROM bot_sessions WHERE chat_id = ?').bind(String(chatId)).run();
    return result.meta.changes > 0;
  } catch (e) {
    console.error('[db] clearBotSession error:', e.message);
    return false;
  }
}

// ─── Tracker Rules & Events ──────────────────────────────────────────────────

export async function addTrackerRule(db, { providerType, targetKey, targetConfig, conditionType, conditionValue, status = 'active' }) {
  try {
    const targetConfigJson = typeof targetConfig === 'object' ? JSON.stringify(targetConfig) : targetConfig;
    const result = await db.prepare(
      `INSERT INTO tracker_rules (provider_type, target_key, target_config_json, condition_type, condition_value, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
    ).bind(providerType, targetKey, targetConfigJson, conditionType, conditionValue, status).run();
    return result.meta.changes > 0;
  } catch (e) {
    console.error('[db] addTrackerRule error:', e.message);
    return false;
  }
}

export async function getTrackerRules(db) {
  try {
    const { results } = await db.prepare('SELECT * FROM tracker_rules ORDER BY created_at DESC').all();
    return results || [];
  } catch (e) {
    console.error('[db] getTrackerRules error:', e.message);
    return [];
  }
}

export async function getTrackerRule(db, id) {
  try {
    return await db.prepare('SELECT * FROM tracker_rules WHERE id = ?').bind(id).first();
  } catch (e) {
    console.error('[db] getTrackerRule error:', e.message);
    return null;
  }
}

export async function getTrackerRulesByStatus(db, status) {
  try {
    const { results } = await db.prepare('SELECT * FROM tracker_rules WHERE status = ? ORDER BY created_at DESC').bind(status).all();
    return results || [];
  } catch (e) {
    console.error('[db] getTrackerRulesByStatus error:', e.message);
    return [];
  }
}

export async function updateTrackerRuleStatus(db, id, status) {
  try {
    let result;
    if (status === 'active') {
      result = await db.prepare(
        `UPDATE tracker_rules
         SET status = 'active',
             arm_version = arm_version + 1,
             updated_at = datetime('now')
         WHERE id = ? AND (status = 'paused' OR status = 'triggered')`
      ).bind(id).run();
    } else {
      result = await db.prepare("UPDATE tracker_rules SET status = ?, updated_at = datetime('now') WHERE id = ?")
        .bind(status, id).run();
    }
    return result.meta.changes > 0;
  } catch (e) {
    console.error('[db] updateTrackerRuleStatus error:', e.message);
    return false;
  }
}

export async function removeTrackerRule(db, id) {
  try {
    await db.prepare('DELETE FROM tracker_events WHERE rule_id = ?').bind(id).run();
    const result = await db.prepare('DELETE FROM tracker_rules WHERE id = ?').bind(id).run();
    return result.meta.changes > 0;
  } catch (e) {
    console.error('[db] removeTrackerRule error:', e.message);
    return false;
  }
}

export async function atomicTriggerAndEnqueueStockNotification(db, {
  ruleId,
  armVersion,
  lastValue,
  lastObservedAt,
  lastSource,
  payload
}) {
  const payloadJson = typeof payload === 'object' ? JSON.stringify(payload) : payload;
  const availableAt = new Date().toISOString();
  const results = await db.batch([
    db.prepare(
      `UPDATE tracker_rules
       SET status = 'trigger_pending',
           last_value = ?,
           last_observed_at = ?,
           last_source = ?,
           updated_at = datetime('now')
       WHERE id = ? AND status = 'active' AND arm_version = ?`
    ).bind(lastValue, lastObservedAt, lastSource, ruleId, armVersion),
    db.prepare(
      `INSERT INTO notification_queue (kind, dedupe_key, payload_json, status, available_at)
       SELECT 'stock', ?, ?, 'pending', ?
       WHERE changes() > 0`
    ).bind(`stock:rule:${ruleId}:${armVersion}`, payloadJson, availableAt)
  ]);
  return (results[0]?.meta?.changes || 0) > 0;
}

export async function addTrackerEvent(db, { ruleId, eventType, value, observedAt, source, details = {} }) {
  try {
    const detailsJson = typeof details === 'object' ? JSON.stringify(details) : details;
    const result = await db.prepare(
      `INSERT INTO tracker_events (rule_id, event_type, value, observed_at, source, details_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
    ).bind(ruleId, eventType, value, observedAt || null, source || null, detailsJson).run();
    return result.meta.changes > 0;
  } catch (e) {
    console.error('[db] addTrackerEvent error:', e.message);
    return false;
  }
}

export async function getTrackerEvents(db, ruleId) {
  try {
    const { results } = await db.prepare('SELECT * FROM tracker_events WHERE rule_id = ? ORDER BY observed_at DESC, id DESC').bind(ruleId).all();
    return results || [];
  } catch (e) {
    console.error('[db] getTrackerEvents error:', e.message);
    return [];
  }
}
