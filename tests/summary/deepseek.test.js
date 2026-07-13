import { describe, it, expect, beforeEach, vi } from 'vitest';
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
  });
});
