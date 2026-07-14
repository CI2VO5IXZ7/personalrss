import { describe, it, expect, vi, afterEach } from 'vitest';
import app from '../../src/index.js';

describe('Admin Probe Stock Route', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('should reject requests with missing or invalid token', async () => {
    const req1 = new Request('https://worker.local/admin/probe-stock?code=600519', {
      method: 'GET'
    });
    const env = {
      ADMIN_TOKEN: 'super-secret-admin-token'
    };
    const res1 = await app.fetch(req1, env);
    expect(res1.status).toBe(401);

    const req2 = new Request('https://worker.local/admin/probe-stock?code=600519', {
      method: 'GET',
      headers: {
        'Authorization': 'Bearer wrong-token'
      }
    });
    const res2 = await app.fetch(req2, env);
    expect(res2.status).toBe(401);
  });

  it('should allow request with valid authorization token and return quote', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-13T15:38:00+08:00'));

    const req = new Request('https://worker.local/admin/probe-stock?code=600519', {
      method: 'GET',
      headers: {
        'Authorization': 'Bearer super-secret-admin-token'
      }
    });
    const env = {
      ADMIN_TOKEN: 'super-secret-admin-token'
    };

    const mockFetch = vi.fn().mockImplementation(async (url) => {
      return {
        status: 200,
        text: async () => 'v_sh600519="1~贵州茅台~600519~1720.50~1710.00~1715.00~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~20260713153701~0";'
      };
    });
    globalThis.fetch = mockFetch;

    const res = await app.fetch(req, env);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.code).toBe('sh600519');
    expect(data.quote.latestPrice).toBe(1720.50);
  });

  it('should return 400 if code parameter is missing or invalid', async () => {
    const req1 = new Request('https://worker.local/admin/probe-stock', {
      method: 'GET',
      headers: {
        'Authorization': 'Bearer super-secret-admin-token'
      }
    });
    const env = {
      ADMIN_TOKEN: 'super-secret-admin-token'
    };
    const res1 = await app.fetch(req1, env);
    expect(res1.status).toBe(400);

    const req2 = new Request('https://worker.local/admin/probe-stock?code=invalidcode', {
      method: 'GET',
      headers: {
        'Authorization': 'Bearer super-secret-admin-token'
      }
    });
    const res2 = await app.fetch(req2, env);
    expect(res2.status).toBe(400);
  });
});
