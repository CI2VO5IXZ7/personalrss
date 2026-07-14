// Instagram Generator Provider
//
// 该 provider 将 Instagram 公开用户主页抓取结果转换为 generator 标准化 item。
//
// contentHash 说明：
// 使用 WebCrypto SHA-256 对真实内容（title、descriptionHtml、mediaType、imageUrl、
// rawImages 的稳定 JSON）生成小写 hex 哈希。明确排除 canonicalId、itemKey、publishedAt、
// link，使不同 ID 但内容相同的 post 能在二级去重中命中。crypto 优先从 context.crypto 注入，
// 否则回退到 globalThis.crypto。若所有内容字段均为空，则 contentHash 为空字符串。

import { normalizeGeneratorItem } from '../../core/contract.js';
import {
  fetchRawProfile,
  buildPostDescription
} from './fetcher.js';

function isPlainObject(value) {
  return Object.prototype.toString.call(value) === '[object Object]';
}

function isValidInstagramUsername(username) {
  const u = String(username).trim();
  if (u.length === 0 || u.length > 30) return false;
  if (u.startsWith('.') || u.endsWith('.')) return false;
  if (u.includes('..')) return false;
  return /^[a-z0-9_.]+$/.test(u);
}

function normalizeInstagramUsername(username) {
  const u = String(username).trim().toLowerCase();
  if (!isValidInstagramUsername(u)) {
    throw new Error('Invalid Instagram username');
  }
  return u;
}

function getCrypto(context) {
  return context?.crypto || globalThis.crypto;
}

async function computeContentHash({ title, descriptionHtml, mediaType, imageUrl, rawImages }, context) {
  const t = String(title ?? '');
  const d = String(descriptionHtml ?? '');
  const m = String(mediaType ?? '');
  const i = String(imageUrl ?? '');
  const r = Array.isArray(rawImages) ? rawImages : [];

  if (t === '' && d === '' && m === '' && i === '' && r.length === 0) {
    return '';
  }

  const crypto = getCrypto(context);
  if (!crypto || typeof crypto.subtle?.digest !== 'function') {
    throw new Error('WebCrypto SHA-256 is not available');
  }

  const payload = JSON.stringify({ title: t, descriptionHtml: d, mediaType: m, imageUrl: i, rawImages: r });
  const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
  const bytes = new Uint8Array(buffer);
  let hex = '';
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, '0');
  }
  return hex;
}

function hasSidecarVideo(node) {
  const children = node.edge_sidecar_to_children?.edges;
  if (!Array.isArray(children) || children.length === 0) return false;
  return children.some(edge => edge?.node?.is_video);
}

function buildRawImages(node) {
  const parentUrl = node.display_url || node.thumbnail_src || '';
  const urls = parentUrl ? [parentUrl] : [];

  if (node.edge_sidecar_to_children?.edges?.length > 0) {
    for (const edge of node.edge_sidecar_to_children.edges) {
      const childUrl = edge?.node?.display_url || edge?.node?.thumbnail_src || '';
      if (childUrl && childUrl !== parentUrl) {
        urls.push(childUrl);
      }
    }
  }

  return urls;
}

function buildImageUrl(node) {
  if (node.display_url || node.thumbnail_src) {
    return node.display_url || node.thumbnail_src;
  }
  const firstChild = node.edge_sidecar_to_children?.edges?.[0]?.node;
  return firstChild?.display_url || firstChild?.thumbnail_src || '';
}

function parseMediaType(node) {
  if (node.is_video) return 'video';
  if (hasSidecarVideo(node)) return 'video';
  return 'image';
}

function parsePublishedAt(node) {
  const t = node.taken_at_timestamp;
  if (t !== undefined && t !== null && t !== '' && !isNaN(Number(t))) {
    const d = new Date(Number(t) * 1000);
    if (!isNaN(d.getTime())) return d;
  }
  return undefined;
}

function parseTitle(node, username) {
  const caption = node.edge_media_to_caption?.edges?.[0]?.node?.text || '';
  const firstLine = (caption.split('\n')[0] || '').substring(0, 100);
  if (firstLine) return firstLine;
  if (username && username.trim()) return `@${username.trim()} post`;
  return 'Instagram post';
}

function parseLink(node) {
  const shortcode = node.shortcode || '';
  return shortcode ? `https://www.instagram.com/p/${shortcode}/` : '';
}

function parseItemKey(node) {
  return node.shortcode || node.id || '';
}

export const instagramProvider = {
  type: 'instagram',
  displayName: 'Instagram',

  validateConfig(config, context) {
    if (config !== undefined && !isPlainObject(config)) {
      throw new Error('Invalid config: must be a plain object or undefined');
    }

    const instanceKey = context?.instanceKey;
    if (typeof instanceKey !== 'string') {
      throw new Error('Invalid Instagram username');
    }
    normalizeInstagramUsername(instanceKey);

    return { ...(config || {}), configVersion: 1 };
  },

  async fetchItems(instance, context) {
    if (!instance || typeof instance !== 'object' || Array.isArray(instance)) {
      throw new Error('Invalid instance');
    }

    this.validateConfig(instance.config, { instanceKey: instance.instanceKey });
    const username = normalizeInstagramUsername(instance.instanceKey);

    const { nodes, meta } = await fetchRawProfile(username, context);
    return { items: nodes, meta };
  },

  async normalizeItem(raw, instance, context) {
    const node = raw;
    const username = normalizeInstagramUsername(instance?.instanceKey || '');

    const itemKey = parseItemKey(node);
    const canonicalId = node.id || '';
    const link = parseLink(node);
    const title = parseTitle(node, username);
    const descriptionHtml = buildPostDescription(node);
    const publishedAt = parsePublishedAt(node);
    const mediaType = parseMediaType(node);
    const imageUrl = buildImageUrl(node);
    const rawImages = buildRawImages(node);

    const contentHash = await computeContentHash({
      title,
      descriptionHtml,
      mediaType,
      imageUrl,
      rawImages
    }, context);

    return normalizeGeneratorItem({
      itemKey,
      canonicalId,
      contentHash,
      title,
      descriptionHtml,
      link,
      publishedAt,
      mediaType,
      imageUrl,
      rawImages
    });
  },

  buildFeedMeta(instance, context) {
    const username = String(instance?.instanceKey || '').trim().toLowerCase();
    return {
      title: `${instance?.displayName || username} - Instagram`,
      link: username ? `https://www.instagram.com/${username}/` : '',
      description: username ? `Instagram posts from @${username}` : '',
      language: 'zh-CN'
    };
  }
};
