import { describe, it, expect, vi } from 'vitest';
import { isSafeUrl, redactText, redactUrl, safeFetch } from '../../src/security/url.js';

const publicResolver = async () => ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'];

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

  it.each([
    'signature',
    'sig',
    'code',
    'access_token',
    'auth_token',
    'credential',
    'expires',
    'X-Amz-Signature',
    'X-Amz-Credential',
    'X-Amz-Security-Token',
    'X-Goog-Signature',
    'X-Goog-Credential',
    'X-Goog-Security-Token',
    'GoogleAccessId',
    'Policy',
    'Key-Pair-Id'
  ])('redacts signed-feed credential key %s in URLs and free text case-insensitively', key => {
    const secret = `signed-secret-${key.toLowerCase()}`;
    const url = `https://feeds.example/private.xml?${encodeURIComponent(key)}=${encodeURIComponent(secret)}&label=public`;
    const redactedUrl = redactUrl(url);
    const redactedText = redactText(`fetch failed: ${url}; ${key}=${secret}`);

    expect(redactedUrl).not.toContain(secret);
    expect(redactedUrl).toContain(`${encodeURIComponent(key)}=***`);
    expect(redactedUrl).toContain('label=public');
    expect(redactedText).not.toContain(secret);
    expect(redactedText).toContain('***');
  });

  it('does not redact benign keys merely containing sensitive substrings', () => {
    const url = 'https://example.com/feed?designation=editorial&signal=strong&codec=h264&credentials_mode=include&expiration_date=tomorrow&x-goog-signature-version=v4&googleaccessid_hint=public';
    expect(redactUrl(url)).toBe(url);
    expect(redactText('designation=editorial signal=strong codec=h264 credentials_mode=include expiration_date=tomorrow x-goog-signature-version=v4 googleaccessid_hint=public'))
      .toBe('designation=editorial signal=strong codec=h264 credentials_mode=include expiration_date=tomorrow x-goog-signature-version=v4 googleaccessid_hint=public');
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
      resolver: publicResolver,
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
      fetchFn: mockGlobalFetch,
      resolver: publicResolver
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
      resolver: publicResolver,
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
          expect(options.resolver).toBeUndefined();
          expect(options.customUserOption).toBe('hello'); // should be preserved
          return {
            status: 200,
            headers: new Headers({ 'content-type': 'text/xml' }),
            text: async () => 'ok'
          };
        });

        await safeFetch('https://example.com/test', {
          fetchFn: mockGlobalFetch,
          resolver: publicResolver,
          maxRedirects: 3,
          timeoutMs: 5000,
          maxBytes: 1000,
          allowedContentTypes: ['text/xml'],
          customUserOption: 'hello'
        });

        expect(mockGlobalFetch).toHaveBeenCalledTimes(1);
      });

      it('gives each redirect hop a fresh timeout budget', async () => {
        vi.useFakeTimers();
        const signals = [];
        let callCount = 0;
        const fetchFn = vi.fn((_url, options) => {
          signals.push(options.signal);
          callCount++;
          return new Promise(resolve => setTimeout(() => resolve(callCount === 1
            ? { status: 302, headers: new Headers({ location: '/next' }) }
            : {
                status: 200,
                headers: new Headers({ 'content-type': 'text/plain' }),
                text: async () => 'done'
              }), 40));
        });

        try {
          const operation = safeFetch('https://example.com/start', {
            fetchFn,
            resolver: publicResolver,
            timeoutMs: 50
          });
          await vi.advanceTimersByTimeAsync(40);
          await vi.advanceTimersByTimeAsync(40);
          const response = await operation;

          expect(await response.text()).toBe('done');
          expect(fetchFn).toHaveBeenCalledTimes(2);
          expect(signals[0].aborted).toBe(true);
          expect(signals[1].aborted).toBe(false);
          expect(vi.getTimerCount()).toBe(0);
        } finally {
          vi.useRealTimers();
        }
      });

      it('does not wait for an unused redirect body whose cancel promise hangs', async () => {
        const cancel = vi.fn(() => new Promise(() => {}));
        const fetchFn = vi.fn()
          .mockResolvedValueOnce({
            status: 302,
            headers: new Headers({ location: '/next' }),
            body: { cancel }
          })
          .mockResolvedValueOnce({
            status: 200,
            headers: new Headers({ 'content-type': 'text/plain' }),
            text: async () => 'done'
          });

        const response = await safeFetch('https://example.com/start', {
          fetchFn,
          resolver: publicResolver,
          timeoutMs: 50
        });

        expect(await response.text()).toBe('done');
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(fetchFn).toHaveBeenCalledTimes(2);
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
          fetchFn: mockGlobalFetch,
          resolver: publicResolver
        })).rejects.toThrow(/Unsafe redirect URL: http:\/\/\[::ffff:(127\.0\.0\.1|7f00:1)\]\/unsafe/);

        expect(mockGlobalFetch).toHaveBeenCalledTimes(1); // Should abort before second fetch
      });
    });

    describe('safeFetch URL Redaction and UTF-8 maxBytes', () => {
      it('uses one timeout budget across response headers and body consumption', async () => {
        vi.useFakeTimers();
        const fetchFn = vi.fn((_url, options) => new Promise(resolve => {
          setTimeout(() => resolve({
            status: 200,
            headers: new Headers({ 'content-type': 'text/plain' }),
            text: () => new Promise(bodyResolve => setTimeout(() => bodyResolve('late'), 30))
          }), 30);
        }));

        try {
          const rejection = safeFetch('https://example.com/slow', {
            fetchFn,
            resolver: publicResolver,
            timeoutMs: 50
          }).catch(error => error);

          await vi.advanceTimersByTimeAsync(49);
          let settled = false;
          rejection.then(() => { settled = true; });
          await Promise.resolve();
          expect(settled).toBe(false);

          await vi.advanceTimersByTimeAsync(1);
          const error = await rejection;
          expect(error.message).toMatch(/timed out/i);
        } finally {
          vi.useRealTimers();
        }
      });

      it('times out when headers arrive but body consumption hangs and ignores AbortSignal', async () => {
        vi.useFakeTimers();
        const signals = [];
        const fetchFn = vi.fn(async (_url, options) => {
          signals.push(options.signal);
          return {
            status: 200,
            headers: new Headers({ 'content-type': 'text/plain' }),
            text: () => new Promise(() => {})
          };
        });

        try {
          const operation = safeFetch('https://example.com/hanging-body', {
            fetchFn,
            resolver: publicResolver,
            timeoutMs: 50
          });
          const rejection = operation.catch(error => error);
          await Promise.resolve();
          await Promise.resolve();

          await vi.advanceTimersByTimeAsync(50);
          const error = await rejection;

          expect(error).toBeInstanceOf(Error);
          expect(error.message).toMatch(/timed out/i);
          expect(signals).toHaveLength(1);
          expect(signals[0].aborted).toBe(true);
          expect(vi.getTimerCount()).toBe(0);
        } finally {
          vi.useRealTimers();
        }
      });

      it('aborts and cancels an oversized chunked stream before reading remaining chunks', async () => {
        const encoder = new TextEncoder();
        const chunks = [encoder.encode('abc'), encoder.encode('def'), encoder.encode('never-read')];
        let pullCount = 0;
        const cancel = vi.fn();
        const signals = [];
        const body = new ReadableStream({
          pull(controller) {
            const chunk = chunks[pullCount++];
            if (chunk) controller.enqueue(chunk);
            else controller.close();
          },
          cancel
        }, { highWaterMark: 0 });
        const fetchFn = vi.fn(async (_url, options) => {
          signals.push(options.signal);
          return {
            status: 200,
            headers: new Headers({ 'content-type': 'text/plain' }),
            body,
            text: async () => { throw new Error('must consume the stream incrementally'); }
          };
        });

        await expect(safeFetch('https://example.com/chunked', {
          fetchFn,
          resolver: publicResolver,
          maxBytes: 5
        })).rejects.toThrow('Response text size exceeds limit of 5 bytes');

        expect(pullCount).toBe(2);
        expect(cancel).toHaveBeenCalled();
        expect(signals[0].aborted).toBe(true);
      });

      it('should redact sensitive query parameters in unsafe redirect errors', async () => {
        const mockGlobalFetch = vi.fn().mockImplementation(async (url, options) => {
          return {
            status: 302,
            headers: new Headers({ 'location': 'http://127.0.0.1/feed?token=supersecret' })
          };
        });

        await expect(safeFetch('https://example.com/start', {
          fetchFn: mockGlobalFetch,
          resolver: publicResolver
        })).rejects.toThrow('Unsafe redirect URL: http://127.0.0.1/feed?token=***');

        try {
          await safeFetch('https://example.com/start', {
            fetchFn: mockGlobalFetch,
            resolver: publicResolver
          });
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
          fetchFn: mockGlobalFetch,
          resolver: publicResolver
        })).rejects.toThrow('fetch failed to https://example.com/feed?token=***');

        try {
          await safeFetch('https://example.com/feed?token=supersecret', {
            fetchFn: mockGlobalFetch,
            resolver: publicResolver
          });
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

        await expect(safeFetch('https://example.com/multibyte', {
          fetchFn: mockGlobalFetch,
          resolver: publicResolver,
          maxBytes: 6
        })).rejects.toThrow('Response text size exceeds limit of 6 bytes');
      });
    });
  });

  describe('hostname resolution preflight', () => {
    const okResponse = () => ({
      status: 200,
      headers: new Headers({ 'content-type': 'text/plain' }),
      text: async () => 'ok'
    });

    it('uses the fixed trusted DoH endpoint for both A and AAAA in production', async () => {
      const requests = [];
      const fetchMock = vi.fn(async url => {
        requests.push(String(url));
        if (String(url).startsWith('https://cloudflare-dns.com/dns-query')) {
          const type = new URL(url).searchParams.get('type');
          return {
            ok: true,
            status: 200,
            json: async () => ({
              Status: 0,
              Answer: type === '1'
                ? [{ type: 1, data: '93.184.216.34' }]
                : [{ type: 28, data: '2606:2800:220:1:248:1893:25c8:1946' }]
            })
          };
        }
        return okResponse();
      });
      vi.stubGlobal('fetch', fetchMock);

      try {
        await safeFetch('https://public.example/feed');
      } finally {
        vi.unstubAllGlobals();
      }

      const dohRequests = requests.filter(url => url.startsWith('https://cloudflare-dns.com/dns-query'));
      expect(dohRequests).toHaveLength(2);
      expect(dohRequests.map(url => new URL(url).searchParams.get('type')).sort()).toEqual(['1', '28']);
      expect(requests).toContain('https://public.example/feed');
    });

    it('aborts hanging trusted DoH requests after the fixed resolver timeout', async () => {
      vi.useFakeTimers();
      const signals = [];
      const fetchMock = vi.fn((_url, options = {}) => {
        const { signal } = options;
        signals.push(signal);
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('DoH request aborted')), { once: true });
        });
      });
      vi.stubGlobal('fetch', fetchMock);

      try {
        const operation = safeFetch('https://hanging.example/feed');
        const rejection = operation.catch(error => error);
        await Promise.resolve();
        await Promise.resolve();

        expect(signals).toHaveLength(2);
        expect(signals.every(signal => signal instanceof AbortSignal)).toBe(true);
        expect(signals.every(signal => !signal.aborted)).toBe(true);

        await vi.advanceTimersByTimeAsync(3000);
        const error = await rejection;

        expect(error.message).toContain('Hostname resolution failed');
        expect(signals.every(signal => signal.aborted)).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
        expect(fetchMock).toHaveBeenCalledTimes(2);
      } finally {
        vi.unstubAllGlobals();
        vi.useRealTimers();
      }
    });

    it('allows a public hostname and caches its resolution within one call', async () => {
      const resolver = vi.fn(publicResolver);
      const fetchFn = vi.fn()
        .mockResolvedValueOnce({ status: 302, headers: new Headers({ location: '/next' }) })
        .mockResolvedValueOnce(okResponse());

      await safeFetch('https://public.example/start', { fetchFn, resolver });

      expect(fetchFn).toHaveBeenCalledTimes(2);
      expect(resolver).toHaveBeenCalledTimes(1);
      expect(resolver).toHaveBeenCalledWith('public.example');
    });

    it.each([
      ['loopback', ['127.0.0.1']],
      ['private', ['10.23.1.4']],
      ['link-local metadata', ['169.254.169.254']],
      ['IPv6 unique-local', ['fd00::1']],
      ['IPv6 link-local', ['fe80::1']]
    ])('rejects a hostname resolving to %s addresses', async (_label, addresses) => {
      const fetchFn = vi.fn().mockResolvedValue(okResponse());

      await expect(safeFetch('https://attacker.example/feed', {
        fetchFn,
        resolver: async () => addresses
      })).rejects.toThrow('Unsafe hostname resolution');

      expect(fetchFn).not.toHaveBeenCalled();
    });

    it('rejects mixed public and private answers', async () => {
      const fetchFn = vi.fn().mockResolvedValue(okResponse());

      await expect(safeFetch('https://mixed.example/feed', {
        fetchFn,
        resolver: async () => ['93.184.216.34', '10.0.0.8']
      })).rejects.toThrow('Unsafe hostname resolution');

      expect(fetchFn).not.toHaveBeenCalled();
    });

    it('revalidates a redirect to a different hostname before fetching it', async () => {
      const fetchFn = vi.fn().mockResolvedValue({
        status: 302,
        headers: new Headers({ location: 'https://private.example/secret' })
      });
      const resolver = vi.fn(async hostname => hostname === 'public.example'
        ? ['93.184.216.34']
        : ['127.0.0.1']);

      await expect(safeFetch('https://public.example/start', { fetchFn, resolver }))
        .rejects.toThrow('Unsafe hostname resolution');

      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(resolver).toHaveBeenCalledTimes(2);
    });

    it('fails closed when resolution fails or returns no usable address', async () => {
      const fetchFn = vi.fn().mockResolvedValue(okResponse());

      await expect(safeFetch('https://failure.example/feed', {
        fetchFn,
        resolver: async () => { throw new Error('DNS unavailable'); }
      })).rejects.toThrow('Hostname resolution failed');
      await expect(safeFetch('https://empty.example/feed', {
        fetchFn,
        resolver: async () => []
      })).rejects.toThrow('Hostname resolution failed');

      expect(fetchFn).not.toHaveBeenCalled();
    });

    it('redacts tokens from resolver errors and unsafe URLs', async () => {
      const secret = 'resolver-secret-token';

      try {
        await safeFetch(`https://public.example/feed?token=${secret}`, {
          fetchFn: vi.fn(),
          resolver: async () => {
            throw new Error(`lookup failed for https://dns.invalid/query?token=${secret}`);
          }
        });
        throw new Error('expected safeFetch to reject');
      } catch (err) {
        expect(err.message).not.toContain(secret);
        expect(err.stack).not.toContain(secret);
        expect(err.message).toContain('token=***');
      }
    });

    it.each([
      'http://metadata.google.internal/latest/meta-data',
      'http://instance-data.ec2.internal/latest/meta-data',
      'http://service.local/resource',
      'http://service.internal/resource'
    ])('blocks private or metadata hostname %s without resolving it', async url => {
      const resolver = vi.fn(publicResolver);
      await expect(safeFetch(url, { fetchFn: vi.fn(), resolver })).rejects.toThrow('Unsafe redirect URL');
      expect(resolver).not.toHaveBeenCalled();
    });
  });
});
