import { lease, complete, fail } from './queue.js';
import { sendPhotoWithFallback, sendMessage, TelegramError } from '../telegram.js';
import { escapeHtml } from '../html.js';
import { isSafeUrl } from '../security/url.js';

export function formatRssNotification(payload) {
  const feedTitle = escapeHtml(payload.feedTitle || '');
  const entryTitle = escapeHtml(payload.entryTitle || '');
  const summary = escapeHtml(payload.summary || '');
  const link = payload.link && isSafeUrl(payload.link) ? escapeHtml(payload.link) : '';
  
  if (link) {
    return `📰 <b>${feedTitle}</b>\n\n<b>${entryTitle}</b>\n\n${summary}\n\n<a href="${link}">查看原文</a>`;
  }
  return `📰 <b>${feedTitle}</b>\n\n<b>${entryTitle}</b>\n\n${summary}`;
}

export function formatStockNotification(payload) {
  const code = escapeHtml(payload.code || '');
  const condType = payload.conditionType === 'gte' ? '≥' : '≤';
  const condVal = payload.conditionValue;
  const price = payload.price;
  const obsAt = escapeHtml(payload.observedAt || '');
  const source = escapeHtml(payload.source || '');
  
  return `📈 <b>个股提醒: ${code}</b>\n\n最新价: <b>${price}</b>\n条件: 最新价 ${condType} ${condVal}\n时间: ${obsAt}\n数据源: ${source}`;
}

export async function processNotificationBatch(db, env, options = {}) {
  const limit = options.batchLimit || 10;
  const leaseDurationSeconds = options.leaseDurationSeconds || 300;
  const maxAttempts = options.maxAttempts || 3;
  const fetchFn = options.fetchFn || fetch;

  const pushToken = env.PUSH_TELEGRAM_BOT_TOKEN;
  const pushChannelId = env.PUSH_TELEGRAM_CHANNEL_ID;

  if (!pushToken || !pushChannelId) {
    console.error('[sender] PUSH_TELEGRAM_BOT_TOKEN or PUSH_TELEGRAM_CHANNEL_ID not configured');
    return 0;
  }

  // Lease pending items
  const items = await lease(db, limit, maxAttempts, leaseDurationSeconds);
  let processedCount = 0;

  for (const item of items) {
    let success = false;
    let errorMsg = '';
    let retryAfter = 60; // default backoff

    try {
      const payload = JSON.parse(item.payload_json);
      
      if (item.kind === 'rss') {
        const text = formatRssNotification(payload);
        const safeImageUrl = payload.imageUrl && isSafeUrl(payload.imageUrl) ? payload.imageUrl : '';
        await sendPhotoWithFallback(pushToken, pushChannelId, safeImageUrl, text, { fetchFn });
        success = true;
      } else if (item.kind === 'stock') {
        const text = formatStockNotification(payload);
        await sendMessage(pushToken, pushChannelId, text, 'HTML', { fetchFn });
        
        const finalStatus = payload.autoPause ? 'paused' : 'triggered';
        const nowStr = new Date().toISOString();
        await db.prepare(
          `UPDATE tracker_rules
           SET status = ?, triggered_at = ?, updated_at = ?
           WHERE id = ? AND status = 'trigger_pending'`
        ).bind(finalStatus, nowStr, nowStr, payload.ruleId).run();

        await db.prepare(
          `INSERT INTO tracker_events (rule_id, event_type, value, observed_at, source, details_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
        ).bind(
          payload.ruleId,
          finalStatus,
          payload.price,
          payload.observedAt,
          payload.source,
          JSON.stringify({ sent_at: nowStr })
        ).run();

        success = true;
      } else if (item.kind === 'system') {
        const text = `⚠️ <b>系统告警</b>\n\n${escapeHtml(payload.message || '')}`;
        const adminToken = env.TELEGRAM_BOT_TOKEN;
        const adminChatId = env.TELEGRAM_CHAT_ID;
        if (adminToken && adminChatId) {
          await sendMessage(adminToken, adminChatId, text, 'HTML', { fetchFn });
        }
        success = true;
      } else {
        throw new Error(`Unknown notification kind: ${item.kind}`);
      }
    } catch (err) {
      errorMsg = err.message || 'Unknown error';
      if (err instanceof TelegramError && err.status === 429) {
        retryAfter = err.retryAfter || 60;
      }
    }

    if (success) {
      await complete(db, item.id, item.lease_token);
      processedCount++;
    } else {
      await fail(db, item.id, item.lease_token, errorMsg, retryAfter, maxAttempts);
      if (errorMsg.includes('Too Many Requests') || errorMsg.includes('429')) {
        break;
      }
    }
  }
  return processedCount;
}
export { escapeHtml };
