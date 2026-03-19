import { Hono } from 'hono';
import {
  getAccounts, getAccountsByPlatform, getAccount,
  addAccount, removeAccount,
  getCachedPosts, upsertPosts, isCacheStale, rowToPost
} from './db.js';
import { generateInstagramFeed, generateXhsFeed } from './rss.js';
import { sendMessage, setWebhook, parseCommand, verifyWebhookSecret } from './telegram.js';
import { handleImageProxy } from './proxy.js';
import { fetchProfile as fetchIg } from './crawlers/instagram.js';
import { fetchProfile as fetchXhs } from './crawlers/xhs_tikhub.js';

const app = new Hono();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getBaseUrl(env, req) {
  return env.BASE_URL || `https://${new URL(req.url).host}`;
}

function cacheTtl(env) {
  return parseInt(env.CACHE_TTL_MINUTES || '60', 10);
}

function rssResponse(xml) {
  return new Response(xml, {
    headers: {
      'Content-Type': 'application/rss+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=1800'
    }
  });
}

// ─── 首页 ─────────────────────────────────────────────────────────────────────

app.get('/', async c => {
  const db = c.env.DB;
  const accounts = await getAccounts(db);
  const baseUrl = getBaseUrl(c.env, c.req.raw);
  const feeds = accounts.map(a => ({
    platform: a.platform === 'instagram' ? 'Instagram' : '小红书',
    name: a.display_name || a.user_id,
    rssUrl: a.platform === 'instagram'
      ? `${baseUrl}/rss/ig/${a.user_id}`
      : `${baseUrl}/rss/xhs/${a.user_id}`
  }));
  return c.json({ service: 'Social RSS Bridge', status: 'running', feeds });
});

// ─── 状态 ─────────────────────────────────────────────────────────────────────

app.get('/status', async c => {
  const db = c.env.DB;
  const igAccounts = await getAccountsByPlatform(db, 'instagram');
  const xhsAccounts = await getAccountsByPlatform(db, 'xiaohongshu');
  return c.json({
    instagram: { accounts: igAccounts.length, method: 'Public API' },
    xiaohongshu: { accounts: xhsAccounts.length, method: 'TikHub API' },
    tikhub: { configured: !!c.env.TIKHUB_API_TOKEN },
    worker: 'active'
  });
});

// ─── 图片代理 ─────────────────────────────────────────────────────────────────

app.get('/img', handleImageProxy);

// ─── Instagram RSS（D1 缓存优先）──────────────────────────────────────────────

app.get('/rss/ig/:username', async c => {
  const { username } = c.req.param();
  const db = c.env.DB;
  const account = await getAccount(db, 'instagram', username);

  if (!account) {
    return c.text('Forbidden: Account not in whitelist', 403);
  }

  const displayName = account.display_name || username;
  const ttl = cacheTtl(c.env);
  const baseUrl = getBaseUrl(c.env, c.req.raw);

  const cachedRows = await getCachedPosts(db, 'ig', username);
  const cachedPosts = cachedRows.map(rowToPost);
  const stale = await isCacheStale(db, 'ig', username, ttl);

  if (stale || cachedPosts.length === 0) {
    c.executionCtx.waitUntil(
      fetchIg(username)
        .then(newPosts => upsertPosts(db, 'ig', username, newPosts))
        .catch(e => console.error(`[bg-ig] ${username}: ${e.message}`))
    );
  }

  return rssResponse(generateInstagramFeed(username, displayName, cachedPosts, baseUrl));
});

// ─── 小红书 RSS（D1 缓存优先，TikHub API）─────────────────────────────────────

app.get('/rss/xhs/:userId', async c => {
  const { userId } = c.req.param();
  const db = c.env.DB;
  const account = await getAccount(db, 'xiaohongshu', userId);

  if (!account) {
    return c.text('Forbidden: Account not in whitelist', 403);
  }

  const displayName = account.display_name || userId;
  const ttl = cacheTtl(c.env);
  const baseUrl = getBaseUrl(c.env, c.req.raw);

  const cachedRows = await getCachedPosts(db, 'xhs', userId);
  const cachedPosts = cachedRows.map(rowToPost);
  const stale = await isCacheStale(db, 'xhs', userId, ttl);

  if (stale || cachedPosts.length === 0) {
    c.executionCtx.waitUntil(
      fetchXhs(c.env, userId)
        .then(newPosts => upsertPosts(db, 'xhs', userId, newPosts))
        .catch(async e => {
          console.error(`[bg-xhs] ${userId}: ${e.message}`);
          if (e.code === 'NO_API_TOKEN') {
            await sendMessage(c.env.TELEGRAM_BOT_TOKEN, c.env.TELEGRAM_CHAT_ID,
              '⚠️ TIKHUB_API_TOKEN 未配置，小红书数据无法获取。'
            ).catch(() => {});
          }
        })
    );
  }

  return rssResponse(generateXhsFeed(userId, displayName, cachedPosts, baseUrl));
});

// ─── Telegram Webhook 设置（部署后调用一次）──────────────────────────────────

app.get('/setup-webhook', async c => {
  if (!c.env.ADMIN_TOKEN || c.req.query('token') !== c.env.ADMIN_TOKEN) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  const baseUrl = getBaseUrl(c.env, c.req.raw);
  const secretToken = c.env.ADMIN_TOKEN || '';
  const result = await setWebhook(c.env.TELEGRAM_BOT_TOKEN, `${baseUrl}/telegram`, secretToken);
  return c.json(result);
});

// ─── Admin: 手动刷新缓存 ─────────────────────────────────────────────────────

app.get('/admin/refresh', async c => {
  if (!c.env.ADMIN_TOKEN || c.req.query('token') !== c.env.ADMIN_TOKEN) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  const results = await refreshAllCaches(c.env);
  return c.json({ refreshed: results });
});

// ─── Telegram Webhook ─────────────────────────────────────────────────────────

app.post('/telegram', async c => {
  // 校验 Telegram Webhook Secret Token
  if (!verifyWebhookSecret(c.req.raw, c.env.ADMIN_TOKEN || '')) {
    return c.text('ok');
  }

  let update;
  try { update = await c.req.json(); } catch { return c.text('ok'); }

  const msg = update.message;
  if (!msg?.text) return c.text('ok');

  const chatId = msg.chat.id;
  const token = c.env.TELEGRAM_BOT_TOKEN;
  const allowedChat = c.env.TELEGRAM_CHAT_ID;

  if (String(chatId) !== String(allowedChat)) return c.text('ok');

  const parsed = parseCommand(msg.text);
  if (!parsed) return c.text('ok');

  c.executionCtx.waitUntil(handleCommand(parsed, c.env, chatId, token));
  return c.text('ok');
});

// ─── Telegram 命令处理 ────────────────────────────────────────────────────────

async function handleCommand({ cmd, args }, env, chatId, token) {
  const db = env.DB;

  switch (cmd) {
    case 'start':
    case 'help':
      await sendMessage(token, chatId,
        '🤖 <b>Social RSS Bridge</b>\n\n' +
        '<b>订阅管理：</b>\n' +
        '/add_ig &lt;username&gt; [displayName] — 添加 IG 订阅\n' +
        '/add_xhs &lt;userId&gt; [displayName] — 添加小红书订阅\n' +
        '/remove_ig &lt;username&gt; — 删除 IG 订阅\n' +
        '/remove_xhs &lt;userId&gt; — 删除小红书订阅\n' +
        '/list — 列出所有订阅\n\n' +
        '<b>其他：</b>\n' +
        '/feeds — 列出 RSS 链接\n' +
        '/status — 查看服务状态\n' +
        '/refresh — 立即刷新缓存\n' +
        '/help — 显示此帮助');
      break;

    case 'add_ig': {
      if (!args[0]) { await sendMessage(token, chatId, '❌ 用法：/add_ig &lt;username&gt; [displayName]'); break; }
      const username = args[0];
      const displayName = args.slice(1).join(' ') || username;
      const ok = await addAccount(db, 'instagram', username, displayName);
      if (ok) {
        const baseUrl = env.BASE_URL || 'https://your-worker.workers.dev';
        await sendMessage(token, chatId,
          `✅ 已添加 Instagram 订阅：<b>${displayName}</b>\n\n📡 RSS: <code>${baseUrl}/rss/ig/${username}</code>`);
      } else {
        await sendMessage(token, chatId, `⚠️ 添加失败（可能已存在）：${username}`);
      }
      break;
    }

    case 'add_xhs': {
      if (!args[0]) { await sendMessage(token, chatId, '❌ 用法：/add_xhs &lt;userId&gt; [displayName]'); break; }
      const userId = args[0];
      const displayName = args.slice(1).join(' ') || userId;
      const ok = await addAccount(db, 'xiaohongshu', userId, displayName);
      if (ok) {
        const baseUrl = env.BASE_URL || 'https://your-worker.workers.dev';
        await sendMessage(token, chatId,
          `✅ 已添加小红书订阅：<b>${displayName}</b>\n\n📡 RSS: <code>${baseUrl}/rss/xhs/${userId}</code>`);
      } else {
        await sendMessage(token, chatId, `⚠️ 添加失败（可能已存在）：${userId}`);
      }
      break;
    }

    case 'remove_ig': {
      if (!args[0]) { await sendMessage(token, chatId, '❌ 用法：/remove_ig &lt;username&gt;'); break; }
      const ok = await removeAccount(db, 'instagram', args[0]);
      await sendMessage(token, chatId, ok
        ? `✅ 已删除 Instagram 订阅：${args[0]}`
        : `⚠️ 未找到该订阅：${args[0]}`);
      break;
    }

    case 'remove_xhs': {
      if (!args[0]) { await sendMessage(token, chatId, '❌ 用法：/remove_xhs &lt;userId&gt;'); break; }
      const ok = await removeAccount(db, 'xiaohongshu', args[0]);
      await sendMessage(token, chatId, ok
        ? `✅ 已删除小红书订阅：${args[0]}`
        : `⚠️ 未找到该订阅：${args[0]}`);
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
        const icon = a.platform === 'instagram' ? '📸' : '🍠';
        const plat = a.platform === 'instagram' ? 'IG' : 'XHS';
        msg += `${icon} [${plat}] <b>${a.display_name || a.user_id}</b>\n   ID: <code>${a.user_id}</code>\n\n`;
      }
      await sendMessage(token, chatId, msg);
      break;
    }

    case 'feeds': {
      const accounts = await getAccounts(db);
      const baseUrl = env.BASE_URL || 'https://your-worker.workers.dev';
      if (accounts.length === 0) {
        await sendMessage(token, chatId, '📭 暂无订阅，使用 /add_ig 或 /add_xhs 添加。');
        break;
      }
      let msg = '📡 <b>RSS 订阅链接</b>\n\n';
      for (const a of accounts) {
        const icon = a.platform === 'instagram' ? '📸' : '🍠';
        const path = a.platform === 'instagram' ? `rss/ig/${a.user_id}` : `rss/xhs/${a.user_id}`;
        msg += `${icon} ${a.display_name || a.user_id}\n<code>${baseUrl}/${path}</code>\n\n`;
      }
      await sendMessage(token, chatId, msg);
      break;
    }

    case 'status': {
      const igAccounts = await getAccountsByPlatform(db, 'instagram');
      const xhsAccounts = await getAccountsByPlatform(db, 'xiaohongshu');
      let msg = '📊 <b>服务状态</b>\n\n';
      msg += `📸 Instagram：${igAccounts.length} 个订阅（公开 API）\n\n`;
      msg += `🍠 小红书：${xhsAccounts.length} 个订阅（TikHub API）\n`;
      msg += `   API Token: ${env.TIKHUB_API_TOKEN ? '✅ 已配置' : '❌ 未配置'}\n`;
      await sendMessage(token, chatId, msg);
      break;
    }

    case 'refresh':
      await sendMessage(token, chatId, '🔄 正在刷新所有缓存...');
      try {
        const results = await refreshAllCaches(env);
        let msg = '✅ <b>缓存刷新完成</b>\n\n';
        for (const r of results) {
          msg += r.ok
            ? `✅ ${r.platform} ${r.id}: ${r.posts} 条\n`
            : `❌ ${r.platform} ${r.id}: ${r.error}\n`;
        }
        await sendMessage(token, chatId, msg);
      } catch (e) {
        await sendMessage(token, chatId, `❌ 刷新失败：${e.message}`);
      }
      break;

    default:
      await sendMessage(token, chatId, `未知命令 /${cmd}，发送 /help 查看可用命令。`);
  }
}

// ─── 缓存刷新（Cron + 手动共用）──────────────────────────────────────────────

async function refreshAllCaches(env) {
  console.log('[cron] Starting cache refresh...');
  const db = env.DB;
  const results = [];

  const igAccounts = await getAccountsByPlatform(db, 'instagram');
  for (const a of igAccounts) {
    try {
      const newPosts = await fetchIg(a.user_id);
      await upsertPosts(db, 'ig', a.user_id, newPosts);
      results.push({ platform: 'ig', id: a.user_id, posts: newPosts.length, ok: true });
      console.log(`[cron] IG @${a.user_id}: ${newPosts.length} posts`);
    } catch (e) {
      results.push({ platform: 'ig', id: a.user_id, ok: false, error: e.message });
      console.error(`[cron] IG @${a.user_id} failed: ${e.message}`);
    }
  }

  const xhsAccounts = await getAccountsByPlatform(db, 'xiaohongshu');
  let xhsApiAlerted = false;
  for (const a of xhsAccounts) {
    try {
      const newPosts = await fetchXhs(env, a.user_id);
      await upsertPosts(db, 'xhs', a.user_id, newPosts);
      results.push({ platform: 'xhs', id: a.user_id, posts: newPosts.length, ok: true });
      console.log(`[cron] XHS ${a.user_id}: ${newPosts.length} posts`);
    } catch (e) {
      results.push({ platform: 'xhs', id: a.user_id, ok: false, error: e.message });
      console.error(`[cron] XHS ${a.user_id} failed: ${e.message}`);
      if (!xhsApiAlerted && e.code === 'NO_API_TOKEN') {
        xhsApiAlerted = true;
        await sendMessage(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID,
          '⚠️ TIKHUB_API_TOKEN 未配置，小红书数据无法获取。'
        ).catch(() => {});
      }
    }
  }

  return results;
}

// ─── Export ───────────────────────────────────────────────────────────────────

export default {
  fetch: app.fetch,

  async scheduled(event, env, ctx) {
    console.log(`[scheduled] cron: ${event.cron}`);
    if (event.cron === '0 * * * *') {
      ctx.waitUntil(refreshAllCaches(env));
    }
  }
};
