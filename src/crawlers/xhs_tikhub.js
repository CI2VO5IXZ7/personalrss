// 小红书抓取 — 通过 TikHub Xiaohongshu-App-V2-API
// API 文档: https://api.tikhub.io/#/Xiaohongshu-App-V2-API
//
// 实际验证的端点和返回结构:
//   get_user_posted_notes  → data.data.notes[]  每个 note: { id, type, title, desc, create_time, images_list[].url }
//   get_image_note_detail  → data.data[0].note_list[0]  含 { note_id, title, desc, time, image_list[].url }
//   get_video_note_detail  → data.data[0]  直接是笔记对象 { note_id, title, desc, time, images_list[].url, video_info_v2 }

import { trackApiCall } from '../db.js';

const TIKHUB_BASE = 'https://api.tikhub.io';
const XHS_BASE = 'https://www.xiaohongshu.com';

// ─── 获取用户笔记列表 ──────────────────────────────────────────────────────

export async function fetchProfile(env, userId, existingIds = new Set()) {
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
  if (env.DB) await trackApiCall(env.DB, 'get_user_posted_notes').catch(() => {});

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

  const headers = { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' };
  const results = [];

  for (const note of notes) {
    const noteId = note.id || note.note_id || '';
    const noteType = note.type || 'normal';

    // 增量逻辑：已缓存的笔记跳过详情 API 调用
    if (existingIds.has(noteId)) {
      continue;
    }

    // 只对新笔记调用对应的详情接口
    const endpoint = noteType === 'video' ? 'get_video_note_detail' : 'get_image_note_detail';

    try {
      const detailUrl = `${TIKHUB_BASE}/api/v1/xiaohongshu/app_v2/${endpoint}?note_id=${encodeURIComponent(noteId)}`;
      const detailResp = await fetch(detailUrl, { headers });
      if (env.DB) await trackApiCall(env.DB, endpoint).catch(() => {});
      if (detailResp.ok) {
        const detailData = await detailResp.json();
        if (detailData.code === 200 && detailData.data) {
          const noteObj = extractNoteFromDetail(detailData.data, endpoint);
          if (noteObj) {
            const parsed = parseNote(noteObj, noteType);
            // 强制使用列表 API 的 noteId，避免详情 API 返回不同 ID 导致重复
            if (parsed) { parsed.id = noteId; parsed.link = `${XHS_BASE}/explore/${noteId}`; results.push(parsed); continue; }
          }
        }
      }
    } catch (e) {
      console.error(`[xhs] ${endpoint} for ${noteId} error: ${e.message}`);
    }

    // 详情接口失败时回退到列表数据
    const parsed = parseNoteFromList(note, userId);
    if (parsed) results.push(parsed);
  }

  console.log(`[xhs] ${userId}: ${notes.length} notes in list, ${existingIds.size} cached, ${results.length} new fetched`);
  return results;
}

// ─── 获取单条笔记详情（含完整图文）─────────────────────────────────────────

export async function fetchNoteDetail(env, noteId, noteType) {
  const token = env.TIKHUB_API_TOKEN;
  if (!token) return null;

  const headers = { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' };

  // 根据类型直接调用对应的详情接口
  const endpoint = noteType === 'video' ? 'get_video_note_detail' : 'get_image_note_detail';

  try {
    const url = `${TIKHUB_BASE}/api/v1/xiaohongshu/app_v2/${endpoint}?note_id=${encodeURIComponent(noteId)}`;
    const resp = await fetch(url, { headers });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (data.code !== 200 || !data.data) return null;

    const noteObj = extractNoteFromDetail(data.data, endpoint);
    if (noteObj) return parseNote(noteObj, noteType);
  } catch (e) {
    console.error(`[xhs] ${endpoint} error: ${e.message}`);
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
    // 结构: data.data = [ noteObj, ... ] (直接就是笔记，字段用 id 而非 note_id)
    if (Array.isArray(inner) && inner[0]?.id) {
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

function parseNote(noteObj, noteType) {
  try {
    const noteId = noteObj.note_id || noteObj.id || '';
    const title = noteObj.title || '';
    const desc = noteObj.desc || '';

    const imageList = extractImageUrls(noteObj);
    const cover = imageList[0] || '';
    const videoUrl = noteType === 'video' ? extractVideoUrl(noteObj) : '';

    const date = parseTimestamp(noteObj.time || noteObj.create_time || noteObj.last_update_time)
               || parseObjectIdDate(noteId)
               || new Date().toISOString();

    const link = `${XHS_BASE}/explore/${noteId}`;
    const description = buildDescription(desc, imageList, cover, videoUrl);

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
      addUrl(convertHeifToJpg(img.url || img.url_default || img.original));
    }
    if (urls.length > 0) break;
  }

  return urls;
}

// ─── HEIF → JPG 转换（XHS CDN 支持 URL 参数转格式）─────────────────────────

function convertHeifToJpg(url) {
  if (!url || typeof url !== 'string') return url;
  // XHS CDN URL 含 format/heif 或 format/hei，替换为 format/jpg
  return url.replace(/format\/heif?\b/gi, 'format/jpg');
}

// ─── 提取视频 URL ────────────────────────────────────────────────────────

function extractVideoUrl(noteObj) {
  const v2 = noteObj.video_info_v2 || noteObj.video_info || noteObj.video;
  if (!v2) return '';
  if (typeof v2 === 'string') return v2;
  if (v2.url) return v2.url;

  // media.stream.h264[0].master_url / h265 / av1
  const stream = v2.media?.stream;
  if (stream) {
    for (const codec of ['h264', 'h265', 'av1']) {
      const tracks = stream[codec];
      if (Array.isArray(tracks) && tracks[0]?.master_url) {
        return tracks[0].master_url;
      }
    }
  }

  // url_info_list
  if (Array.isArray(v2.url_info_list) && v2.url_info_list[0]?.url) {
    return v2.url_info_list[0].url;
  }

  return '';
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

function buildDescription(desc, imageList, fallbackCover, videoUrl) {
  let html = '';

  if (videoUrl) {
    // 视频笔记: 使用 video 标签，封面作为 poster
    html += `<p><video src="${videoUrl}" controls style="max-width:100%"${fallbackCover ? ` poster="${fallbackCover}"` : ''}>视频无法播放</video></p>`;
  } else {
    // 图文笔记: 展示所有图片
    const images = imageList.length > 0 ? imageList : (fallbackCover ? [fallbackCover] : []);
    for (const imgUrl of images) {
      html += `<p><img src="${imgUrl}" style="max-width:100%"/></p>`;
    }
  }

  if (desc) {
    html += `<p>${desc.replace(/\n/g, '<br/>')}</p>`;
  }

  return html || '<p>（无内容）</p>';
}
