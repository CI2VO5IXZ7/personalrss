import { redactUrl, redactText } from '../security/url.js';

export async function enqueue(db, { kind, dedupeKey, payload, availableAt }) {
  try {
    const payloadJson = typeof payload === 'object' ? JSON.stringify(payload) : payload;
    const available = availableAt || new Date().toISOString();
    const result = await db.prepare(
      `INSERT OR IGNORE INTO notification_queue (kind, dedupe_key, payload_json, status, available_at)
       VALUES (?, ?, ?, 'pending', ?)`
    ).bind(kind, dedupeKey, payloadJson, available).run();

    return result.meta.changes > 0;
  } catch (e) {
    const cleanMsg = redactText(e.message);
    console.error('[queue] enqueue error:', cleanMsg);
    throw new Error(cleanMsg);
  }
}

function generateUUID() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function safeDeadItemKind(kind) {
  const value = String(kind || 'unknown');
  return /^[a-z0-9_-]{1,32}$/i.test(value) ? value : 'unknown';
}

export async function lease(db, limit, maxAttempts = 3, leaseDurationSeconds = 300, leaseToken = null) {
  try {
    const token = leaseToken || generateUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + leaseDurationSeconds * 1000);
    const nowStr = now.toISOString();
    const expiresAtStr = expiresAt.toISOString();
    
    const batchResults = await db.batch([
      db.prepare(
        `UPDATE notification_queue
         SET status = 'dead',
             last_error = 'max attempts exhausted',
             processing_started_at = NULL,
             lease_token = NULL,
             lease_expires_at = NULL
         WHERE attempts >= ?
           AND (
             (status = 'pending' AND (available_at IS NULL OR available_at <= ?))
             OR
             (status = 'processing' AND (lease_expires_at IS NOT NULL AND lease_expires_at <= ?))
           )
         RETURNING id, kind`
      ).bind(maxAttempts, nowStr, nowStr),
      db.prepare(
        `UPDATE notification_queue
         SET status = 'processing',
             processing_started_at = ?,
             lease_token = ?,
             lease_expires_at = ?,
             attempts = attempts + 1
         WHERE id IN (
           SELECT id FROM notification_queue
           WHERE (
             (status = 'pending' AND (available_at IS NULL OR available_at <= ?))
             OR
             (status = 'processing' AND (lease_expires_at IS NOT NULL AND lease_expires_at <= ?))
           )
             AND attempts < ?
           ORDER BY created_at ASC
           LIMIT ?
         )
         RETURNING *`
      ).bind(nowStr, token, expiresAtStr, nowStr, nowStr, maxAttempts, limit),
      db.prepare(
        `INSERT OR IGNORE INTO notification_queue
           (kind, dedupe_key, payload_json, status, available_at)
         SELECT
           'system',
           'system:notification-dead:' || id,
           json_object(
             'message',
             'Notification id ' || id || ' kind ' ||
             CASE
               WHEN length(kind) BETWEEN 1 AND 32
                 AND kind NOT GLOB '*[^A-Za-z0-9_-]*' THEN kind
               ELSE 'unknown'
             END || ' reached dead status.'
           ),
           'pending',
           ?
         FROM notification_queue
         WHERE kind <> 'system'
           AND status = 'dead'
           AND attempts >= ?
           AND last_error = 'max attempts exhausted'`
      ).bind(nowStr, maxAttempts)
    ]);

    return batchResults[1].results || [];
  } catch (e) {
    console.error('[queue] lease error:', redactText(e.message));
    return [];
  }
}

export async function complete(db, id, leaseToken) {
  try {
    const now = new Date().toISOString();
    const result = await db.prepare(
      `UPDATE notification_queue
       SET status = 'sent', sent_at = ?, processing_started_at = NULL, lease_token = NULL, lease_expires_at = NULL
       WHERE id = ? AND status = 'processing' AND lease_token = ?`
    ).bind(now, id, leaseToken).run();
    return result.meta.changes > 0;
  } catch (e) {
    console.error('[queue] complete error:', redactText(e.message));
    return false;
  }
}

export async function fail(db, id, leaseToken, errorMsg, backoffSeconds = 60, maxAttempts = 3) {
  try {
    const cleanErrorMsg = redactText(String(errorMsg || 'Unknown error'));
    const item = await db.prepare(
      `SELECT id, kind, attempts FROM notification_queue WHERE id = ? AND status = 'processing' AND lease_token = ?`
    ).bind(id, leaseToken).first();

    if (!item) return false;

    if (item.attempts >= maxAttempts) {
      const nowStr = new Date().toISOString();
      const alertPayload = JSON.stringify({
        message: `Notification id ${Number(item.id)} kind ${safeDeadItemKind(item.kind)} reached dead status.`
      });
      const results = await db.batch([
        db.prepare(
          `UPDATE notification_queue
           SET status = 'dead', last_error = ?, processing_started_at = NULL, lease_token = NULL, lease_expires_at = NULL
           WHERE id = ? AND status = 'processing' AND lease_token = ?`
        ).bind(cleanErrorMsg, id, leaseToken),
        db.prepare(
          `INSERT OR IGNORE INTO notification_queue
             (kind, dedupe_key, payload_json, status, available_at)
           SELECT 'system', ?, ?, 'pending', ?
           FROM notification_queue
           WHERE id = ? AND kind <> 'system' AND status = 'dead'`
        ).bind(`system:notification-dead:${Number(item.id)}`, alertPayload, nowStr, id)
      ]);
      return results[0].meta.changes > 0;
    } else {
      const availableAt = new Date(Date.now() + backoffSeconds * 1000).toISOString();
      const result = await db.prepare(
        `UPDATE notification_queue
         SET status = 'pending', last_error = ?, available_at = ?, processing_started_at = NULL, lease_token = NULL, lease_expires_at = NULL
         WHERE id = ? AND status = 'processing' AND lease_token = ?`
      ).bind(cleanErrorMsg, availableAt, id, leaseToken).run();
      return result.meta.changes > 0;
    }
  } catch (e) {
    console.error('[queue] fail error:', redactText(e.message));
    return false;
  }
}
