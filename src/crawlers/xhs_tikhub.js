// 小红书抓取 — 通过 TikHub Xiaohongshu-App-V2-API
// API 文档: https://api.tikhub.io/#/Xiaohongshu-App-V2-API
//
// 实际验证的端点和返回结构:
//   get_user_posted_notes  → data.data.notes[]  每个 note: { id, type, title, desc, create_time, images_list[].url }
//   get_image_note_detail  → data.data[0].note_list[0]  含 { note_id, title, desc, time, image_list[].url }
//   get_video_note_detail  → data.data[0]  直接是笔记对象 { note_id, title, desc, time, images_list[].url, video_info_v2 }

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

  // 实际结构: data.data.notes[]
  const notes = data.data?.data?.notes || data.data?.notes || [];
  if (!notes.length) return [];

  return notes.map(note => parseNoteFromList(note, userId)).filter(Boolean);
}

// ─── 获取单条笔记详情（含完整图文）─────────────────────────────────────────

export async function fetchNoteDetail(env, noteId, noteType) {
  const token = env.TIKHUB_API_TOKEN;
  if (!token) return null;

  const headers = { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' };

  // 根据类型决定端点顺序; normal=图文优先, video=视频优先
  const endpoints = noteType === 'video'
    ? ['get_video_note_detail', 'get_image_note_detail']
    : ['get_image_note_detail', 'get_video_note_detail'];

  for (const endpoint of endpoints) {
    try {
      const url = `${TIKHUB_BASE}/api/v1/xiaohongshu/app_v2/${endpoint}?note_id=${encodeURIComponent(noteId)}`;
      const resp = await fetch(url, { headers });
      if (!resp.ok) continue;
      const data = await resp.json();
      if (data.code !== 200 || !data.data) continue;

      // 提取笔记对象 — 两个接口返回结构不同
      const noteObj = extractNoteFromDetail(data.data, endpoint);
      if (noteObj) return parseNote(noteObj);
    } catch (e) {
      console.error(`[xhs] ${endpoint} error: ${e.message}`);
    }
  }
  return null;
}

// ─── 从详情接口返回中提取笔记对象 ──────────────────────────────────────────

function extractNoteFromDetail(apiData, endpoint) {
  const inner = apiData.data; // data.data
  if (!inner) return null;

  if (endpoint === 'get_image_note_detail') {
    // 结构: data.data = [ { note_list: [noteObj], ... } ]
    if (Array.isArray(inner) && inner[0]?.note_list?.[0]) {
      return inner[0].note_list[0];
    }
  }

  if (endpoint === 'get_video_note_detail') {
    // 结构: data.data = [ noteObj, ... ] (直接就是笔记)
    if (Array.isArray(inner) && inner[0]?.note_id) {
      return inner[0];
    }
  }

  // 兜底: 如果 inner 本身就是笔记对象
  if (inner.note_id || inner.id) return inner;

  return null;
}

// ─── 解析笔记列表项 (来自 get_user_posted_notes) ────────────────────────────

function parseNoteFromList(note, userId) {
  try {
    // 字段: id, type, title, desc, create_time, images_list[].url, comments_count, share_count
    const noteId = note.id || note.note_id || '';
    const title = note.title || '';
    const desc = note.desc || '';

    // 图片: images_list[].url
    const imageList = extractImageUrls(note);
    const cover = imageList[0] || '';

    // 时间: create_time (秒级 unix timestamp)
    const date = parseTimestamp(note.create_time || note.time) || parseObjectIdDate(noteId) || new Date().toISOString();

    const link = `${XHS_BASE}/explore/${noteId}`;
    const description = buildDescription(desc, imageList, cover);

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

// ─── 解析笔记对象 (来自详情接口) ────────────────────────────────────────────

function parseNote(noteObj) {
  try {
    const noteId = noteObj.note_id || noteObj.id || '';
    const title = noteObj.title || '';
    const desc = noteObj.desc || '';

    const imageList = extractImageUrls(noteObj);
    const cover = imageList[0] || '';

    const date = parseTimestamp(noteObj.time || noteObj.create_time || noteObj.last_update_time)
               || parseObjectIdDate(noteId)
               || new Date().toISOString();

    const link = `${XHS_BASE}/explore/${noteId}`;
    const description = buildDescription(desc, imageList, cover);

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
    console.error('[xhs] parseNote error:', e.message);
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

  // 实测字段: images_list[].url (列表接口 + 视频详情) 或 image_list[].url (图文详情)
  const lists = [
    noteData.images_list,
    noteData.image_list,
  ].filter(Boolean);

  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const img of list) {
      addUrl(img.url || img.url_default || img.original);
    }
    if (urls.length > 0) break;
  }

  return urls;
}

// ─── 时间戳解析 ────────────────────────────────────────────────────────────

function parseTimestamp(ts) {
  if (!ts) return null;
  const n = Number(ts);
  if (n > 1000000000000) return new Date(n).toISOString();
  if (n > 1000000000) return new Date(n * 1000).toISOString();
  return null;
}

function parseObjectIdDate(noteId) {
  if (!noteId || noteId.length < 8) return null;
  const hexTs = parseInt(noteId.substring(0, 8), 16);
  if (hexTs > 1000000000 && hexTs < 2000000000) {
    return new Date(hexTs * 1000).toISOString();
  }
  return null;
}

// ─── 构建 HTML 描述（含图文）───────────────────────────────────────────────

function buildDescription(desc, imageList, fallbackCover) {
  let html = '';

  const images = imageList.length > 0 ? imageList : (fallbackCover ? [fallbackCover] : []);
  for (const imgUrl of images) {
    html += `<p><img src="${imgUrl}" style="max-width:100%"/></p>`;
  }

  if (desc) {
    html += `<p>${desc.replace(/\n/g, '<br/>')}</p>`;
  }

  return html || '<p>（无内容）</p>';
}
