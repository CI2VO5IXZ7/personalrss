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

  it('runs the generator assembly on every cron tick', async () => {
    vi.setSystemTime(new Date(2026, 6, 13, 12, 10, 0));
    const generatorScheduler = await import('../src/generators/core/scheduler.js');
    const genSpy = vi.spyOn(generatorScheduler, 'runDueGenerators')
      .mockResolvedValue({ attempted: 0, succeeded: 0, failed: 0, errorsRedacted: [] });

    const app = (await import('../src/index.js')).default;
    const env = { DB: {} };
    const ctx = { waitUntil: vi.fn(async (promise) => await promise) };

    await app.scheduled({ cron: '*/10 * * * *' }, env, ctx);

    expect(genSpy).toHaveBeenCalledTimes(1);
  });

  it('isolates generator failure so the scheduled handler resolves', async () => {
    vi.setSystemTime(new Date(2026, 6, 13, 12, 10, 0));
    const generatorScheduler = await import('../src/generators/core/scheduler.js');
    const genSpy = vi.spyOn(generatorScheduler, 'runDueGenerators')
      .mockRejectedValue(new Error('generator boom'));

    const app = (await import('../src/index.js')).default;
    const env = { DB: {} };
    const ctx = { waitUntil: vi.fn(async (promise) => await promise) };

    await expect(app.scheduled({ cron: '*/10 * * * *' }, env, ctx)).resolves.toBeUndefined();
    expect(genSpy).toHaveBeenCalledTimes(1);
  });
});
