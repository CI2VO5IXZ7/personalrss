import { normalizeGeneratorItem } from './contract.js';
import { redactText } from '../../security/url.js';

export class GeneratorService {
  constructor(registry, repository, renderer, clock) {
    if (registry && typeof registry === 'object' && !registry.get && registry.registry) {
      const opts = registry;
      this.registry = opts.registry;
      this.repository = opts.repository;
      this.renderer = opts.renderer;
      this.clock = opts.clock;
    } else {
      this.registry = registry;
      this.repository = repository;
      this.renderer = renderer;
      this.clock = clock;
    }
    if (!this.clock) {
      this.clock = { now: () => new Date() };
    }
    if (!this.registry) {
      throw new Error('Registry is required');
    }
    if (!this.repository) {
      throw new Error('Repository is required');
    }
    if (!this.renderer) {
      throw new Error('Renderer is required');
    }
  }

  async create(db, type, instanceKey, config, displayName) {
    const provider = this.registry.get(type);
    if (!provider) {
      throw new Error(`Unsupported generator provider type: ${type}`);
    }

    const context = { db, instanceKey };
    const validatedConfig = await provider.validateConfig(config, context);
    const finalConfig = validatedConfig !== undefined ? validatedConfig : config;

    return await this.repository.createInstance(db, {
      providerType: type,
      instanceKey,
      displayName,
      config: finalConfig
    });
  }

  async list(db, filters = {}) {
    return await this.repository.listInstances(db, filters);
  }

  async get(db, id) {
    return await this.repository.getInstance(db, id);
  }

  async pause(db, id) {
    return await this.repository.updateInstance(db, id, { status: 'paused' });
  }

  async resume(db, id) {
    return await this.repository.updateInstance(db, id, { status: 'active', nextRefreshAt: null });
  }

  async remove(db, id) {
    return await this.repository.deleteInstance(db, id);
  }

  async refresh(db, id, options = {}) {
    const instance = await this.repository.getInstance(db, id);
    if (!instance) {
      throw new Error(`Instance not found: ${id}`);
    }

    const provider = this.registry.get(instance.providerType);
    if (!provider) {
      throw new Error(`Unsupported provider type: ${instance.providerType}`);
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

    const startTime = this.clock.now().getTime();
    const attemptTime = new Date(startTime);

    try {
      const fetchResult = await provider.fetchItems(instance, context);
      if (!fetchResult || typeof fetchResult !== 'object' || Array.isArray(fetchResult)) {
        throw new Error('Provider contract error: fetchItems must return a plain object');
      }
      if (!Array.isArray(fetchResult.items)) {
        throw new Error('Provider contract error: fetchItems result must contain an items array');
      }

      const rawItems = fetchResult.items;

      const normalizedItems = [];
      for (const rawItem of rawItems) {
        let normalized = provider.normalizeItem(rawItem, instance, context);
        if (normalized instanceof Promise || (normalized && typeof normalized.then === 'function')) {
          normalized = await normalized;
        }
        const guarded = normalizeGeneratorItem(normalized);
        normalizedItems.push(guarded);
      }

      const insertedCount = await this.repository.saveItems(db, id, normalizedItems, retentionLimit);

      const nextRefreshAt = new Date(this.clock.now().getTime() + intervalMinutes * 60 * 1000);
      const duration = this.clock.now().getTime() - startTime;
      const lastResult = normalizedItems.length === 0 ? 'empty' : 'success';
      const lastSuccessAt = this.clock.now();

      await this.repository.updateRefreshState(db, id, {
        nextRefreshAt,
        statusUpdates: {
          lastAttemptAt: attemptTime,
          lastSuccessAt,
          lastResult,
          lastError: '',
          consecutiveFailures: 0,
          lastItemCount: normalizedItems.length,
          lastNewCount: insertedCount,
          lastDurationMs: duration
        }
      });

      return {
        itemCount: normalizedItems.length,
        newCount: insertedCount,
        meta: fetchResult.meta
      };
    } catch (err) {
      const duration = this.clock.now().getTime() - startTime;
      const cleanError = redactText(err.message || String(err));

      const currentStatus = await this.repository.getStatus(db, id);
      const consecutiveFailures = (currentStatus?.consecutiveFailures || 0) + 1;

      const nextRefreshAt = new Date(this.clock.now().getTime() + intervalMinutes * 60 * 1000);

      await this.repository.updateRefreshState(db, id, {
        nextRefreshAt,
        statusUpdates: {
          lastAttemptAt: attemptTime,
          lastResult: 'error',
          lastError: cleanError,
          consecutiveFailures,
          lastDurationMs: duration
        }
      });

      throw err;
    }
  }

  async getFeed(db, id, feedUrl) {
    const instance = await this.repository.getInstance(db, id);
    if (!instance) {
      return null;
    }

    const provider = this.registry.get(instance.providerType);
    if (!provider) {
      throw new Error(`Unsupported provider type: ${instance.providerType}`);
    }

    const context = { db };
    const feedMeta = await provider.buildFeedMeta(instance, context);
    const items = await this.repository.getItems(db, id, 50);

    return this.renderer.renderRssFeed(feedMeta, items, feedUrl);
  }
}
