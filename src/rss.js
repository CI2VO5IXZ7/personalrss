// RSS 2.0 XML 生成 — 含图片代理 URL 替换

import { proxyImageUrl, proxyHtmlImages } from './proxy.js';

// 将日期格式化为 RFC 822 北京时间（+0800）
function toBeijingRFC822(date) {
  const d = new Date(date.getTime() + 8 * 3600 * 1000);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = n => String(n).padStart(2, '0');
  return `${days[d.getUTCDay()]}, ${pad(d.getUTCDate())} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} +0800`;
}

function escapeXml(str) {
  return (str || '').toString()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildItemsXml(items, baseUrl) {
  return items.slice(0, 50).map(item => {
    const date = item.date ? new Date(item.date) : new Date();
    const validDate = isNaN(date.getTime()) ? new Date() : date;

    // 将 description 中的图片 URL 替换为代理 URL
    const description = proxyHtmlImages(
      item.description || buildDefaultDesc(item),
      baseUrl
    );

    // enclosure 图片也走代理
    const proxyImg = item.image ? proxyImageUrl(item.image, baseUrl) : '';

    return `    <item>
      <title><![CDATA[${item.title || ''}]]></title>
      <link>${escapeXml(item.link || '')}</link>
      <guid isPermaLink="false">${escapeXml(item.id || item.link || '')}</guid>
      <pubDate>${toBeijingRFC822(validDate)}</pubDate>
      <description><![CDATA[${description}]]></description>
      <content:encoded><![CDATA[${description}]]></content:encoded>
      ${proxyImg ? `<enclosure url="${escapeXml(proxyImg)}" type="image/jpeg" length="0"/>` : ''}
    </item>`;
  }).join('\n');
}

function buildDefaultDesc(post) {
  let html = '';
  if (post.image) html += `<p><img src="${post.image}" style="max-width:100%"/></p>`;
  if (post.description) html += `<p>${post.description.replace(/\n/g, '<br/>')}</p>`;
  return html || '<p>（无内容）</p>';
}

export function generateInstagramFeed(username, displayName, posts, baseUrl) {
  const feedUrl = `${baseUrl}/rss/ig/${username}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title><![CDATA[${displayName || username} - Instagram]]></title>
    <link>https://www.instagram.com/${username}/</link>
    <description><![CDATA[Instagram posts from @${username}]]></description>
    <language>zh-CN</language>
    <atom:link href="${escapeXml(feedUrl)}" rel="self" type="application/rss+xml"/>
    <lastBuildDate>${toBeijingRFC822(new Date())}</lastBuildDate>
${buildItemsXml(posts, baseUrl)}
  </channel>
</rss>`;
}

export function generateXhsFeed(userId, displayName, posts, baseUrl) {
  const feedUrl = `${baseUrl}/rss/xhs/${userId}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title><![CDATA[${displayName || userId} - 小红书]]></title>
    <link>https://www.xiaohongshu.com/user/profile/${userId}</link>
    <description><![CDATA[小红书用户 ${displayName || userId} 的笔记]]></description>
    <language>zh-CN</language>
    <atom:link href="${escapeXml(feedUrl)}" rel="self" type="application/rss+xml"/>
    <lastBuildDate>${toBeijingRFC822(new Date())}</lastBuildDate>
${buildItemsXml(posts, baseUrl)}
  </channel>
</rss>`;
}
