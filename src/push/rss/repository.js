function validatePositiveInteger(name, value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid ${name}: must be a positive integer`);
  }
}

export async function addSubscription(db, feedUrl, feedUrlRedacted, siteUrl, title, intervalMinutes = 10) {
  validatePositiveInteger('intervalMinutes', intervalMinutes);
  const result = await db.prepare(
    `INSERT OR IGNORE INTO rss_subscriptions (feed_url, feed_url_redacted, site_url, title, interval_minutes, next_check_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`
  ).bind(feedUrl, feedUrlRedacted, siteUrl, title, intervalMinutes).run();
  return result.meta.changes > 0;
}

export async function getSubscriptions(db) {
  const { results } = await db.prepare('SELECT * FROM rss_subscriptions ORDER BY created_at DESC').all();
  return results || [];
}

export async function getSubscription(db, id) {
  validatePositiveInteger('id', id);
  return await db.prepare('SELECT * FROM rss_subscriptions WHERE id = ?').bind(id).first();
}

export async function getSubscriptionByUrl(db, feedUrl) {
  return await db.prepare('SELECT * FROM rss_subscriptions WHERE feed_url = ?').bind(feedUrl).first();
}

export async function pauseSubscription(db, id) {
  validatePositiveInteger('id', id);
  const result = await db.prepare(
    "UPDATE rss_subscriptions SET status = 'paused', updated_at = datetime('now') WHERE id = ?"
  ).bind(id).run();
  return result.meta.changes > 0;
}

export async function resumeSubscription(db, id) {
  validatePositiveInteger('id', id);
  const result = await db.prepare(
    "UPDATE rss_subscriptions SET status = 'active', next_check_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
  ).bind(id).run();
  return result.meta.changes > 0;
}

export async function removeSubscription(db, id) {
  validatePositiveInteger('id', id);
  const results = await db.batch([
    db.prepare(
      `DELETE FROM notification_queue
       WHERE dedupe_key LIKE ?
         AND status IN ('pending', 'processing', 'failed')`
    ).bind(`rss:${id}:%`),
    db.prepare('DELETE FROM rss_entries WHERE subscription_id = ?').bind(id),
    db.prepare('DELETE FROM rss_subscriptions WHERE id = ?').bind(id)
  ]);
  return (results[2]?.meta?.changes || 0) > 0;
}
