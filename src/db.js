// D1 Database operations for Social RSS Bridge

// ─── Accounts ────────────────────────────────────────────────────────────────

export async function getAccounts(db) {
  try {
    const { results } = await db.prepare('SELECT * FROM accounts ORDER BY created_at DESC').all();
    return results || [];
  } catch { return []; }
}

export async function getAccountsByPlatform(db, platform) {
  try {
    const { results } = await db.prepare('SELECT * FROM accounts WHERE platform = ?').bind(platform).all();
    return results || [];
  } catch { return []; }
}

export async function getAccount(db, platform, userId) {
  try {
    return await db.prepare('SELECT * FROM accounts WHERE platform = ? AND user_id = ?')
      .bind(platform, userId).first();
  } catch { return null; }
}

export async function addAccount(db, platform, userId, displayName = '') {
  try {
    const result = await db.prepare('INSERT OR IGNORE INTO accounts (platform, user_id, display_name) VALUES (?, ?, ?)')
      .bind(platform, userId, displayName).run();
    return result.meta.changes > 0;
  } catch (e) {
    console.error('[db] addAccount error:', e.message);
    return false;
  }
}

export async function removeAccount(db, platform, userId) {
  try {
    const result = await db.prepare('DELETE FROM accounts WHERE platform = ? AND user_id = ?')
      .bind(platform, userId).run();
    // Also clean up cached posts
    await db.prepare('DELETE FROM posts_cache WHERE platform = ? AND user_id = ?')
      .bind(platform, userId).run();
    return result.meta.changes > 0;
  } catch (e) {
    console.error('[db] removeAccount error:', e.message);
    return false;
  }
}

// ─── Posts Cache ──────────────────────────────────────────────────────────────

export async function getCachedPosts(db, platform, userId, limit = 50) {
  try {
    const { results } = await db.prepare(
      'SELECT * FROM posts_cache WHERE platform = ? AND user_id = ? ORDER BY date DESC LIMIT ?'
    ).bind(platform, userId, limit).all();
    return results || [];
  } catch { return []; }
}

export async function upsertPosts(db, platform, userId, posts) {
  if (!posts || posts.length === 0) return;
  try {
    const stmt = db.prepare(
      `INSERT OR REPLACE INTO posts_cache (platform, user_id, post_id, title, description, link, image, date, raw_images, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
    );
    const batch = posts.map(p => stmt.bind(
      platform, userId,
      p.id || p.post_id || '',
      p.title || '',
      p.description || '',
      p.link || '',
      p.image || '',
      p.date || '',
      JSON.stringify(p.raw_images || [])
    ));
    await db.batch(batch);
  } catch (e) {
    console.error('[db] upsertPosts error:', e.message);
  }
}

export async function getLastFetchTime(db, platform, userId) {
  try {
    const row = await db.prepare(
      'SELECT fetched_at FROM posts_cache WHERE platform = ? AND user_id = ? ORDER BY fetched_at DESC LIMIT 1'
    ).bind(platform, userId).first();
    return row?.fetched_at || null;
  } catch { return null; }
}

export async function isCacheStale(db, platform, userId, ttlMinutes) {
  const lastFetch = await getLastFetchTime(db, platform, userId);
  if (!lastFetch) return true;
  const age = Date.now() - new Date(lastFetch + 'Z').getTime();
  return age > ttlMinutes * 60 * 1000;
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
    title: row.title,
    description: row.description,
    link: row.link,
    image: row.image,
    date: row.date,
    raw_images: JSON.parse(row.raw_images || '[]')
  };
}
