import { describe, it, expect, vi } from 'vitest';
import { isSafeUrl, redactUrl, safeFetch } from '../../src/security/url.js';

describe('URL Redaction', () => {
  it('should redact credentials in URL basic auth', () => {
    expect(redactUrl('http://user:password@example.com/feed.xml')).toBe('http://user:***@example.com/feed.xml');
    expect(redactUrl('https://foo@example.com/')).toBe('https://***@example.com/');
  });

  it('should redact sensitive query parameters', () => {
    expect(redactUrl('https://example.com/feed.xml?token=abc-123&user=john')).toBe('https://example.com/feed.xml?token=***&user=john');
    expect(redactUrl('https://example.com/feed.xml?key=abc-123&auth=xyz&ok=1')).toBe('https://example.com/feed.xml?key=***&auth=***&ok=1');
    expect(redactUrl('https://example.com/feed.xml?secret=supersecret')).toBe('https://example.com/feed.xml?secret=***');
    expect(redactUrl('https://example.com/feed.xml?api_key=mykey')).toBe('https://example.com/feed.xml?api_key=***');
  });

  it('should return original URL if no sensitive data found', () => {
    expect(redactUrl('https://example.com/feed.xml')).toBe('https://example.com/feed.xml');
    expect(redactUrl('https://example.com/feed.xml?q=test&page=2')).toBe('https://example.com/feed.xml?q=test&page=2');
  });
});

describe('SSRF / URL Safety Validation', () => {
  it('should reject invalid protocols', () => {
    expect(isSafeUrl('ftp://example.com')).toBe(false);
    expect(isSafeUrl('file:///etc/passwd')).toBe(false);
    expect(isSafeUrl('gopher://example.com')).toBe(false);
  });

  it('should reject loopback IPs', () => {
    expect(isSafeUrl('http://127.0.0.1')).toBe(false);
    expect(isSafeUrl('http://127.0.0.2')).toBe(false);
    expect(isSafeUrl('http://127.255.255.255')).toBe(false);
    expect(isSafeUrl('http://[::1]')).toBe(false);
    expect(isSafeUrl('http://localhost')).toBe(false);
  });

  it('should reject private IPv4 ranges', () => {
    expect(isSafeUrl('http://10.0.0.1')).toBe(false);
    expect(isSafeUrl('http://172.16.0.1')).toBe(false);
    expect(isSafeUrl('http://172.31.255.255')).toBe(false);
    expect(isSafeUrl('http://192.168.1.100')).toBe(false);
  });

  it('should reject link-local and metadata IPs', () => {
    expect(isSafeUrl('http://169.254.169.254')).toBe(false);
    expect(isSafeUrl('http://[fe80::1]')).toBe(false);
  });

  it('should reject multicast and reserved IPs', () => {
    expect(isSafeUrl('http://224.0.0.1')).toBe(false);
    expect(isSafeUrl('http://240.0.0.1')).toBe(false);
    expect(isSafeUrl('http://255.255.255.255')).toBe(false);
  });

  it('should accept valid public URLs', () => {
    expect(isSafeUrl('https://github.com/')).toBe(true);
    expect(isSafeUrl('http://example.com/feed.xml')).toBe(true);
    expect(isSafeUrl('https://test.co.uk/path?param=1')).toBe(true);
  });
});

describe('safeFetch (Redirect-safe)', () => {
  it('should fetch safe URLs and handle redirects safely', async () => {
    const mockResponses = [
      {
        status: 302,
        headers: new Headers({ 'location': 'https://example.com/redirected' }),
        text: async () => ''
      },
      {
        status: 200,
        headers: new Headers({ 'content-type': 'text/xml' }),
        text: async () => '<rss></rss>'
      }
    ];

    let callCount = 0;
    const mockGlobalFetch = vi.fn().mockImplementation(async (url, options) => {
      const response = mockResponses[callCount++];
      return {
        ok: response.status === 200,
        status: response.status,
        headers: response.headers,
        text: response.text
      };
    });

    const result = await safeFetch('https://example.com/start', {
      fetchFn: mockGlobalFetch,
      maxRedirects: 3
    });

    expect(mockGlobalFetch).toHaveBeenCalledTimes(2);
    expect(mockGlobalFetch.mock.calls[0][0]).toBe('https://example.com/start');
    expect(mockGlobalFetch.mock.calls[1][0]).toBe('https://example.com/redirected');
    expect(await result.text()).toBe('<rss></rss>');
  });

  it('should stop and throw/error on redirect to unsafe URL', async () => {
    const mockGlobalFetch = vi.fn().mockImplementation(async (url, options) => {
      return {
        status: 302,
        headers: new Headers({ 'location': 'http://127.0.0.1/malicious' })
      };
    });

    await expect(safeFetch('https://example.com/start', {
      fetchFn: mockGlobalFetch
    })).rejects.toThrow('Unsafe redirect URL: http://127.0.0.1/malicious');
  });

  it('should stop and error on exceeding maxRedirects', async () => {
    const mockGlobalFetch = vi.fn().mockImplementation(async (url, options) => {
      return {
        status: 302,
        headers: new Headers({ 'location': 'https://example.com/loop' })
      };
    });

    await expect(safeFetch('https://example.com/start', {
      fetchFn: mockGlobalFetch,
      maxRedirects: 2
    })).rejects.toThrow('Too many redirects');
  });

  describe('URL Security Hardening Regressions', () => {
    describe('isSafeUrl IPv4 & IPv6 Hardening', () => {
      it('should reject CGNAT IP ranges (100.64.0.0/10)', () => {
        expect(isSafeUrl('http://100.64.0.1')).toBe(false);
        expect(isSafeUrl('http://100.100.100.100')).toBe(false);
        expect(isSafeUrl('http://100.127.255.255')).toBe(false);
        expect(isSafeUrl('http://100.128.0.1')).toBe(true); // outside CGNAT range
      });

      it('should reject IPv4-mapped/compatible IPv6 addresses mapping to unsafe IPs', () => {
        expect(isSafeUrl('http://[::ffff:127.0.0.1]')).toBe(false);
        expect(isSafeUrl('http://[::ffff:10.0.0.5]')).toBe(false);
        expect(isSafeUrl('http://[::ffff:192.168.1.1]')).toBe(false);
        expect(isSafeUrl('http://[::ffff:100.64.0.1]')).toBe(false);
        expect(isSafeUrl('http://[::ffff:0.0.0.0]')).toBe(false);
        expect(isSafeUrl('http://[::127.0.0.1]')).toBe(false);
        expect(isSafeUrl('http://[::ffff:8.8.8.8]')).toBe(true); // safe public IP
      });

      it('should reject unspecified, reserved, and special IP literals', () => {
        expect(isSafeUrl('http://0.0.0.0')).toBe(false);
        expect(isSafeUrl('http://[::]')).toBe(false);
        expect(isSafeUrl('http://[0::0]')).toBe(false);
        expect(isSafeUrl('http://[2001:db8::1]')).toBe(false); // documentation
        expect(isSafeUrl('http://[100::1]')).toBe(false); // discard-only
        expect(isSafeUrl('http://[2001:10::1]')).toBe(false); // ORCHIDv2
        expect(isSafeUrl('http://192.0.2.1')).toBe(false); // TEST-NET-1
        expect(isSafeUrl('http://198.51.100.1')).toBe(false); // TEST-NET-2
        expect(isSafeUrl('http://203.0.113.1')).toBe(false); // TEST-NET-3
        expect(isSafeUrl('http://198.18.0.5')).toBe(false); // Benchmarking
      });

      it('should reject alternate localhost and IPv4 representations supported by parser', () => {
        expect(isSafeUrl('http://127.1')).toBe(false);
        expect(isSafeUrl('http://0177.0.0.1')).toBe(false);
        expect(isSafeUrl('http://0x7f.1')).toBe(false);
        expect(isSafeUrl('http://2130706433')).toBe(false);
        expect(isSafeUrl('http://127.0.0.1.')).toBe(false); // trailing dot
      });
    });

    describe('safeFetch Option Stripping and Redirect Revalidation', () => {
      it('should strip internal options before forwarding to fetchFn', async () => {
        const mockGlobalFetch = vi.fn().mockImplementation(async (url, options) => {
          // Check that options passed to fetch do NOT contain internal keys
          expect(options.fetchFn).toBeUndefined();
          expect(options.maxRedirects).toBeUndefined();
          expect(options.timeoutMs).toBeUndefined();
          expect(options.maxBytes).toBeUndefined();
          expect(options.allowedContentTypes).toBeUndefined();
          expect(options.customUserOption).toBe('hello'); // should be preserved
          return {
            status: 200,
            headers: new Headers({ 'content-type': 'text/xml' }),
            text: async () => 'ok'
          };
        });

        await safeFetch('https://example.com/test', {
          fetchFn: mockGlobalFetch,
          maxRedirects: 3,
          timeoutMs: 5000,
          maxBytes: 1000,
          allowedContentTypes: ['text/xml'],
          customUserOption: 'hello'
        });

        expect(mockGlobalFetch).toHaveBeenCalledTimes(1);
      });

      it('should perform redirect revalidation against hardened IP rules', async () => {
        const mockResponses = [
          {
            status: 302,
            headers: new Headers({ 'location': 'http://[::ffff:127.0.0.1]/unsafe' })
          },
          {
            status: 200,
            headers: new Headers({ 'content-type': 'text/xml' }),
            text: async () => 'ok'
          }
        ];

        let callCount = 0;
        const mockGlobalFetch = vi.fn().mockImplementation(async (url, options) => {
          return mockResponses[callCount++];
        });

        await expect(safeFetch('https://example.com/start', {
          fetchFn: mockGlobalFetch
        })).rejects.toThrow(/Unsafe redirect URL: http:\/\/\[::ffff:(127\.0\.0\.1|7f00:1)\]\/unsafe/);

        expect(mockGlobalFetch).toHaveBeenCalledTimes(1); // Should abort before second fetch
      });
    });

    describe('safeFetch URL Redaction and UTF-8 maxBytes', () => {
      it('should redact sensitive query parameters in unsafe redirect errors', async () => {
        const mockGlobalFetch = vi.fn().mockImplementation(async (url, options) => {
          return {
            status: 302,
            headers: new Headers({ 'location': 'http://127.0.0.1/feed?token=supersecret' })
          };
        });

        await expect(safeFetch('https://example.com/start', {
          fetchFn: mockGlobalFetch
        })).rejects.toThrow('Unsafe redirect URL: http://127.0.0.1/feed?token=***');

        try {
          await safeFetch('https://example.com/start', { fetchFn: mockGlobalFetch });
        } catch (err) {
          expect(err.message).not.toContain('supersecret');
          expect(err.message).toContain('http://127.0.0.1/feed?token=***');
        }
      });

      it('should redact sensitive query parameters from surfaced fetch errors', async () => {
        const mockGlobalFetch = vi.fn().mockImplementation(async (url, options) => {
          throw new Error('fetch failed to https://example.com/feed?token=supersecret');
        });

        await expect(safeFetch('https://example.com/feed?token=supersecret', {
          fetchFn: mockGlobalFetch
        })).rejects.toThrow('fetch failed to https://example.com/feed?token=***');

        try {
          await safeFetch('https://example.com/feed?token=supersecret', { fetchFn: mockGlobalFetch });
        } catch (err) {
          expect(err.message).not.toContain('supersecret');
          expect(err.message).toContain('https://example.com/feed?token=***');
        }
      });

      it('should enforce maxBytes using UTF-8 byte length, not character count', async () => {
        const mockGlobalFetch = vi.fn().mockImplementation(async (url, options) => {
          return {
            status: 200,
            headers: new Headers({ 'content-type': 'text/plain' }),
            text: async () => '中国人' // 3 characters, 9 bytes in UTF-8
          };
        });

        const response = await safeFetch('https://example.com/multibyte', {
          fetchFn: mockGlobalFetch,
          maxBytes: 6
        });

        await expect(response.text()).rejects.toThrow('Response text size exceeds limit of 6 bytes');
      });
    });
  });
});
