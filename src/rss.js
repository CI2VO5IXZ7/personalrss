// RSS 2.0 XML 生成 — 含媒体代理 URL 替换

import { escapeHtml, stripHtml } from './html.js';
import { proxyHtmlAssets, proxyImageUrl, proxyMediaUrl } from './proxy.js';

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

    const content = proxyHtmlAssets(
      item.description || buildDefaultDesc(item),
      baseUrl
    );

    const summary = buildSummary(item.description || content);

    const enclosure = buildEnclosure(item, baseUrl);

    return `    <item>
      <title><![CDATA[${item.title || ''}]]></title>
      <link>${escapeXml(item.link || '')}</link>
      <guid isPermaLink="false">${escapeXml(item.id || item.link || '')}</guid>
      <pubDate>${toBeijingRFC822(validDate)}</pubDate>
      <description>${escapeXml(summary)}</description>
      <content:encoded><![CDATA[${content}]]></content:encoded>
      ${enclosure ? `<enclosure url="${escapeXml(enclosure.url)}" type="${escapeXml(enclosure.type)}" length="0"/>` : ''}
    </item>`;
  }).join('\n');
}

function buildEnclosure(item, baseUrl) {
  const rawDescription = item.description || '';
  const videoUrl = extractFirstVideoUrl(rawDescription);

  if ((item.media_type || '').includes('video') && videoUrl) {
    return {
      url: proxyMediaUrl(videoUrl, baseUrl),
      type: 'video/mp4'
    };
  }

  if (item.image) {
    return {
      url: proxyImageUrl(item.image, baseUrl),
      type: 'image/jpeg'
    };
  }

  return null;
}

function extractFirstVideoUrl(html) {
  const match = String(html).match(/<source[^>]+src="([^"]+)"/i);
  return match?.[1] || '';
}

function buildSummary(content) {
  const summary = stripHtml(content || '').replace(/\s+/g, ' ').trim().slice(0, 240);
  return summary || '媒体内容';
}

function buildDefaultDesc(post) {
  let html = '';
  // 优先使用 raw_images 多图展示
  const rawImages = post.raw_images || [];
  if (rawImages.length > 0) {
    for (const imgUrl of rawImages) {
      html += `<p><img src="${imgUrl}" style="max-width:100%"/></p>`;
    }
  } else if (post.image) {
    html += `<p><img src="${post.image}" style="max-width:100%"/></p>`;
  }
  if (post.description) html += `<p>${escapeHtml(post.description).replace(/\n/g, '<br/>')}</p>`;
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
