// KV-based storage for RSS cache, cookies, and state
// env.CACHE   — RSS feed cache (TTL-based auto-expiry)
// env.COOKIES — Cookies + login state (persistent)

export async function readCache(env, type, id) {
  try {
    return await env.CACHE.get(`${type}:${id}`, 'json');
  } catch { return null; }
}

export async function writeCache(env, type, id, data, ttlMinutes = 60) {
  try {
    await env.CACHE.put(`${type}:${id}`, JSON.stringify(data), {
      expirationTtl: ttlMinutes * 60
    });
  } catch (e) { console.error('[store] cache write error:', e.message); }
}

export async function isCacheStale(env, type, id, ttlMinutes) {
  const cached = await readCache(env, type, id);
  if (!cached || !cached.updatedAt) return true;
  const age = Date.now() - new Date(cached.updatedAt).getTime();
  return age > ttlMinutes * 60 * 1000;
}

export async function readCookies(env, platform) {
  try {
    return await env.COOKIES.get(`cookie:${platform}`, 'json');
  } catch { return null; }
}

export async function writeCookies(env, platform, cookies) {
  try {
    await env.COOKIES.put(
      `cookie:${platform}`,
      JSON.stringify({ cookies, savedAt: new Date().toISOString() })
    );
  } catch (e) { console.error('[store] cookie write error:', e.message); }
}

export async function readState(env, key) {
  try {
    return await env.COOKIES.get(`state:${key}`, 'json');
  } catch { return null; }
}

export async function writeState(env, key, value, ttlSeconds = null) {
  try {
    const opts = ttlSeconds ? { expirationTtl: ttlSeconds } : {};
    await env.COOKIES.put(`state:${key}`, JSON.stringify(value), opts);
  } catch (e) { console.error('[store] state write error:', e.message); }
}

export async function deleteState(env, key) {
  try { await env.COOKIES.delete(`state:${key}`); } catch {}
}

export function getAccounts(env) {
  try {
    return JSON.parse(env.ACCOUNTS_JSON || '{}');
  } catch { return {}; }
}
