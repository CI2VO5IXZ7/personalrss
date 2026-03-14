import { Hono } from 'hono';
import { readCache, writeCache, isCacheStale, readCookies, getAccounts } from './store.js';
import { generateInstagramFeed, generateXhsFeed } from './rss.js';
import { sendMessage, sendPhoto, setWebhook, parseCommand } from './telegram.js';
import { handleImageProxy } from './proxy.js';
import { fetchProfile as fetchIg } from './crawlers/instagram.js';
import { fetchProfile as fetchXhs, startQRLogin, confirmLogin } from './crawlers/xhs.js';

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

// 合并去重：新数据 + 旧缓存，按时间排序，保留最新 50 条
function mergePosts(newPosts, cachedPosts) {
  const map = new Map();
  // 旧数据先放入
  for (const p of (cachedPosts || [])) {
    if (p.id) map.set(p.id, p);
  }
  // 新数据覆盖
  for (const p of (newPosts || [])) {
    if (p.id) map.set(p.id, p);
  }
  return [...map.values()]
    .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0))
    .slice(0, 50);
}

// ─── 首页 ─────────────────────────────────────────────────────────────────────

app.get('/', c => {
  const accounts = getAccounts(c.env);
  const baseUrl = getBaseUrl(c.env, c.req.raw);
  const igFeeds = (accounts.instagram || []).map(a => ({
    platform: 'Instagram', name: a.displayName || a.username,
    rssUrl: `${baseUrl}/rss/ig/${a.username}`
  }));
  const xhsFeeds = (accounts.xiaohongshu || []).map(a => ({
    platform: '小红书', name: a.displayName || a.userId,
    rssUrl: `${baseUrl}/rss/xhs/${a.userId}`
  }));
  return c.json({ service: 'Social RSS Bridge', status: 'running', feeds: [...igFeeds, ...xhsFeeds] });
});

// ─── 状态 ─────────────────────────────────────────────────────────────────────

app.get('/status', async c => {
  const xhsCookies = await readCookies(c.env, 'xhs');
  return c.json({
    xiaohongshu: {
      hasCookies: !!xhsCookies?.cookies?.length,
      savedAt: xhsCookies?.savedAt || null
    },
    worker: 'active'
  });
});

// ─── 图片代理 ─────────────────────────────────────────────────────────────────

app.get('/img', handleImageProxy);

// ─── Instagram RSS（缓存优先）─────────────────────────────────────────────────

app.get('/rss/ig/:username', async c => {
  const { username } = c.req.param();
  const accounts = getAccounts(c.env);
  const account = (accounts.instagram || []).find(a => a.username.toLowerCase() === username.toLowerCase());
  if (!account) {
    return c.json({ error: 'Account not configured' }, 404);
  }
  const displayName = account?.displayName || username;
  const ttl = cacheTtl(c.env);
  const baseUrl = getBaseUrl(c.env, c.req.raw);

  const cached = await readCache(c.env, 'ig', username);
  const stale = await isCacheStale(c.env, 'ig', username, ttl);

  if (stale || !cached?.posts) {
    c.executionCtx.waitUntil(
      fetchIg(username)
        .then(newPosts => {
          const merged = mergePosts(newPosts, cached?.posts);
          return writeCache(c.env, 'ig', username, { posts: merged, updatedAt: new Date().toISOString() }, ttl);
        })
        .catch(e => console.error(`[bg-ig] ${username}: ${e.message}`))
    );
  }

  return rssResponse(generateInstagramFeed(username, displayName, cached?.posts || [], baseUrl));
});

// ─── 小红书 RSS（缓存优先）────────────────────────────────────────────────────

app.get('/rss/xhs/:userId', async c => {
  const { userId } = c.req.param();
  const accounts = getAccounts(c.env);
  const account = (accounts.xiaohongshu || []).find(a => a.userId === userId);
  if (!account) {
    return c.json({ error: 'Account not configured' }, 404);
  }
  const displayName = account?.displayName || userId;
  const ttl = cacheTtl(c.env);
  const baseUrl = getBaseUrl(c.env, c.req.raw);

  const cached = await readCache(c.env, 'xhs', userId);
  const stale = await isCacheStale(c.env, 'xhs', userId, ttl);

  if (stale || !cached?.posts) {
    c.executionCtx.waitUntil(
      fetchXhs(c.env, userId)
        .then(newPosts => {
          const merged = mergePosts(newPosts, cached?.posts);
          return writeCache(c.env, 'xhs', userId, { posts: merged, updatedAt: new Date().toISOString() }, ttl);
        })
        .catch(async e => {
          console.error(`[bg-xhs] ${userId}: ${e.message}`);
          if (e.code === 'COOKIE_EXPIRED' || e.code === 'NO_COOKIES') {
            await sendMessage(c.env.TELEGRAM_BOT_TOKEN, c.env.TELEGRAM_CHAT_ID,
              `⚠️ 小红书 Cookie 已失效！请使用 /refresh_xhs 重新登录。`
            ).catch(() => {});
          }
        })
    );
  }

  return rssResponse(generateXhsFeed(userId, displayName, cached?.posts || [], baseUrl));
});

// ─── Telegram Webhook 设置（部署后调用一次）──────────────────────────────────

app.get('/setup-webhook', async c => {
  if (!c.env.ADMIN_TOKEN || c.req.query('token') !== c.env.ADMIN_TOKEN) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  const baseUrl = getBaseUrl(c.env, c.req.raw);
  const result = await setWebhook(c.env.TELEGRAM_BOT_TOKEN, `${baseUrl}/telegram`);
  return c.json(result);
});

// ─── Admin: 手动上传 XHS Cookies ──────────────────────────────────────────────

app.post('/admin/set-xhs-cookies', async c => {
  if (!c.env.ADMIN_TOKEN || c.req.query('token') !== c.env.ADMIN_TOKEN) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  const cookies = await c.req.json();
  const { writeCookies } = await import('./store.js');
  await writeCookies(c.env, 'xhs', cookies);
  return c.json({ ok: true, count: cookies.length });
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
  const accounts = getAccounts(env);

  switch (cmd) {
    case 'start':
    case 'help':
      await sendMessage(token, chatId,
        '🤖 <b>Social RSS Bridge</b>\n\n' +
        '/status — 查看服务状态\n' +
        '/feeds — 列出所有 RSS 链接\n' +
        '/refresh_xhs — 触发小红书扫码登录\n' +
        '/confirm_xhs — 扫码后确认登录状态\n' +
        '/refresh — 立即刷新所有缓存\n' +
        '/help — 显示此帮助');
      break;

    case 'feeds': {
      const baseUrl = env.BASE_URL || 'https://your-worker.workers.dev';
      let msg = '📡 <b>RSS 订阅链接</b>\n\n';
      for (const a of (accounts.instagram || [])) {
        msg += `📸 ${a.displayName || a.username}\n<code>${baseUrl}/rss/ig/${a.username}</code>\n\n`;
      }
      for (const a of (accounts.xiaohongshu || [])) {
        msg += `🍠 ${a.displayName || a.userId}\n<code>${baseUrl}/rss/xhs/${a.userId}</code>\n\n`;
      }
      await sendMessage(token, chatId, msg);
      break;
    }

    case 'status': {
      const xhsCookies = await readCookies(env, 'xhs');
      let msg = '📊 <b>服务状态</b>\n\n';
      msg += '📸 Instagram：无需 Cookie（公开 API）\n\n';
      msg += '🍠 小红书：\n';
      msg += xhsCookies?.cookies?.length
        ? `  Cookie: ✅ 已保存 (${new Date(xhsCookies.savedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })})\n`
        : '  Cookie: ❌ 未设置，使用 /refresh_xhs 登录\n';
      await sendMessage(token, chatId, msg);
      break;
    }

    case 'refresh_xhs':
      await sendMessage(token, chatId, '🔄 正在启动小红书扫码登录，请稍候...');
      try {
        await startQRLogin(env);
      } catch (e) {
        await sendMessage(token, chatId, `❌ 启动 QR 登录失败：${e.message}`);
      }
      break;

    case 'confirm_xhs':
      await sendMessage(token, chatId, '🔍 正在检查登录状态...');
      try {
        const result = await confirmLogin(env);
        if (result.success) {
          await sendMessage(token, chatId, `✅ ${result.message}`);
        } else {
          await sendMessage(token, chatId, `⚠️ ${result.message}`);
        }
      } catch (e) {
        await sendMessage(token, chatId, `❌ 确认失败：${e.message}`);
      }
      break;

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
  const accounts = getAccounts(env);
  const ttl = parseInt(env.CACHE_TTL_MINUTES || '60', 10);
  const results = [];

  for (const a of (accounts.instagram || [])) {
    try {
      const cached = await readCache(env, 'ig', a.username);
      const newPosts = await fetchIg(a.username);
      const merged = mergePosts(newPosts, cached?.posts);
      await writeCache(env, 'ig', a.username, { posts: merged, updatedAt: new Date().toISOString() }, ttl);
      results.push({ platform: 'ig', id: a.username, posts: merged.length, ok: true });
      console.log(`[cron] IG @${a.username}: ${merged.length} posts`);
    } catch (e) {
      results.push({ platform: 'ig', id: a.username, ok: false, error: e.message });
      console.error(`[cron] IG @${a.username} failed: ${e.message}`);
    }
  }

  let xhsCookieAlerted = false;
  for (const a of (accounts.xiaohongshu || [])) {
    try {
      const cached = await readCache(env, 'xhs', a.userId);
      const newPosts = await fetchXhs(env, a.userId);
      const merged = mergePosts(newPosts, cached?.posts);
      await writeCache(env, 'xhs', a.userId, { posts: merged, updatedAt: new Date().toISOString() }, ttl);
      results.push({ platform: 'xhs', id: a.userId, posts: merged.length, ok: true });
      console.log(`[cron] XHS ${a.userId}: ${merged.length} posts`);
    } catch (e) {
      results.push({ platform: 'xhs', id: a.userId, ok: false, error: e.message });
      console.error(`[cron] XHS ${a.userId} failed: ${e.message}`);
      // Cookie 失效时通过 Telegram 提醒（每次 cron 只提醒一次）
      if (!xhsCookieAlerted && (e.code === 'COOKIE_EXPIRED' || e.code === 'NO_COOKIES')) {
        xhsCookieAlerted = true;
        await sendMessage(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID,
          '⚠️ 小红书 Cookie 已失效！请使用 /refresh_xhs 重新登录。'
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
