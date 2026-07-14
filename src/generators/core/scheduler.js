import { redactText } from '../../security/url.js';

async function runWithConcurrency(concurrency, tasks) {
  const results = [];
  const executing = [];
  for (const task of tasks) {
    const p = Promise.resolve().then(() => task());
    results.push(p);
    if (concurrency < tasks.length) {
      const e = p.then(() => executing.splice(executing.indexOf(e), 1));
      executing.push(e);
      if (executing.length >= concurrency) {
        await Promise.race(executing);
      }
    }
  }
  return Promise.all(results);
}

export async function runDueGenerators(db, service, options = {}) {
  const concurrency = options.concurrency ?? 3;
  if (!Number.isInteger(concurrency) || concurrency <= 0) {
    throw new Error('concurrency must be a positive integer');
  }

  const intervalMinutes = options.intervalMinutes ?? 10;
  if (!Number.isInteger(intervalMinutes) || intervalMinutes <= 0) {
    throw new Error('intervalMinutes must be a positive integer');
  }

  const retentionLimit = options.retentionLimit ?? 100;
  if (!Number.isInteger(retentionLimit) || retentionLimit <= 0) {
    throw new Error('retentionLimit must be a positive integer');
  }

  const context = options.context || { db };
  const nowStr = options.nowStr || service.clock.now().toISOString();

  const dueInstances = await service.repository.getDueInstances(db, nowStr);
  if (!Array.isArray(dueInstances)) {
    throw new Error('due results must be an array');
  }

  let attempted = 0;
  let succeeded = 0;
  let failed = 0;
  const errorsRedacted = [];

  if (dueInstances.length === 0) {
    return { attempted, succeeded, failed, errorsRedacted };
  }

  const tasks = dueInstances.map(instance => async () => {
    attempted++;
    const instanceContext = { ...context };
    try {
      await service.refresh(db, instance.id, {
        intervalMinutes,
        retentionLimit,
        context: instanceContext
      });
      succeeded++;
    } catch (err) {
      failed++;
      const cleanMsg = redactText(err.message || String(err));
      errorsRedacted.push({
        id: instance.id,
        providerType: instance.providerType,
        instanceKey: instance.instanceKey,
        error: cleanMsg
      });
    }
  });

  await runWithConcurrency(concurrency, tasks);

  return { attempted, succeeded, failed, errorsRedacted };
}
