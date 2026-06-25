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
import { sendMessage, setWebhook, setMyCommands, parseCommand, verifyWebhookSecret, escapeHtml } from './telegram.js';
import { buildTelegramHelpMessage, getTelegramBotCommands } from './telegram_commands.js';
import { handleImageProxy, handleMediaProxy } from './proxy.js';
import { fetchProfile as fetchIg, validateProfile as validateIg, probeProfile as probeIg } from './crawlers/instagram.js';
import { logError, logInfo, logWarn } from './log.js';

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
  const secretToken = c.env.ADMIN_TOKEN || '';
  const webhook = await setWebhook(c.env.TELEGRAM_BOT_TOKEN, `${baseUrl}/telegram`, secretToken);
  const commands = await syncTelegramCommands(c.env);
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

// ─── Telegram Webhook ─────────────────────────────────────────────────────────

app.post('/telegram', async c => {
  if (!verifyWebhookSecret(c.req.raw, c.env.ADMIN_TOKEN || '')) {
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

  const chatId = msg.chat.id;
  const token = c.env.TELEGRAM_BOT_TOKEN;
  const allowedChat = c.env.TELEGRAM_CHAT_ID;

  if (String(chatId) !== String(allowedChat)) {
    logWarn('telegram.chat_rejected', { chatId });
    return c.text('ok');
  }

  const parsed = parseCommand(msg.text);
  if (!parsed) return c.text('ok');

  c.executionCtx.waitUntil(handleCommand(parsed, c.env, chatId, token));
  return c.text('ok');
});

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

        let msg = '📊 <b>服务状态</b>\n\n';
        msg += `Instagram：<b>${igAccounts.length}</b> 个订阅\n`;

        if (statuses.length > 0) {
          msg += '\n<b>最近抓取结果</b>\n';
          msg += `更新成功：${summary.updated}\n`;
          msg += `无新更新：${summary.no_new_posts}\n`;
          msg += `暂无内容：${summary.no_posts}\n`;
          msg += `抓取失败：${summary.error}\n`;
        }

        if (failures.length > 0) {
          msg += '\n<b>异常账号</b>\n';
          for (const item of failures) {
            msg += `IG <code>${escapeHtml(item.user_id)}</code>: 连续失败 ${item.consecutive_failures} 次\n`;
            if (item.last_error) {
              msg += `${escapeHtml(truncate(item.last_error, 80))}\n`;
            }
          }
        }

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
    ctx.waitUntil(refreshAllCaches(env, { source: 'cron', allowHttpFallback: true }));
  }
};
