import { Hono } from 'hono';
import {
  getAccounts, getAccountsByPlatform, getAccount,
  addAccount, removeAccount,
  getCachedPosts, getCachedPostIds, upsertPosts, rowToPost,
  getApiUsage, getApiUsageSummary,
  clearCachedPosts, getCrawlStatuses, getCrawlStatus,
  clearCachedPostsByPlatform,
  markCrawlSuccess, markCrawlFailure,
  getSetting, setSetting, setFailureAlertCount
} from './db.js';
import { generateInstagramFeed, generateXhsFeed } from './rss.js';
import { sendMessage, setWebhook, setMyCommands, parseCommand, verifyWebhookSecret, escapeHtml } from './telegram.js';
import { buildTelegramHelpMessage, getTelegramBotCommands } from './telegram_commands.js';
import { handleImageProxy, handleMediaProxy } from './proxy.js';
import { fetchProfile as fetchIg, validateProfile as validateIg } from './crawlers/instagram.js';
import { fetchProfile as fetchXhs, validateProfile as validateXhs } from './crawlers/xhs_tikhub.js';
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

function apiUsageAlertThreshold(env) {
  return Math.max(0, parseInt(env.API_USAGE_ALERT_THRESHOLD || '500', 10));
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

function toAccountPlatform(cachePlatform) {
  return cachePlatform === 'ig' ? 'instagram' : 'xiaohongshu';
}

function platformLabel(platform) {
  return platform === 'ig' || platform === 'instagram' ? 'IG' : 'XHS';
}

function truncate(value, max = 120) {
  if (!value) return '';
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

function describeRefreshState(result) {
  if (!result.ok) return `❌ ${platformLabel(result.platform)} ${escapeHtml(result.id)}: ${escapeHtml(result.error)}`;
  if (result.state === 'no_posts') {
    return `ℹ️ ${platformLabel(result.platform)} ${escapeHtml(result.id)}: 账号暂无内容`;
  }
  if (result.state === 'no_new_posts') {
    return `ℹ️ ${platformLabel(result.platform)} ${escapeHtml(result.id)}: 无新更新`;
  }
  return `✅ ${platformLabel(result.platform)} ${escapeHtml(result.id)}: ${result.newCount} 条新增，${result.dedupedCount || 0} 条去重，${result.trimmedCount || 0} 条裁剪`;
}

async function sendAdminAlert(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  try {
    await sendMessage(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, text);
  } catch (e) {
    logError('alert.send_failed', { error: e });
  }
}

async function maybeSendMissingXhsTokenAlert(env) {
  if (env.__xhsMissingTokenAlerted) return;
  env.__xhsMissingTokenAlerted = true;
  await sendAdminAlert(env, '⚠️ <b>TIKHUB_API_TOKEN 未配置</b>\n\n小红书数据无法刷新。');
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
    `平台：${platformLabel(status.platform)}\n` +
    `账号：<code>${escapeHtml(status.user_id)}</code>\n` +
    `连续失败：<b>${currentFailures}</b> 次\n` +
    `最近错误：${escapeHtml(truncate(status.last_error || '未知错误', 180))}`
  );

  await setFailureAlertCount(env.DB, status.platform, status.user_id, currentFailures);
}

async function maybeSendApiUsageAlert(env) {
  const threshold = apiUsageAlertThreshold(env);
  if (!threshold) return;

  const summary = await getApiUsageSummary(env.DB, 1);
  const today = summary[0];
  if (!today?.date || (today.total_calls || 0) < threshold) return;

  const key = `api_usage_alerted:${today.date}`;
  const alreadyAlerted = await getSetting(env.DB, key);
  if (alreadyAlerted === '1') return;

  await sendAdminAlert(
    env,
    `⚠️ <b>TikHub API 调用量告警</b>\n\n` +
    `日期：<b>${today.date}</b>\n` +
    `调用量：<b>${today.total_calls}</b>\n` +
    `阈值：<b>${threshold}</b>`
  );

  await setSetting(env.DB, key, '1');
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

async function validateSubscription(env, platform, userId) {
  if (platform === 'instagram') {
    return validateIg(userId);
  }
  return validateXhs(env, userId);
}

async function refreshInstagramAccount(env, account) {
  const db = env.DB;
  const startedAt = Date.now();
  const cachePlatform = 'ig';
  const userId = account.user_id;

  logInfo('refresh.account.start', { platform: cachePlatform, userId });

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
      durationMs
    };

    logInfo('refresh.account.success', result);
    return result;
  } catch (e) {
    const durationMs = Date.now() - startedAt;
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
      durationMs
    };

    logError('refresh.account.failed', result);
    return result;
  }
}

async function refreshXhsAccount(env, account) {
  const db = env.DB;
  const startedAt = Date.now();
  const cachePlatform = 'xhs';
  const userId = account.user_id;

  logInfo('refresh.account.start', { platform: cachePlatform, userId });

  try {
    const existingIds = await getCachedPostIds(db, cachePlatform, userId);
    const { posts, meta } = await fetchXhs(env, userId, existingIds);
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
      durationMs
    };

    logInfo('refresh.account.success', result);
    return result;
  } catch (e) {
    const durationMs = Date.now() - startedAt;
    await markCrawlFailure(db, cachePlatform, userId, {
      error: e.message,
      durationMs
    });
    const status = await getCrawlStatus(db, cachePlatform, userId);
    await maybeSendFailureAlert(env, status);

    if (e.code === 'NO_API_TOKEN') {
      await maybeSendMissingXhsTokenAlert(env);
    }

    const result = {
      platform: cachePlatform,
      id: userId,
      ok: false,
      state: 'error',
      error: e.message,
      durationMs
    };

    logError('refresh.account.failed', result);
    return result;
  }
}

async function refreshAccount(env, account) {
  return account.platform === 'instagram'
    ? refreshInstagramAccount(env, account)
    : refreshXhsAccount(env, account);
}

async function refreshAllCaches(env, platform = null) {
  const db = env.DB;
  const igAccounts = (!platform || platform === 'instagram') ? await getAccountsByPlatform(db, 'instagram') : [];
  const xhsAccounts = (!platform || platform === 'xiaohongshu') ? await getAccountsByPlatform(db, 'xiaohongshu') : [];
  const tasks = [...igAccounts, ...xhsAccounts];

  logInfo('refresh.batch.start', {
    totalAccounts: tasks.length,
    concurrency: refreshConcurrency(env)
  });

  const results = await runWithConcurrency(tasks, refreshConcurrency(env), account => refreshAccount(env, account));
  await maybeSendApiUsageAlert(env);

  logInfo('refresh.batch.finish', {
    totalAccounts: tasks.length,
    failures: results.filter(r => !r.ok).length
  });

  return results;
}

async function refreshSingleAccount(env, platform, userId) {
  const account = await getAccount(env.DB, platform, userId);
  if (!account) {
    return null;
  }
  return refreshAccount(env, account);
}

async function purgeSingleAccount(env, cachePlatform, userId) {
  const accountPlatform = toAccountPlatform(cachePlatform);
  const account = await getAccount(env.DB, accountPlatform, userId);
  if (!account) return null;

  const removed = await clearCachedPosts(env.DB, cachePlatform, userId);
  logInfo('cache.purged', { platform: cachePlatform, userId, removed });
  return { platform: cachePlatform, id: userId, removed };
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

// ─── 小红书 RSS（仅返回缓存，不触发刷新）─────────────────────────────────────

app.get('/rss/xhs/:userId', async c => {
  const { userId } = c.req.param();
  const db = c.env.DB;
  const account = await getAccount(db, 'xiaohongshu', userId);

  if (!account) {
    return c.text('Forbidden: Account not in whitelist', 403);
  }

  const displayName = account.display_name || userId;
  const baseUrl = getBaseUrl(c.env, c.req.raw);

  const cachedRows = await getCachedPosts(db, 'xhs', userId);
  const cachedPosts = cachedRows.map(rowToPost);

  return rssResponse(generateXhsFeed(userId, displayName, cachedPosts, baseUrl));
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

  const results = await refreshAllCaches(c.env);
  return c.json({ refreshed: results });
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
        const validation = await validateSubscription(env, 'instagram', username);
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

      case 'add_xhs': {
        if (!args[0]) { await sendMessage(token, chatId, '❌ 用法：/add_xhs &lt;userId&gt; [displayName]'); break; }
        const userId = args[0].trim();
        const displayName = args.slice(1).join(' ').trim() || userId;

        if (await getAccount(db, 'xiaohongshu', userId)) {
          await sendMessage(token, chatId, `⚠️ 订阅已存在：<code>${escapeHtml(userId)}</code>`);
          break;
        }

        await sendMessage(token, chatId, `🔎 正在校验小红书账号 <code>${escapeHtml(userId)}</code>...`);
        const validation = await validateSubscription(env, 'xiaohongshu', userId);
        const ok = await addAccount(db, 'xiaohongshu', userId, displayName);

        if (ok) {
          const baseUrl = getBaseUrl(env, { url: 'https://your-worker.workers.dev' });
          await sendMessage(token, chatId,
            `✅ 已添加小红书订阅：<b>${escapeHtml(displayName)}</b>\n\n` +
            `📡 RSS: <code>${baseUrl}/rss/xhs/${escapeHtml(userId)}</code>\n` +
            `📦 当前可见笔记数：<b>${validation.sourceCount}</b>`);
        } else {
          await sendMessage(token, chatId, `⚠️ 添加失败（可能已存在）：<code>${escapeHtml(userId)}</code>`);
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

      case 'remove_xhs': {
        if (!args[0]) { await sendMessage(token, chatId, '❌ 用法：/remove_xhs &lt;userId&gt;'); break; }
        const userId = args[0].trim();
        const ok = await removeAccount(db, 'xiaohongshu', userId);
        await sendMessage(token, chatId, ok
          ? `✅ 已删除小红书订阅：<code>${escapeHtml(userId)}</code>`
          : `⚠️ 未找到该订阅：<code>${escapeHtml(userId)}</code>`);
        break;
      }

      case 'list': {
        const accounts = await getAccounts(db);
        if (accounts.length === 0) {
          await sendMessage(token, chatId, '📭 暂无订阅，使用 /add_ig 或 /add_xhs 添加。');
          break;
        }
        let msg = '📋 <b>订阅列表</b>\n\n';
        for (const a of accounts) {
          msg += `${platformLabel(a.platform)} <b>${escapeHtml(a.display_name || a.user_id)}</b>\n`;
          msg += `ID: <code>${escapeHtml(a.user_id)}</code>\n\n`;
        }
        await sendMessage(token, chatId, msg);
        break;
      }

      case 'feeds': {
        const accounts = await getAccounts(db);
        const baseUrl = getBaseUrl(env, { url: 'https://your-worker.workers.dev' });
        if (accounts.length === 0) {
          await sendMessage(token, chatId, '📭 暂无订阅，使用 /add_ig 或 /add_xhs 添加。');
          break;
        }
        let msg = '📡 <b>RSS 订阅链接</b>\n\n';
        for (const a of accounts) {
          const path = a.platform === 'instagram' ? `rss/ig/${a.user_id}` : `rss/xhs/${a.user_id}`;
          msg += `${platformLabel(a.platform)} ${escapeHtml(a.display_name || a.user_id)}\n`;
          msg += `<code>${baseUrl}/${escapeHtml(path)}</code>\n\n`;
        }
        await sendMessage(token, chatId, msg);
        break;
      }

      case 'status': {
        const igAccounts = await getAccountsByPlatform(db, 'instagram');
        const xhsAccounts = await getAccountsByPlatform(db, 'xiaohongshu');
        const statuses = await getCrawlStatuses(db);
        const summary = formatStatusSummary(statuses);
        const failures = statuses.filter(s => (s.consecutive_failures || 0) > 0)
          .sort((a, b) => (b.consecutive_failures || 0) - (a.consecutive_failures || 0))
          .slice(0, 5);

        let msg = '📊 <b>服务状态</b>\n\n';
        msg += `Instagram：<b>${igAccounts.length}</b> 个订阅\n`;
        msg += `小红书：<b>${xhsAccounts.length}</b> 个订阅\n`;
        msg += `TikHub Token：${env.TIKHUB_API_TOKEN ? '✅ 已配置' : '❌ 未配置'}\n`;

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
            msg += `${platformLabel(item.platform)} <code>${escapeHtml(item.user_id)}</code>: 连续失败 ${item.consecutive_failures} 次\n`;
            if (item.last_error) {
              msg += `${escapeHtml(truncate(item.last_error, 80))}\n`;
            }
          }
        }

        await sendMessage(token, chatId, msg);
        break;
      }

      case 'api_usage': {
        const days = parseInt(args[0] || '7', 10) || 7;
        const usage = await getApiUsage(db, days);
        const summary = await getApiUsageSummary(db, days);
        if (summary.length === 0) {
          await sendMessage(token, chatId, '📊 暂无 API 调用记录。');
          break;
        }
        let msg = `📊 <b>TikHub API 调用量（近 ${days} 天）</b>\n\n`;
        for (const day of summary) {
          msg += `📅 <b>${day.date}</b>：共 ${day.total_calls} 次\n`;
          const dayDetails = usage.filter(u => u.date === day.date);
          for (const detail of dayDetails) {
            msg += `• ${escapeHtml(detail.endpoint)}：${detail.calls} 次\n`;
          }
          msg += '\n';
        }
        const totalAll = summary.reduce((sum, day) => sum + day.total_calls, 0);
        msg += `📈 合计：<b>${totalAll}</b> 次`;
        await sendMessage(token, chatId, msg);
        break;
      }

      case 'refresh': {
        await sendMessage(token, chatId, '🔄 正在刷新全部缓存...');
        const results = await refreshAllCaches(env);
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
        const result = await refreshInstagramAccount(env, account);
        await sendMessage(token, chatId, describeRefreshState(result));
        break;
      }

      case 'refresh_xhs': {
        if (!args[0]) { await sendMessage(token, chatId, '❌ 用法：/refresh_xhs &lt;userId&gt;'); break; }
        const userId = args[0].trim();
        await sendMessage(token, chatId, `🔄 正在刷新小红书 <code>${escapeHtml(userId)}</code>...`);
        const result = await refreshSingleAccount(env, 'xiaohongshu', userId);
        if (!result) {
          await sendMessage(token, chatId, `⚠️ 未找到订阅：<code>${escapeHtml(userId)}</code>`);
          break;
        }
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

      case 'purge_xhs': {
        if (!args[0]) { await sendMessage(token, chatId, '❌ 用法：/purge_xhs &lt;userId&gt;'); break; }
        const userId = args[0].trim();
        const result = await purgeSingleAccount(env, 'xhs', userId);
        if (!result) {
          await sendMessage(token, chatId, `⚠️ 未找到订阅：<code>${escapeHtml(userId)}</code>`);
          break;
        }
        await sendMessage(token, chatId,
          `🧹 已清理小红书缓存：<code>${escapeHtml(userId)}</code>\n` +
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
    if (event.cron === '*/10 * * * *') {
      ctx.waitUntil(refreshAllCaches(env, 'instagram'));
    } else if (event.cron === '0 * * * *') {
      ctx.waitUntil(refreshAllCaches(env, 'xiaohongshu'));
    }
  }
};
