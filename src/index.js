import { Hono } from 'hono';
import { handleImageProxy, handleMediaProxy } from './proxy.js';
import { createGeneratorRouter } from './generators/core/routes.js';
import { GeneratorService } from './generators/core/service.js';
import * as generatorRepository from './generators/core/repository.js';
import * as generatorRenderer from './generators/core/renderer.js';
import { createGeneratorRegistry } from './generators/registry.js';
import { runDueGenerators } from './generators/core/scheduler.js';
import { logError, logInfo } from './log.js';
import { redactText } from './security/url.js';
import adminRouter from './admin/routes.js';
import adminPage from './admin/page.js';

const app = new Hono();

const generatorRegistry = createGeneratorRegistry();
const generatorService = new GeneratorService(generatorRegistry, generatorRepository, generatorRenderer);

app.get('/', c => c.text('Not Found', 404));
app.get('/admin', c => c.html(adminPage));

app.get('/img', handleImageProxy);
app.get('/media', handleMediaProxy);

app.route('/', adminRouter);
app.route('/', createGeneratorRouter(generatorService));

function parsePositiveInt(value, defaultValue) {
  const n = parseInt(value, 10);
  return Number.isInteger(n) && n > 0 ? n : defaultValue;
}

async function runWithIsolation(name, fn) {
  const startedAt = Date.now();
  try {
    const result = await fn();
    logInfo('scheduled.assembly_finished', { name, durationMs: Date.now() - startedAt });
    return { ok: true, result };
  } catch (err) {
    logError('scheduled.assembly_failed', {
      name,
      error: redactText(err?.message || String(err)),
      durationMs: Date.now() - startedAt
    });
    return { ok: false, error: redactText(err?.message || String(err)) };
  }
}

export default {
  fetch: app.fetch,

  async scheduled(event, env, ctx) {
    logInfo('scheduled.triggered', { cron: event.cron });

    await runWithIsolation('generator', () =>
      runDueGenerators(env.DB, generatorService, {
        intervalMinutes: 10,
        retentionLimit: parsePositiveInt(env.CACHE_MAX_POSTS, 100),
        context: { db: env.DB, fetch: globalThis.fetch, crypto: globalThis.crypto }
      })
    );
  }
};
