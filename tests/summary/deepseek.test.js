import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { D1Mock } from '../helpers/d1_mock.js';
import fs from 'fs';
import path from 'path';
import {
  getBeijingDate,
  checkAndIncrementUsage,
  classifyError,
  summarizeContent,
  summarizeWithFallback
} from '../../src/summary/deepseek.js';

describe('DeepSeek Provider Module', () => {
  let db;

  beforeEach(() => {
    db = new D1Mock();
    const migrationSql = fs.readFileSync(
      path.resolve(__dirname, '../../migrations/0005_personal_info_hub.sql'),
      'utf8'
    );
    db.exec(migrationSql);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Beijing Date Helper', () => {
    it('should return a date in YYYY-MM-DD format', () => {
      const date = getBeijingDate();
      expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });

  describe('Daily Limit Primitives', () => {
    it('should increment usage and respect limit', async () => {
      const limit = 3;
      
      // Attempt 1: under limit
      let allowed = await checkAndIncrementUsage(db, limit);
      expect(allowed).toBe(true);

      // Attempt 2: under limit
      allowed = await checkAndIncrementUsage(db, limit);
      expect(allowed).toBe(true);

      // Attempt 3: under limit
      allowed = await checkAndIncrementUsage(db, limit);
      expect(allowed).toBe(true);

      // Attempt 4: hits limit
      allowed = await checkAndIncrementUsage(db, limit);
      expect(allowed).toBe(false);

      const dateStr = getBeijingDate();
      const row = await db.prepare('SELECT count FROM daily_usage WHERE usage_date = ? AND usage_type = ?')
        .bind(dateStr, 'deepseek_summary').first();
      expect(row.count).toBe(3);
    });
  });

  describe('Error Classification', () => {
    it('should classify transient errors as retryable', () => {
      expect(classifyError(429).retryable).toBe(true);
      expect(classifyError(500).retryable).toBe(true);
      expect(classifyError(503).retryable).toBe(true);
      expect(classifyError('TIMEOUT').retryable).toBe(true);
    });

    it('should classify client errors as non-retryable', () => {
      expect(classifyError(400).retryable).toBe(false);
      expect(classifyError(401).retryable).toBe(false);
      expect(classifyError(403).retryable).toBe(false);
    });
  });

  describe('Content Summarization API Call', () => {
    it('should successfully call API and return summary', async () => {
      const mockFetch = vi.fn().mockImplementation(async () => {
        return {
          status: 200,
          ok: true,
          json: async () => ({
            choices: [{ message: { content: 'This is a summary.' } }]
          })
        };
      });

      const summary = await summarizeContent('test-key', 'Some long content', {
        fetchFn: mockFetch
      });

      expect(summary).toBe('This is a summary.');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('requests a factual 2-3 sentence Simplified Chinese summary of approximately 150-250 characters', async () => {
      const mockFetch = vi.fn(async () => ({
        status: 200,
        ok: true,
        json: async () => ({ choices: [{ message: { content: '摘要' } }] })
      }));

      await summarizeContent('test-key', 'Article facts only', { fetchFn: mockFetch });

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      const prompt = requestBody.messages.map(message => message.content).join('\n');
      expect(prompt).toContain('Simplified Chinese');
      expect(prompt).toContain('2-3 sentences');
      expect(prompt).toContain('approximately 150-250 Chinese characters');
      expect(prompt).toContain('Do not fabricate');
      expect(prompt).toContain('Article facts only');
    });

    it('should retry transient errors and eventually succeed', async () => {
      let calls = 0;
      const mockFetch = vi.fn().mockImplementation(async () => {
        calls++;
        if (calls === 1) {
          return { status: 429, ok: false };
        }
        return {
          status: 200,
          ok: true,
          json: async () => ({
            choices: [{ message: { content: 'Summary after retry' } }]
          })
        };
      });

      const summary = await summarizeContent('test-key', 'Some content', {
        fetchFn: mockFetch,
        backoffMs: 1 // speed up tests
      });

      expect(summary).toBe('Summary after retry');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('times out a hanging response body, aborts it, and retries after backoff', async () => {
      vi.useFakeTimers();
      const signals = [];
      const mockFetch = vi.fn((_url, { signal }) => {
        signals.push(signal);
        if (signals.length === 1) {
          return Promise.resolve({
            status: 200,
            ok: true,
            json: () => new Promise(() => {})
          });
        }
        return Promise.resolve({
          status: 200,
          ok: true,
          json: async () => ({ choices: [{ message: { content: 'Summary after body timeout' } }] })
        });
      });

      const operation = summarizeContent('test-key', 'Some content', {
        fetchFn: mockFetch,
        timeoutMs: 100,
        maxRetries: 1,
        backoffMs: 40
      });
      const settled = operation.catch(error => error);
      await vi.advanceTimersByTimeAsync(0);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(signals[0].aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(100);
      expect(signals[0].aborted).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(39);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);

      expect(await settled).toBe('Summary after body timeout');
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('should fail immediately on non-retryable error (e.g., 401)', async () => {
      const mockFetch = vi.fn().mockImplementation(async () => {
        return { status: 401, ok: false };
      });

      await expect(summarizeContent('test-key', 'Some content', {
        fetchFn: mockFetch
      })).rejects.toThrow('DeepSeek API request failed with non-retryable status 401');

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('Summarize with Fallback', () => {
    it('should return summary when within limits and API succeeds', async () => {
      const mockFetch = vi.fn().mockImplementation(async () => {
        return {
          status: 200,
          ok: true,
          json: async () => ({
            choices: [{ message: { content: 'AI summary' } }]
          })
        };
      });

      const result = await summarizeWithFallback(db, 'test-key', 'Full text', 'Fallback text', {
        limit: 5,
        fetchFn: mockFetch
      });

      expect(result).toBe('AI summary');
    });

    it('should fallback to original summary when daily limit is exceeded', async () => {
      // Set usage to limit
      const dateStr = getBeijingDate();
      await db.prepare('INSERT INTO daily_usage (usage_date, usage_type, count) VALUES (?, ?, ?)')
        .bind(dateStr, 'deepseek_summary', 5).run();

      const mockFetch = vi.fn();

      const result = await summarizeWithFallback(db, 'test-key', 'Full text', 'Fallback text', {
        limit: 5,
        fetchFn: mockFetch
      });

      expect(result).toBe('Fallback text');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('enqueues only one system alert for repeated soft-limit fallbacks in a Beijing day', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-13T00:00:00.000Z'));
      await db.prepare('INSERT INTO daily_usage (usage_date, usage_type, count) VALUES (?, ?, ?)')
        .bind('2026-07-13', 'deepseek_summary', 5).run();

      await summarizeWithFallback(db, 'secret-key', 'Full text', 'Fallback text', { limit: 5 });
      await summarizeWithFallback(db, 'secret-key', 'Another article', 'Other fallback', { limit: 5 });

      const { results } = await db.prepare("SELECT * FROM notification_queue WHERE kind = 'system'").all();
      expect(results).toHaveLength(1);
      expect(results[0].dedupe_key).toBe('system:deepseek-soft-limit:2026-07-13');
      expect(JSON.parse(results[0].payload_json).message).toContain('2026-07-13');
      expect(results[0].payload_json).not.toContain('secret-key');
      vi.useRealTimers();
    });

    it('enqueues a new soft-limit alert on the next Beijing day', async () => {
      vi.useFakeTimers();
      await db.prepare('INSERT INTO daily_usage (usage_date, usage_type, count) VALUES (?, ?, ?), (?, ?, ?)')
        .bind(
          '2026-07-13', 'deepseek_summary', 5,
          '2026-07-14', 'deepseek_summary', 5
        ).run();

      vi.setSystemTime(new Date('2026-07-13T15:59:59.000Z'));
      await summarizeWithFallback(db, 'key', 'Article one', 'Fallback one', { limit: 5 });
      vi.setSystemTime(new Date('2026-07-13T16:00:01.000Z'));
      await summarizeWithFallback(db, 'key', 'Article two', 'Fallback two', { limit: 5 });

      const { results } = await db.prepare("SELECT dedupe_key FROM notification_queue WHERE kind = 'system' ORDER BY id").all();
      expect(results.map(row => row.dedupe_key)).toEqual([
        'system:deepseek-soft-limit:2026-07-13',
        'system:deepseek-soft-limit:2026-07-14'
      ]);
      vi.useRealTimers();
    });

    it('falls back without a cap alert when the usage database check fails', async () => {
      const usageErrorDb = {
        prepare(sql) {
          if (sql.includes('daily_usage')) {
            throw new Error('usage database unavailable');
          }
          return db.prepare(sql);
        }
      };
      const mockFetch = vi.fn();

      const result = await summarizeWithFallback(
        usageErrorDb, 'key', 'Article', 'Fallback text', { limit: 5, fetchFn: mockFetch }
      );

      expect(result).toBe('Fallback text');
      expect(mockFetch).not.toHaveBeenCalled();
      expect((await db.prepare("SELECT * FROM notification_queue WHERE kind = 'system'").all()).results).toHaveLength(0);
    });

    it('should fallback to original summary when API call fails completely', async () => {
      const mockFetch = vi.fn().mockImplementation(async () => {
        return { status: 500, ok: false };
      });

      const result = await summarizeWithFallback(db, 'test-key', 'Full text', 'Fallback text', {
        limit: 5,
        fetchFn: mockFetch,
        backoffMs: 1
      });

      expect(result).toBe('Fallback text');
    });

    it('falls back after every response body hangs through the retry limit', async () => {
      vi.useFakeTimers();
      const signals = [];
      const mockFetch = vi.fn((_url, { signal }) => {
        signals.push(signal);
        return Promise.resolve({
          status: 200,
          ok: true,
          json: () => new Promise(() => {})
        });
      });

      const operation = summarizeWithFallback(db, 'test-key', 'Full text', 'Fallback text', {
        limit: 5,
        fetchFn: mockFetch,
        timeoutMs: 75,
        maxRetries: 1,
        backoffMs: 25
      });
      const settled = operation.catch(error => error);
      await vi.advanceTimersByTimeAsync(0);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(75);
      expect(signals[0].aborted).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(25);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(75);

      expect(await settled).toBe('Fallback text');
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(signals.every(signal => signal.aborted)).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
