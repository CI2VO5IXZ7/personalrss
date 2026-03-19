// 小红书抓取 — 通过 TikHub Xiaohongshu-App-V2-API

const TIKHUB_BASE = 'https://api.tikhub.io';
const XHS_BASE = 'https://www.xiaohongshu.com';

// ─── 获取用户笔记列表 ──────────────────────────────────────────────────────

export async function fetchProfile(env, userId) {
  const token = env.TIKHUB_API_TOKEN;
  if (!token) {
    throw Object.assign(new Error('[xhs] TIKHUB_API_TOKEN not configured'), { code: 'NO_API_TOKEN' });
  }

  const url = `${TIKHUB_BASE}/api/v1/xiaohongshu/app_v2/get_user_posted_notes?user_id=${encodeURIComponent(userId)}&cursor=`;

  const resp = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json'
    }
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`[xhs] TikHub API HTTP ${resp.status}: ${text.substring(0, 200)}`);
  }

  const data = await resp.json();
  if (data.code !== 200) {
    throw new Error(`[xhs] TikHub API error: ${data.message || JSON.stringify(data).substring(0, 200)}`);
  }

  const notes = data.data?.notes || data.data?.data?.notes || [];
  if (!notes.length) {
    // Try alternative response structure
    const items = data.data?.items || data.data?.data?.items || data.data?.note_list || [];
    if (items.length) {
      return items.map(item => parseNoteFromList(item, userId));
    }
    // Return empty if truly no notes
    return [];
  }

  return notes.map(note => parseNoteFromList(note, userId)).filter(Boolean);
}

// ─── 获取单条笔记详情（含完整图文）─────────────────────────────────────────

export async function fetchNoteDetail(env, noteId) {
  const token = env.TIKHUB_API_TOKEN;
  if (!token) return null;

  const headers = { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' };

  // 先尝试图文详情，失败再尝试视频详情
  for (const endpoint of ['get_image_note_detail', 'get_video_note_detail']) {
    try {
      const url = `${TIKHUB_BASE}/api/v1/xiaohongshu/app_v2/${endpoint}?note_id=${encodeURIComponent(noteId)}`;
      const resp = await fetch(url, { headers });
      if (!resp.ok) continue;
      const data = await resp.json();
      if (data.code !== 200 || !data.data) continue;
      return parseNoteDetail(data.data);
    } catch (e) {
      console.error(`[xhs] ${endpoint} error: ${e.message}`);
    }
  }
  return null;
}

// ─── 解析笔记列表项 ────────────────────────────────────────────────────────

function parseNoteFromList(note, userId) {
  try {
    // TikHub Xiaohongshu App V2 返回的笔记列表结构
    const noteId = note.note_id || note.id || note.note_card?.note_id || '';
    const noteCard = note.note_card || note;

    const title = noteCard.title || noteCard.display_title || '';
    const desc = noteCard.desc || noteCard.description || noteCard.note_desc || '';

    // 封面图
    const cover = noteCard.cover?.url || noteCard.cover?.url_default ||
                  noteCard.image_list?.[0]?.url || noteCard.cover?.info_list?.[0]?.url ||
                  noteCard.images_list?.[0]?.url || '';

    // 多图
    const imageList = extractImageUrls(noteCard);

    // 时间
    let date = new Date().toISOString();
    const ts = noteCard.time || noteCard.timestamp || noteCard.create_time || noteCard.last_update_time;
    if (ts) {
      const tsNum = Number(ts);
      if (tsNum > 1000000000000) {
        date = new Date(tsNum).toISOString();
      } else if (tsNum > 1000000000) {
        date = new Date(tsNum * 1000).toISOString();
      }
    }
    // fallback: noteId 前8位 hex 是 MongoDB ObjectID timestamp
    if (!ts && noteId && noteId.length >= 8) {
      const hexTs = parseInt(noteId.substring(0, 8), 16);
      if (hexTs > 1000000000 && hexTs < 2000000000) {
        date = new Date(hexTs * 1000).toISOString();
      }
    }

    const link = `${XHS_BASE}/explore/${noteId}`;

    // 构建含图文的 HTML description
    const description = buildDescription(title, desc, imageList, cover);

    return {
      id: noteId,
      title: title || desc.substring(0, 80) || 'XHS 笔记',
      description,
      link,
      image: cover,
      date,
      raw_images: imageList
    };
  } catch (e) {
    console.error('[xhs] parseNoteFromList error:', e.message);
    return null;
  }
}

// ─── 解析笔记详情 ──────────────────────────────────────────────────────────

function parseNoteDetail(data) {
  try {
    const noteData = data?.data || data?.note_data || data;
    const noteId = noteData.note_id || noteData.id || '';
    const title = noteData.title || noteData.display_title || '';
    const desc = noteData.desc || noteData.description || '';

    const imageList = extractImageUrls(noteData);
    const cover = imageList[0] || noteData.cover?.url || '';

    let date = new Date().toISOString();
    const ts = noteData.time || noteData.timestamp || noteData.create_time;
    if (ts) {
      const tsNum = Number(ts);
      if (tsNum > 1000000000000) date = new Date(tsNum).toISOString();
      else if (tsNum > 1000000000) date = new Date(tsNum * 1000).toISOString();
    }

    const link = `${XHS_BASE}/explore/${noteId}`;
    const description = buildDescription(title, desc, imageList, cover);

    return {
      id: noteId,
      title: title || desc.substring(0, 80) || 'XHS 笔记',
      description,
      link,
      image: cover,
      date,
      raw_images: imageList
    };
  } catch (e) {
    console.error('[xhs] parseNoteDetail error:', e.message);
    return null;
  }
}

// ─── 提取所有图片 URL ──────────────────────────────────────────────────────

function extractImageUrls(noteData) {
  const urls = [];
  const seen = new Set();

  function addUrl(url) {
    if (url && typeof url === 'string' && !seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  }

  // image_list / images_list (常见结构)
  const lists = [
    noteData.image_list,
    noteData.images_list,
    noteData.note_card?.image_list,
    noteData.note_card?.images_list,
    noteData.image_scenes?.default?.images,
  ].filter(Boolean);

  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const img of list) {
      addUrl(img.url || img.url_default || img.original || img.info_list?.[0]?.url);
    }
    if (urls.length > 0) break; // 只取第一个有效列表
  }

  // 封面图作为兜底
  if (urls.length === 0) {
    addUrl(noteData.cover?.url || noteData.cover?.url_default || noteData.cover?.info_list?.[0]?.url);
  }

  return urls;
}

// ─── 构建 HTML 描述（含图文）───────────────────────────────────────────────

function buildDescription(title, desc, imageList, fallbackCover) {
  let html = '';

  // 图片（所有图都展示）
  const images = imageList.length > 0 ? imageList : (fallbackCover ? [fallbackCover] : []);
  for (const imgUrl of images) {
    html += `<p><img src="${imgUrl}" style="max-width:100%"/></p>`;
  }

  // 文字内容
  if (desc) {
    html += `<p>${desc.replace(/\n/g, '<br/>')}</p>`;
  }

  return html || '<p>（无内容）</p>';
}
