import { describe, it, expect, vi } from 'vitest';
import {
  TelegramError,
  sendMessage,
  sendPhotoWithFallback
} from '../src/telegram.js';

describe('Telegram Push Helpers', () => {
  it('should send a text message successfully', async () => {
    const mockGlobalFetch = vi.fn().mockImplementation(async () => {
      return {
        status: 200,
        ok: true,
        json: async () => ({ ok: true, result: { message_id: 123 } })
      };
    });

    globalThis.fetch = mockGlobalFetch;

    const res = await sendMessage('token123', 'chat123', 'Hello test');
    expect(res.ok).toBe(true);
    expect(mockGlobalFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(mockGlobalFetch.mock.calls[0][1].body);
    expect(body.text).toBe('Hello test');
    expect(body.chat_id).toBe('chat123');
  });

  it('should throw TelegramError on 429 with retryAfter', async () => {
    const mockGlobalFetch = vi.fn().mockImplementation(async () => {
      return {
        status: 429,
        ok: false,
        json: async () => ({
          ok: false,
          error_code: 429,
          description: 'Too Many Requests: retry after 15',
          parameters: { retry_after: 15 }
        })
      };
    });

    globalThis.fetch = mockGlobalFetch;

    await expect(sendMessage('token123', 'chat123', 'Hello test'))
      .rejects.toThrow('Too Many Requests: retry after 15');

    try {
      await sendMessage('token123', 'chat123', 'Hello test');
    } catch (err) {
      expect(err).toBeInstanceOf(TelegramError);
      expect(err.status).toBe(429);
      expect(err.retryAfter).toBe(15);
    }
  });

  it('should send photo directly when successful', async () => {
    const mockGlobalFetch = vi.fn().mockImplementation(async (url) => {
      if (url.includes('sendPhoto')) {
        return {
          status: 200,
          ok: true,
          json: async () => ({ ok: true, result: { message_id: 456 } })
        };
      }
      return { status: 400, ok: false };
    });

    globalThis.fetch = mockGlobalFetch;

    const res = await sendPhotoWithFallback('token123', 'chat123', 'https://example.com/pic.jpg', 'My Caption');
    expect(res.ok).toBe(true);
    expect(mockGlobalFetch).toHaveBeenCalledTimes(1);
    expect(mockGlobalFetch.mock.calls[0][0]).toContain('sendPhoto');
  });

  it('should fallback to sendMessage when sendPhoto fails with non-429 error', async () => {
    let photoCalled = false;
    let messageCalled = false;

    const mockGlobalFetch = vi.fn().mockImplementation(async (url) => {
      if (url.includes('sendPhoto')) {
        photoCalled = true;
        return {
          status: 400,
          ok: false,
          json: async () => ({ ok: false, description: 'Bad Request: link invalid' })
        };
      }
      if (url.includes('sendMessage')) {
        messageCalled = true;
        return {
          status: 200,
          ok: true,
          json: async () => ({ ok: true, result: { message_id: 789 } })
        };
      }
      return { status: 500, ok: false };
    });

    globalThis.fetch = mockGlobalFetch;

    const res = await sendPhotoWithFallback('token123', 'chat123', 'https://example.com/pic.jpg', 'My Caption');
    expect(res.ok).toBe(true);
    expect(photoCalled).toBe(true);
    expect(messageCalled).toBe(true);
    expect(mockGlobalFetch).toHaveBeenCalledTimes(2);
  });

  it('should not fallback and throw TelegramError when sendPhoto fails with 429 rate limit', async () => {
    const mockGlobalFetch = vi.fn().mockImplementation(async (url) => {
      if (url.includes('sendPhoto')) {
        return {
          status: 429,
          ok: false,
          json: async () => ({
            ok: false,
            error_code: 429,
            description: 'Too Many Requests',
            parameters: { retry_after: 8 }
          })
        };
      }
      return { status: 500, ok: false };
    });

    globalThis.fetch = mockGlobalFetch;

    await expect(sendPhotoWithFallback('token123', 'chat123', 'https://example.com/pic.jpg', 'My Caption'))
      .rejects.toThrow('Too Many Requests');
  });

  it('should support concurrent-safe injection of fetchFn without modifying globalThis.fetch', async () => {
    const originalGlobalFetch = globalThis.fetch;
    const fetch1 = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 1 } })
    });
    const fetch2 = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 2 } })
    });

    const [res1, res2] = await Promise.all([
      sendMessage('token1', 'chat1', 'msg1', 'HTML', { fetchFn: fetch1 }),
      sendMessage('token2', 'chat2', 'msg2', 'HTML', { fetchFn: fetch2 })
    ]);

    expect(res1.ok).toBe(true);
    expect(res2.ok).toBe(true);
    expect(fetch1).toHaveBeenCalledTimes(1);
    expect(fetch2).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).toBe(originalGlobalFetch);
  });

  it('should redact sensitive query values (token/secret) in photoUrl and error message when falling back', async () => {
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    
    const sensitivePhotoUrl = 'https://example.com/pic.jpg?token=supersecret&key=pass123';
    const sensitiveErrorMessage = 'Bad Request: Invalid token=secret123 value';

    const mockGlobalFetch = vi.fn().mockImplementation(async (url) => {
      if (url.includes('sendPhoto')) {
        return {
          status: 400,
          ok: false,
          json: async () => ({ ok: false, description: sensitiveErrorMessage })
        };
      }
      if (url.includes('sendMessage')) {
        return {
          status: 200,
          ok: true,
          json: async () => ({ ok: true, result: { message_id: 789 } })
        };
      }
      return { status: 500, ok: false };
    });

    globalThis.fetch = mockGlobalFetch;

    const res = await sendPhotoWithFallback('token123', 'chat123', sensitivePhotoUrl, 'My Caption');
    expect(res.ok).toBe(true);
    
    expect(consoleWarnSpy).toHaveBeenCalled();
    const logOutput = consoleWarnSpy.mock.calls[0].join(' ');
    
    // Check that raw values are NOT present
    expect(logOutput).not.toContain('supersecret');
    expect(logOutput).not.toContain('pass123');
    expect(logOutput).not.toContain('secret123');
    
    // Check that redacted placeholders (***) are present
    expect(logOutput).toContain('***');
    
    consoleWarnSpy.mockRestore();
  });
});
