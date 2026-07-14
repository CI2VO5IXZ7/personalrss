import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('Cron Trigger Isolation and Import Seams', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function loadSpies() {
    const generatorScheduler = await import('../src/generators/core/scheduler.js');
    const monitorEngine = await import('../src/monitors/core/engine.js');
    const pushScheduler = await import('../src/push/rss/scheduler.js');
    const pushSender = await import('../src/push/notifications/sender.js');

    return {
      genSpy: vi.spyOn(generatorScheduler, 'runDueGenerators').mockResolvedValue({ attempted: 0, succeeded: 0, failed: 0, errorsRedacted: [] }),
      monitorSpy: vi.spyOn(monitorEngine, 'evaluateRules').mockResolvedValue(0),
      pushSpy: vi.spyOn(pushScheduler, 'processDueSubscriptions').mockResolvedValue(0),
      senderSpy: vi.spyOn(pushSender, 'processNotificationBatch').mockResolvedValue(0)
    };
  }

  it('runs all four assemblies at 10-minute marks', async () => {
    vi.setSystemTime(new Date(2026, 6, 13, 12, 10, 0));
    const { genSpy, monitorSpy, pushSpy, senderSpy } = await loadSpies();

    const app = (await import('../src/index.js')).default;
    const env = { DB: {} };
    const ctx = { waitUntil: vi.fn(async (promise) => await promise) };

    await app.scheduled({ cron: '*/5 * * * *' }, env, ctx);

    expect(genSpy).toHaveBeenCalledTimes(1);
    expect(monitorSpy).toHaveBeenCalledTimes(1);
    expect(pushSpy).toHaveBeenCalledTimes(1);
    expect(senderSpy).toHaveBeenCalledTimes(1);
  });

  it('skips generator refresh but still runs monitor, push, and queue on 5-minute offsets', async () => {
    vi.setSystemTime(new Date(2026, 6, 13, 12, 15, 0));
    const { genSpy, monitorSpy, pushSpy, senderSpy } = await loadSpies();

    const app = (await import('../src/index.js')).default;
    const env = { DB: {} };
    const ctx = { waitUntil: vi.fn(async (promise) => await promise) };

    await app.scheduled({ cron: '*/5 * * * *' }, env, ctx);

    expect(genSpy).toHaveBeenCalledTimes(0);
    expect(monitorSpy).toHaveBeenCalledTimes(1);
    expect(pushSpy).toHaveBeenCalledTimes(1);
    expect(senderSpy).toHaveBeenCalledTimes(1);
  });

  it('isolates generator failure so monitor, push, and queue each run once', async () => {
    vi.setSystemTime(new Date(2026, 6, 13, 12, 10, 0));
    const generatorScheduler = await import('../src/generators/core/scheduler.js');
    const monitorEngine = await import('../src/monitors/core/engine.js');
    const pushScheduler = await import('../src/push/rss/scheduler.js');
    const pushSender = await import('../src/push/notifications/sender.js');

    const genSpy = vi.spyOn(generatorScheduler, 'runDueGenerators').mockRejectedValue(new Error('generator boom'));
    const monitorSpy = vi.spyOn(monitorEngine, 'evaluateRules').mockResolvedValue(0);
    const pushSpy = vi.spyOn(pushScheduler, 'processDueSubscriptions').mockResolvedValue(0);
    const senderSpy = vi.spyOn(pushSender, 'processNotificationBatch').mockResolvedValue(0);

    const app = (await import('../src/index.js')).default;
    const env = { DB: {} };
    const ctx = { waitUntil: vi.fn(async (promise) => await promise) };

    await app.scheduled({ cron: '*/5 * * * *' }, env, ctx);

    expect(genSpy).toHaveBeenCalledTimes(1);
    expect(monitorSpy).toHaveBeenCalledTimes(1);
    expect(pushSpy).toHaveBeenCalledTimes(1);
    expect(senderSpy).toHaveBeenCalledTimes(1);
  });
});
