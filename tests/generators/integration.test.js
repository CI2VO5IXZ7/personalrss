import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { D1Mock } from '../helpers/d1_mock.js';
import { createGeneratorRegistry } from '../../src/generators/registry.js';
import { GeneratorService } from '../../src/generators/core/service.js';
import * as repo from '../../src/generators/core/repository.js';
import * as renderer from '../../src/generators/core/renderer.js';
import { createGeneratorRouter } from '../../src/generators/core/routes.js';

vi.mock('../../src/log.js', () => ({
  logError: vi.fn(),
  logEvent: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn()
}));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '../..');
const migrationsDir = path.join(root, 'migrations');

function applyAllMigrations(db) {
  const files = [
    '0001_init.sql',
    '0002_fix_unique_constraint.sql',
    '0003_api_usage.sql',
    '0004_post_meta_and_crawl_status.sql',
    '0005_personal_info_hub.sql',
    '0006_rss_secondary_dedupe_indexes.sql',
    '0007_integrated_output_platform.sql'
  ];
  for (const file of files) {
    db.exec(fs.readFileSync(path.join(migrationsDir, file), 'utf8'));
  }
}

async function sha256Hex(payload) {
  const buffer = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(payload)
  );
  return Array.from(new Uint8Array(buffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function makeImageNode(overrides = {}) {
  return {
    id: 'img_1',
    shortcode: 'sc1',
    taken_at_timestamp: 1700000000,
    display_url: 'https://scontent.cdninstagram.com/img.jpg',
    thumbnail_src: 'https://scontent.cdninstagram.com/img.jpg',
    is_video: false,
    edge_media_to_caption: {
      edges: [{ node: { text: 'Hello world' } }]
    },
    ...overrides
  };
}

function makeFakeFetch(imageNode) {
  return (url) => {
    const parsed = new URL(url);
    const username = parsed.searchParams.get('username');

    if (username === 'failprofile') {
      return Promise.resolve({ ok: false, status: 500 });
    }

    if (username === 'emptyprofile') {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          data: { user: { edge_owner_to_timeline_media: { edges: [] } } }
        })
      });
    }

    // Default (jjlin, etc.) returns one image node.
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        data: {
          user: {
            edge_owner_to_timeline_media: {
              edges: [{ node: imageNode }]
            }
          }
        }
      })
    });
  };
}

describe('Generator Integration', () => {
  let db;
  let service;
  let router;
  let context;
  let clock;
  let imageNode;

  beforeEach(() => {
    db = new D1Mock();
    applyAllMigrations(db);

    clock = {
      currentTime: new Date('2026-07-14T04:00:00.000Z'),
      now() { return this.currentTime; }
    };

    const registry = createGeneratorRegistry();
    service = new GeneratorService(registry, repo, renderer, clock);
    router = createGeneratorRouter(service);

    imageNode = makeImageNode();
    context = {
      db,
      fetch: makeFakeFetch(imageNode),
      crypto: globalThis.crypto,
      sleep: () => Promise.resolve(),
      getRandom: () => 0
    };
  });

  it('creates an Instagram instance with normalized username and configVersion 1, and does not touch rss_subscriptions', async () => {
    const instance = await service.create(db, 'instagram', '  JJLin  ', {}, 'JJ Lin');

    expect(instance.providerType).toBe('instagram');
    expect(instance.instanceKey).toBe('jjlin');
    expect(instance.displayName).toBe('JJ Lin');
    expect(instance.config).toEqual({ configVersion: 1 });

    const { results } = await db.prepare('SELECT count(*) as count FROM rss_subscriptions').all();
    expect(results[0].count).toBe(0);
  });

  it('refreshes an instance, saves a normalized image item, and updates status to success', async () => {
    const instance = await service.create(db, 'instagram', 'jjlin', {}, 'JJ Lin');
    const result = await service.refresh(db, instance.id, { context });

    expect(result).toEqual({
      itemCount: 1,
      newCount: 1,
      meta: { sourceCount: 1, emptyReason: '' }
    });

    const status = await repo.getStatus(db, instance.id);
    expect(status.lastResult).toBe('success');
    expect(status.lastError).toBe('');
    expect(status.consecutiveFailures).toBe(0);
    expect(status.lastItemCount).toBe(1);
    expect(status.lastNewCount).toBe(1);
    expect(status.lastDurationMs).toBeGreaterThanOrEqual(0);
    expect(status.lastSuccessAt).toBe('2026-07-14T04:00:00.000Z');

    const items = await repo.getItems(db, instance.id);
    expect(items).toHaveLength(1);

    const item = items[0];
    expect(item.itemKey).toBe('sc1');
    expect(item.canonicalId).toBe('img_1');
    expect(item.title).toBe('Hello world');
    expect(item.link).toBe('https://www.instagram.com/p/sc1/');
    expect(item.mediaType).toBe('image');
    expect(item.imageUrl).toBe('https://scontent.cdninstagram.com/img.jpg');
    expect(item.rawImages).toEqual(['https://scontent.cdninstagram.com/img.jpg']);
    expect(item.publishedAt).toBe('2023-11-14T22:13:20.000Z');

    const expectedHash = await sha256Hex(JSON.stringify({
      title: 'Hello world',
      descriptionHtml: '<img src="https://scontent.cdninstagram.com/img.jpg" style="max-width:100%"><br><p>Hello world</p>',
      mediaType: 'image',
      imageUrl: 'https://scontent.cdninstagram.com/img.jpg',
      rawImages: ['https://scontent.cdninstagram.com/img.jpg']
    }));

    expect(item.contentHash).toBe(expectedHash);
    expect(item.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns newCount 0 on a second refresh with identical content', async () => {
    const instance = await service.create(db, 'instagram', 'jjlin', {}, 'JJ Lin');

    const first = await service.refresh(db, instance.id, { context });
    expect(first.newCount).toBe(1);

    const second = await service.refresh(db, instance.id, { context });
    expect(second).toEqual({
      itemCount: 1,
      newCount: 0,
      meta: { sourceCount: 1, emptyReason: '' }
    });

    const status = await repo.getStatus(db, instance.id);
    expect(status.lastResult).toBe('success');
    expect(status.lastNewCount).toBe(0);

    const items = await repo.getItems(db, instance.id);
    expect(items).toHaveLength(1);
  });

  it('renders a feed with the self URL, Instagram metadata, proxied media, and no /rss/ig/', async () => {
    const instance = await service.create(db, 'instagram', 'jjlin', {}, 'JJ Lin');
    await service.refresh(db, instance.id, { context });

    const feedUrl = 'https://worker.example/feeds/1.xml';
    const xml = await service.getFeed(db, instance.id, feedUrl);

    expect(xml).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>/);
    expect(xml).toContain('<title><![CDATA[JJ Lin - Instagram]]></title>');
    expect(xml).toContain('<link>https://www.instagram.com/jjlin/</link>');
    expect(xml).toContain('<description><![CDATA[Instagram posts from @jjlin]]></description>');
    expect(xml).toContain('<atom:link href="https://worker.example/feeds/1.xml" rel="self" type="application/rss+xml"/>');
    expect(xml).toContain('<guid isPermaLink="false">img_1</guid>');
    expect(xml).toContain('<link>https://www.instagram.com/p/sc1/</link>');
    expect(xml).toContain('https://worker.example/img?url=https%3A%2F%2Fscontent.cdninstagram.com%2Fimg.jpg');
    expect(xml).toContain('type="image/jpeg"');
    expect(xml).not.toContain('/rss/ig/');
  });

  it('serves the feed through the Hono router with application/rss+xml', async () => {
    const instance = await service.create(db, 'instagram', 'jjlin', {}, 'JJ Lin');
    await service.refresh(db, instance.id, { context });

    const req = new Request('http://localhost/feeds/1.xml');
    const res = await router.fetch(req, { DB: db });

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/rss+xml; charset=utf-8');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=600');

    const body = await res.text();
    expect(body).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>/);
    expect(body).toContain('<atom:link href="http://localhost/feeds/1.xml" rel="self" type="application/rss+xml"/>');
    expect(body).toContain('<title><![CDATA[JJ Lin - Instagram]]></title>');
    expect(body).toContain('http://localhost/img?url=https%3A%2F%2Fscontent.cdninstagram.com%2Fimg.jpg');
    expect(body).not.toContain('/rss/ig/');
  });

  it('sets status to empty for a profile with no posts', async () => {
    const instance = await service.create(db, 'instagram', 'emptyprofile', {}, 'Empty Profile');
    const result = await service.refresh(db, instance.id, { context });

    expect(result).toEqual({
      itemCount: 0,
      newCount: 0,
      meta: { sourceCount: 0, emptyReason: 'no_posts' }
    });

    const status = await repo.getStatus(db, instance.id);
    expect(status.lastResult).toBe('empty');
    expect(status.lastItemCount).toBe(0);
    expect(status.lastNewCount).toBe(0);
    expect(status.consecutiveFailures).toBe(0);

    const items = await repo.getItems(db, instance.id);
    expect(items).toHaveLength(0);
  });

  it('does not create fake items and records status error when the provider fails', async () => {
    const instance = await service.create(db, 'instagram', 'failprofile', {}, 'Fail Profile');

    await expect(service.refresh(db, instance.id, { context }))
      .rejects.toThrow('Instagram API HTTP 500');

    const status = await repo.getStatus(db, instance.id);
    expect(status.lastResult).toBe('error');
    expect(status.consecutiveFailures).toBe(1);
    expect(status.lastError).toBe('Instagram API HTTP 500');
    expect(status.lastItemCount).toBe(0);
    expect(status.lastNewCount).toBe(0);

    const items = await repo.getItems(db, instance.id);
    expect(items).toHaveLength(0);
  });
});
