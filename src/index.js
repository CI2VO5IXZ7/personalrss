import { Hono } from 'hono';
import { handleImageProxy, handleMediaProxy } from './proxy.js';
import { createGeneratorRouter } from './generators/core/routes.js';
import { GeneratorService } from './generators/core/service.js';
import * as generatorRepository from './generators/core/repository.js';
import * as generatorRenderer from './generators/core/renderer.js';
import { createGeneratorRegistry } from './generators/registry.js';
import { runDueGenerators } from './generators/core/scheduler.js';
import { MonitorService } from './monitors/core/service.js';
import { createMonitorRegistry } from './monitors/registry.js';
import { evaluateRules as runMonitorEvaluations } from './monitors/core/engine.js';
import * as pushRssService from './push/rss/service.js';
import { processDueSubscriptions as runDueRssPushSubscriptions } from './push/rss/scheduler.js';
import { processNotificationBatch as runNotificationQueue } from './push/notifications/sender.js';
import { createTelegramRouter } from './telegram/routes.js';
import { createProbeRouter } from './system/probe.js';
import { logError, logInfo } from './log.js';
import { redactText } from './security/url.js';

const app = new Hono();

const generatorRegistry = createGeneratorRegistry();
const monitorRegistry = createMonitorRegistry();
const generatorService = new GeneratorService(generatorRegistry, generatorRepository, generatorRenderer);
const monitorService = new MonitorService(monitorRegistry);

const telegramRouter = createTelegramRouter({
  generatorService,
  monitorService,
  pushService: pushRssService
});

const probeRouter = createProbeRouter({ monitorService });

app.get('/', c => c.text('Not Found', 404));
app.get('/status', c => c.text('Not Found', 404));

app.get('/img', handleImageProxy);
app.get('/media', handleMediaProxy);

app.route('/', createGeneratorRouter(generatorService));
app.route('/', telegramRouter);
app.route('/', probeRouter);

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

    const now = new Date();
    const minute = now.getUTCMinutes();

    const tasks = [];

    if (minute % 10 === 0) {
      tasks.push(runWithIsolation('generator', () =>
        runDueGenerators(env.DB, generatorService, {
          intervalMinutes: 10,
          retentionLimit: parsePositiveInt(env.CACHE_MAX_POSTS, 100),
          context: { db: env.DB, fetch: globalThis.fetch, crypto: globalThis.crypto }
        })
      ));
    }

    tasks.push(runWithIsolation('monitor', () =>
      runMonitorEvaluations(env.DB, env, { fetchFn: fetch, relativeTo: now })
    ));

    tasks.push(runWithIsolation('push_rss', () =>
      runDueRssPushSubscriptions(env.DB, env, {
        batchLimit: parsePositiveInt(env.REFRESH_CONCURRENCY, 3)
      })
    ));

    tasks.push(runWithIsolation('notification_queue', () =>
      runNotificationQueue(env.DB, env, { batchLimit: 10 })
    ));

    await Promise.all(tasks.map(t => t.then(() => {})));
  }
};
