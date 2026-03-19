import { Hono } from 'hono';
import {
  getAccounts, getAccountsByPlatform, getAccount,
  addAccount, removeAccount,
  getCachedPosts, upsertPosts, isCacheStale, rowToPost,
  getApiUsage, getApiUsageSummary
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
    icon: a.platform === 'instagram' ? '📸' : '🍠',
    name: a.display_name || a.user_id,
    userId: a.user_id,
    rssUrl: a.platform === 'instagram'
      ? `${baseUrl}/rss/ig/${a.user_id}`
      : `${baseUrl}/rss/xhs/${a.user_id}`,
    profileUrl: a.platform === 'instagram'
      ? `https://www.instagram.com/${a.user_id}/`
      : `https://www.xiaohongshu.com/user/profile/${a.user_id}`
  }));

  const todaySummary = await getApiUsageSummary(db, 1);
  const todayCalls = todaySummary[0]?.total_calls || 0;

  const html = buildHomePage(feeds, todayCalls);
  return c.html(html);
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
        '/api_usage [天数] — TikHub API 调用量\n' +
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

    case 'api_usage': {
      const days = parseInt(args[0]) || 7;
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
        for (const d of dayDetails) {
          msg += `   • ${d.endpoint}：${d.calls} 次\n`;
        }
        msg += '\n';
      }
      const totalAll = summary.reduce((s, d) => s + d.total_calls, 0);
      msg += `📈 合计：<b>${totalAll}</b> 次`;
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

// ─── 首页 HTML 生成 ──────────────────────────────────────────────────────────

function buildHomePage(feeds, todayCalls) {
  const feedCards = feeds.map(f => `
      <div class="card">
        <div class="card-header">
          <span class="icon">${f.icon}</span>
          <div>
            <div class="card-title">${esc(f.name)}</div>
            <div class="card-platform">${esc(f.platform)}</div>
          </div>
        </div>
        <div class="card-links">
          <a href="${esc(f.rssUrl)}" class="btn btn-rss" title="RSS 订阅">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 11a9 9 0 0 1 9 9"/><path d="M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1"/></svg>
            RSS
          </a>
          <a href="${esc(f.profileUrl)}" class="btn btn-profile" target="_blank" rel="noopener">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
            主页
          </a>
        </div>
      </div>`).join('\n');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Social RSS Bridge</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
    background:linear-gradient(135deg,#0f0c29,#302b63,#24243e);min-height:100vh;color:#e0e0e0}
  .container{max-width:720px;margin:0 auto;padding:40px 20px}
  .header{text-align:center;margin-bottom:40px}
  .header h1{font-size:2rem;font-weight:700;background:linear-gradient(90deg,#f093fb,#f5576c,#fda085);
    -webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:8px}
  .header p{color:#9e9eb8;font-size:0.95rem}
  .stats{display:flex;justify-content:center;gap:24px;margin:24px 0}
  .stat{background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.08);
    border-radius:12px;padding:16px 28px;text-align:center;backdrop-filter:blur(8px)}
  .stat-value{font-size:1.8rem;font-weight:700;color:#f5576c}
  .stat-label{font-size:0.8rem;color:#9e9eb8;margin-top:4px}
  .section-title{font-size:1.1rem;font-weight:600;color:#c0b8e8;margin:32px 0 16px;
    display:flex;align-items:center;gap:8px}
  .card{background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);
    border-radius:14px;padding:20px;margin-bottom:12px;
    transition:transform .2s,border-color .2s;backdrop-filter:blur(8px)}
  .card:hover{transform:translateY(-2px);border-color:rgba(245,87,108,0.3)}
  .card-header{display:flex;align-items:center;gap:14px;margin-bottom:14px}
  .icon{font-size:2rem;width:48px;height:48px;display:flex;align-items:center;justify-content:center;
    background:rgba(255,255,255,0.08);border-radius:12px}
  .card-title{font-size:1.05rem;font-weight:600;color:#f0eef6}
  .card-platform{font-size:0.82rem;color:#8e8ea8;margin-top:2px}
  .card-links{display:flex;gap:10px}
  .btn{display:inline-flex;align-items:center;gap:6px;padding:8px 16px;border-radius:8px;
    font-size:0.82rem;font-weight:500;text-decoration:none;transition:all .2s}
  .btn-rss{background:rgba(245,87,108,0.15);color:#f5576c;border:1px solid rgba(245,87,108,0.25)}
  .btn-rss:hover{background:rgba(245,87,108,0.25)}
  .btn-profile{background:rgba(160,140,255,0.12);color:#a08cff;border:1px solid rgba(160,140,255,0.2)}
  .btn-profile:hover{background:rgba(160,140,255,0.22)}
  .footer{text-align:center;margin-top:48px;color:#6e6e88;font-size:0.8rem}
  .empty{text-align:center;padding:40px;color:#8e8ea8}
  @media(max-width:480px){.container{padding:24px 16px}.header h1{font-size:1.5rem}
    .stats{flex-direction:column;align-items:center;gap:12px}}
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>Social RSS Bridge</h1>
    <p>将社交媒体转换为 RSS 订阅源</p>
  </div>
  <div class="stats">
    <div class="stat">
      <div class="stat-value">${feeds.length}</div>
      <div class="stat-label">订阅源</div>
    </div>
    <div class="stat">
      <div class="stat-value">${todayCalls}</div>
      <div class="stat-label">今日 API 调用</div>
    </div>
  </div>
  <div class="section-title">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 11a9 9 0 0 1 9 9"/><path d="M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1"/></svg>
    订阅源
  </div>
  ${feeds.length > 0 ? feedCards : '<div class="empty">暂无订阅，通过 Telegram Bot 添加。</div>'}
  <div class="footer">Powered by Cloudflare Workers &amp; D1</div>
</div>
</body>
</html>`;
}

function esc(s) {
  return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
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
