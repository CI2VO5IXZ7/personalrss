import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { processSubscription } from '../../src/rss/scheduler.js';
import { enqueue, lease, complete, fail } from '../../src/notifications/queue.js';
import { D1Mock } from '../helpers/d1_mock.js';
import fs from 'fs';
import path from 'path';

describe('Logging Redaction', () => {
  let consoleErrorSpy;
  let db;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    db = new D1Mock();
    const migrationSql = fs.readFileSync(
      path.resolve(__dirname, '../../migrations/0005_personal_info_hub.sql'),
      'utf8'
    );
    db.exec(migrationSql);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('should redact credentials and tokens from RSS scheduler console.error', async () => {
    const sub = {
      id: 1,
      feed_url: 'https://example.com/feed.xml?token=supersecret',
      feed_url_redacted: 'https://example.com/feed.xml?token=***',
      interval_minutes: 10,
      last_success_at: '2026-07-13T12:00:00Z'
    };

    const entryLink = 'https://user:password123@private.com/article?token=hidetoken&secret=shh';
    const feedXml = `
      <rss version="2.0">
        <channel>
          <title>Test</title>
          <item>
            <title>Item 1</title>
            <link>${entryLink}</link>
            <description>short desc</description>
            <guid>guid-1</guid>
          </item>
        </channel>
      </rss>
    `;

    const mockFetch = vi.fn().mockImplementation(async (url) => {
      if (url.includes('private.com')) {
        throw new Error(`Failed to fetch from ${entryLink}`);
      }
      return {
        status: 200,
        headers: new Headers({ 'content-type': 'application/rss+xml' }),
        text: async () => feedXml
      };
    });

    await processSubscription(db, sub, { RSS_PROCESSING_LIMIT: '5' }, { fetchFn: mockFetch });

    expect(consoleErrorSpy).toHaveBeenCalled();
    const loggedError = consoleErrorSpy.mock.calls[0].join(' ');
    
    expect(loggedError).not.toContain('password123');
    expect(loggedError).not.toContain('hidetoken');
    expect(loggedError).not.toContain('supersecret');
    expect(loggedError).not.toContain('shh');
    expect(loggedError).toContain('***');
  });

  it('should redact credentials and tokens from queue enqueue error logs', async () => {
    const badDb = {
      prepare: () => {
        throw new Error('Database connection failed for https://user:secretpass@db.local/sql?token=mytoken&key=secretkey');
      }
    };

    await expect(enqueue(badDb, { kind: 'rss', dedupeKey: 'k', payload: {} })).rejects.toThrow();

    expect(consoleErrorSpy).toHaveBeenCalled();
    const loggedError = consoleErrorSpy.mock.calls[0].join(' ');

    expect(loggedError).not.toContain('secretpass');
    expect(loggedError).not.toContain('mytoken');
    expect(loggedError).not.toContain('secretkey');
    expect(loggedError).toContain('***');
  });

  it('should redact credentials and tokens from other queue method error logs', async () => {
    const badDb = {
      prepare: () => {
        throw new Error('Database connection failed for https://user:secretpass@db.local/sql?token=mytoken');
      }
    };

    consoleErrorSpy.mockClear();

    await lease(badDb, 5);
    await complete(badDb, 1, 'token');
    await fail(badDb, 1, 'token', 'error');

    expect(consoleErrorSpy).toHaveBeenCalled();
    for (const call of consoleErrorSpy.mock.calls) {
      const loggedError = call.join(' ');
      expect(loggedError).not.toContain('secretpass');
      expect(loggedError).not.toContain('mytoken');
      expect(loggedError).toContain('***');
    }
  });
});
