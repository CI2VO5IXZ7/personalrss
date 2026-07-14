import { Hono } from 'hono';
import {
  getAccounts, getAccountsByPlatform, getAccount,
  addAccount, removeAccount,
  getCachedPosts, upsertPosts, rowToPost,
  clearCachedPosts, getCrawlStatuses, getCrawlStatus,
  clearCachedPostsByPlatform,
  markCrawlSuccess, markCrawlFailure,
  setFailureAlertCount
} from './db.js';
import { generateInstagramFeed } from './rss.js';
import { sendMessage, setWebhook, setMyCommands, parseCommand, verifyWebhookSecret, deriveWebhookSecret, escapeHtml } from './telegram.js';
import { buildTelegramHelpMessage, getTelegramBotCommands } from './telegram_commands.js';
import { handleImageProxy, handleMediaProxy } from './proxy.js';
import { fetchProfile as fetchIg, validateProfile as validateIg, probeProfile as probeIg } from './crawlers/instagram.js';
import { logError, logInfo, logWarn } from './log.js';
import { redactText } from './security/url.js';

const app = new Hono();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getBaseUrl(env, req) {
  const raw = env.BASE_URL || `https://${new URL(req.url).host}`;
  return String(raw).replace(/\/+$/, '');
}

function cachePostLimit(env) {
  return parseInt(env.CACHE_MAX_POSTS || '100', 10);
}

function refreshConcurrency(env) {
  return Math.max(1, parseInt(env.REFRESH_CONCURRENCY || '3', 10));
}

function failureAlertThreshold(env) {
  return Math.max(1, parseInt(env.FAILURE_ALERT_THRESHOLD || '3', 10));
}

function fallbackFailureThreshold(env) {
  return Math.max(1, parseInt(env.FALLBACK_REFRESH_FAILURE_THRESHOLD || '3', 10));
}

function fallbackHttpStatuses(env) {
  const raw = env.FALLBACK_REFRESH_HTTP_STATUSES || '401,403,429';
  return new Set(
    String(raw)
      .split(',')
      .map(s => parseInt(s.trim(), 10))
      .filter(n => Number.isFinite(n))
  );
}

function httpFallbackEnabled(env) {
  const v = env.ENABLE_HTTP_FALLBACK_REFRESH;
  if (v === undefined || v === null || v === '') return true;
  return String(v).toLowerCase() === 'true' || String(v) === '1';
}

// 从抓取错误信息中解析 Instagram HTTP 状态码（形如 "Instagram API HTTP 401"）。
function extractInstagramHttpStatus(message) {
  const m = /Instagram API HTTP (\d+)/.exec(message || '');
  return m ? parseInt(m[1], 10) : null;
}

function fallbackUrlBase(env) {
  const raw = env.FALLBACK_REFRESH_URL_BASE || env.BASE_URL || '';
  return String(raw).replace(/\/+$/, '');
}

function rssResponse(xml) {
  return new Response(xml, {
    headers: {
      'Content-Type': 'application/rss+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=1800'
    }
  });
}

function getAdminTokenFromRequest(c) {
  // 内部 Worker 自调用使用自定义头，避免依赖 Authorization 在自调用路径上的保留行为。
  const internal = c.req.header('X-PersonalRSS-Admin-Token');
  if (internal) return internal.trim();

  const header = c.req.header('Authorization') || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  return header.trim();
}

function requireAdmin(c) {
  const expected = c.env.ADMIN_TOKEN || '';
  const actual = getAdminTokenFromRequest(c);
  if (!expected || actual !== expected) {
    logWarn('admin.auth_failed', {
      path: c.req.path,
      method: c.req.method
    });
    return c.json({ error: 'Unauthorized' }, 401);
  }
  return null;
}

function truncate(value, max = 120) {
  if (!value) return '';
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

function describeRefreshState(result) {
  if (!result.ok) return `❌ IG ${escapeHtml(result.id)}: ${escapeHtml(result.error)}`;
  if (result.state === 'no_posts') {
    return `ℹ️ IG ${escapeHtml(result.id)}: 账号暂无内容`;
  }
  if (result.state === 'no_new_posts') {
    return `ℹ️ IG ${escapeHtml(result.id)}: 无新更新`;
  }
  return `✅ IG ${escapeHtml(result.id)}: ${result.newCount} 条新增，${result.dedupedCount || 0} 条去重，${result.trimmedCount || 0} 条裁剪`;
}

async function sendAdminAlert(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  try {
    await sendMessage(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, text);
  } catch (e) {
    logError('alert.send_failed', { error: e });
  }
}

async function maybeSendFailureAlert(env, status) {
  if (!status) return;

  const threshold = failureAlertThreshold(env);
  const currentFailures = status.consecutive_failures || 0;
  const lastAlerted = status.last_alerted_failure_count || 0;

  if (currentFailures < threshold) return;
  if (Math.floor(currentFailures / threshold) <= Math.floor(lastAlerted / threshold)) return;

  await sendAdminAlert(
    env,
    `⚠️ <b>抓取连续失败告警</b>\n\n` +
    `平台：IG\n` +
    `账号：<code>${escapeHtml(status.user_id)}</code>\n` +
    `连续失败：<b>${currentFailures}</b> 次\n` +
    `最近错误：${escapeHtml(truncate(status.last_error || '未知错误', 180))}`
  );

  await setFailureAlertCount(env.DB, status.platform, status.user_id, currentFailures);
}

async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const size = Math.min(limit, items.length);

  async function next() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: size }, () => next()));
  return results;
}

// 触发一次受保护的 HTTP 兜底刷新：通过公网 Worker URL 调用单账号刷新接口。
// 之所以走 HTTP，是因为 Cloudflare Worker 无法强制固定 colo/placement，
// 通过公网入口再次进入可能会经由不同的请求路径/落点，从而绕开当前 colo 的 IG 风控。
// 这是 best-effort，不保证一定换到更好的落点。
async function attemptHttpFallbackRefresh(env, account, { reason } = {}) {
  const username = account.user_id;
  const base = fallbackUrlBase(env);

  if (!base) {
    return { ok: false, reached: false, error: 'no BASE_URL/FALLBACK_REFRESH_URL_BASE configured' };
  }
  if (!env.ADMIN_TOKEN) {
    return { ok: false, reached: false, error: 'no ADMIN_TOKEN configured' };
  }

  const url = `${base}/admin/refresh_ig/${encodeURIComponent(username)}?fallback=1`;

  // 注意：不要记录 Authorization 头或 token。
  logWarn('refresh.account.fallback_request', { id: username, reason: reason || null });

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.ADMIN_TOKEN}`,
        'X-PersonalRSS-Admin-Token': env.ADMIN_TOKEN,
        'X-PersonalRSS-Fallback': '1'
      }
    });

    if (!resp.ok) {
      return { ok: false, reached: false, error: `fallback request HTTP ${resp.status}` };
    }

    let body;
    try {
      body = await resp.json();
    } catch {
      return { ok: false, reached: false, error: 'fallback response not JSON' };
    }

    const result = body?.result || null;
    if (!result) {
      return { ok: false, reached: false, error: 'fallback response missing result' };
    }

    // reached=true 表示兜底路由确实执行了刷新（成功或失败均已记录到 crawl_status）。
    return { ok: !!result.ok, reached: true, result };
  } catch (e) {
    return { ok: false, reached: false, error: truncate(e?.message || 'fallback request failed', 200) };
  }
}

async function refreshInstagramAccount(env, account, options = {}) {
  const {
    allowHttpFallback = true,
    source = 'unknown',
    colo = null
  } = options;

  const db = env.DB;
  const startedAt = Date.now();
  const cachePlatform = 'ig';
  const userId = account.user_id;

  logInfo('refresh.account.start', { platform: cachePlatform, userId, source, colo });

  try {
    const { posts, meta } = await fetchIg(userId);
    const writeResult = await upsertPosts(db, cachePlatform, userId, posts, {
      keepLimit: cachePostLimit(env)
    });
    const state = meta.sourceCount === 0 ? 'no_posts' : (writeResult.newCount > 0 ? 'updated' : 'no_new_posts');
    const durationMs = Date.now() - startedAt;

    await markCrawlSuccess(db, cachePlatform, userId, {
      result: state,
      postCount: meta.sourceCount,
      newCount: writeResult.newCount,
      emptyReason: state === 'updated' ? '' : state,
      durationMs
    });

    const result = {
      platform: cachePlatform,
      id: userId,
      ok: true,
      state,
      posts: meta.sourceCount,
      newCount: writeResult.newCount,
      dedupedCount: writeResult.dedupedCount,
      trimmedCount: writeResult.trimmedCount,
      durationMs,
      source,
      colo
    };

    logInfo('refresh.account.success', result);
    return result;
  } catch (e) {
    const durationMs = Date.now() - startedAt;
    const httpStatus = extractInstagramHttpStatus(e.message);

    // 判定是否符合 HTTP 兜底条件：命中配置的风控状态码，且把本次失败计入后达到阈值。
    if (
      allowHttpFallback &&
      httpFallbackEnabled(env) &&
      httpStatus !== null &&
      fallbackHttpStatuses(env).has(httpStatus)
    ) {
      const previous = await getCrawlStatus(db, cachePlatform, userId);
      const projectedFailures = (previous?.consecutive_failures || 0) + 1;
      const threshold = fallbackFailureThreshold(env);

      if (projectedFailures >= threshold) {
        const fallbackReason = `Instagram API HTTP ${httpStatus} (consecutive=${projectedFailures}>=${threshold})`;
        logWarn('refresh.account.fallback_attempt', {
          platform: cachePlatform, id: userId, source, httpStatus, projectedFailures, threshold
        });

        const fb = await attemptHttpFallbackRefresh(env, account, { reason: fallbackReason });

        if (fb.reached) {
          // 兜底路由已执行刷新（内部已记录成功/失败一次），直接采用其结果，避免重复计数。
          const innerResult = fb.result || {};
          const merged = {
            ...innerResult,
            platform: cachePlatform,
            id: userId,
            source,
            colo,
            fallbackAttempted: true,
            fallbackReason,
            viaHttpFallback: true
          };
          if (fb.ok) {
            logInfo('refresh.account.fallback_success', merged);
          } else {
            logWarn('refresh.account.fallback_failed', merged);
          }
          return merged;
        }

        // 兜底请求未能到达刷新路由（网络/鉴权等问题）：按原始失败正常记录一次。
        await markCrawlFailure(db, cachePlatform, userId, { error: e.message, durationMs });
        const status = await getCrawlStatus(db, cachePlatform, userId);
        await maybeSendFailureAlert(env, status);

        const result = {
          platform: cachePlatform,
          id: userId,
          ok: false,
          state: 'error',
          error: e.message,
          durationMs,
          source,
          colo,
          fallbackAttempted: true,
          fallbackReason,
          fallbackError: fb.error || 'fallback request failed'
        };
        logError('refresh.account.failed', result);
        return result;
      }
    }

    // 普通失败路径。
    await markCrawlFailure(db, cachePlatform, userId, {
      error: e.message,
      durationMs
    });
    const status = await getCrawlStatus(db, cachePlatform, userId);
    await maybeSendFailureAlert(env, status);

    const result = {
      platform: cachePlatform,
      id: userId,
      ok: false,
      state: 'error',
      error: e.message,
      durationMs,
      source,
      colo,
      fallbackAttempted: false
    };

    logError('refresh.account.failed', result);
    return result;
  }
}

async function refreshAllCaches(env, options = {}) {
  const { source = 'cron', allowHttpFallback = true } = options;
  const db = env.DB;
  const igAccounts = await getAccountsByPlatform(db, 'instagram');

  logInfo('refresh.batch.start', {
    totalAccounts: igAccounts.length,
    concurrency: refreshConcurrency(env),
    source
  });

  const results = await runWithConcurrency(
    igAccounts,
    refreshConcurrency(env),
    account => refreshInstagramAccount(env, account, { source, allowHttpFallback })
  );

  logInfo('refresh.batch.finish', {
    totalAccounts: igAccounts.length,
    failures: results.filter(r => !r.ok).length,
    source
  });

  return results;
}

async function purgePlatformCache(env, cachePlatform) {
  const removed = await clearCachedPostsByPlatform(env.DB, cachePlatform);
  logInfo('cache.platform_purged', { platform: cachePlatform, removed });
  return { platform: cachePlatform, removed };
}

function formatStatusSummary(statuses) {
  const counts = {
    updated: 0,
    no_new_posts: 0,
    no_posts: 0,
    error: 0
  };

  for (const status of statuses) {
    const key = status.last_result || 'error';
    if (key in counts) counts[key] += 1;
  }

  return counts;
}

async function syncTelegramCommands(env) {
  const commands = getTelegramBotCommands();
  const result = await setMyCommands(env.TELEGRAM_BOT_TOKEN, commands);
  logInfo('telegram.commands_synced', { count: commands.length });
  return result;
}

function safeTelegramSetupFailure(c, stage, error) {
  let message = redactText(error?.message || 'Telegram request failed');
  for (const secret of [c.env.ADMIN_TOKEN, c.env.TELEGRAM_BOT_TOKEN]) {
    if (typeof secret === 'string' && secret) {
      message = message.split(secret).join('***');
    }
  }

  const failure = {
    ok: false,
    stage,
    status: Number.isInteger(error?.status) ? error.status : null,
    message: truncate(message, 300)
  };
  logError('telegram.setup_failed', failure);
  return c.json(failure, 502);
}

// ─── Closed Public Pages ──────────────────────────────────────────────────────

app.get('/', c => c.text('Not Found', 404));
app.get('/status', c => c.text('Not Found', 404));

// ─── Proxy ────────────────────────────────────────────────────────────────────

app.get('/img', handleImageProxy);
app.get('/media', handleMediaProxy);

// ─── Instagram RSS（仅返回缓存，不触发刷新）─────────────────────────────────────

app.get('/rss/ig/:username', async c => {
  const { username } = c.req.param();
  const db = c.env.DB;
  const account = await getAccount(db, 'instagram', username);

  if (!account) {
    return c.text('Forbidden: Account not in whitelist', 403);
  }

  const canonicalUsername = account.user_id;
  const displayName = account.display_name || canonicalUsername;
  const baseUrl = getBaseUrl(c.env, c.req.raw);

  if (username !== canonicalUsername) {
    return c.redirect(`${baseUrl}/rss/ig/${encodeURIComponent(canonicalUsername)}`, 302);
  }

  const cachedRows = await getCachedPosts(db, 'ig', canonicalUsername);
  const cachedPosts = cachedRows.map(rowToPost);

  return rssResponse(generateInstagramFeed(canonicalUsername, displayName, cachedPosts, baseUrl));
});

// ─── Telegram Webhook 设置（部署后调用一次）──────────────────────────────────

app.post('/setup-webhook', async c => {
  const unauthorized = requireAdmin(c);
  if (unauthorized) return unauthorized;

  const baseUrl = getBaseUrl(c.env, c.req.raw);
  let webhook;
  try {
    const secretToken = await deriveWebhookSecret(c.env.ADMIN_TOKEN);
    webhook = await setWebhook(c.env.TELEGRAM_BOT_TOKEN, `${baseUrl}/telegram`, secretToken);
  } catch (error) {
    return safeTelegramSetupFailure(c, 'setWebhook', error);
  }

  let commands;
  try {
    commands = await syncTelegramCommands(c.env);
  } catch (error) {
    return safeTelegramSetupFailure(c, 'setMyCommands', error);
  }

  return c.json({ webhook, commands });
});

app.post('/admin/sync-telegram-commands', async c => {
  const unauthorized = requireAdmin(c);
  if (unauthorized) return unauthorized;

  const result = await syncTelegramCommands(c.env);
  return c.json({ commands: result });
});

// ─── Admin: 手动刷新缓存 ─────────────────────────────────────────────────────

app.post('/admin/refresh', async c => {
  const unauthorized = requireAdmin(c);
  if (unauthorized) return unauthorized;

  const results = await refreshAllCaches(c.env, { source: 'admin', allowHttpFallback: true });
  return c.json({ refreshed: results });
});

// ─── Admin: 单账号刷新 ────────────────────────────────────────────────────────
// 既可用于手动测试，也是 HTTP 兜底刷新的内部目标路由。
// 这里关闭 allowHttpFallback 以避免递归（兜底路由再次触发兜底）。
app.post('/admin/refresh_ig/:username', async c => {
  const unauthorized = requireAdmin(c);
  if (unauthorized) return unauthorized;

  const { username } = c.req.param();
  const account = await getAccount(c.env.DB, 'instagram', username);
  if (!account) {
    return c.json({ ok: false, error: 'Account not in whitelist' }, 404);
  }

  const colo = c.req.raw.cf?.colo || null;
  const isFallback = c.req.query('fallback') === '1';
  const result = await refreshInstagramAccount(c.env, account, {
    allowHttpFallback: false,
    source: isFallback ? 'http-fallback' : 'http-admin',
    colo
  });

  return c.json({ result, colo });
});

// ─── Admin: Instagram 探针诊断（只读，不写缓存）─────────────────────────────────
// 用于从不同客户端网络测试 Cloudflare colo/placement 对 Instagram 风控的影响。
app.get('/admin/probe-instagram', async c => {
  const unauthorized = requireAdmin(c);
  if (unauthorized) return unauthorized;

  const username = (c.req.query('username') || '').trim();
  const colo = c.req.raw.cf?.colo || null;
  const ray = c.req.header('cf-ray') || null;

  if (!username) {
    return c.json({ ok: false, error: 'missing username', colo, ray, timestamp: new Date().toISOString() }, 400);
  }

  logInfo('probe.instagram.start', { username, colo });

  const startedAt = Date.now();
  let status = null;
  let sourceCount = null;
  let ok = false;
  let error = null;

  try {
    const result = await probeIg(username);
    ok = result.ok;
    status = result.status;
    sourceCount = result.sourceCount;
    if (!ok) error = result.error || null;
  } catch (e) {
    error = truncate(e?.message || 'probe failed', 200);
  }

  const durationMs = Date.now() - startedAt;

  if (ok) {
    logInfo('probe.instagram.finish', { username, status, colo, durationMs });
  } else {
    logWarn('probe.instagram.failure', { username, status, colo, durationMs });
  }

  return c.json({
    ok,
    username,
    status,
    durationMs,
    colo,
    placement: c.req.raw.cf?.placement || null,
    ray,
    sourceCount,
    error,
    timestamp: new Date().toISOString()
  });
});

// ─── Admin: Stock 探针诊断（只读，不写 D1） ────────────────────────────────────
app.get('/admin/probe-stock', async c => {
  const unauthorized = requireAdmin(c);
  if (unauthorized) return unauthorized;

  const codeQuery = (c.req.query('code') || '').trim();
  const colo = c.req.raw.cf?.colo || null;
  const ray = c.req.header('cf-ray') || null;

  if (!codeQuery) {
    return c.json({ ok: false, error: 'missing code', colo, ray, timestamp: new Date().toISOString() }, 400);
  }

  const { normalizeSymbol, fetchStockQuotes } = await import('./trackers/providers/stock.js');
  const code = normalizeSymbol(codeQuery);
  if (!code) {
    return c.json({ ok: false, error: 'invalid symbol format', colo, ray, timestamp: new Date().toISOString() }, 400);
  }

  logInfo('probe.stock.start', { code, colo });

  const startedAt = Date.now();
  let ok = false;
  let quote = null;
  let error = null;

  try {
    const quotes = await fetchStockQuotes([code], { fetchFn: fetch });
    quote = quotes[code];
    if (quote) {
      ok = true;
    } else {
      error = 'no quote returned';
    }
  } catch (e) {
    error = truncate(e?.message || 'probe failed', 200);
  }

  const durationMs = Date.now() - startedAt;

  if (ok) {
    logInfo('probe.stock.finish', { code, colo, durationMs });
  } else {
    logWarn('probe.stock.failure', { code, colo, durationMs, error });
  }

  return c.json({
    ok,
    code,
    quote,
    durationMs,
    colo,
    ray,
    error,
    timestamp: new Date().toISOString()
  });
});

// ─── Telegram Webhook ─────────────────────────────────────────────────────────

app.post('/telegram', async c => {
  let expectedWebhookSecret;
  try {
    expectedWebhookSecret = await deriveWebhookSecret(c.env.ADMIN_TOKEN);
  } catch {
    logError('telegram.webhook_secret_unavailable', {});
    return c.text('ok');
  }

  if (!verifyWebhookSecret(c.req.raw, expectedWebhookSecret)) {
    logWarn('telegram.webhook_secret_rejected', {});
    return c.text('ok');
  }

  let update;
  try {
    update = await c.req.json();
  } catch {
    return c.text('ok');
  }

  const msg = update.message;
  if (!msg?.text) return c.text('ok');

  const chatId = msg.chat?.id;
  const token = c.env.TELEGRAM_BOT_TOKEN;
  const allowedChat = c.env.TELEGRAM_CHAT_ID;

  if (msg.chat?.type !== 'private') {
    logWarn('telegram.chat_type_rejected', { chatType: msg.chat?.type });
    return c.text('ok');
  }

  if (String(chatId) !== String(allowedChat)) {
    logWarn('telegram.chat_rejected', { chatId });
    return c.text('ok');
  }

  const adminUserId = c.env.TELEGRAM_ADMIN_USER_ID;
  if (!adminUserId || String(msg.from?.id || '') !== String(adminUserId)) {
    logWarn('telegram.user_rejected', { fromUserId: msg.from?.id });
    return c.text('ok');
  }

  const db = c.env.DB;
  const { getBotSession, clearBotSession } = await import('./db.js');
  const session = await getBotSession(db, chatId);

  if (session) {
    const parsed = parseCommand(msg.text);
    if (parsed && parsed.cmd === 'cancel') {
      await clearBotSession(db, chatId);
      await sendMessage(token, chatId, '✅ 已取消订阅流程。');
      return c.text('ok');
    }
    c.executionCtx.waitUntil(handleSessionMessage(session, msg.text, c.env, chatId, token));
    return c.text('ok');
  }

  const parsed = parseCommand(msg.text);
  if (!parsed) return c.text('ok');

  c.executionCtx.waitUntil(handleCommand(parsed, c.env, chatId, token));
  return c.text('ok');
});

// ─── Bot Session Helpers ──────────────────────────────────────────────────────

async function processAddRss(db, url, env, chatId, token) {
  const { isSafeUrl, redactUrl, safeFetch, redactText } = await import('./security/url.js');
  const { discoverFeeds } = await import('./rss/discovery.js');
  const { parseFeed } = await import('./rss/parser.js');
  const { processSubscription } = await import('./rss/scheduler.js');
  const { addRssSubscription, getRssSubscriptionByUrl, clearBotSession } = await import('./db.js');

  if (!isSafeUrl(url)) {
    await sendMessage(token, chatId, '❌ 订阅链接不安全，禁止订阅该地址。');
    await clearBotSession(db, chatId);
    return;
  }

  const redacted = redactUrl(url);
  const existing = await getRssSubscriptionByUrl(db, url);
  if (existing) {
    await sendMessage(token, chatId, `⚠️ 订阅已存在：<code>${escapeHtml(redacted)}</code>`);
    await clearBotSession(db, chatId);
    return;
  }

  await sendMessage(token, chatId, `🔎 正在检测订阅源 <code>${escapeHtml(redacted)}</code>...`);

  let finalUrl = url;
  let isHtml = false;
  let responseText = '';
  let contentType = '';

  try {
    const res = await safeFetch(url, {
      timeoutMs: 8000,
      ...(env.SAFE_FETCH_RESOLVER ? { resolver: env.SAFE_FETCH_RESOLVER } : {}),
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; PersonalRSS/2.0; +https://github.com/CI2VO5IXZ7/personalrss)'
      }
    });

    contentType = res.headers.get('content-type') || '';
    responseText = await res.text();

    if (contentType.includes('text/html')) {
      isHtml = true;
    }
  } catch (e) {
    await sendMessage(token, chatId, `❌ 无法访问该链接：${escapeHtml(redactText(e.message))}`);
    await clearBotSession(db, chatId);
    return;
  }

  if (isHtml) {
    const discovered = discoverFeeds(responseText, url);
    if (discovered.length === 0) {
      await sendMessage(token, chatId, '❌ 未能在网页中发现任何 RSS/Atom 订阅源。');
      await clearBotSession(db, chatId);
      return;
    }
    finalUrl = discovered[0].url;
    if (!isSafeUrl(finalUrl)) {
      await sendMessage(token, chatId, '❌ 发现的订阅源链接不安全，禁止订阅该地址。');
      await clearBotSession(db, chatId);
      return;
    }
    const existingDiscovered = await getRssSubscriptionByUrl(db, finalUrl);
    if (existingDiscovered) {
      await sendMessage(token, chatId, `⚠️ 发现订阅源 <code>${escapeHtml(redactUrl(finalUrl))}</code>，但该订阅已存在。`);
      await clearBotSession(db, chatId);
      return;
    }
    await sendMessage(token, chatId, `ℹ️ 网页中发现订阅源，将订阅第一个：<code>${escapeHtml(redactUrl(finalUrl))}</code>`);
  }

  let parsed;
  try {
    let feedXml = responseText;
    if (isHtml) {
      const feedRes = await safeFetch(finalUrl, {
        timeoutMs: 5000,
        ...(env.SAFE_FETCH_RESOLVER ? { resolver: env.SAFE_FETCH_RESOLVER } : {})
      });
      feedXml = await feedRes.text();
    }
    parsed = await parseFeed(feedXml, '');
  } catch (e) {
    await sendMessage(token, chatId, `❌ 订阅源解析失败：${escapeHtml(redactText(e.message))}`);
    await clearBotSession(db, chatId);
    return;
  }

  const title = parsed.title || 'Untitled Feed';
  const siteUrl = parsed.siteUrl || '';

  const added = await addRssSubscription(db, finalUrl, redactUrl(finalUrl), siteUrl, title, 10);
  if (added) {
    const newSub = await getRssSubscriptionByUrl(db, finalUrl);
    await processSubscription(db, newSub, env);

    await sendMessage(token, chatId,
      `✅ 成功订阅 RSS：<b>${escapeHtml(title)}</b>\n\n` +
      `ID: <b>${newSub.id}</b>\n` +
      `链接：<code>${escapeHtml(redactUrl(finalUrl))}</code>\n` +
      `检测间隔：<b>10</b> 分钟（已建立首次基线，不推送历史条目）`
    );
  } else {
    await sendMessage(token, chatId, '❌ 订阅保存失败。');
  }

  await clearBotSession(db, chatId);
}

async function handleSessionMessage(session, text, env, chatId, token) {
  const db = env.DB;
  if (session.flow === 'rss_add' && session.step === 'await_url') {
    const url = text.trim();
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      await sendMessage(token, chatId, '❌ 链接格式错误。请输入以 http:// 或 https:// 开头的链接：\n(发送 /cancel 退出流程)');
      return;
    }
    await processAddRss(db, url, env, chatId, token);
  } else if (session.flow === 'stock_add') {
    const input = text.trim();
    const { normalizeSymbol, fetchStockQuotes } = await import('./trackers/providers/stock.js');
    const { addTrackerRule, clearBotSession, setBotSession } = await import('./db.js');

    if (session.step === 'await_code') {
      const code = normalizeSymbol(input);
      if (!code) {
        await sendMessage(token, chatId, '❌ 无效的股票代码，请重新输入（支持 6 位代码，如 600519 或 sz000001）：\n(发送 /cancel 退出)');
        return;
      }
      await sendMessage(token, chatId, `🔎 正在查询股票 <code>${escapeHtml(code)}</code> 行情...`);
      let quotes;
      try {
        quotes = await fetchStockQuotes([code], { fetchFn: fetch });
      } catch (err) {
        await sendMessage(token, chatId, `❌ 查询行情失败：${escapeHtml(err.message)}`);
        await clearBotSession(db, chatId);
        return;
      }
      const quote = quotes[code];
      if (!quote) {
        await sendMessage(token, chatId, `❌ 无法获取股票 <code>${escapeHtml(code)}</code> 的当前价格。`);
        await clearBotSession(db, chatId);
        return;
      }
      const currentPrice = quote.latestPrice;
      const sessionData = {
        code,
        currentPrice,
        source: quote.source,
        observedAt: quote.timestamp
      };

      const expiresAt = new Date(Date.now() + 300 * 1000).toISOString();
      await setBotSession(db, chatId, 'stock_add', 'await_condition_price', sessionData, expiresAt);

      await sendMessage(token, chatId,
        `📈 股票：<code>${escapeHtml(code)}</code>\n` +
        `当前价格：<b>${currentPrice}</b>\n\n` +
        `请输入阈值条件和目标价格（例如：<code>gte 1800</code> 或 <code>lte 10</code>）：\n(发送 /cancel 退出)`
      );
    } else if (session.step === 'await_condition_price') {
      const parts = input.toLowerCase().split(/\s+/);
      const condition = parts[0];
      const targetPrice = parseFloat(parts[1]);
      if ((condition !== 'gte' && condition !== 'lte') || isNaN(targetPrice) || targetPrice <= 0) {
        await sendMessage(token, chatId, '❌ 格式错误。请输入正确的条件和目标价格（如 <code>gte 1800</code> 或 <code>lte 10</code>）：\n(发送 /cancel 退出)');
        return;
      }

      const sessionData = JSON.parse(session.data_json);
      const code = sessionData.code;
      const currentPrice = sessionData.currentPrice;

      let satisfied = false;
      if (condition === 'gte') {
        satisfied = currentPrice >= targetPrice;
      } else if (condition === 'lte') {
        satisfied = currentPrice <= targetPrice;
      }

      if (satisfied) {
        const nextData = { ...sessionData, condition, targetPrice };
        const expiresAt = new Date(Date.now() + 300 * 1000).toISOString();
        await setBotSession(db, chatId, 'stock_add', 'await_confirmation', nextData, expiresAt);
        await sendMessage(token, chatId,
          `⚠️ 当前价格为 <b>${currentPrice}</b>，已满足阈值条件 <b>${condition === 'gte' ? '≥' : '≤'} ${targetPrice}</b>！\n` +
          `是否确认创建该规则？（发送 “确认” 或 “yes” 确认，发送 /cancel 取消）`
        );
      } else {
        const ok = await addTrackerRule(db, {
          providerType: 'stock',
          targetKey: code,
          targetConfig: { code },
          conditionType: condition,
          conditionValue: targetPrice,
          status: 'active'
        });
        if (ok) {
          await sendMessage(token, chatId, `✅ 已成功添加股票提醒规则：<code>${escapeHtml(code)}</code> ${condition === 'gte' ? '≥' : '≤'} ${targetPrice}`);
        } else {
          await sendMessage(token, chatId, '❌ 添加股票提醒规则失败。');
        }
        await clearBotSession(db, chatId);
      }
    } else if (session.step === 'await_confirmation') {
      if (input === '确认' || input.toLowerCase() === 'yes') {
        const sessionData = JSON.parse(session.data_json);
        const { code, condition, targetPrice } = sessionData;
        const ok = await addTrackerRule(db, {
          providerType: 'stock',
          targetKey: code,
          targetConfig: { code },
          conditionType: condition,
          conditionValue: targetPrice,
          status: 'active'
        });
        if (ok) {
          await sendMessage(token, chatId, `✅ 已成功添加股票提醒规则：<code>${escapeHtml(code)}</code> ${condition === 'gte' ? '≥' : '≤'} ${targetPrice}`);
        } else {
          await sendMessage(token, chatId, '❌ 添加股票提醒规则失败。');
        }
        await clearBotSession(db, chatId);
      } else {
        await sendMessage(token, chatId, '❌ 输入不符合要求。请输入 “确认” 或 “yes” 确认创建，或发送 /cancel 退出流程。');
      }
    }
  }
}

// ─── Telegram 命令处理 ────────────────────────────────────────────────────────

async function handleCommand({ cmd, args }, env, chatId, token) {
  const db = env.DB;

  try {
    switch (cmd) {
      case 'start':
      case 'help':
        await sendMessage(token, chatId, buildTelegramHelpMessage());
        break;

      case 'add_ig': {
        if (!args[0]) { await sendMessage(token, chatId, '❌ 用法：/add_ig &lt;username&gt; [displayName]'); break; }
        const username = args[0].trim();
        const displayName = args.slice(1).join(' ').trim() || username;

        if (await getAccount(db, 'instagram', username)) {
          await sendMessage(token, chatId, `⚠️ 订阅已存在：<code>${escapeHtml(username)}</code>`);
          break;
        }

        await sendMessage(token, chatId, `🔎 正在校验 Instagram 账号 <code>${escapeHtml(username)}</code>...`);
        const validation = await validateIg(username);
        const ok = await addAccount(db, 'instagram', username, displayName);

        if (ok) {
          const baseUrl = getBaseUrl(env, { url: 'https://your-worker.workers.dev' });
          await sendMessage(token, chatId,
            `✅ 已添加 Instagram 订阅：<b>${escapeHtml(displayName)}</b>\n\n` +
            `📡 RSS: <code>${baseUrl}/rss/ig/${escapeHtml(username)}</code>\n` +
            `📦 当前可见帖子数：<b>${validation.sourceCount}</b>`);
        } else {
          await sendMessage(token, chatId, `⚠️ 添加失败（可能已存在）：<code>${escapeHtml(username)}</code>`);
        }
        break;
      }

      case 'remove_ig': {
        if (!args[0]) { await sendMessage(token, chatId, '❌ 用法：/remove_ig &lt;username&gt;'); break; }
        const username = args[0].trim();
        const ok = await removeAccount(db, 'instagram', username);
        await sendMessage(token, chatId, ok
          ? `✅ 已删除 Instagram 订阅：<code>${escapeHtml(username)}</code>`
          : `⚠️ 未找到该订阅：<code>${escapeHtml(username)}</code>`);
        break;
      }

      case 'list': {
        const accounts = await getAccounts(db);
        if (accounts.length === 0) {
          await sendMessage(token, chatId, '📭 暂无订阅，使用 /add_ig 添加。');
          break;
        }
        let msg = '📋 <b>订阅列表</b>\n\n';
        for (const a of accounts) {
          msg += `IG <b>${escapeHtml(a.display_name || a.user_id)}</b>\n`;
          msg += `ID: <code>${escapeHtml(a.user_id)}</code>\n\n`;
        }
        await sendMessage(token, chatId, msg);
        break;
      }

      case 'feeds': {
        const accounts = await getAccounts(db);
        const baseUrl = getBaseUrl(env, { url: 'https://your-worker.workers.dev' });
        if (accounts.length === 0) {
          await sendMessage(token, chatId, '📭 暂无订阅，使用 /add_ig 添加。');
          break;
        }
        let msg = '📡 <b>RSS 订阅链接</b>\n\n';
        for (const a of accounts) {
          msg += `IG ${escapeHtml(a.display_name || a.user_id)}\n`;
          msg += `<code>${baseUrl}/rss/ig/${escapeHtml(a.user_id)}</code>\n\n`;
        }
        await sendMessage(token, chatId, msg);
        break;
      }

      case 'status': {
        const igAccounts = await getAccountsByPlatform(db, 'instagram');
        const statuses = await getCrawlStatuses(db);
        const summary = formatStatusSummary(statuses);
        const failures = statuses.filter(s => (s.consecutive_failures || 0) > 0)
          .sort((a, b) => (b.consecutive_failures || 0) - (a.consecutive_failures || 0))
          .slice(0, 5);

        // Fetch RSS stats
        const rssActive = (await db.prepare("SELECT COUNT(*) as count FROM rss_subscriptions WHERE status = 'active'").first())?.count || 0;
        const rssPaused = (await db.prepare("SELECT COUNT(*) as count FROM rss_subscriptions WHERE status = 'paused'").first())?.count || 0;
        const rssError = (await db.prepare("SELECT COUNT(*) as count FROM rss_subscriptions WHERE status = 'error'").first())?.count || 0;

        // Fetch Stock stats
        const stockActive = (await db.prepare("SELECT COUNT(*) as count FROM tracker_rules WHERE status = 'active'").first())?.count || 0;
        const stockTriggered = (await db.prepare("SELECT COUNT(*) as count FROM tracker_rules WHERE status = 'triggered'").first())?.count || 0;
        const stockPending = (await db.prepare("SELECT COUNT(*) as count FROM tracker_rules WHERE status = 'trigger_pending'").first())?.count || 0;

        // Fetch Notifications stats
        const notifyPending = (await db.prepare("SELECT COUNT(*) as count FROM notification_queue WHERE status = 'pending'").first())?.count || 0;
        const notifyDead = (await db.prepare("SELECT COUNT(*) as count FROM notification_queue WHERE status = 'dead'").first())?.count || 0;

        // Fetch DeepSeek usage
        const { getBeijingDate } = await import('./summary/deepseek.js');
        const dateStr = getBeijingDate();
        const dsUsage = await db.prepare("SELECT count FROM daily_usage WHERE usage_date = ? AND usage_type = 'deepseek_summary'").bind(dateStr).first();
        const dsCount = dsUsage?.count || 0;
        const dsLimit = parseInt(env.DEEPSEEK_DAILY_LIMIT || '200', 10);

        let msg = '📊 <b>服务状态</b>\n\n';
        msg += `📸 <b>Instagram</b>\n`;
        msg += `订阅账号：<b>${igAccounts.length}</b> 个\n`;

        if (statuses.length > 0) {
          msg += `更新成功：${summary.updated} | 无新更新：${summary.no_new_posts} | 暂无内容：${summary.no_posts} | 抓取失败：${summary.error}\n`;
        }

        if (failures.length > 0) {
          msg += '异常账号：\n';
          for (const item of failures) {
            msg += `  - <code>${escapeHtml(item.user_id)}</code>: 连续失败 ${item.consecutive_failures} 次\n`;
          }
        }

        msg += `\n📰 <b>RSS 订阅</b>\n`;
        msg += `活跃：<b>${rssActive}</b> | 暂停：<b>${rssPaused}</b> | 异常：<b>${rssError}</b>\n`;

        msg += `\n📈 <b>股票提醒</b>\n`;
        msg += `活跃：<b>${stockActive}</b> | 已触发：<b>${stockTriggered}</b> | 待发送：<b>${stockPending}</b>\n`;

        msg += `\n✉️ <b>通知队列</b>\n`;
        msg += `积压 (pending)：<b>${notifyPending}</b> | 失败 (dead)：<b>${notifyDead}</b>\n`;

        msg += `\n🤖 <b>AI 摘要 (DeepSeek)</b>\n`;
        msg += `今日已用：<b>${dsCount}</b> / ${dsLimit}\n`;

        await sendMessage(token, chatId, msg);
        break;
      }

      case 'refresh': {
        await sendMessage(token, chatId, '🔄 正在刷新全部缓存...');
        const results = await refreshAllCaches(env, { source: 'telegram', allowHttpFallback: true });
        const hasNew = results.some(r => r.ok && (r.newCount || 0) > 0);
        let msg = '✅ <b>缓存刷新完成</b>\n\n';
        msg += results.map(describeRefreshState).join('\n');
        if (!hasNew && results.every(r => r.ok)) {
          msg += '\n\n📭 所有订阅均无新更新。';
        }
        await sendMessage(token, chatId, msg);
        break;
      }

      case 'refresh_ig': {
        if (!args[0]) { await sendMessage(token, chatId, '❌ 用法：/refresh_ig &lt;username&gt;'); break; }
        const requestedUsername = args[0].trim();
        const account = await getAccount(db, 'instagram', requestedUsername);
        if (!account) {
          await sendMessage(token, chatId, `⚠️ 未找到订阅：<code>${escapeHtml(requestedUsername)}</code>`);
          break;
        }
        const canonicalUsername = account.user_id;
        await sendMessage(token, chatId, `🔄 正在刷新 IG <code>${escapeHtml(canonicalUsername)}</code>...`);
        const result = await refreshInstagramAccount(env, account, { source: 'telegram', allowHttpFallback: true });
        await sendMessage(token, chatId, describeRefreshState(result));
        break;
      }

      case 'purge_ig': {
        if (args[0]) {
          await sendMessage(token, chatId, '❌ 用法：/purge_ig');
          break;
        }
        const result = await purgePlatformCache(env, 'ig');
        await sendMessage(token, chatId,
          '🧹 已清理全部 IG 缓存\n' +
          `删除条数：<b>${result.removed}</b>`);
        break;
      }

      case 'rss_add': {
        if (args[0]) {
          const url = args[0].trim();
          await processAddRss(db, url, env, chatId, token);
        } else {
          const { setBotSession } = await import('./db.js');
          const expiresAt = new Date(Date.now() + 300 * 1000).toISOString(); // 5 min expiry
          await setBotSession(db, chatId, 'rss_add', 'await_url', {}, expiresAt);
          await sendMessage(token, chatId, '请输入您要订阅的 RSS/Atom 订阅源链接或网页链接：\n(发送 /cancel 退出流程)');
        }
        break;
      }

      case 'rss_list': {
        const { getRssSubscriptions } = await import('./db.js');
        const subs = await getRssSubscriptions(db);
        if (subs.length === 0) {
          await sendMessage(token, chatId, '📭 暂无 RSS 订阅，使用 /rss_add 添加。');
          break;
        }
        let msg = '📋 <b>RSS 订阅列表</b>\n\n';
        for (const s of subs) {
          msg += `ID: <b>${s.id}</b> - ${escapeHtml(s.title || '未命名')} (${escapeHtml(s.status)}, ${s.interval_minutes}m)\n`;
          msg += `URL: <code>${escapeHtml(s.feed_url_redacted)}</code>\n\n`;
        }
        await sendMessage(token, chatId, msg);
        break;
      }

      case 'rss_remove': {
        if (!args[0]) {
          await sendMessage(token, chatId, '❌ 用法：/rss_remove <id>');
          break;
        }
        const id = parseInt(args[0].trim(), 10);
        if (Number.isNaN(id)) {
          await sendMessage(token, chatId, '❌ 无效的 ID。用法：/rss_remove <id>');
          break;
        }
        const { getRssSubscription, removeRssSubscription } = await import('./db.js');
        const sub = await getRssSubscription(db, id);
        if (!sub) {
          await sendMessage(token, chatId, `⚠️ 未找到 ID 为 <b>${id}</b> 的订阅。`);
          break;
        }
        const ok = await removeRssSubscription(db, id);
        await sendMessage(token, chatId, ok
          ? `✅ 已成功删除 RSS 订阅：<b>${escapeHtml(sub.title)}</b>`
          : `⚠️ 删除失败：<b>${escapeHtml(sub.title)}</b>`
        );
        break;
      }

      case 'rss_pause': {
        if (!args[0]) {
          await sendMessage(token, chatId, '❌ 用法：/rss_pause <id>');
          break;
        }
        const id = parseInt(args[0].trim(), 10);
        if (Number.isNaN(id)) {
          await sendMessage(token, chatId, '❌ 无效的 ID。用法：/rss_pause <id>');
          break;
        }
        const { getRssSubscription, pauseRssSubscription } = await import('./db.js');
        const sub = await getRssSubscription(db, id);
        if (!sub) {
          await sendMessage(token, chatId, `⚠️ 未找到 ID 为 <b>${id}</b> 的订阅。`);
          break;
        }
        const ok = await pauseRssSubscription(db, id);
        await sendMessage(token, chatId, ok
          ? `✅ 已成功暂停 RSS 订阅：<b>${escapeHtml(sub.title)}</b>`
          : `⚠️ 暂停失败：<b>${escapeHtml(sub.title)}</b>`
        );
        break;
      }

      case 'rss_resume': {
        if (!args[0]) {
          await sendMessage(token, chatId, '❌ 用法：/rss_resume <id>');
          break;
        }
        const id = parseInt(args[0].trim(), 10);
        if (Number.isNaN(id)) {
          await sendMessage(token, chatId, '❌ 无效的 ID。用法：/rss_resume <id>');
          break;
        }
        const { getRssSubscription, resumeRssSubscription } = await import('./db.js');
        const sub = await getRssSubscription(db, id);
        if (!sub) {
          await sendMessage(token, chatId, `⚠️ 未找到 ID 为 <b>${id}</b> 的订阅。`);
          break;
        }
        const ok = await resumeRssSubscription(db, id);
        await sendMessage(token, chatId, ok
          ? `✅ 已成功恢复 RSS 订阅：<b>${escapeHtml(sub.title)}</b>`
          : `⚠️ 恢复失败：<b>${escapeHtml(sub.title)}</b>`
        );
        break;
      }

      case 'rss_refresh': {
        if (!args[0]) {
          await sendMessage(token, chatId, '❌ 用法：/rss_refresh <id>');
          break;
        }
        const id = parseInt(args[0].trim(), 10);
        if (Number.isNaN(id)) {
          await sendMessage(token, chatId, '❌ 无效的 ID。用法：/rss_refresh <id>');
          break;
        }
        const { getRssSubscription } = await import('./db.js');
        const sub = await getRssSubscription(db, id);
        if (!sub) {
          await sendMessage(token, chatId, `⚠️ 未找到 ID 为 <b>${id}</b> 的订阅。`);
          break;
        }
        await sendMessage(token, chatId, `🔄 正在手动刷新 RSS 订阅：<b>${escapeHtml(sub.title)}</b>...`);
        const { processSubscription } = await import('./rss/scheduler.js');
        const res = await processSubscription(db, sub, env);
        if (res.success) {
          await sendMessage(token, chatId, `✅ 刷新完成！发现并入队了 <b>${res.count}</b> 条新文章。`);
        } else {
          await sendMessage(token, chatId, `❌ 刷新失败：${escapeHtml(res.error)}`);
        }
        break;
      }

      case 'rss_set_interval': {
        if (!args[0] || !args[1]) {
          await sendMessage(token, chatId, '❌ 用法：/rss_set_interval <id> <minutes>');
          break;
        }
        const id = parseInt(args[0].trim(), 10);
        const minutes = parseInt(args[1].trim(), 10);
        if (Number.isNaN(id) || Number.isNaN(minutes) || minutes < 5) {
          await sendMessage(token, chatId, '❌ 无效参数。刷新间隔最小为 5 分钟。用法：/rss_set_interval <id> <minutes>');
          break;
        }
        const { getRssSubscription, updateRssSubscriptionInterval } = await import('./db.js');
        const sub = await getRssSubscription(db, id);
        if (!sub) {
          await sendMessage(token, chatId, `⚠️ 未找到 ID 为 <b>${id}</b> 的订阅。`);
          break;
        }
        const ok = await updateRssSubscriptionInterval(db, id, minutes);
        await sendMessage(token, chatId, ok
          ? `✅ 已将 RSS 订阅 <b>${escapeHtml(sub.title)}</b> 的检测周期设置为 <b>${minutes}</b> 分钟。`
          : `⚠️ 设置失败：<b>${escapeHtml(sub.title)}</b>`
        );
        break;
      }

      case 'stock_quote': {
        if (!args[0]) {
          await sendMessage(token, chatId, '❌ 用法：/stock_quote <code>');
          break;
        }
        const input = args[0].trim();
        const { normalizeSymbol, fetchStockQuotes } = await import('./trackers/providers/stock.js');
        const code = normalizeSymbol(input);
        if (!code) {
          await sendMessage(token, chatId, '❌ 无效的股票代码。用法：/stock_quote <code>');
          break;
        }
        await sendMessage(token, chatId, `🔎 正在查询 <code>${escapeHtml(code)}</code> 行情...`);
        try {
          const quotes = await fetchStockQuotes([code], { fetchFn: fetch });
          const q = quotes[code];
          if (!q) {
            await sendMessage(token, chatId, `❌ 无法获取 <code>${escapeHtml(code)}</code> 的行情。`);
            break;
          }
          const change = q.latestPrice - q.yesterdayClose;
          const pct = ((change / q.yesterdayClose) * 100).toFixed(2);
          const sign = change > 0 ? '+' : '';

          await sendMessage(token, chatId,
            `📈 <b>股票行情: ${escapeHtml(code)}</b>\n\n` +
            `最新价: <b>${q.latestPrice}</b>\n` +
            `昨收价: <b>${q.yesterdayClose}</b>\n` +
            `涨跌幅: <b>${sign}${pct}%</b>\n` +
            `更新时间: <code>${escapeHtml(q.timestamp)}</code>\n` +
            `数据源: <code>${escapeHtml(q.source)}</code>`
          );
        } catch (err) {
          await sendMessage(token, chatId, `❌ 查询失败：${escapeHtml(err.message)}`);
        }
        break;
      }

      case 'stock_add': {
        const { normalizeSymbol, fetchStockQuotes } = await import('./trackers/providers/stock.js');
        const { addTrackerRule, setBotSession } = await import('./db.js');

        if (args[0] && args[1] && args[2]) {
          const code = normalizeSymbol(args[0].trim());
          const condition = args[1].trim().toLowerCase();
          const targetPrice = parseFloat(args[2].trim());

          if (!code) {
            await sendMessage(token, chatId, '❌ 无效的股票代码。');
            break;
          }
          if (condition !== 'gte' && condition !== 'lte') {
            await sendMessage(token, chatId, '❌ 条件必须为 gte 或 lte。');
            break;
          }
          if (isNaN(targetPrice) || targetPrice <= 0) {
            await sendMessage(token, chatId, '❌ 目标价必须是正数。');
            break;
          }

          await sendMessage(token, chatId, `🔎 正在查询 <code>${escapeHtml(code)}</code> 行情...`);
          let quotes;
          try {
            quotes = await fetchStockQuotes([code], { fetchFn: fetch });
          } catch (err) {
            await sendMessage(token, chatId, `❌ 查询行情失败：${escapeHtml(err.message)}`);
            break;
          }
          const q = quotes[code];
          if (!q) {
            await sendMessage(token, chatId, `❌ 无法获取当前行情，添加失败。`);
            break;
          }

          const currentPrice = q.latestPrice;
          let satisfied = false;
          if (condition === 'gte') {
            satisfied = currentPrice >= targetPrice;
          } else if (condition === 'lte') {
            satisfied = currentPrice <= targetPrice;
          }

          if (satisfied) {
            const sessionData = {
              code,
              currentPrice,
              condition,
              targetPrice,
              source: q.source,
              observedAt: q.timestamp
            };
            const expiresAt = new Date(Date.now() + 300 * 1000).toISOString();
            await setBotSession(db, chatId, 'stock_add', 'await_confirmation', sessionData, expiresAt);
            await sendMessage(token, chatId,
              `⚠️ 当前价格为 <b>${currentPrice}</b>，已满足阈值条件 <b>${condition === 'gte' ? '≥' : '≤'} ${targetPrice}</b>！\n` +
              `是否确认创建该规则？（发送 “确认” 或 “yes” 确认，发送 /cancel 取消）`
            );
          } else {
            const ok = await addTrackerRule(db, {
              providerType: 'stock',
              targetKey: code,
              targetConfig: { code },
              conditionType: condition,
              conditionValue: targetPrice,
              status: 'active'
            });
            if (ok) {
              await sendMessage(token, chatId, `✅ 已成功添加股票提醒规则：<code>${escapeHtml(code)}</code> ${condition === 'gte' ? '≥' : '≤'} ${targetPrice}`);
            } else {
              await sendMessage(token, chatId, '❌ 添加股票提醒规则失败。');
            }
          }
        } else {
          const expiresAt = new Date(Date.now() + 300 * 1000).toISOString();
          await setBotSession(db, chatId, 'stock_add', 'await_code', {}, expiresAt);
          await sendMessage(token, chatId, '请输入股票代码（例如 600519 或 sz000001）：\n(发送 /cancel 退出流程)');
        }
        break;
      }

      case 'stock_list': {
        const { getTrackerRules } = await import('./db.js');
        const rules = await getTrackerRules(db);
        const stockRules = rules.filter(r => r.provider_type === 'stock');
        if (stockRules.length === 0) {
          await sendMessage(token, chatId, '📭 暂无股票提醒，使用 /stock_add 添加。');
          break;
        }
        let msg = '📋 <b>股票提醒列表</b>\n\n';
        for (const r of stockRules) {
          const cond = r.condition_type === 'gte' ? 'gte (≥)' : 'lte (≤)';
          msg += `ID: <b>${r.id}</b> - <code>${escapeHtml(r.target_key)}</code> ${cond} <b>${r.condition_value}</b> (${escapeHtml(r.status)})\n`;
          if (r.last_value !== null) {
            msg += `最新值: <b>${r.last_value}</b> (时间: ${escapeHtml(r.last_observed_at || '')})\n`;
          }
          msg += '\n';
        }
        await sendMessage(token, chatId, msg);
        break;
      }

      case 'stock_pause': {
        if (!args[0]) {
          await sendMessage(token, chatId, '❌ 用法：/stock_pause <id>');
          break;
        }
        const id = parseInt(args[0].trim(), 10);
        if (isNaN(id)) {
          await sendMessage(token, chatId, '❌ 无效的 ID。用法：/stock_pause <id>');
          break;
        }
        const { getTrackerRule, updateTrackerRuleStatus } = await import('./db.js');
        const rule = await getTrackerRule(db, id);
        if (!rule) {
          await sendMessage(token, chatId, `⚠️ 未找到 ID 为 <b>${id}</b> 的规则。`);
          break;
        }
        const ok = await updateTrackerRuleStatus(db, id, 'paused');
        await sendMessage(token, chatId, ok
          ? `✅ 已成功暂停股票提醒规则 ID: <b>${id}</b>`
          : `⚠️ 暂停失败。`
        );
        break;
      }

      case 'stock_resume': {
        if (!args[0]) {
          await sendMessage(token, chatId, '❌ 用法：/stock_resume <id>');
          break;
        }
        const id = parseInt(args[0].trim(), 10);
        if (isNaN(id)) {
          await sendMessage(token, chatId, '❌ 无效的 ID。用法：/stock_resume <id>');
          break;
        }
        const { getTrackerRule, updateTrackerRuleStatus } = await import('./db.js');
        const rule = await getTrackerRule(db, id);
        if (!rule) {
          await sendMessage(token, chatId, `⚠️ 未找到 ID 为 <b>${id}</b> 的规则。`);
          break;
        }
        const ok = await updateTrackerRuleStatus(db, id, 'active');
        await sendMessage(token, chatId, ok
          ? `✅ 已成功恢复股票提醒规则 ID: <b>${id}</b>`
          : `⚠️ 恢复失败。`
        );
        break;
      }

      case 'stock_remove': {
        if (!args[0]) {
          await sendMessage(token, chatId, '❌ 用法：/stock_remove <id>');
          break;
        }
        const id = parseInt(args[0].trim(), 10);
        if (isNaN(id)) {
          await sendMessage(token, chatId, '❌ 无效的 ID。用法：/stock_remove <id>');
          break;
        }
        const { getTrackerRule, removeTrackerRule } = await import('./db.js');
        const rule = await getTrackerRule(db, id);
        if (!rule) {
          await sendMessage(token, chatId, `⚠️ 未找到 ID 为 <b>${id}</b> 的规则。`);
          break;
        }
        const ok = await removeTrackerRule(db, id);
        await sendMessage(token, chatId, ok
          ? `✅ 已成功删除股票提醒规则 ID: <b>${id}</b>`
          : `⚠️ 删除失败。`
        );
        break;
      }

      case 'sync_commands': {
        await sendMessage(token, chatId, '🔄 正在同步 Telegram 机器人命令菜单...');
        await syncTelegramCommands(env);
        await sendMessage(token, chatId, '✅ Telegram 机器人命令菜单已同步。');
        break;
      }

      default:
        await sendMessage(token, chatId, `未知命令 /${escapeHtml(cmd)}，发送 /help 查看可用命令。`);
    }
  } catch (e) {
    logError('telegram.command_failed', {
      cmd,
      error: e
    });
    await sendMessage(token, chatId, `❌ 命令执行失败：${escapeHtml(e.message)}`).catch(() => {});
  }
}

// ─── Export ───────────────────────────────────────────────────────────────────

export default {
  fetch: app.fetch,

  async scheduled(event, env, ctx) {
    logInfo('scheduled.triggered', { cron: event.cron });

    const now = new Date();
    const minute = now.getUTCMinutes();
    const promises = [];

    // 1. Instagram refresh runs every 10 minutes (minutes ending in 0)
    if (minute % 10 === 0) {
      promises.push(refreshAllCaches(env, { source: 'cron', allowHttpFallback: true }));
    }

    // 2. RSS processing runs every 5 minutes (every trigger)
    const { processDueSubscriptions } = await import('./rss/scheduler.js');
    promises.push(processDueSubscriptions(env.DB, env, { batchLimit: 5 }));

    // 3. Notification sending runs every 5 minutes (every trigger)
    const { processNotificationBatch } = await import('./notifications/sender.js');
    promises.push(processNotificationBatch(env.DB, env, { batchLimit: 10 }));

    // 4. Stock rules evaluation runs every 5 minutes (every trigger)
    const { evaluateRules } = await import('./trackers/engine.js');
    promises.push(evaluateRules(env.DB, env).catch(err => console.error('[scheduled] evaluateRules error:', err.message)));

    ctx.waitUntil(Promise.all(promises));
  }
};
