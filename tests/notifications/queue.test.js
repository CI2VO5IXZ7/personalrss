import { describe, it, expect, beforeEach, vi } from 'vitest';
import { D1Mock } from '../helpers/d1_mock.js';
import fs from 'fs';
import path from 'path';
import { enqueue, lease, complete, fail } from '../../src/notifications/queue.js';

describe('D1 Notification Queue', () => {
  let db;

  beforeEach(() => {
    db = new D1Mock();
    const migrationSql = fs.readFileSync(
      path.resolve(__dirname, '../../migrations/0005_personal_info_hub.sql'),
      'utf8'
    );
    db.exec(migrationSql);
  });

  it('should enqueue a notification successfully', async () => {
    const success = await enqueue(db, {
      kind: 'rss',
      dedupeKey: 'rss-item-1',
      payload: { title: 'First Post', link: 'https://example.com/1' }
    });

    expect(success).toBe(true);

    // Duplicated dedupe key should fail (ignored)
    const duplicate = await enqueue(db, {
      kind: 'rss',
      dedupeKey: 'rss-item-1',
      payload: { title: 'First Post Duplicate', link: 'https://example.com/1' }
    });

    expect(duplicate).toBe(false);

    const { results } = await db.prepare('SELECT * FROM notification_queue').all();
    expect(results).toHaveLength(1);
    expect(results[0].kind).toBe('rss');
    expect(results[0].dedupe_key).toBe('rss-item-1');
    expect(JSON.parse(results[0].payload_json).title).toBe('First Post');
    expect(results[0].status).toBe('pending');
  });

  it('should lease pending items atomically', async () => {
    await enqueue(db, { kind: 'rss', dedupeKey: 'k1', payload: { id: 1 } });
    await enqueue(db, { kind: 'stock', dedupeKey: 'k2', payload: { id: 2 } });
    await enqueue(db, { kind: 'system', dedupeKey: 'k3', payload: { id: 3 } });

    // Lease 2 items
    const leased = await lease(db, 2);
    expect(leased).toHaveLength(2);
    expect(leased[0].dedupe_key).toBe('k1');
    expect(leased[0].status).toBe('processing');
    expect(leased[0].attempts).toBe(1);
    expect(leased[1].dedupe_key).toBe('k2');
    expect(leased[1].status).toBe('processing');
    expect(leased[1].attempts).toBe(1);

    // Remaining items
    const { results: pending } = await db.prepare("SELECT * FROM notification_queue WHERE status = 'pending'").all();
    expect(pending).toHaveLength(1);
    expect(pending[0].dedupe_key).toBe('k3');
  });

  it('should handle available_at for leasing', async () => {
    const futureDate = new Date(Date.now() + 3600 * 1000).toISOString();
    await enqueue(db, { kind: 'rss', dedupeKey: 'k1', payload: { id: 1 }, availableAt: futureDate });
    await enqueue(db, { kind: 'rss', dedupeKey: 'k2', payload: { id: 2 } });

    const leased = await lease(db, 10);
    expect(leased).toHaveLength(1);
    expect(leased[0].dedupe_key).toBe('k2');
  });

  it('should complete leased items', async () => {
    await enqueue(db, { kind: 'rss', dedupeKey: 'k1', payload: { id: 1 } });
    const leased = await lease(db, 1);
    const item = leased[0];

    const completed = await complete(db, item.id, item.lease_token);
    expect(completed).toBe(true);

    const row = await db.prepare('SELECT * FROM notification_queue WHERE id = ?').bind(item.id).first();
    expect(row.status).toBe('sent');
    expect(row.sent_at).not.toBeNull();
  });

  it('should fail and retry/dead state correctly', async () => {
    await enqueue(db, { kind: 'rss', dedupeKey: 'k1', payload: { id: 1 } });
    
    // Attempt 1
    let leased = await lease(db, 1, 3);
    expect(leased[0].attempts).toBe(1);
    await fail(db, leased[0].id, leased[0].lease_token, 'Network error 1', 0, 3);

    // Verify it is back to pending and has available_at set
    let row = await db.prepare('SELECT * FROM notification_queue WHERE id = ?').bind(leased[0].id).first();
    expect(row.status).toBe('pending');
    expect(row.last_error).toBe('Network error 1');

    // Attempt 2
    leased = await lease(db, 1, 3);
    expect(leased[0].attempts).toBe(2);
    await fail(db, leased[0].id, leased[0].lease_token, 'Network error 2', 0, 3);

    // Attempt 3
    leased = await lease(db, 1, 3);
    expect(leased[0].attempts).toBe(3);
    await fail(db, leased[0].id, leased[0].lease_token, 'Final blow', 10, 3);

    row = await db.prepare('SELECT * FROM notification_queue WHERE id = ?').bind(leased[0].id).first();
    expect(row.status).toBe('dead');
    expect(row.last_error).toBe('Final blow');
  });

  describe('Lease Recovery and Validation Regressions', () => {
    it('should support lease expiry and recovery for crashed/stale workers', async () => {
      vi.useFakeTimers();
      const startTime = new Date(2026, 6, 13, 12, 0, 0);
      vi.setSystemTime(startTime);

      await enqueue(db, { kind: 'rss', dedupeKey: 'k1', payload: { id: 1 } });

      // Lease item for 10 seconds
      const leased1 = await lease(db, 1, 3, 10);
      expect(leased1).toHaveLength(1);
      expect(leased1[0].attempts).toBe(1);
      expect(leased1[0].lease_token).toBeDefined();

      // Try leasing immediately - should get nothing
      const leasedImmediate = await lease(db, 1, 3, 10);
      expect(leasedImmediate).toHaveLength(0);

      // Advance time by 11 seconds to expire the lease
      vi.setSystemTime(new Date(startTime.getTime() + 11000));

      // Try leasing again - should recover the expired item and increment attempts
      const leased2 = await lease(db, 1, 3, 10);
      expect(leased2).toHaveLength(1);
      expect(leased2[0].attempts).toBe(2);
      expect(leased2[0].lease_token).not.toBe(leased1[0].lease_token);

      vi.useRealTimers();
    });

    it('should require matching lease token and status for complete/fail', async () => {
      await enqueue(db, { kind: 'rss', dedupeKey: 'k1', payload: { id: 1 } });
      const leased = await lease(db, 1);
      const item = leased[0];

      // Try completing with invalid token
      const compBadToken = await complete(db, item.id, 'wrong-token');
      expect(compBadToken).toBe(false);

      // Try failing with invalid token
      const failBadToken = await fail(db, item.id, 'wrong-token', 'error', 0, 3);
      expect(failBadToken).toBe(false);

      // Verify the item is still processing
      const row = await db.prepare('SELECT status FROM notification_queue WHERE id = ?').bind(item.id).first();
      expect(row.status).toBe('processing');

      // Complete with correct token should succeed
      const compGoodToken = await complete(db, item.id, item.lease_token);
      expect(compGoodToken).toBe(true);
    });

    it('should prevent stale workers from completing/failing a newer lease', async () => {
      vi.useFakeTimers();
      const startTime = new Date(2026, 6, 13, 12, 0, 0);
      vi.setSystemTime(startTime);

      await enqueue(db, { kind: 'rss', dedupeKey: 'k1', payload: { id: 1 } });

      // Worker A leases
      const leasedA = await lease(db, 1, 3, 10);
      const itemA = leasedA[0];

      // Expire lease
      vi.setSystemTime(new Date(startTime.getTime() + 11000));

      // Worker B leases (newer lease)
      const leasedB = await lease(db, 1, 3, 10);
      const itemB = leasedB[0];
      expect(itemB.lease_token).not.toBe(itemA.lease_token);

      // Worker A tries to complete (stale)
      const compStale = await complete(db, itemA.id, itemA.lease_token);
      expect(compStale).toBe(false);

      // Worker A tries to fail (stale)
      const failStale = await fail(db, itemA.id, itemA.lease_token, 'stale err', 0, 3);
      expect(failStale).toBe(false);

      // Verify item remains in processing status with B's lease token
      const row = await db.prepare('SELECT status, lease_token FROM notification_queue WHERE id = ?').bind(itemB.id).first();
      expect(row.status).toBe('processing');
      expect(row.lease_token).toBe(itemB.lease_token);

      // Worker B completes
      const compFresh = await complete(db, itemB.id, itemB.lease_token);
      expect(compFresh).toBe(true);

      vi.useRealTimers();
    });
  });

  describe('Queue Exhaustion', () => {
    it('should move a crashed final leased attempt to dead after expiry', async () => {
      vi.useFakeTimers();
      const startTime = new Date(2026, 6, 13, 12, 0, 0);
      vi.setSystemTime(startTime);

      await enqueue(db, { kind: 'rss', dedupeKey: 'k1', payload: { id: 1 } });

      // Attempt 1: Lease and fail
      let leased = await lease(db, 1, 3, 10);
      expect(leased[0].attempts).toBe(1);
      await fail(db, leased[0].id, leased[0].lease_token, 'err 1', 0, 3);

      // Attempt 2: Lease and fail
      leased = await lease(db, 1, 3, 10);
      expect(leased[0].attempts).toBe(2);
      await fail(db, leased[0].id, leased[0].lease_token, 'err 2', 0, 3);

      // Attempt 3: Lease and then worker crashes (expired)
      leased = await lease(db, 1, 3, 10);
      expect(leased[0].attempts).toBe(3);
      const crashedToken = leased[0].lease_token;

      // Advance time by 11 seconds to expire the lease
      vi.setSystemTime(new Date(startTime.getTime() + 11000));

      // Call lease() which should move it to dead
      const newlyLeased = await lease(db, 1, 3, 10);
      expect(newlyLeased).toHaveLength(0); // Should not lease it again

      // Verify the item is now dead in the database
      const row = await db.prepare('SELECT * FROM notification_queue WHERE id = ?').bind(leased[0].id).first();
      expect(row.status).toBe('dead');
      expect(row.attempts).toBe(3);
      expect(row.last_error).toBe('max attempts exhausted');
      expect(row.processing_started_at).toBeNull();
      expect(row.lease_token).toBeNull();
      expect(row.lease_expires_at).toBeNull();

      // Verify lease-token stale-worker safety: crashed worker trying to complete/fail should fail
      const compCrashed = await complete(db, row.id, crashedToken);
      expect(compCrashed).toBe(false);

      const failCrashed = await fail(db, row.id, crashedToken, 'crashed worker retry', 0, 3);
      expect(failCrashed).toBe(false);

      vi.useRealTimers();
    });

    it('should move a pending exhausted row to dead', async () => {
      // Enqueue item
      await enqueue(db, { kind: 'rss', dedupeKey: 'k2', payload: { id: 2 } });
      
      // Manually set it to pending and attempts = 3 (exhausted)
      await db.prepare(
        "UPDATE notification_queue SET attempts = 3, status = 'pending', available_at = ? WHERE dedupe_key = 'k2'"
      ).bind(new Date().toISOString()).run();

      // Call lease() which should move it to dead
      const newlyLeased = await lease(db, 1, 3, 10);
      expect(newlyLeased).toHaveLength(0);

      // Verify it is dead
      const row = await db.prepare("SELECT * FROM notification_queue WHERE dedupe_key = 'k2'").first();
      expect(row.status).toBe('dead');
      expect(row.last_error).toBe('max attempts exhausted');
      expect(row.lease_token).toBeNull();
    });

    it('should leave non-expired processing row untouched', async () => {
      await enqueue(db, { kind: 'rss', dedupeKey: 'k3', payload: { id: 3 } });

      // Lease it (attempts = 1, status = 'processing')
      const leased = await lease(db, 1, 3, 100);
      expect(leased).toHaveLength(1);
      expect(leased[0].attempts).toBe(1);

      // Call lease again immediately
      const leased2 = await lease(db, 1, 3, 100);
      expect(leased2).toHaveLength(0);

      // Verify the item is still processing and untouched
      const row = await db.prepare("SELECT * FROM notification_queue WHERE dedupe_key = 'k3'").first();
      expect(row.status).toBe('processing');
      expect(row.attempts).toBe(1);
      expect(row.lease_token).toBe(leased[0].lease_token);
    });
  });
});
