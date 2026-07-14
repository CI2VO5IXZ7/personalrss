import { lease, complete, fail } from './queue.js';
import { sendPhotoWithFallback, sendMessage, TelegramError } from '../../telegram.js';
import { escapeHtml } from '../../html.js';
import { isSafeUrl, redactText } from '../../security/url.js';
import { logInfo } from '../../log.js';

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

  let processedCount = 0;

  for (let i = 0; i < limit; i++) {
    // Lease exactly one pending item at a time
    const items = await lease(db, 1, maxAttempts, leaseDurationSeconds);
    if (!items || items.length === 0) {
      break;
    }
    const item = items[0];
    let success = false;
    let errorMsg = '';
    let rateLimited = false;
    let retryAfter = Math.min(60 * Math.pow(2, Math.max(0, item.attempts - 1)), 3600);

    try {
      const payload = JSON.parse(item.payload_json);

      if (item.kind === 'rss') {
        if (!pushToken || !pushChannelId) {
          throw new Error('push Telegram credentials not configured');
        }

        let subId = null;
        const payloadSubId = payload.subscriptionId;
        if (typeof payloadSubId === 'number') {
          if (Number.isInteger(payloadSubId) && payloadSubId > 0) {
            subId = payloadSubId;
          }
        } else if (typeof payloadSubId === 'string') {
          if (/^\d+$/.test(payloadSubId)) {
            const parsed = parseInt(payloadSubId, 10);
            if (parsed > 0) {
              subId = parsed;
            }
          }
        }

        if (subId === null && item.dedupe_key) {
          const match = item.dedupe_key.match(/^rss:([1-9]\d*):/);
          if (match) {
            subId = parseInt(match[1], 10);
          }
        }

        if (subId === null) {
          throw new Error('Invalid or missing subscriptionId');
        }

        let subExists = true;
        try {
          const subCheck = await db.prepare('SELECT id FROM rss_subscriptions WHERE id = ?').bind(subId).first();
          subExists = !!subCheck;
        } catch (err) {
          throw new Error('Database check failed: ' + err.message);
        }

        if (!subExists) {
          logInfo('sender.rss_subscription_removed_skip', {
            notificationId: item.id,
            subscriptionId: subId
          });
          success = true;
        } else {
          const text = formatRssNotification(payload);
          const safeImageUrl = payload.imageUrl && isSafeUrl(payload.imageUrl) ? payload.imageUrl : '';
          await sendPhotoWithFallback(pushToken, pushChannelId, safeImageUrl, text, { fetchFn });
          success = true;
        }

      } else if (item.kind === 'stock') {
        if (!pushToken || !pushChannelId) {
          throw new Error('push Telegram credentials not configured');
        }
        const currentRule = await db.prepare(
          'SELECT status, arm_version FROM tracker_rules WHERE id = ?'
        ).bind(payload.ruleId).first();
        const isCurrentArm = currentRule
          && currentRule.status === 'trigger_pending'
          && currentRule.arm_version === payload.armVersion;

        if (!isCurrentArm) {
          // The rule was removed, rearmed, or otherwise moved on. Complete this
          // old queue item without delivering a stale alert.
          success = true;
        } else {
          const text = formatStockNotification(payload);
          await sendMessage(pushToken, pushChannelId, text, 'HTML', { fetchFn });

          const finalStatus = payload.autoPause ? 'paused' : 'triggered';
          const nowStr = new Date().toISOString();
          const updateResult = await db.prepare(
            `UPDATE tracker_rules
             SET status = ?, triggered_at = ?, updated_at = ?
             WHERE id = ? AND status = 'trigger_pending' AND arm_version = ?`
          ).bind(finalStatus, nowStr, nowStr, payload.ruleId, payload.armVersion).run();

          if (updateResult.meta.changes > 0) {
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
          }

          success = true;
        }
      } else if (item.kind === 'system') {
        const text = `⚠️ <b>系统告警</b>\n\n${escapeHtml(payload.message || '')}`;
        const adminToken = env.TELEGRAM_BOT_TOKEN;
        const adminChatId = env.TELEGRAM_CHAT_ID;
        if (!adminToken || !adminChatId) {
          throw new Error('admin Telegram credentials not configured');
        }
        await sendMessage(adminToken, adminChatId, text, 'HTML', { fetchFn });
        success = true;
      } else {
        throw new Error(`Unknown notification kind: ${item.kind}`);
      }
    } catch (err) {
      errorMsg = redactText(err.message || 'Unknown error');
      if (err instanceof TelegramError && err.status === 429) {
        rateLimited = true;
        retryAfter = err.retryAfter ?? 60;
      }
    }

    if (success) {
      await complete(db, item.id, item.lease_token);
      processedCount++;
    } else {
      await fail(db, item.id, item.lease_token, errorMsg, retryAfter, maxAttempts);
      if (rateLimited) {
        break;
      }
    }
  }
  return processedCount;
}
export { escapeHtml };
