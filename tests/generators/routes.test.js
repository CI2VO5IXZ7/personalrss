import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createGeneratorRouter } from '../../src/generators/core/routes.js';
import { logError } from '../../src/log.js';

vi.mock('../../src/log.js', () => ({
  logError: vi.fn(),
  logEvent: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn()
}));

describe('Generator Routes', () => {
  let mockService;
  let router;
  let mockDb;

  beforeEach(() => {
    mockDb = {};
    mockService = {
      getFeed: vi.fn(),
      clock: {
        now: () => new Date()
      }
    };
    router = createGeneratorRouter(mockService);
    vi.mocked(logError).mockClear();
  });

  it('serves active feed with UTF-8, Cache-Control headers', async () => {
    const mockXml = '<?xml version="1.0" encoding="UTF-8"?><rss>test</rss>';
    mockService.getFeed.mockResolvedValue(mockXml);

    const req = new Request('https://worker.local/feeds/123.xml');
    const env = { DB: mockDb };

    const res = await router.fetch(req, env);

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('application/rss+xml');
    expect(res.headers.get('Content-Type')).toContain('charset=utf-8');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=600');
    expect(await res.text()).toBe(mockXml);
    expect(mockService.getFeed).toHaveBeenCalledWith(mockDb, 123, 'https://worker.local/feeds/123.xml');
  });

  it('serves paused feed when instance exists', async () => {
    const mockXml = '<?xml version="1.0" encoding="UTF-8"?><rss>paused-test</rss>';
    mockService.getFeed.mockResolvedValue(mockXml);

    const req = new Request('https://worker.local/feeds/5.xml');
    const env = { DB: mockDb };

    const res = await router.fetch(req, env);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(mockXml);
  });

  it('returns 404 for nonexistent instance', async () => {
    mockService.getFeed.mockResolvedValue(null);

    const req = new Request('https://worker.local/feeds/999.xml');
    const env = { DB: mockDb };

    const res = await router.fetch(req, env);

    expect(res.status).toBe(404);
    expect(await res.text()).toBe('Not Found');
  });

  it('rejects invalid ID format with 404', async () => {
    const env = { DB: mockDb };

    const testInvalidIds = ['abc', '0', '-5', '1.5', '1a'];
    for (const invalidId of testInvalidIds) {
      const req = new Request(`https://worker.local/feeds/${invalidId}.xml`);
      const res = await router.fetch(req, env);
      expect(res.status).toBe(404);
    }

    expect(mockService.getFeed).not.toHaveBeenCalled();
  });

  it('handles server errors gracefully with redacted message and 500 status code', async () => {
    mockService.getFeed.mockRejectedValue(new Error('Internal database fault: password=secretValue'));

    const req = new Request('https://worker.local/feeds/42.xml');
    const env = { DB: mockDb };

    const res = await router.fetch(req, env);

    expect(res.status).toBe(500);
    expect(await res.text()).toBe('Internal Server Error');
    expect(logError).toHaveBeenCalledWith('generator.route_failed', {
      id: 42,
      error: 'Internal database fault: password=***'
    });
  });
});
