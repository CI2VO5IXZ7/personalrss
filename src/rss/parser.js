import { XMLParser } from 'fast-xml-parser';

export async function sha256(data) {
  const encoder = new TextEncoder();
  const dataBuffer = encoder.encode(data);
  const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

function getArray(val) {
  if (val === undefined || val === null) return [];
  return Array.isArray(val) ? val : [val];
}

function getText(val) {
  if (val === undefined || val === null) return '';
  if (typeof val === 'object') {
    return val['#text'] !== undefined ? String(val['#text']).trim() : '';
  }
  return String(val).trim();
}

function extractImageFromHtml(html) {
  if (!html || typeof html !== 'string') return '';
  const match = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  return match ? match[1] : '';
}

export async function parseFeed(xmlContent, subscriptionId) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseAttributeValue: false,
    cdataPropName: '__cdata'
  });

  const parsed = parser.parse(xmlContent);

  let title = '';
  let siteUrl = '';
  let items = [];

  // Detect RSS vs Atom
  if (parsed.rss && parsed.rss.channel) {
    const channel = parsed.rss.channel;
    title = getText(channel.title);
    
    const channelLinks = getArray(channel.link);
    for (const linkVal of channelLinks) {
      if (typeof linkVal === 'string') {
        siteUrl = linkVal;
        break;
      } else if (linkVal && linkVal['#text']) {
        siteUrl = linkVal['#text'];
        break;
      }
    }

    items = getArray(channel.item);
  } else if (parsed.feed) {
    // Atom
    const feed = parsed.feed;
    title = getText(feed.title);

    const feedLinks = getArray(feed.link);
    for (const linkVal of feedLinks) {
      if (typeof linkVal === 'string') {
        siteUrl = linkVal;
        break;
      } else if (linkVal && linkVal['@_href']) {
        siteUrl = linkVal['@_href'];
        break;
      }
    }

    items = getArray(feed.entry);
  } else {
    throw new Error('Unsupported feed format');
  }

  const entries = await Promise.all(items.map(async item => {
    const entryTitle = getText(item.title);

    let entryLink = '';
    const links = getArray(item.link);
    for (const linkVal of links) {
      if (typeof linkVal === 'string') {
        entryLink = linkVal;
        break;
      } else if (linkVal && linkVal['@_href']) {
        entryLink = linkVal['@_href'];
        break;
      } else if (linkVal && linkVal['#text']) {
        entryLink = linkVal['#text'];
        break;
      }
    }

    let guid = '';
    if (item.guid) {
      guid = getText(item.guid);
    } else if (item.id) {
      guid = getText(item.id);
    }

    let publishedAt = '';
    const dateStr = item.pubDate || item.published || item.updated || item['dc:date'];
    if (dateStr) {
      const parsedDate = new Date(getText(dateStr));
      if (!Number.isNaN(parsedDate.getTime())) {
        publishedAt = parsedDate.toISOString();
      }
    }

    let content = '';
    if (item['content:encoded']) {
      content = getText(item['content:encoded']);
    } else if (item.content) {
      content = getText(item.content);
    } else if (item.description) {
      content = getText(item.description);
    } else if (item.summary) {
      content = getText(item.summary);
    }

    const summary = getText(item.summary || item.description);

    let imageUrl = '';
    
    // 1. media:content
    const mediaContents = getArray(item['media:content']);
    for (const media of mediaContents) {
      if (media && media['@_url'] && (!media['@_medium'] || media['@_medium'] === 'image')) {
        imageUrl = media['@_url'];
        break;
      }
    }

    // 2. enclosure
    if (!imageUrl && item.enclosure) {
      const enclosures = getArray(item.enclosure);
      for (const enc of enclosures) {
        if (enc && enc['@_url']) {
          const type = enc['@_type'] || '';
          if (type.startsWith('image/') || enc['@_url'].match(/\.(jpg|jpeg|png|gif|webp)/i)) {
            imageUrl = enc['@_url'];
            break;
          }
        }
      }
    }

    // 3. media:thumbnail
    if (!imageUrl && item['media:thumbnail']) {
      const thumbs = getArray(item['media:thumbnail']);
      if (thumbs[0] && thumbs[0]['@_url']) {
        imageUrl = thumbs[0]['@_url'];
      }
    }

    // 4. HTML fallback
    if (!imageUrl) {
      imageUrl = extractImageFromHtml(content);
    }

    // Dedupe key logic
    let entryKey = '';
    if (guid) {
      entryKey = guid;
    } else if (entryLink) {
      entryKey = entryLink;
    } else {
      entryKey = await sha256(`${subscriptionId || ''}${entryTitle}${entryLink}${publishedAt}`);
    }

    const contentHash = await sha256(content);

    return {
      entryKey,
      guid,
      link: entryLink,
      title: entryTitle,
      publishedAt,
      contentHash,
      imageUrl,
      content: summary || content
    };
  }));

  return {
    title,
    siteUrl,
    entries
  };
}
