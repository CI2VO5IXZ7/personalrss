import { describe, it, expect, beforeEach } from 'vitest';
import { D1Mock } from './helpers/d1_mock.js';
import fs from 'fs';
import path from 'path';
import {
  addRssSubscription,
  getRssSubscriptions,
  getRssSubscription,
  getRssSubscriptionByUrl,
  removeRssSubscription,
  pauseRssSubscription,
  resumeRssSubscription,
  updateRssSubscriptionInterval,
  updateRssSubscriptionCheck,
  getDueRssSubscriptions,
  addRssEntry,
  hasRssEntry,
  atomicClaimAndEnqueueRssNotification,
  getBotSession,
  setBotSession,
  clearBotSession,
  addTrackerRule,
  getTrackerRule,
  updateTrackerRuleStatus,
  atomicTriggerAndEnqueueStockNotification
} from '../src/db.js';

describe('RSS D1 Repository & Bot Sessions', () => {
  let db;

  beforeEach(() => {
    db = new D1Mock();
    const migrationSql = fs.readFileSync(
      path.resolve(__dirname, '../migrations/0005_personal_info_hub.sql'),
      'utf8'
    );
    db.exec(migrationSql);
  });

  it('should manage RSS subscriptions', async () => {
    const success = await addRssSubscription(
      db,
      'https://example.com/feed.xml?token=secret123',
      'https://example.com/feed.xml?token=***',
      'https://example.com',
      'Example Feed',
      15
    );
    expect(success).toBe(true);

    const subs = await getRssSubscriptions(db);
    expect(subs).toHaveLength(1);
    expect(subs[0].title).toBe('Example Feed');
    expect(subs[0].feed_url).toBe('https://example.com/feed.xml?token=secret123');
    expect(subs[0].feed_url_redacted).toBe('https://example.com/feed.xml?token=***');
    expect(subs[0].interval_minutes).toBe(15);
    expect(subs[0].status).toBe('active');

    const subById = await getRssSubscription(db, subs[0].id);
    expect(subById.title).toBe('Example Feed');

    const subByUrl = await getRssSubscriptionByUrl(db, 'https://example.com/feed.xml?token=secret123');
    expect(subByUrl.title).toBe('Example Feed');

    // Pause
    const paused = await pauseRssSubscription(db, subs[0].id);
    expect(paused).toBe(true);
    let updatedSub = await getRssSubscription(db, subs[0].id);
    expect(updatedSub.status).toBe('paused');

    // Resume
    const resumed = await resumeRssSubscription(db, subs[0].id);
    expect(resumed).toBe(true);
    updatedSub = await getRssSubscription(db, subs[0].id);
    expect(updatedSub.status).toBe('active');

    // Update interval
    const intervalUpdated = await updateRssSubscriptionInterval(db, subs[0].id, 30);
    expect(intervalUpdated).toBe(true);
    updatedSub = await getRssSubscription(db, subs[0].id);
    expect(updatedSub.interval_minutes).toBe(30);

    // Remove
    const removed = await removeRssSubscription(db, subs[0].id);
    expect(removed).toBe(true);
    const subsAfter = await getRssSubscriptions(db);
    expect(subsAfter).toHaveLength(0);
  });

  it('should handle due subscriptions', async () => {
    // Add active feed due now (default next_check_at is datetime('now'))
    await addRssSubscription(db, 'https://due.com/feed', 'https://due.com/feed', 'https://due.com', 'Due', 10);
    // Add paused feed due now
    await addRssSubscription(db, 'https://paused.com/feed', 'https://paused.com/feed', 'https://paused.com', 'Paused', 10);
    const allSubs = await getRssSubscriptions(db);
    const dueId = allSubs.find(s => s.title === 'Due').id;
    const pausedId = allSubs.find(s => s.title === 'Paused').id;
    await pauseRssSubscription(db, pausedId);

    // Add active feed due in the future
    await addRssSubscription(db, 'https://future.com/feed', 'https://future.com/feed', 'https://future.com', 'Future', 10);
    const futureId = allSubs.find(s => s.title === 'Future')?.id || (allSubs.find(s => s.title === 'Due').id + 2);
    // Update future check time
    await db.prepare(
      "UPDATE rss_subscriptions SET next_check_at = datetime('now', '+1 hour') WHERE id = ?"
    ).bind(futureId).run();

    const dueSubs = await getDueRssSubscriptions(db, 10);
    expect(dueSubs).toHaveLength(1);
    expect(dueSubs[0].id).toBe(dueId);

    // Update check details
    const nextCheck = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const updateSuccess = await updateRssSubscriptionCheck(db, dueId, {
      status: 'active',
      etag: 'etag-val',
      lastModified: 'mod-val',
      lastCheckedAt: new Date().toISOString(),
      lastSuccessAt: new Date().toISOString(),
      consecutiveFailures: 0,
      lastError: '',
      nextCheckAt: nextCheck
    });
    expect(updateSuccess).toBe(true);

    const dueSubsAfter = await getDueRssSubscriptions(db, 10);
    expect(dueSubsAfter).toHaveLength(0);
  });

  it('should handle RSS entries deduplication', async () => {
    await addRssSubscription(db, 'https://feed.com', 'https://feed.com', 'https://feed.com', 'Feed', 10);
    const subs = await getRssSubscriptions(db);
    const subId = subs[0].id;

    const entry = {
      entryKey: 'item-1',
      guid: 'guid-1',
      link: 'https://feed.com/1',
      title: 'Item 1',
      publishedAt: '2026-07-13T12:00:00Z',
      contentHash: 'hash1',
      imageUrl: 'https://feed.com/image.jpg'
    };

    const added = await addRssEntry(db, subId, entry);
    expect(added).toBe(true);

    // Check presence
    const hasIt = await hasRssEntry(db, subId, 'item-1');
    expect(hasIt).toBe(true);

    const hasOther = await hasRssEntry(db, subId, 'item-2');
    expect(hasOther).toBe(false);

    // Attempting to add duplicate should fail/ignore
    const addedDup = await addRssEntry(db, subId, entry);
    expect(addedDup).toBe(false);

    expect(await hasRssEntry(db, subId, 'changed-guid', entry.link, 'different-hash')).toBe(true);
    expect(await hasRssEntry(db, subId, 'changed-guid', 'https://feed.com/changed', entry.contentHash)).toBe(true);
  });

  it('atomically rolls back an RSS entry when notification queue insertion fails', async () => {
    await addRssSubscription(db, 'https://feed.com', 'https://feed.com', '', 'Feed', 10);
    const [sub] = await getRssSubscriptions(db);
    const entry = {
      entryKey: 'new-guid', guid: 'new-guid', link: 'https://feed.com/new',
      title: 'New', publishedAt: '2026-07-13T12:00:00Z', contentHash: 'new-hash', imageUrl: ''
    };
    db.exec(`CREATE TRIGGER fail_rss_notification BEFORE INSERT ON notification_queue
      WHEN NEW.kind = 'rss' BEGIN SELECT RAISE(FAIL, 'queue failed'); END;`);

    await expect(atomicClaimAndEnqueueRssNotification(db, sub.id, entry, {
      feedTitle: 'Feed', entryTitle: 'New'
    })).rejects.toThrow('queue failed');

    expect((await db.prepare('SELECT * FROM rss_entries').all()).results).toHaveLength(0);
    expect((await db.prepare('SELECT * FROM notification_queue').all()).results).toHaveLength(0);
  });

  it('should enforce feed_url uniqueness and ignore duplicate add attempts', async () => {
    const added1 = await addRssSubscription(
      db,
      'https://example.com/unique-feed.xml',
      'https://example.com/unique-feed.xml',
      'https://example.com',
      'Unique Feed',
      10
    );
    expect(added1).toBe(true);

    // Duplicate add attempt
    const added2 = await addRssSubscription(
      db,
      'https://example.com/unique-feed.xml',
      'https://example.com/unique-feed.xml',
      'https://example.com',
      'Unique Feed Duplicate',
      10
    );
    expect(added2).toBe(false);

    // Verify only one row exists and it has the first title
    const subs = await getRssSubscriptions(db);
    const match = subs.filter(s => s.feed_url === 'https://example.com/unique-feed.xml');
    expect(match).toHaveLength(1);
    expect(match[0].title).toBe('Unique Feed');
  });

  it('should handle bot sessions flow', async () => {
    const expiresAt = new Date(Date.now() + 600 * 1000).toISOString();
    const success = await setBotSession(db, 'chat123', 'rss_add', 'await_url', { count: 1 }, expiresAt);
    expect(success).toBe(true);

    const session = await getBotSession(db, 'chat123');
    expect(session).not.toBeNull();
    expect(session.flow).toBe('rss_add');
    expect(session.step).toBe('await_url');
    expect(JSON.parse(session.data_json)).toEqual({ count: 1 });

    const cleared = await clearBotSession(db, 'chat123');
    expect(cleared).toBe(true);

    const sessionAfter = await getBotSession(db, 'chat123');
    expect(sessionAfter).toBeNull();
  });
});

describe('Tracker Rules Status Management', () => {
  let db;
  beforeEach(() => {
    db = new D1Mock();
    const migrationSql = fs.readFileSync(
      path.resolve(__dirname, '../migrations/0005_personal_info_hub.sql'),
      'utf8'
    );
    db.exec(migrationSql);
  });

  it('rolls back the rule transition when the stock notification insert fails', async () => {
    await addTrackerRule(db, {
      providerType: 'stock', targetKey: 'sh600519', targetConfig: {},
      conditionType: 'gte', conditionValue: 1700
    });
    await db.prepare(
      `INSERT INTO notification_queue (kind, dedupe_key, payload_json)
       VALUES ('stock', 'stock:rule:1:1', '{}')`
    ).run();

    await expect(atomicTriggerAndEnqueueStockNotification(db, {
      ruleId: 1, armVersion: 1, lastValue: 1750,
      lastObservedAt: '2026-07-13T10:00:00+08:00', lastSource: 'tencent',
      payload: { ruleId: 1, armVersion: 1 }
    })).rejects.toThrow();

    expect((await getTrackerRule(db, 1)).status).toBe('active');
  });

  it('should only resume paused or triggered rules and increment arm_version exactly once', async () => {
    // Create a test rule for each status
    await addTrackerRule(db, {
      providerType: 'stock',
      targetKey: 'sh600519',
      targetConfig: { code: '600519' },
      conditionType: 'gte',
      conditionValue: 1700.00,
      status: 'paused'
    }); // ID 1
    
    await addTrackerRule(db, {
      providerType: 'stock',
      targetKey: 'sz000001',
      targetConfig: { code: '000001' },
      conditionType: 'gte',
      conditionValue: 10.00,
      status: 'triggered'
    }); // ID 2

    await addTrackerRule(db, {
      providerType: 'stock',
      targetKey: 'sh688001',
      targetConfig: { code: '688001' },
      conditionType: 'gte',
      conditionValue: 50.00,
      status: 'trigger_pending'
    }); // ID 3

    await addTrackerRule(db, {
      providerType: 'stock',
      targetKey: 'bj920185',
      targetConfig: { code: '920185' },
      conditionType: 'gte',
      conditionValue: 5.00,
      status: 'active'
    }); // ID 4

    await addTrackerRule(db, {
      providerType: 'stock',
      targetKey: 'sh900901',
      targetConfig: { code: '900901' },
      conditionType: 'gte',
      conditionValue: 2.00,
      status: 'error'
    }); // ID 5

    // 1. Resume paused rule (ID 1)
    const resPaused = await updateTrackerRuleStatus(db, 1, 'active');
    expect(resPaused).toBe(true);
    const rule1 = await getTrackerRule(db, 1);
    expect(rule1.status).toBe('active');
    expect(rule1.arm_version).toBe(2); // Initial arm_version is 1, incremented to 2

    // 2. Resume triggered rule (ID 2)
    const resTriggered = await updateTrackerRuleStatus(db, 2, 'active');
    expect(resTriggered).toBe(true);
    const rule2 = await getTrackerRule(db, 2);
    expect(rule2.status).toBe('active');
    expect(rule2.arm_version).toBe(2); // Initial is 1, incremented to 2

    // 3. Try to resume trigger_pending rule (ID 3) - should FAIL
    const resPending = await updateTrackerRuleStatus(db, 3, 'active');
    expect(resPending).toBe(false);
    const rule3 = await getTrackerRule(db, 3);
    expect(rule3.status).toBe('trigger_pending');
    expect(rule3.arm_version).toBe(1); // Unchanged

    // 4. Try to resume active rule (ID 4) - should FAIL
    const resActive = await updateTrackerRuleStatus(db, 4, 'active');
    expect(resActive).toBe(false);
    const rule4 = await getTrackerRule(db, 4);
    expect(rule4.status).toBe('active');
    expect(rule4.arm_version).toBe(1); // Unchanged

    // 5. Try to resume error rule (ID 5) - should FAIL
    const resError = await updateTrackerRuleStatus(db, 5, 'active');
    expect(resError).toBe(false);
    const rule5 = await getTrackerRule(db, 5);
    expect(rule5.status).toBe('error');
    expect(rule5.arm_version).toBe(1); // Unchanged
  });
});
