import { describe, it, expect, vi } from 'vitest';
import { fetchProfile, validateProfile, probeProfile, IG_HEADERS } from '../../src/generators/providers/instagram/fetcher.js';

const IG_BASE = 'https://www.instagram.com';
const PROFILE_API = `${IG_BASE}/api/v1/users/web_profile_info/`;

function makeIgResponse(body, { status = 200, ok = true } = {}) {
  return Promise.resolve({
    ok,
    status,
    json: () => Promise.resolve(body)
  });
}

function makeJsonErrorResponse(status) {
  return Promise.resolve({ ok: false, status });
}

function makeProfileBody(overrides = {}) {
  return {
    data: {
      user: {
        edge_owner_to_timeline_media: {
          edges: [
            { node: makeImageNode({
              id: 'post_1',
              shortcode: 'A1',
              takenAt: 1700000000,
              displayUrl: 'https://cdn.example.com/1.jpg',
              caption: 'First post'
            }) }
          ]
        }
      }
    },
    ...overrides
  };
}

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

function makeFetch(fn) {
  return vi.fn((...args) => Promise.resolve(fn(...args)));
}

function makeSleep() {
  return vi.fn(() => Promise.resolve());
}

function makeGetRandom() {
  return vi.fn(() => 0);
}

function expectUrlAndHeaders(call) {
  const [url, options] = call;
  expect(url).toBe(`${PROFILE_API}?username=jjlin`);
  expect(options.headers).toEqual(IG_HEADERS);
  expect(options.headers['x-ig-app-id']).toBe('936619743392459');
  expect(options.headers['User-Agent']).toMatch(/Mozilla/);
}

describe('Instagram fetcher characterization (legacy crawler behavior)', () => {
  it('requests the web profile info endpoint with the expected URL and headers', async () => {
    const body = makeProfileBody();
    const fetch = vi.fn(() => makeIgResponse(body));
    const sleep = makeSleep();

    await fetchProfile('jjlin', { fetch, sleep, getRandom: makeGetRandom() });

    expect(fetch).toHaveBeenCalledTimes(1);
    expectUrlAndHeaders(fetch.mock.calls[0]);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('returns mapped posts and source count on a successful fetch', async () => {
    const body = makeProfileBody({
      data: {
        user: {
          edge_owner_to_timeline_media: {
            edges: [
              { node: makeImageNode({ id: 'p1', shortcode: 'sc1', takenAt: 1700000000, displayUrl: 'https://cdn.example.com/a.jpg', caption: 'Hello\nWorld' }) }
            ]
          }
        }
      }
    });
    const fetch = vi.fn(() => makeIgResponse(body));
    const sleep = makeSleep();

    const { posts, meta } = await fetchProfile('jjlin', { fetch, sleep, getRandom: makeGetRandom() });

    expect(meta).toEqual({ sourceCount: 1, emptyReason: '' });
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      id: 'p1',
      title: 'Hello',
      link: 'https://www.instagram.com/p/sc1/',
      image: 'https://cdn.example.com/a.jpg',
      canonical_id: 'p1',
      media_type: 'image'
    });
    expect(posts[0].description).toContain('<img src="https://cdn.example.com/a.jpg" style="max-width:100%">');
    expect(posts[0].description).toContain('<p>Hello<br>World</p>');
    expect(posts[0].date).toBe(new Date(1700000000 * 1000).toISOString());
  });

  it('returns empty posts and no_posts reason when the account has no posts', async () => {
    const body = { data: { user: { edge_owner_to_timeline_media: { edges: [] } } } };
    const fetch = vi.fn(() => makeIgResponse(body));
    const sleep = makeSleep();

    const { posts, meta } = await fetchProfile('jjlin', { fetch, sleep, getRandom: makeGetRandom() });

    expect(posts).toEqual([]);
    expect(meta).toEqual({ sourceCount: 0, emptyReason: 'no_posts' });
  });

  it('throws when the API response has no user data', async () => {
    const body = { data: { user: null } };
    const fetch = vi.fn(() => makeIgResponse(body));
    const sleep = makeSleep();

    await expect(fetchProfile('jjlin', { fetch, sleep, getRandom: makeGetRandom() }))
      .rejects.toThrow('No user data in Instagram API response');
  });

  it('retries on 401 and eventually succeeds', async () => {
    const body = makeProfileBody();
    const fetch = vi.fn(() => {
      if (fetch.mock.calls.length === 1) return makeJsonErrorResponse(401);
      return makeIgResponse(body);
    });
    const sleep = makeSleep();

    await fetchProfile('jjlin', { fetch, sleep, getRandom: makeGetRandom() });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(800);
  });

  it('retries on 403 and eventually succeeds', async () => {
    const body = makeProfileBody();
    const fetch = vi.fn(() => {
      if (fetch.mock.calls.length === 1) return makeJsonErrorResponse(403);
      return makeIgResponse(body);
    });
    const sleep = makeSleep();

    await fetchProfile('jjlin', { fetch, sleep, getRandom: makeGetRandom() });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('retries on 429 and eventually succeeds', async () => {
    const body = makeProfileBody();
    const fetch = vi.fn(() => {
      if (fetch.mock.calls.length < 2) return makeJsonErrorResponse(429);
      return makeIgResponse(body);
    });
    const sleep = makeSleep();

    await fetchProfile('jjlin', { fetch, sleep, getRandom: makeGetRandom() });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('retries on 5xx statuses and eventually succeeds', async () => {
    const body = makeProfileBody();
    const fetch = vi.fn(() => {
      if (fetch.mock.calls.length < 2) return makeJsonErrorResponse(503);
      return makeIgResponse(body);
    });
    const sleep = makeSleep();

    await fetchProfile('jjlin', { fetch, sleep, getRandom: makeGetRandom() });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('throws after exhausting retries on 429', async () => {
    const fetch = vi.fn(() => makeJsonErrorResponse(429));
    const sleep = makeSleep();

    await expect(fetchProfile('jjlin', { fetch, sleep, getRandom: makeGetRandom() }))
      .rejects.toThrow('Instagram API HTTP 429');

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 800);
    expect(sleep).toHaveBeenNthCalledWith(2, 1600);
  });

  it('does not retry non-retryable HTTP errors', async () => {
    const fetch = vi.fn(() => makeJsonErrorResponse(404));
    const sleep = makeSleep();

    await expect(fetchProfile('jjlin', { fetch, sleep, getRandom: makeGetRandom() }))
      .rejects.toThrow('Instagram API HTTP 404');

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('throws on malformed JSON response', async () => {
    const fetch = vi.fn(() => Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.reject(new SyntaxError('Unexpected token'))
    }));
    const sleep = makeSleep();

    await expect(fetchProfile('jjlin', { fetch, sleep, getRandom: makeGetRandom() }))
      .rejects.toThrow(SyntaxError);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('validateProfile returns username and source count', async () => {
    const body = makeProfileBody({
      data: {
        user: {
          edge_owner_to_timeline_media: {
            edges: [
              { node: makeImageNode({ id: 'p1' }) },
              { node: makeImageNode({ id: 'p2' }) }
            ]
          }
        }
      }
    });
    const fetch = vi.fn(() => makeIgResponse(body));

    const result = await validateProfile('jjlin', { fetch, sleep: makeSleep(), getRandom: makeGetRandom() });

    expect(result).toEqual({ username: 'jjlin', sourceCount: 2 });
  });

  it('probeProfile returns ok status and source count without retrying', async () => {
    const body = makeProfileBody({
      data: {
        user: {
          edge_owner_to_timeline_media: {
            edges: [
              { node: makeImageNode({ id: 'p1' }) },
              { node: makeImageNode({ id: 'p2' }) },
              { node: makeImageNode({ id: 'p3' }) }
            ]
          }
        }
      }
    });
    const fetch = vi.fn(() => makeIgResponse(body));
    const sleep = makeSleep();

    const result = await probeProfile('jjlin', { fetch, sleep, getRandom: makeGetRandom() });

    expect(result).toEqual({ ok: true, status: 200, sourceCount: 3 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('probeProfile reports HTTP failure without retry', async () => {
    const fetch = vi.fn(() => makeJsonErrorResponse(403));
    const sleep = makeSleep();

    const result = await probeProfile('jjlin', { fetch, sleep, getRandom: makeGetRandom() });

    expect(result).toEqual({ ok: false, status: 403, sourceCount: null, error: 'Instagram API HTTP 403' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('probeProfile reports parse error on malformed JSON', async () => {
    const fetch = vi.fn(() => Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.reject(new SyntaxError('Unexpected token'))
    }));
    const sleep = makeSleep();

    const result = await probeProfile('jjlin', { fetch, sleep, getRandom: makeGetRandom() });

    expect(result).toMatchObject({ ok: false, status: 200, sourceCount: null, parseError: true });
    expect(result.error).toBe('Failed to parse Instagram response');
    expect(sleep).not.toHaveBeenCalled();
  });

  it('probeProfile reports missing user data with sourceCount 0', async () => {
    const fetch = vi.fn(() => makeIgResponse({ data: { user: null } }));
    const sleep = makeSleep();

    const result = await probeProfile('jjlin', { fetch, sleep, getRandom: makeGetRandom() });

    expect(result).toEqual({ ok: false, status: 200, sourceCount: 0, error: 'No user data in Instagram API response' });
  });

  it('maps a single image post correctly', async () => {
    const node = makeImageNode({
      id: 'single_img',
      shortcode: 'single1',
      takenAt: 1700000000,
      displayUrl: 'https://cdn.example.com/single.jpg',
      caption: 'Single image'
    });
    const body = { data: { user: { edge_owner_to_timeline_media: { edges: [{ node }] } } } };
    const fetch = vi.fn(() => makeIgResponse(body));

    const { posts } = await fetchProfile('jjlin', { fetch, sleep: makeSleep(), getRandom: makeGetRandom() });

    expect(posts[0]).toMatchObject({
      id: 'single_img',
      canonical_id: 'single_img',
      title: 'Single image',
      link: 'https://www.instagram.com/p/single1/',
      image: 'https://cdn.example.com/single.jpg',
      media_type: 'image'
    });
    expect(posts[0].description).toContain('<img src="https://cdn.example.com/single.jpg" style="max-width:100%">');
    expect(posts[0].description).toContain('<p>Single image</p>');
  });

  it('maps a single video post correctly', async () => {
    const node = makeVideoNode({
      id: 'single_vid',
      shortcode: 'v1',
      takenAt: 1700000001,
      displayUrl: 'https://cdn.example.com/poster.jpg',
      videoUrl: 'https://cdn.example.com/clip.mp4',
      caption: 'My video'
    });
    const body = { data: { user: { edge_owner_to_timeline_media: { edges: [{ node }] } } } };
    const fetch = vi.fn(() => makeIgResponse(body));

    const { posts } = await fetchProfile('jjlin', { fetch, sleep: makeSleep(), getRandom: makeGetRandom() });

    expect(posts[0]).toMatchObject({
      id: 'single_vid',
      canonical_id: 'single_vid',
      title: 'My video',
      link: 'https://www.instagram.com/p/v1/',
      image: 'https://cdn.example.com/poster.jpg',
      media_type: 'video'
    });
    expect(posts[0].description).toContain('<video controls poster="https://cdn.example.com/poster.jpg"><source src="https://cdn.example.com/clip.mp4" type="video/mp4"></video>');
  });

  it('maps a sidecar post with images and videos', async () => {
    const child1 = makeImageNode({ id: 'c1', shortcode: 'c1', displayUrl: 'https://cdn.example.com/child1.jpg', caption: '' });
    const child2 = makeVideoNode({ id: 'c2', shortcode: 'c2', displayUrl: 'https://cdn.example.com/child2.jpg', videoUrl: 'https://cdn.example.com/child2.mp4', caption: '' });
    const node = makeImageNode({
      id: 'sidecar_1',
      shortcode: 'sc1',
      takenAt: 1700000002,
      displayUrl: 'https://cdn.example.com/parent.jpg',
      caption: 'Sidecar post',
      children: [child1, child2]
    });
    const body = { data: { user: { edge_owner_to_timeline_media: { edges: [{ node }] } } } };
    const fetch = vi.fn(() => makeIgResponse(body));

    const { posts } = await fetchProfile('jjlin', { fetch, sleep: makeSleep(), getRandom: makeGetRandom() });

    expect(posts[0]).toMatchObject({
      id: 'sidecar_1',
      canonical_id: 'sidecar_1',
      title: 'Sidecar post',
      link: 'https://www.instagram.com/p/sc1/',
      image: 'https://cdn.example.com/parent.jpg',
      media_type: 'image'
    });
    expect(posts[0].description).toContain('<img src="https://cdn.example.com/child1.jpg" style="max-width:100%">');
    expect(posts[0].description).toContain('<video controls poster="https://cdn.example.com/child2.jpg"><source src="https://cdn.example.com/child2.mp4" type="video/mp4"></video>');
    expect(posts[0].description).toContain('<p>Sidecar post</p>');
  });

  it('escapes caption HTML and converts newlines', async () => {
    const node = makeImageNode({
      id: 'escape_1',
      shortcode: 'esc1',
      takenAt: 1700000000,
      displayUrl: 'https://cdn.example.com/e.jpg',
      caption: 'R&B & Rock <3\nLine 2'
    });
    const body = { data: { user: { edge_owner_to_timeline_media: { edges: [{ node }] } } } };
    const fetch = vi.fn(() => makeIgResponse(body));

    const { posts } = await fetchProfile('jjlin', { fetch, sleep: makeSleep(), getRandom: makeGetRandom() });

    expect(posts[0].title).toBe('R&B & Rock <3');
    expect(posts[0].description).toContain('<p>R&amp;B &amp; Rock &lt;3<br>Line 2</p>');
  });

  it('falls back to @username post title when caption is empty', async () => {
    const node = makeImageNode({ id: 'no_caption', shortcode: 'nc1', caption: '' });
    const body = { data: { user: { edge_owner_to_timeline_media: { edges: [{ node }] } } } };
    const fetch = vi.fn(() => makeIgResponse(body));

    const { posts } = await fetchProfile('jjlin', { fetch, sleep: makeSleep(), getRandom: makeGetRandom() });

    expect(posts[0].title).toBe('@jjlin post');
  });

  it('fails fast when fetch is not a function', async () => {
    const body = makeProfileBody();
    const fetch = 'not-a-function';

    await expect(fetchProfile('jjlin', { fetch, sleep: makeSleep(), getRandom: makeGetRandom() }))
      .rejects.toThrow('fetch must be a function');
  });

  it('fails fast when sleep is not a function', async () => {
    const body = makeProfileBody();
    const fetch = vi.fn(() => makeIgResponse(body));

    await expect(fetchProfile('jjlin', { fetch, sleep: 'not-a-sleep', getRandom: makeGetRandom() }))
      .rejects.toThrow('sleep must be a function');
  });

  it('fails fast when getRandom is not a function', async () => {
    const body = makeProfileBody();
    const fetch = vi.fn(() => makeIgResponse(body));

    await expect(fetchProfile('jjlin', { fetch, sleep: makeSleep(), getRandom: 'not-a-function' }))
      .rejects.toThrow('getRandom must be a function');
  });

  it('fails fast when maxAttempts is not a positive integer', async () => {
    const body = makeProfileBody();
    const fetch = vi.fn(() => makeIgResponse(body));

    await expect(fetchProfile('jjlin', { fetch, sleep: makeSleep(), getRandom: makeGetRandom(), maxAttempts: 0 }))
      .rejects.toThrow('maxAttempts must be a positive integer');
    await expect(fetchProfile('jjlin', { fetch, sleep: makeSleep(), getRandom: makeGetRandom(), maxAttempts: '3' }))
      .rejects.toThrow('maxAttempts must be a positive integer');
    await expect(fetchProfile('jjlin', { fetch, sleep: makeSleep(), getRandom: makeGetRandom(), maxAttempts: -1 }))
      .rejects.toThrow('maxAttempts must be a positive integer');
  });

  it('does not retry when maxAttempts is set to 1', async () => {
    const body = makeProfileBody();
    const fetch = vi.fn(() => makeJsonErrorResponse(429));
    const sleep = makeSleep();

    await expect(fetchProfile('jjlin', { fetch, sleep, getRandom: makeGetRandom(), maxAttempts: 1 }))
      .rejects.toThrow('Instagram API HTTP 429');

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
