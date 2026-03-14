// Instagram 抓取 — 使用官方内部 API（无需登录，CF 网络可直达公开 profile）

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
  return caption ? `${media}<br><p>${caption.replace(/\n/g, '<br>')}</p>` : media;
}

export async function fetchProfile(username) {
  const url = `${IG_BASE}/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
  const resp = await fetch(url, { headers: IG_HEADERS });

  if (!resp.ok) {
    throw new Error(`Instagram API HTTP ${resp.status}`);
  }

  const data = await resp.json();
  const user = data?.data?.user;
  if (!user) throw new Error('No user data in Instagram API response');

  const edges = user.edge_owner_to_timeline_media?.edges || [];
  return edges.map(({ node }) => ({
    id: node.id,
    title: (node.edge_media_to_caption?.edges?.[0]?.node?.text || '').split('\n')[0].substring(0, 100) || `@${username} post`,
    description: buildPostDescription(node),
    link: `https://www.instagram.com/p/${node.shortcode}/`,
    image: node.display_url || node.thumbnail_src || '',
    date: node.taken_at_timestamp ? new Date(node.taken_at_timestamp * 1000).toISOString() : new Date().toISOString()
  }));
}
