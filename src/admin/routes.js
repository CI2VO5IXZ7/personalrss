import { Hono } from 'hono';
import { GeneratorService } from '../generators/core/service.js';
import * as generatorRepository from '../generators/core/repository.js';
import * as generatorRenderer from '../generators/core/renderer.js';
import { createGeneratorRegistry } from '../generators/registry.js';
import { redactText } from '../security/url.js';

function parseId(value) {
  if (!/^[1-9]\d*$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function errorResponse(c, error, status = 500) {
  return c.json({ error: redactText(error?.message || String(error)) }, status);
}

export function createAdminRouter(generatorService) {
  const router = new Hono();

  router.use('/api/*', async (c, next) => {
    const adminToken = c.env?.ADMIN_TOKEN;
    if (!adminToken || c.req.header('Authorization') !== `Bearer ${adminToken}`) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    await next();
  });

  router.get('/api/generators', async (c) => {
    try {
      return c.json(await generatorService.list(c.env.DB));
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  router.post('/api/generators', async (c) => {
    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const { type, instanceKey, displayName } = body || {};
    if (typeof type !== 'string' || !type.trim() || typeof instanceKey !== 'string' || !instanceKey.trim()) {
      return c.json({ error: 'type and instanceKey are required' }, 400);
    }
    if (displayName !== undefined && typeof displayName !== 'string') {
      return c.json({ error: 'displayName must be a string' }, 400);
    }

    try {
      const generator = await generatorService.create(
        c.env.DB,
        type,
        instanceKey,
        {},
        displayName || ''
      );
      return c.json(generator, 201);
    } catch (error) {
      return errorResponse(c, error, 400);
    }
  });

  router.post('/api/generators/:id/refresh', async (c) => {
    const id = parseId(c.req.param('id'));
    if (id === null) return c.json({ error: 'Invalid generator ID' }, 400);

    try {
      const result = await generatorService.refresh(c.env.DB, id, {
        retentionLimit: positiveInt(c.env.CACHE_MAX_POSTS, 100),
        context: { db: c.env.DB, fetch: globalThis.fetch, crypto: globalThis.crypto }
      });
      return c.json(result);
    } catch (error) {
      const status = error?.message?.startsWith('Instance not found:') ? 404 : 500;
      return errorResponse(c, error, status);
    }
  });

  router.post('/api/generators/:id/pause', async (c) => {
    const id = parseId(c.req.param('id'));
    if (id === null) return c.json({ error: 'Invalid generator ID' }, 400);

    try {
      const updated = await generatorService.pause(c.env.DB, id);
      return updated ? c.json({ success: true }) : c.json({ error: 'Generator not found' }, 404);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  router.post('/api/generators/:id/resume', async (c) => {
    const id = parseId(c.req.param('id'));
    if (id === null) return c.json({ error: 'Invalid generator ID' }, 400);

    try {
      const updated = await generatorService.resume(c.env.DB, id);
      return updated ? c.json({ success: true }) : c.json({ error: 'Generator not found' }, 404);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  router.delete('/api/generators/:id', async (c) => {
    const id = parseId(c.req.param('id'));
    if (id === null) return c.json({ error: 'Invalid generator ID' }, 400);

    try {
      const removed = await generatorService.remove(c.env.DB, id);
      return removed ? c.json({ success: true }) : c.json({ error: 'Generator not found' }, 404);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  router.get('/api/status', async (c) => {
    try {
      const generators = await generatorService.list(c.env.DB);
      return c.json({ generators: generators.length });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  return router;
}

const generatorService = new GeneratorService(
  createGeneratorRegistry(),
  generatorRepository,
  generatorRenderer
);

const adminRouter = createAdminRouter(generatorService);

export default adminRouter;
