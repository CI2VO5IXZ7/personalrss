// Instagram 抓取 — 使用官方内部 API。
// 注意：该接口是非公开接口，Instagram 会对 Cloudflare/机房 IP 做 401/429 风控。
// 因此这里必须低频、低并发，并对临时风控做短退避重试；不要把失败冒充为空结果。

import { escapeHtml } from '../html.js';

const IG_BASE = 'https://www.instagram.com';
const IG_APP_ID = '936619743392459';

const IG_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'x-ig-app-id': IG_APP_ID,
  'Referer': 'https://www.instagram.com/',
  'Origin': 'https://www.instagram.com',
  'sec-fetch-site': 'same-origin',
  'sec-fetch-mode': 'cors'
};

const RETRYABLE_HTTP_STATUS = new Set([401, 403, 429, 500, 502, 503, 504]);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function retryDelayMs(attempt) {
  // Cloudflare Worker 里不能长时间阻塞；只做短退避，主要错开并发峰值。
  return 800 * attempt + Math.floor(Math.random() * 500);
}

async function fetchInstagramJson(url, options, maxAttempts = 3) {
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const resp = await fetch(url, options);

    if (resp.ok) {
      return resp.json();
    }

    lastError = new Error(`Instagram API HTTP ${resp.status}`);

    if (!RETRYABLE_HTTP_STATUS.has(resp.status) || attempt === maxAttempts) {
      throw lastError;
    }

    await sleep(retryDelayMs(attempt));
  }

  throw lastError;
}

function buildPostDescription(node) {
  const media = node.edge_sidecar_to_children
    ? node.edge_sidecar_to_children.edges.map(e => {
        const n = e.node;
        return n.is_video
          ? `<video controls poster="${n.display_url}"><source src="${n.video_url || ''}" type="video/mp4"></video>`
          : `<img src="${n.display_url}" style="max-width:100%">`;
      }).join('<br>')
    : node.is_video
      ? `<video controls poster="${node.display_url}"><source src="${node.video_url || ''}" type="video/mp4"></video>`
      : `<img src="${node.display_url}" style="max-width:100%">`;

  const caption = node.edge_media_to_caption?.edges?.[0]?.node?.text || '';
  return caption ? `${media}<br><p>${escapeHtml(caption).replace(/\n/g, '<br>')}</p>` : media;
}

function mapNodeToPost(username, node) {
  return {
    id: node.id,
    title: (node.edge_media_to_caption?.edges?.[0]?.node?.text || '').split('\n')[0].substring(0, 100) || `@${username} post`,
    description: buildPostDescription(node),
    link: `https://www.instagram.com/p/${node.shortcode}/`,
    image: node.display_url || node.thumbnail_src || '',
    date: node.taken_at_timestamp ? new Date(node.taken_at_timestamp * 1000).toISOString() : new Date().toISOString(),
    canonical_id: node.id,
    media_type: node.is_video ? 'video' : 'image'
  };
}

export async function fetchProfile(username) {
  const url = `${IG_BASE}/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
  const data = await fetchInstagramJson(url, { headers: IG_HEADERS });
  const user = data?.data?.user;
  if (!user) throw new Error('No user data in Instagram API response');

  const edges = user.edge_owner_to_timeline_media?.edges || [];
  return {
    posts: edges.map(({ node }) => mapNodeToPost(username, node)),
    meta: {
      sourceCount: edges.length,
      emptyReason: edges.length === 0 ? 'no_posts' : ''
    }
  };
}

export async function validateProfile(username) {
  const { meta } = await fetchProfile(username);
  return { username, sourceCount: meta.sourceCount };
}
