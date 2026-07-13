import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import app from '../src/index.js';

describe('Cron Trigger Cadence and Batching', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('should run Instagram refresh, RSS process, and Notification send on 10-minute intervals', async () => {
    // Set system time to minute 10
    vi.setSystemTime(new Date(2026, 6, 13, 12, 10, 0));

    // Mock functions called during cron
    const mockRssScheduler = await import('../src/rss/scheduler.js');
    const mockRssSpy = vi.spyOn(mockRssScheduler, 'processDueSubscriptions').mockResolvedValue(0);

    const mockSender = await import('../src/notifications/sender.js');
    const mockSenderSpy = vi.spyOn(mockSender, 'processNotificationBatch').mockResolvedValue(0);

    // To mock refreshAllCaches, we can mock DB / platform query
    const dbMock = {
      prepare: vi.fn().mockImplementation(() => {
        const stmt = {
          all: vi.fn().mockResolvedValue({ results: [] })
        };
        stmt.bind = vi.fn().mockReturnValue(stmt);
        return stmt;
      })
    };

    const env = { DB: dbMock };
    const ctx = {
      waitUntil: vi.fn(async (promise) => {
        await promise;
      })
    };

    await app.scheduled({ cron: '*/5 * * * *' }, env, ctx);

    // Verify all 3 were scheduled
    expect(mockRssSpy).toHaveBeenCalledTimes(1);
    expect(mockSenderSpy).toHaveBeenCalledTimes(1);
    // Instagram accounts query should be prepared since it's minute 10
    expect(dbMock.prepare).toHaveBeenCalled();
  });

  it('should skip Instagram refresh but run RSS and Notification processing on 5-minute intervals (not 10)', async () => {
    // Set system time to minute 15
    vi.setSystemTime(new Date(2026, 6, 13, 12, 15, 0));

    const mockRssScheduler = await import('../src/rss/scheduler.js');
    const mockRssSpy = vi.spyOn(mockRssScheduler, 'processDueSubscriptions').mockResolvedValue(0);

    const mockSender = await import('../src/notifications/sender.js');
    const mockSenderSpy = vi.spyOn(mockSender, 'processNotificationBatch').mockResolvedValue(0);

    const dbMock = {
      prepare: vi.fn().mockImplementation(() => {
        const stmt = {
          all: vi.fn().mockResolvedValue({ results: [] })
        };
        stmt.bind = vi.fn().mockReturnValue(stmt);
        return stmt;
      })
    };

    const env = { DB: dbMock };
    const ctx = {
      waitUntil: vi.fn(async (promise) => {
        await promise;
      })
    };

    await app.scheduled({ cron: '*/5 * * * *' }, env, ctx);

    // Verify RSS and notifications were run
    expect(mockRssSpy).toHaveBeenCalledTimes(1);
    expect(mockSenderSpy).toHaveBeenCalledTimes(1);
    // Instagram accounts should NOT be queried
    expect(dbMock.prepare).not.toHaveBeenCalled();
  });
});
