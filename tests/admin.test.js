import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAdminRouter } from '../src/admin/routes.js';

describe('Admin API', () => {
  let generatorService;
  let router;
  let db;
  let env;

  function request(path, options = {}) {
    const headers = new Headers(options.headers);
    headers.set('Authorization', 'Bearer test-admin-token');
    return router.fetch(new Request(`https://worker.local${path}`, { ...options, headers }), env);
  }

  beforeEach(() => {
    db = {};
    env = { DB: db, ADMIN_TOKEN: 'test-admin-token', CACHE_MAX_POSTS: '25' };
    generatorService = {
      list: vi.fn(),
      create: vi.fn(),
      refresh: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      remove: vi.fn()
    };
    router = createAdminRouter(generatorService);
  });

  it('rejects missing and mismatched Bearer tokens', async () => {
    const missing = await router.fetch(new Request('https://worker.local/api/generators'), env);
    const mismatched = await router.fetch(new Request('https://worker.local/api/generators', {
      headers: { Authorization: 'Bearer wrong-token' }
    }), env);

    expect(missing.status).toBe(401);
    expect(mismatched.status).toBe(401);
    expect(await missing.json()).toEqual({ error: 'Unauthorized' });
    expect(generatorService.list).not.toHaveBeenCalled();
  });

  it('rejects requests when ADMIN_TOKEN is not configured', async () => {
    const response = await router.fetch(new Request('https://worker.local/api/generators', {
      headers: { Authorization: 'Bearer undefined' }
    }), { DB: db });

    expect(response.status).toBe(401);
    expect(generatorService.list).not.toHaveBeenCalled();
  });

  it('lists generator instances', async () => {
    const generators = [{ id: 1, providerType: 'instagram', instanceKey: 'example', status: 'active' }];
    generatorService.list.mockResolvedValue(generators);

    const response = await request('/api/generators');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(generators);
    expect(generatorService.list).toHaveBeenCalledWith(db);
  });

  it('creates a generator from the JSON body', async () => {
    const created = { id: 2, providerType: 'stock', instanceKey: '600519', displayName: 'Kweichow Moutai', status: 'active' };
    generatorService.create.mockResolvedValue(created);

    const response = await request('/api/generators', {
      method: 'POST',
      body: JSON.stringify({ type: 'stock', instanceKey: '600519', displayName: 'Kweichow Moutai' })
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(created);
    expect(generatorService.create).toHaveBeenCalledWith(db, 'stock', '600519', {}, 'Kweichow Moutai');
  });

  it('validates the create body', async () => {
    const response = await request('/api/generators', {
      method: 'POST',
      body: JSON.stringify({ type: 'instagram' })
    });

    expect(response.status).toBe(400);
    expect(generatorService.create).not.toHaveBeenCalled();
  });

  it('refreshes a generator with Worker context and retention settings', async () => {
    generatorService.refresh.mockResolvedValue({ itemCount: 3, newCount: 1 });

    const response = await request('/api/generators/7/refresh', { method: 'POST' });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ itemCount: 3, newCount: 1 });
    expect(generatorService.refresh).toHaveBeenCalledWith(db, 7, {
      retentionLimit: 25,
      context: { db, fetch: globalThis.fetch, crypto: globalThis.crypto }
    });
  });

  it('pauses a generator', async () => {
    generatorService.pause.mockResolvedValue(true);

    const response = await request('/api/generators/3/pause', { method: 'POST' });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(generatorService.pause).toHaveBeenCalledWith(db, 3);
  });

  it('resumes a generator', async () => {
    generatorService.resume.mockResolvedValue(true);

    const response = await request('/api/generators/3/resume', { method: 'POST' });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(generatorService.resume).toHaveBeenCalledWith(db, 3);
  });

  it('deletes a generator', async () => {
    generatorService.remove.mockResolvedValue(true);

    const response = await request('/api/generators/3', { method: 'DELETE' });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(generatorService.remove).toHaveBeenCalledWith(db, 3);
  });

  it('returns 404 when a lifecycle operation does not find the generator', async () => {
    generatorService.pause.mockResolvedValue(false);

    const response = await request('/api/generators/99/pause', { method: 'POST' });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Generator not found' });
  });

  it('returns the total generator count', async () => {
    generatorService.list.mockResolvedValue([{ id: 1 }, { id: 2 }, { id: 3 }]);

    const response = await request('/api/status');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ generators: 3 });
    expect(generatorService.list).toHaveBeenCalledWith(db);
  });

  it('rejects invalid generator IDs before calling the service', async () => {
    const response = await request('/api/generators/not-a-number/refresh', { method: 'POST' });

    expect(response.status).toBe(400);
    expect(generatorService.refresh).not.toHaveBeenCalled();
  });
});
