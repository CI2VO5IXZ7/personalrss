// 通用 RSS 2.0 Renderer

import { escapeHtml, stripHtml } from '../../html.js';
import { proxyImageUrl, proxyMediaUrl, proxyHtmlAssets } from '../../proxy.js';

const RFC822_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const RFC822_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function toBeijingRFC822(date) {
  const d = new Date(date.getTime() + 8 * 3600 * 1000);
  const pad = n => String(n).padStart(2, '0');
  return `${RFC822_DAYS[d.getUTCDay()]}, ${pad(d.getUTCDate())} ${RFC822_MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} +0800`;
}

function safeCdata(str) {
  return String(str ?? '').replace(/]]>/g, ']]]]><![CDATA[>');
}

function parseDate(value) {
  if (value === undefined || value === null) {
    return null;
  }
  if (value instanceof Date) {
    return isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') {
      return null;
    }
    const parsed = new Date(trimmed);
    return isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

function sortItems(items) {
  return [...items].sort((a, b) => {
    const aDate = parseDate(a.publishedAt);
    const bDate = parseDate(b.publishedAt);
    if (aDate && bDate) {
      return bDate.getTime() - aDate.getTime();
    }
    if (aDate) return -1;
    if (bDate) return 1;
    return 0;
  });
}

function extractFirstVideoUrl(html) {
  const match = String(html ?? '').match(/<source[^>]+src="([^"]+)"/i);
  return match?.[1] || '';
}

function buildSummary(descriptionHtml) {
  const summary = stripHtml(descriptionHtml || '').replace(/\s+/g, ' ').trim().slice(0, 240);
  return summary || '媒体内容';
}

function buildDefaultMediaHtml(item, baseUrl) {
  const rawImages = Array.isArray(item.rawImages) ? item.rawImages : [];
  const imageUrl = typeof item.imageUrl === 'string' ? item.imageUrl.trim() : '';
  const images = rawImages.length > 0 ? rawImages : (imageUrl ? [imageUrl] : []);
  const validImages = images.filter(url => typeof url === 'string' && url.trim() !== '');

  if (validImages.length === 0) {
    return '<p>（无内容）</p>';
  }

  return validImages.map(url => `<p><img src="${proxyImageUrl(url.trim(), baseUrl)}" style="max-width:100%"/></p>`).join('');
}

function buildContent(item, baseUrl) {
  const descriptionHtml = String(item.descriptionHtml || '');
  const rawContent = descriptionHtml || buildDefaultMediaHtml(item, baseUrl);
  return proxyHtmlAssets(rawContent, baseUrl);
}

function buildEnclosure(item, baseUrl) {
  const mediaType = String(item.mediaType || '');

  if (mediaType.includes('video')) {
    const videoUrl = extractFirstVideoUrl(item.descriptionHtml);
    if (typeof videoUrl === 'string' && videoUrl.trim() !== '') {
      return {
        url: proxyMediaUrl(videoUrl.trim(), baseUrl),
        type: 'video/mp4'
      };
    }
  }

  const imageUrl = (typeof item.imageUrl === 'string' ? item.imageUrl.trim() : '') ||
    (Array.isArray(item.rawImages)
      ? item.rawImages.find(url => typeof url === 'string' && url.trim() !== '')
      : '');
  const trimmedImageUrl = typeof imageUrl === 'string' ? imageUrl.trim() : '';
  if (trimmedImageUrl) {
    return {
      url: proxyImageUrl(trimmedImageUrl, baseUrl),
      type: 'image/jpeg'
    };
  }

  return null;
}

function buildItemXml(item, baseUrl) {
  const content = buildContent(item, baseUrl);
  const summary = buildSummary(item.descriptionHtml);

  const guid = [item.canonicalId, item.link, item.itemKey]
    .map(v => typeof v === 'string' ? v.trim() : '')
    .find(v => v.length > 0) || '';
  if (!guid) {
    throw new Error('Item GUID must not be empty');
  }

  const link = typeof item.link === 'string' ? item.link.trim() : '';
  const date = parseDate(item.publishedAt);
  const enclosure = buildEnclosure(item, baseUrl);

  const linkXml = link ? `    <link>${escapeHtml(link)}</link>\n` : '';
  const pubDateXml = date ? `    <pubDate>${toBeijingRFC822(date)}</pubDate>\n` : '';
  const enclosureXml = enclosure
    ? `    <enclosure url="${escapeHtml(enclosure.url)}" type="${escapeHtml(enclosure.type)}" length="0"/>\n`
    : '';

  return `    <item>
      <title><![CDATA[${safeCdata(item.title)}]]></title>
${linkXml}      <guid isPermaLink="false">${escapeHtml(guid)}</guid>
${pubDateXml}      <description>${escapeHtml(summary)}</description>
      <content:encoded><![CDATA[${safeCdata(content)}]]></content:encoded>
${enclosureXml}    </item>`;
}

export function renderRssFeed(feedMeta, items, feedUrl) {
  if (!feedMeta || typeof feedMeta !== 'object' || Array.isArray(feedMeta)) {
    throw new Error('feedMeta must be a plain object');
  }
  if (!Array.isArray(items)) {
    throw new Error('items must be an array');
  }
  if (typeof feedUrl !== 'string' || feedUrl.trim() === '') {
    throw new Error('feedUrl must be an absolute http/https URL');
  }

  let parsedFeedUrl;
  try {
    parsedFeedUrl = new URL(feedUrl);
  } catch {
    throw new Error('feedUrl must be an absolute http/https URL');
  }
  if (parsedFeedUrl.protocol !== 'http:' && parsedFeedUrl.protocol !== 'https:') {
    throw new Error('feedUrl must be an absolute http/https URL');
  }

  const baseUrl = parsedFeedUrl.origin;

  const title = feedMeta?.title || '';
  const link = feedMeta?.link || '';
  const description = feedMeta?.description || '';
  const language = feedMeta?.language || 'zh-CN';

  const sortedItems = sortItems(items).slice(0, 50);
  const itemsXml = sortedItems.map(item => buildItemXml(item, baseUrl)).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title><![CDATA[${safeCdata(title)}]]></title>
    <link>${escapeHtml(link)}</link>
    <description><![CDATA[${safeCdata(description)}]]></description>
    <language>${escapeHtml(language)}</language>
    <atom:link href="${escapeHtml(feedUrl)}" rel="self" type="application/rss+xml"/>
    <lastBuildDate>${toBeijingRFC822(new Date())}</lastBuildDate>
${itemsXml}
  </channel>
</rss>`;
}
