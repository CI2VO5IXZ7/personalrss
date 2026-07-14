import { describe, it, expect, vi } from 'vitest';
import {
  validateGeneratorProvider,
  normalizeGeneratorItem
} from '../../src/generators/core/contract.js';
import { instagramProvider } from '../../src/generators/providers/instagram/index.js';

const IG_BASE = 'https://www.instagram.com';
const PROFILE_API = `${IG_BASE}/api/v1/users/web_profile_info/`;

function makeImageNode({
  id = 'img_1',
  shortcode = 'img1',
  takenAt = 1700000000,
  displayUrl = 'https://cdn.example.com/img.jpg',
  caption = 'Hello world',
  children = null
}) {
  const node = {
    id,
    shortcode,
    taken_at_timestamp: takenAt,
    display_url: displayUrl,
    thumbnail_src: displayUrl,
    is_video: false,
    edge_media_to_caption: caption ? { edges: [{ node: { text: caption } }] } : { edges: [] },
    ...(children ? { edge_sidecar_to_children: { edges: children.map(c => ({ node: c })) } } : {})
  };
  return node;
}

function makeVideoNode({
  id = 'vid_1',
  shortcode = 'vid1',
  takenAt = 1700000000,
  displayUrl = 'https://cdn.example.com/poster.jpg',
  videoUrl = 'https://cdn.example.com/video.mp4',
  caption = 'A video'
}) {
  return {
    id,
    shortcode,
    taken_at_timestamp: takenAt,
    display_url: displayUrl,
    thumbnail_src: displayUrl,
    is_video: true,
    video_url: videoUrl,
    edge_media_to_caption: caption ? { edges: [{ node: { text: caption } }] } : { edges: [] }
  };
}

function makeProfileBody(edges = []) {
  return { data: { user: { edge_owner_to_timeline_media: { edges } } } };
}

function makeJsonResponse(body, { status = 200, ok = true } = {}) {
  return Promise.resolve({ ok, status, json: () => Promise.resolve(body) });
}

function makeJsonErrorResponse(status) {
  return Promise.resolve({ ok: false, status });
}

function makeFetch(fn) {
  return vi.fn((...args) => Promise.resolve(fn(...args)));
}

function makeSleep() {
  return vi.fn(() => Promise.resolve());
}

function makeGetRandom() {
  return vi.fn(() => 0);
}

function makeInstance(instanceKey = 'jjlin', config = {}) {
  return { instanceKey, config };
}

describe('Instagram Provider', () => {
  it('conforms to the generator provider contract', () => {
    expect(validateGeneratorProvider(instagramProvider)).toBe(instagramProvider);
  });

  it('has the expected type and display name', () => {
    expect(instagramProvider.type).toBe('instagram');
    expect(instagramProvider.displayName).toBe('Instagram');
  });

  describe('validateConfig', () => {
    it('returns a normalized config object with configVersion 1', () => {
      const result = instagramProvider.validateConfig({ custom: true }, { instanceKey: '  JJLin  ' });
      expect(result).toEqual({ custom: true, configVersion: 1 });
    });

    it('uses an empty config when none is provided', () => {
      const result = instagramProvider.validateConfig(undefined, { instanceKey: 'jjlin' });
      expect(result).toEqual({ configVersion: 1 });
    });

    it('does not return an instanceKey wrapper', () => {
      const result = instagramProvider.validateConfig({ custom: true }, { instanceKey: 'jjlin' });
      expect(result).not.toHaveProperty('instanceKey');
      expect(result).toEqual({ custom: true, configVersion: 1 });
    });

    it('rejects config that is not a plain object or undefined', () => {
      expect(() => instagramProvider.validateConfig('not-object', { instanceKey: 'jjlin' })).toThrow(/config/);
      expect(() => instagramProvider.validateConfig(123, { instanceKey: 'jjlin' })).toThrow(/config/);
      expect(() => instagramProvider.validateConfig(null, { instanceKey: 'jjlin' })).toThrow(/config/);
      expect(() => instagramProvider.validateConfig([], { instanceKey: 'jjlin' })).toThrow(/config/);
    });

    it('rejects empty instanceKey', () => {
      expect(() => instagramProvider.validateConfig(undefined, { instanceKey: '   ' })).toThrow(/username|instanceKey/i);
    });

    it('rejects missing instanceKey', () => {
      expect(() => instagramProvider.validateConfig(undefined, {})).toThrow(/username|instanceKey/i);
      expect(() => instagramProvider.validateConfig(undefined, undefined)).toThrow(/username|instanceKey/i);
    });

    it('rejects usernames with spaces', () => {
      expect(() => instagramProvider.validateConfig(undefined, { instanceKey: 'jj lin' })).toThrow(/Invalid Instagram username/);
    });

    it('rejects usernames starting or ending with a period', () => {
      expect(() => instagramProvider.validateConfig(undefined, { instanceKey: '.jjlin' })).toThrow(/Invalid Instagram username/);
      expect(() => instagramProvider.validateConfig(undefined, { instanceKey: 'jjlin.' })).toThrow(/Invalid Instagram username/);
    });

    it('rejects usernames with consecutive periods', () => {
      expect(() => instagramProvider.validateConfig(undefined, { instanceKey: 'jj..lin' })).toThrow(/Invalid Instagram username/);
    });

    it('rejects usernames with invalid characters', () => {
      expect(() => instagramProvider.validateConfig(undefined, { instanceKey: 'jj-lin' })).toThrow(/Invalid Instagram username/);
      expect(() => instagramProvider.validateConfig(undefined, { instanceKey: 'jj@lin' })).toThrow(/Invalid Instagram username/);
    });

    it('rejects usernames longer than 30 characters', () => {
      expect(() => instagramProvider.validateConfig(undefined, { instanceKey: 'a'.repeat(31) })).toThrow(/Invalid Instagram username/);
    });
  });

  describe('fetchItems', () => {
    it('fetches raw nodes without pre-normalizing', async () => {
      const node = makeImageNode({
        id: 'p1',
        shortcode: 'sc1',
        takenAt: 1700000000,
        displayUrl: 'https://cdn.example.com/1.jpg',
        caption: 'First post'
      });
      const fetch = makeFetch(() => makeJsonResponse(makeProfileBody([{ node }])));
      const deps = { fetch, sleep: makeSleep(), getRandom: makeGetRandom() };

      const result = await instagramProvider.fetchItems(makeInstance('jjlin', {}), deps);

      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch.mock.calls[0][0]).toBe(`${PROFILE_API}?username=jjlin`);
      expect(result).toEqual({
        items: [node],
        meta: { sourceCount: 1, emptyReason: '' }
      });
      expect(result.items[0]).toBe(node);
    });

    it('normalizes instanceKey to lowercase before fetching', async () => {
      const body = makeProfileBody([]);
      const fetch = vi.fn(() => makeJsonResponse(body));

      await instagramProvider.fetchItems(makeInstance('JJLin', {}), { fetch, sleep: makeSleep(), getRandom: makeGetRandom() });

      expect(fetch.mock.calls[0][0]).toBe(`${PROFILE_API}?username=jjlin`);
    });

    it('injects fetch, sleep and random for deterministic testing', async () => {
      const body = makeProfileBody([]);
      const fetch = makeFetch(() => makeJsonResponse(body));
      const sleep = makeSleep();
      const getRandom = makeGetRandom();
      const deps = { fetch, sleep, getRandom };

      await instagramProvider.fetchItems(makeInstance('jjlin', {}), deps);

      expect(fetch).toHaveBeenCalled();
      expect(sleep).not.toHaveBeenCalled();
      expect(getRandom).not.toHaveBeenCalled();
    });

    it('passes through retries from the fetcher', async () => {
      const node = makeImageNode({ id: 'p1', shortcode: 'sc1' });
      const body = makeProfileBody([{ node }]);
      const fetch = vi.fn(() => {
        if (fetch.mock.calls.length === 1) return makeJsonErrorResponse(429);
        return makeJsonResponse(body);
      });
      const sleep = makeSleep();

      const result = await instagramProvider.fetchItems(makeInstance('jjlin', {}), { fetch, sleep, getRandom: makeGetRandom() });

      expect(fetch).toHaveBeenCalledTimes(2);
      expect(sleep).toHaveBeenCalledTimes(1);
      expect(result.items).toHaveLength(1);
    });

    it('throws for invalid instanceKey', async () => {
      const fetch = vi.fn(() => makeJsonResponse(makeProfileBody([])));
      await expect(instagramProvider.fetchItems(makeInstance('jj lin', {}), { fetch }))
        .rejects.toThrow(/Invalid Instagram username/);
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  describe('normalizeItem', () => {
    it('produces all normalized item fields for an image post', async () => {
      const node = makeImageNode({
        id: 'p1',
        shortcode: 'sc1',
        takenAt: 1700000000,
        displayUrl: 'https://cdn.example.com/1.jpg',
        caption: 'Hello\nWorld'
      });

      const item = await instagramProvider.normalizeItem(node, makeInstance('jjlin'));

      expect(item).toEqual(normalizeGeneratorItem({
        itemKey: 'sc1',
        canonicalId: 'p1',
        contentHash: item.contentHash,
        title: 'Hello',
        descriptionHtml: item.descriptionHtml,
        link: 'https://www.instagram.com/p/sc1/',
        publishedAt: new Date(1700000000 * 1000),
        mediaType: 'image',
        imageUrl: 'https://cdn.example.com/1.jpg',
        rawImages: ['https://cdn.example.com/1.jpg']
      }));
    });

    it('produces a normalized video post', async () => {
      const node = makeVideoNode({
        id: 'v1',
        shortcode: 'v1',
        takenAt: 1700000001,
        displayUrl: 'https://cdn.example.com/poster.jpg',
        videoUrl: 'https://cdn.example.com/clip.mp4',
        caption: 'Watch this'
      });

      const item = await instagramProvider.normalizeItem(node, makeInstance('jjlin'));

      expect(item).toMatchObject({
        itemKey: 'v1',
        canonicalId: 'v1',
        title: 'Watch this',
        link: 'https://www.instagram.com/p/v1/',
        mediaType: 'video',
        imageUrl: 'https://cdn.example.com/poster.jpg',
        rawImages: ['https://cdn.example.com/poster.jpg']
      });
      expect(item.descriptionHtml).toContain('<video controls poster="https://cdn.example.com/poster.jpg"><source src="https://cdn.example.com/clip.mp4" type="video/mp4"></video>');
    });

    it('produces a normalized sidecar post with images and videos', async () => {
      const child1 = makeImageNode({ id: 'c1', shortcode: 'c1', displayUrl: 'https://cdn.example.com/c1.jpg', caption: '' });
      const child2 = makeVideoNode({ id: 'c2', shortcode: 'c2', displayUrl: 'https://cdn.example.com/c2.jpg', videoUrl: 'https://cdn.example.com/c2.mp4', caption: '' });
      const node = makeImageNode({
        id: 'sc1',
        shortcode: 'sc1',
        takenAt: 1700000002,
        displayUrl: 'https://cdn.example.com/parent.jpg',
        caption: 'Sidecar',
        children: [child1, child2]
      });

      const item = await instagramProvider.normalizeItem(node, makeInstance('jjlin'));

      expect(item).toMatchObject({
        itemKey: 'sc1',
        canonicalId: 'sc1',
        mediaType: 'video',
        imageUrl: 'https://cdn.example.com/parent.jpg',
        rawImages: ['https://cdn.example.com/parent.jpg', 'https://cdn.example.com/c1.jpg', 'https://cdn.example.com/c2.jpg']
      });
      expect(item.descriptionHtml).toContain('<img src="https://cdn.example.com/c1.jpg" style="max-width:100%">');
      expect(item.descriptionHtml).toContain('<video controls poster="https://cdn.example.com/c2.jpg"><source src="https://cdn.example.com/c2.mp4" type="video/mp4"></video>');
    });

    it('escapes HTML in the caption and descriptionHtml', async () => {
      const node = makeImageNode({
        id: 'p1',
        shortcode: 'esc1',
        displayUrl: 'https://cdn.example.com/e.jpg',
        caption: 'R&B & Rock <3'
      });

      const item = await instagramProvider.normalizeItem(node, makeInstance('jjlin'));

      expect(item.title).toBe('R&B & Rock <3');
      expect(item.descriptionHtml).toContain('<p>R&amp;B &amp; Rock &lt;3</p>');
    });

    it('falls back to a generated title when caption is empty', async () => {
      const node = makeImageNode({ id: 'p1', shortcode: 'sc1', caption: '' });
      const item = await instagramProvider.normalizeItem(node, makeInstance('jjlin'));
      expect(item.title).toBe('@jjlin post');
    });

    it('uses item id as itemKey when shortcode is missing', async () => {
      const node = makeImageNode({ id: 'p1', shortcode: '', caption: '' });
      const item = await instagramProvider.normalizeItem(node, makeInstance('jjlin'));
      expect(item.itemKey).toBe('p1');
      expect(item.link).toBe('');
    });

    it('sets mediaType to video for sidecar posts containing a video', async () => {
      const child1 = makeImageNode({ id: 'c1', shortcode: 'c1', displayUrl: 'https://cdn.example.com/c1.jpg', caption: '' });
      const child2 = makeVideoNode({ id: 'c2', shortcode: 'c2', displayUrl: 'https://cdn.example.com/c2.jpg', videoUrl: 'https://cdn.example.com/c2.mp4', caption: '' });
      const node = makeImageNode({ id: 'sc1', shortcode: 'sc1', displayUrl: 'https://cdn.example.com/parent.jpg', caption: '', children: [child1, child2] });

      const item = await instagramProvider.normalizeItem(node, makeInstance('jjlin'));

      expect(item.mediaType).toBe('video');
      expect(item.rawImages).toEqual([
        'https://cdn.example.com/parent.jpg',
        'https://cdn.example.com/c1.jpg',
        'https://cdn.example.com/c2.jpg'
      ]);
    });

    it('sets publishedAt to undefined when taken_at_timestamp is missing or invalid', async () => {
      const node = makeImageNode({ id: 'p1', shortcode: 'sc1', takenAt: null, caption: '' });
      const item = await instagramProvider.normalizeItem(node, makeInstance('jjlin'));
      expect(item.publishedAt).toBeUndefined();

      const invalidNode = makeImageNode({ id: 'p2', shortcode: 'sc2', takenAt: 'not-a-number', caption: '' });
      const invalidItem = await instagramProvider.normalizeItem(invalidNode, makeInstance('jjlin'));
      expect(invalidItem.publishedAt).toBeUndefined();
    });

    it('produces a stable contentHash for identical raw data', async () => {
      const node = makeImageNode({ id: 'p1', shortcode: 'sc1', caption: 'Same' });
      const item1 = await instagramProvider.normalizeItem(node, makeInstance('jjlin'));
      const item2 = await instagramProvider.normalizeItem(node, makeInstance('jjlin'));
      expect(item1.contentHash).toBe(item2.contentHash);
      expect(item1.contentHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('produces the same contentHash for different ids with identical content', async () => {
      const node1 = makeImageNode({ id: 'p1', shortcode: 'sc1', caption: 'Same post' });
      const node2 = makeImageNode({ id: 'p2', shortcode: 'sc2', caption: 'Same post' });
      const hash1 = (await instagramProvider.normalizeItem(node1, makeInstance('jjlin'))).contentHash;
      const hash2 = (await instagramProvider.normalizeItem(node2, makeInstance('jjlin'))).contentHash;
      expect(hash1).toBe(hash2);
    });

    it('produces different contentHash for distinct posts', async () => {
      const node1 = makeImageNode({ id: 'p1', shortcode: 'sc1', caption: 'One', takenAt: 1700000000 });
      const node2 = makeImageNode({ id: 'p2', shortcode: 'sc2', caption: 'Two', takenAt: 1700000001 });
      const hash1 = (await instagramProvider.normalizeItem(node1, makeInstance('jjlin'))).contentHash;
      const hash2 = (await instagramProvider.normalizeItem(node2, makeInstance('jjlin'))).contentHash;
      expect(hash1).not.toBe(hash2);
    });

    it('produces different contentHash for the same canonical id with different titles', async () => {
      const node1 = makeImageNode({ id: 'p1', shortcode: 'sc1', caption: 'A' });
      const node2 = makeImageNode({ id: 'p1', shortcode: 'sc1', caption: 'B' });
      const hash1 = (await instagramProvider.normalizeItem(node1, makeInstance('jjlin'))).contentHash;
      const hash2 = (await instagramProvider.normalizeItem(node2, makeInstance('jjlin'))).contentHash;
      expect(hash1).not.toBe(hash2);
    });

    it('produces the same contentHash for the same content with different publishedAt', async () => {
      const node1 = makeImageNode({ id: 'p1', shortcode: 'sc1', caption: 'Same', takenAt: 1700000000 });
      const node2 = makeImageNode({ id: 'p2', shortcode: 'sc2', caption: 'Same', takenAt: 1700000001 });
      const hash1 = (await instagramProvider.normalizeItem(node1, makeInstance('jjlin'))).contentHash;
      const hash2 = (await instagramProvider.normalizeItem(node2, makeInstance('jjlin'))).contentHash;
      expect(hash1).toBe(hash2);
    });

    it('uses context.crypto when provided for contentHash', async () => {
      const node = makeImageNode({ id: 'p1', shortcode: 'sc1', caption: 'Crypto' });
      const digest = vi.fn(async () => new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32]).buffer);
      const crypto = { subtle: { digest } };

      const item = await instagramProvider.normalizeItem(node, makeInstance('jjlin'), { crypto });

      expect(digest).toHaveBeenCalledWith('SHA-256', expect.any(Uint8Array));
      expect(item.contentHash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('buildFeedMeta', () => {
    it('builds feed metadata with the Instagram profile link and no old /rss/ig URL', () => {
      const meta = instagramProvider.buildFeedMeta({ instanceKey: 'jjlin', displayName: 'JJ Lin' });
      expect(meta).toEqual({
        title: 'JJ Lin - Instagram',
        link: 'https://www.instagram.com/jjlin/',
        description: 'Instagram posts from @jjlin',
        language: 'zh-CN'
      });
      expect(meta.link).not.toContain('/rss/ig');
      expect(meta.title).not.toContain('/rss/ig');
      expect(meta.description).not.toContain('/rss/ig');
    });

    it('falls back to instanceKey when displayName is absent', () => {
      const meta = instagramProvider.buildFeedMeta({ instanceKey: 'jjlin' });
      expect(meta.title).toBe('jjlin - Instagram');
    });
  });
});
