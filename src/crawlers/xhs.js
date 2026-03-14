// 小红书抓取 — CF Browser Rendering scrape API + Cookie
import { readCookies, writeCookies } from '../store.js';
import { sendMessage, sendPhoto } from '../telegram.js';

const XHS_BASE = 'https://www.xiaohongshu.com';

// ─── CF Browser Rendering scrape ─────────────────────────────────────────────

export async function cfScrape(env, url, elements, cookies = []) {
  const cfUrl = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/browser-rendering/scrape`;
  const resp = await fetch(cfUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.CF_API_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      url,
      elements,
      cookies: cookies.map(c => ({
        name: c.name, value: c.value,
        domain: c.domain || '.xiaohongshu.com', path: c.path || '/'
      })),
      gotoOptions: { waitUntil: 'networkidle0', timeout: 25000 }
    })
  });
  if (!resp.ok) throw new Error(`CF scrape HTTP ${resp.status}`);
  const data = await resp.json();
  if (!data.success) throw new Error(`CF scrape failed: ${JSON.stringify(data.errors)}`);
  return data.result;
}

async function cfScreenshot(env, url) {
  const cfUrl = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/browser-rendering/screenshot`;
  const resp = await fetch(cfUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.CF_API_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      url,
      gotoOptions: { waitUntil: 'networkidle0', timeout: 30000 }
    })
  });
  if (!resp.ok) throw new Error(`CF screenshot HTTP ${resp.status}`);
  return resp.arrayBuffer();
}

// ─── Note Item 解析 ──────────────────────────────────────────────────────────

function parseNoteItem(html, userId) {
  try {
    // 提取所有 href，跳过隐藏的假链接，找含 24-char hex noteId（且不等于 userId）的链接
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)]
      .map(m => m[1])
      .filter(h => !h.includes('display'));
    const noteLink = hrefs.find(h => {
      const id = h.match(/([a-f0-9]{24})/)?.[1];
      return id && id !== userId;
    });
    const noteId = noteLink?.match(/([a-f0-9]{24})/)?.[1] || '';

    // XHS CDN 图片：按域名匹配（xhscdn.com / ci.xiaohongshu / sns-img），不依赖文件扩展名
    const img = (
      html.match(/(?:src|data-src)="(https?:\/\/[^"]*(?:xhscdn\.com|ci\.xiaohongshu|sns-img)[^"]*)"/) ||
      html.match(/(?:src|data-src)="(https?:\/\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/) ||
      html.match(/(?:src|data-src)="(https?:\/\/[^"]{30,})"/)
    )?.[1] || '';

    const title = (
      html.match(/class="[^"]*title[^"]*"[^>]*>\s*([^<]{2,100})\s*</) ||
      html.match(/<span[^>]*>\s*([^<]{4,100})\s*<\/span>/)
    )?.[1]?.trim() || '';

    const desc = (html.match(/class="[^"]*desc[^"]*"[^>]*>\s*([^<]{2,200})\s*</)?.[1] || '').trim();

    if (!noteId && !img) return null;

    const link = noteLink
      ? (noteLink.startsWith('http') ? noteLink : `${XHS_BASE}${noteLink}`)
      : `${XHS_BASE}/user/profile/${userId}`;

    // noteId 是 MongoDB ObjectID，前 8 位 hex = unix timestamp（秒）
    let date = new Date().toISOString();
    if (noteId && noteId.length >= 8) {
      const ts = parseInt(noteId.substring(0, 8), 16);
      if (ts > 1000000000 && ts < 2000000000) {
        date = new Date(ts * 1000).toISOString();
      }
    }

    return {
      id: noteId || img,
      title: title || desc.substring(0, 80) || 'XHS 笔记',
      description: desc || title || '',
      link,
      image: img,
      date
    };
  } catch { return null; }
}

// ─── 公开接口 ────────────────────────────────────────────────────────────────

export async function fetchProfile(env, userId) {
  const cookieData = await readCookies(env, 'xhs');
  if (!cookieData?.cookies?.length) {
    throw Object.assign(new Error('[xhs] No cookies. Use /refresh_xhs in Telegram.'), { code: 'NO_COOKIES' });
  }

  const result = await cfScrape(
    env,
    `${XHS_BASE}/user/profile/${userId}`,
    [{ selector: 'section.note-item' }, { selector: '.note-item' }, { selector: 'title' }],
    cookieData.cookies
  );

  // 检测登录态失效
  const titleEl = result.find(r => r.selector === 'title');
  if (titleEl?.results?.[0]?.text?.match(/登录|login|验证/i)) {
    throw Object.assign(new Error('[xhs] Cookie expired'), { code: 'COOKIE_EXPIRED' });
  }

  const posts = [];
  const seenIds = new Set();
  for (const section of result) {
    if (!section.results?.length) continue;
    for (const item of section.results) {
      const post = parseNoteItem(item.html || '', userId);
      if (post && !seenIds.has(post.id)) {
        seenIds.add(post.id);
        posts.push(post);
      }
    }
    if (posts.length > 0) break;
  }
  return posts;
}

export async function validateCookies(env) {
  const cookieData = await readCookies(env, 'xhs');
  if (!cookieData?.cookies?.length) return false;
  try {
    const result = await cfScrape(env, `${XHS_BASE}/`, [{ selector: 'title' }], cookieData.cookies);
    const title = result.find(r => r.selector === 'title')?.results?.[0]?.text || '';
    return !title.match(/登录|login/i);
  } catch { return false; }
}

// ─── QR 登录（截图发 Telegram，用户扫码后手动 /confirm_xhs 确认）─────────────

export async function startQRLogin(env) {
  const screenshotBytes = await cfScreenshot(env, `${XHS_BASE}/login`);

  await sendPhoto(
    env.TELEGRAM_BOT_TOKEN,
    env.TELEGRAM_CHAT_ID,
    screenshotBytes,
    '🍠 请用小红书 App 扫描上方二维码登录\n⏰ 有效时间：3 分钟\n\n扫码成功后请发送 /confirm_xhs 确认登录'
  );

  return { success: true };
}

export async function confirmLogin(env) {
  // 使用 Browser Rendering 访问首页，检查 Set-Cookie 和页面标题
  const cfUrl = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/browser-rendering/content`;
  const resp = await fetch(cfUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.CF_API_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      url: `${XHS_BASE}/`,
      gotoOptions: { waitUntil: 'networkidle0', timeout: 25000 }
    })
  });

  if (!resp.ok) throw new Error(`CF content HTTP ${resp.status}`);

  // 尝试从现有 KV 中读取 cookies，如果用户之前手动上传过就复用
  const existing = await readCookies(env, 'xhs');
  if (existing?.cookies?.length) {
    // 验证现有 cookie 是否有效
    const valid = await validateCookies(env);
    if (valid) {
      return { success: true, message: '当前 Cookie 仍然有效' };
    }
  }

  return {
    success: false,
    message: '无法自动获取 Cookie。请手动从浏览器导出 Cookie 并通过 /admin/set-xhs-cookies 接口上传。'
  };
}
