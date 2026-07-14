import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { D1Mock } from './helpers/d1_mock.js';
import fs from 'fs';
import path from 'path';
import app from '../src/index.js';

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
    db.exec(fs.readFileSync(path.resolve(__dirname, '../migrations', file), 'utf8'));
  }
}

describe('Production App Routing Tests', () => {
  let db;
  let env;
  let ctx;

  beforeEach(() => {
    db = new D1Mock();
    applyAllMigrations(db);

    env = {
      DB: db,
      BASE_URL: 'https://worker.example',
      TELEGRAM_CHAT_ID: '12345',
      TELEGRAM_ADMIN_USER_ID: 'admin1',
      ADMIN_TOKEN: 'secret-token',
      TELEGRAM_BOT_TOKEN: 'bot-token',
      CACHE_MAX_POSTS: '100'
    };

    ctx = {
      waitUntil: vi.fn(async (promise) => await promise)
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('proves that GET /rss/ig/foo returns 404 with no redirect', async () => {
    const req = new Request('https://worker.example/rss/ig/foo', {
      method: 'GET'
    });
    const res = await app.fetch(req, env, ctx);
    expect(res.status).toBe(404);
    expect(res.headers.get('location')).toBeNull();
  });

  it('proves that root GET /status returns 404', async () => {
    const req = new Request('https://worker.example/status', {
      method: 'GET'
    });
    const res = await app.fetch(req, env, ctx);
    expect(res.status).toBe(404);
  });

  it('proves that invalid feed IDs return 404', async () => {
    const invalidPaths = [
      '/feeds/abc.xml',
      '/feeds/1x.xml',
      '/feeds/01.xml',
      '/feeds/+1.xml',
      '/feeds/-1.xml',
      '/feeds/1'
    ];
    for (const p of invalidPaths) {
      const req = new Request(`https://worker.example${p}`, {
        method: 'GET'
      });
      const res = await app.fetch(req, env, ctx);
      expect(res.status).toBe(404);
    }
  });

  it('verifies GET /feeds/<id>.xml returns 200 RSS feed with correct self-link and content-type', async () => {
    // Insert realistic generator instance and item rows into the D1 database
    await db.prepare(`
      INSERT INTO generator_instances (
        id, provider_type, instance_key, display_name, config_json, status
      ) VALUES (
        1, 'instagram', 'jjlin', 'JJ Lin', '{}', 'active'
      )
    `).run();

    await db.prepare(`
      INSERT INTO generator_items (
        generator_id, item_key, canonical_id, content_hash, title, description_html, link, published_at, media_type, image_url, raw_images_json
      ) VALUES (
        1, 'post123', 'canon123', 'hash123', 'My Instagram Post', '<p>Hello Instagram</p>', 'https://instagram.com/p/post123', '2026-07-13T07:40:00Z', 'image', 'https://example.com/image.jpg', '[]'
      )
    `).run();

    const req = new Request('https://worker.example/feeds/1.xml', {
      method: 'GET'
    });
    const res = await app.fetch(req, env, ctx);

    expect(res.status).toBe(200);

    const contentType = res.headers.get('content-type');
    expect(contentType).toContain('application/rss+xml');

    const bodyText = await res.text();
    expect(bodyText).toContain('<rss version="2.0"');
    expect(bodyText).toContain('My Instagram Post');
    expect(bodyText).toContain('<atom:link href="https://worker.example/feeds/1.xml" rel="self" type="application/rss+xml"/>');
  });
});
