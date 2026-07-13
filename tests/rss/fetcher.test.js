import { describe, it, expect, vi } from 'vitest';
import { fetchFeed } from '../../src/rss/fetcher.js';

const publicResolver = async () => ['93.184.216.34'];

describe('Feed Fetcher', () => {
  it('uses the canonical repository URL in the default User-Agent', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({ 'content-type': 'application/rss+xml' }),
      text: async () => '<rss />'
    });

    await fetchFeed('https://example.com/feed.xml', {
      fetchFn: mockFetch,
      resolver: publicResolver
    });

    expect(mockFetch.mock.calls[0][1].headers['User-Agent']).toBe(
      'Mozilla/5.0 (compatible; PersonalRSS/2.0; +https://github.com/CI2VO5IXZ7/personalrss)'
    );
  });

  it('should include If-None-Match and If-Modified-Since headers when etag and lastModified are provided', async () => {
    const mockFetch = vi.fn().mockImplementation(async (url, options) => {
      const headers = options.headers || {};
      expect(headers['If-None-Match']).toBe('etag123');
      expect(headers['If-Modified-Since']).toBe('Sun, 12 Jul 2026 12:00:00 GMT');
      return {
        status: 200,
        headers: new Headers({
          'content-type': 'application/rss+xml',
          'etag': 'etag456',
          'last-modified': 'Mon, 13 Jul 2026 12:00:00 GMT'
        }),
        text: async () => '<rss><channel><title>Mock Feed</title></channel></rss>'
      };
    });

    const result = await fetchFeed('https://example.com/feed.xml', {
      etag: 'etag123',
      lastModified: 'Sun, 12 Jul 2026 12:00:00 GMT',
      fetchFn: mockFetch,
      resolver: publicResolver
    });

    expect(result.status).toBe(200);
    expect(result.etag).toBe('etag456');
    expect(result.lastModified).toBe('Mon, 13 Jul 2026 12:00:00 GMT');
    expect(result.xml).toBe('<rss><channel><title>Mock Feed</title></channel></rss>');
  });

  it('should handle 304 Not Modified status correctly', async () => {
    const mockFetch = vi.fn().mockImplementation(async (url, options) => {
      return {
        status: 304,
        headers: new Headers({}),
        text: async () => ''
      };
    });

    const result = await fetchFeed('https://example.com/feed.xml', {
      etag: 'etag123',
      fetchFn: mockFetch,
      resolver: publicResolver
    });

    expect(result.status).toBe(304);
    expect(result.xml).toBe('');
  });
});
