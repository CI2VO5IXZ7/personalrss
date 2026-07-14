import { describe, it, expect } from 'vitest';
import { renderRssFeed } from '../../src/generators/core/renderer.js';

function parseXml(xml) {
  // Lightweight parser: enough to extract key fields for these tests.
  const dom = {};
  dom.channel = {
    title: extractTag(xml, 'title'),
    link: extractTag(xml, 'link'),
    description: extractTag(xml, 'description'),
    atomLink: extractAttr(xml, 'atom:link', 'href'),
    lastBuildDate: extractTag(xml, 'lastBuildDate'),
    items: extractItems(xml)
  };
  return dom;
}

function extractTag(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}(?:[^>]*)>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`));
  return match ? match[1].trim() : null;
}

function extractAttr(xml, tag, attr) {
  const match = xml.match(new RegExp(`<${tag}[^>]*\\s${attr}="([^"]+)"`));
  return match ? match[1] : null;
}

function extractItems(xml) {
  const items = [];
  const regex = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = regex.exec(xml)) !== null) {
    const item = m[1];
    items.push({
      title: extractTag(item, 'title'),
      link: extractTag(item, 'link'),
      guid: extractAttr(item, 'guid', 'isPermaLink') === null ? extractTag(item, 'guid') : extractTag(item, 'guid'),
      guidPermaLink: extractAttr(item, 'guid', 'isPermaLink'),
      pubDate: extractTag(item, 'pubDate'),
      description: extractTag(item, 'description'),
      contentEncoded: extractTag(item, 'content:encoded'),
      enclosureUrl: extractAttr(item, 'enclosure', 'url'),
      enclosureType: extractAttr(item, 'enclosure', 'type')
    });
  }
  return items;
}

const feedMeta = {
  title: 'Test Feed',
  link: 'https://example.com/source',
  description: 'A test feed'
};

function makeItem(overrides = {}, index = 0) {
  return {
    itemKey: `item-${index}`,
    canonicalId: `canonical-${index}`,
    contentHash: `hash-${index}`,
    title: `Post ${index}`,
    descriptionHtml: `<p>Body ${index}</p>`,
    link: `https://example.com/post/${index}`,
    publishedAt: new Date(Date.UTC(2026, 6, 14, 3, 0, index)),
    mediaType: 'image',
    imageUrl: `https://example.com/img/${index}.jpg`,
    rawImages: [`https://example.com/img/${index}.jpg`],
    ...overrides
  };
}

describe('Generic RSS 2.0 Renderer', () => {
  it('renders feed metadata and self URL', () => {
    const feedUrl = 'https://worker.example.com/feeds/3.xml';
    const xml = renderRssFeed(feedMeta, [makeItem()], feedUrl);
    const parsed = parseXml(xml);

    expect(xml).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>/);
    expect(parsed.channel.title).toBe('Test Feed');
    expect(parsed.channel.link).toBe('https://example.com/source');
    expect(parsed.channel.description).toBe('A test feed');
    expect(parsed.channel.atomLink).toBe(feedUrl);
    expect(xml).toContain('xmlns:content=');
    expect(xml).toContain('xmlns:atom=');
  });

  it('renders an item with guid, RFC822 pubDate, and isPermaLink=false', () => {
    const xml = renderRssFeed(feedMeta, [makeItem()], 'https://worker.example.com/feeds/3.xml');
    const parsed = parseXml(xml);
    const item = parsed.channel.items[0];

    expect(item.title).toBe('Post 0');
    expect(item.link).toBe('https://example.com/post/0');
    expect(item.guid).toBe('canonical-0');
    expect(item.guidPermaLink).toBe('false');
    expect(item.pubDate).toMatch(/^\w{3}, \d{2} \w{3} \d{4} \d{2}:\d{2}:\d{2} \+0800$/);
    expect(item.description).toBe(`Body 0`);
    expect(item.contentEncoded).toBe('<p>Body 0</p>');
  });

  it('escapes XML in link and description summary', () => {
    const item = makeItem({
      link: 'https://example.com/post?a=1&b=2',
      descriptionHtml: '<p>Hello & <b>world</b></p>',
      title: 'Title with <tag>'
    });
    const xml = renderRssFeed(feedMeta, [item], 'https://worker.example.com/feeds/3.xml');

    expect(xml).toContain('https://example.com/post?a=1&amp;b=2');
    expect(xml).toContain('Hello &amp; world');
    expect(xml).toContain('<title><![CDATA[Title with <tag>]]></title>');
  });

  it('keeps CDATA safe when content contains the CDATA terminator', () => {
    const item = makeItem({
      title: 'Alert ]]> end',
      descriptionHtml: '<script>if (x) { "]]>" }</script>'
    });
    const xml = renderRssFeed(feedMeta, [item], 'https://worker.example.com/feeds/3.xml');

    expect(xml).toContain('Alert ]]]]><![CDATA[> end');
    expect(xml).toContain('<script>if (x) { "]]]]><![CDATA[>" }</script>');
  });

  it('renders an image enclosure', () => {
    const item = makeItem({
      imageUrl: 'https://cdn.example.com/photo.jpg',
      rawImages: ['https://cdn.example.com/photo.jpg']
    });
    const xml = renderRssFeed(feedMeta, [item], 'https://worker.example.com/feeds/3.xml');
    const parsed = parseXml(xml);

    expect(parsed.channel.items[0].enclosureUrl).toBe('https://worker.example.com/img?url=https%3A%2F%2Fcdn.example.com%2Fphoto.jpg');
    expect(parsed.channel.items[0].enclosureType).toBe('image/jpeg');
  });

  it('renders a video enclosure from a source tag in descriptionHtml', () => {
    const item = makeItem({
      mediaType: 'video',
      descriptionHtml: '<video controls poster="https://cdn.example.com/poster.jpg"><source src="https://cdn.example.com/video.mp4" type="video/mp4"></video>',
      imageUrl: 'https://cdn.example.com/poster.jpg'
    });
    const xml = renderRssFeed(feedMeta, [item], 'https://worker.example.com/feeds/3.xml');
    const parsed = parseXml(xml);

    expect(parsed.channel.items[0].enclosureUrl).toBe('https://worker.example.com/media?url=https%3A%2F%2Fcdn.example.com%2Fvideo.mp4');
    expect(parsed.channel.items[0].enclosureType).toBe('video/mp4');
  });

  it('falls back to image enclosure when video source tag is missing', () => {
    const item = makeItem({
      mediaType: 'video',
      descriptionHtml: '<p>Just a caption</p>',
      imageUrl: 'https://cdn.example.com/poster.jpg'
    });
    const xml = renderRssFeed(feedMeta, [item], 'https://worker.example.com/feeds/3.xml');
    const parsed = parseXml(xml);

    expect(parsed.channel.items[0].enclosureType).toBe('image/jpeg');
    expect(parsed.channel.items[0].enclosureUrl).toBe('https://worker.example.com/img?url=https%3A%2F%2Fcdn.example.com%2Fposter.jpg');
  });

  it('limits output to the 50 most recent items', () => {
    const items = Array.from({ length: 60 }, (_, i) => makeItem({
      itemKey: `item-${i}`,
      canonicalId: `canonical-${i}`,
      publishedAt: new Date(Date.UTC(2026, 6, 14, 3, 0, i))
    }, i));
    const xml = renderRssFeed(feedMeta, items, 'https://worker.example.com/feeds/3.xml');
    const parsed = parseXml(xml);

    expect(parsed.channel.items).toHaveLength(50);
    expect(parsed.channel.items[0].guid).toBe('canonical-59');
    expect(parsed.channel.items[49].guid).toBe('canonical-10');
  });

  it('sorts unsorted items by publishedAt descending', () => {
    const items = [
      makeItem({ itemKey: 'a', canonicalId: 'a', publishedAt: new Date(Date.UTC(2026, 6, 14, 1, 0, 0)) }, 1),
      makeItem({ itemKey: 'c', canonicalId: 'c', publishedAt: new Date(Date.UTC(2026, 6, 14, 3, 0, 0)) }, 3),
      makeItem({ itemKey: 'b', canonicalId: 'b', publishedAt: new Date(Date.UTC(2026, 6, 14, 2, 0, 0)) }, 2)
    ];
    const xml = renderRssFeed(feedMeta, items, 'https://worker.example.com/feeds/3.xml');
    const parsed = parseXml(xml);

    expect(parsed.channel.items.map(i => i.guid)).toEqual(['c', 'b', 'a']);
  });

  it('renders image tags from rawImages when descriptionHtml is empty', () => {
    const item = makeItem({
      descriptionHtml: '',
      rawImages: ['https://cdn.example.com/1.jpg', 'https://cdn.example.com/2.jpg']
    });
    const xml = renderRssFeed(feedMeta, [item], 'https://worker.example.com/feeds/3.xml');
    const parsed = parseXml(xml);

    expect(parsed.channel.items[0].contentEncoded).toContain('https://worker.example.com/img?url=https%3A%2F%2Fcdn.example.com%2F1.jpg');
    expect(parsed.channel.items[0].contentEncoded).toContain('https://worker.example.com/img?url=https%3A%2F%2Fcdn.example.com%2F2.jpg');
  });

  it('requires feedMeta to be a plain object, items to be an array, and feedUrl to be an absolute http/https URL', () => {
    expect(() => renderRssFeed(null, [], 'https://worker.example.com/feeds/3.xml')).toThrow(/feedMeta/);
    expect(() => renderRssFeed([], [], 'https://worker.example.com/feeds/3.xml')).toThrow(/feedMeta/);
    expect(() => renderRssFeed(feedMeta, 'not-array', 'https://worker.example.com/feeds/3.xml')).toThrow(/items/);
    expect(() => renderRssFeed(feedMeta, [], '/relative')).toThrow(/feedUrl/);
    expect(() => renderRssFeed(feedMeta, [], 'ftp://example.com/feed.xml')).toThrow(/feedUrl/);
    expect(() => renderRssFeed(feedMeta, [], 'not a url')).toThrow(/feedUrl/);
    expect(() => renderRssFeed(feedMeta, [], '')).toThrow(/feedUrl/);

    const xml = renderRssFeed(feedMeta, [], 'https://worker.example.com/feeds/3.xml');
    expect(xml).toContain('https://worker.example.com/feeds/3.xml');
  });

  it('falls back to link then itemKey for guid and never leaves it empty', () => {
    const item = makeItem({
      itemKey: 'fallback-key',
      canonicalId: '',
      link: '',
      publishedAt: undefined
    });
    const xml = renderRssFeed(feedMeta, [item], 'https://worker.example.com/feeds/3.xml');
    const parsed = parseXml(xml);

    expect(parsed.channel.items[0].guid).toBe('fallback-key');
    expect(parsed.channel.items[0].guidPermaLink).toBe('false');
  });

  it('falls back to link when canonicalId is empty', () => {
    const item = makeItem({
      canonicalId: '',
      link: 'https://example.com/post/link-only'
    });
    const xml = renderRssFeed(feedMeta, [item], 'https://worker.example.com/feeds/3.xml');
    const parsed = parseXml(xml);

    expect(parsed.channel.items[0].guid).toBe('https://example.com/post/link-only');
    expect(parsed.channel.items[0].link).toBe('https://example.com/post/link-only');
  });

  it('omits the link element when link is empty or whitespace-only', () => {
    const item = makeItem({
      canonicalId: 'no-link',
      link: '   ',
      publishedAt: undefined
    });
    const xml = renderRssFeed(feedMeta, [item], 'https://worker.example.com/feeds/3.xml');
    const parsed = parseXml(xml);

    expect(parsed.channel.items[0].guid).toBe('no-link');
    expect(parsed.channel.items[0].link).toBeNull();
    expect(xml).not.toMatch(/<item>\s*<title>.*?<\/title>\s*<link>/);
  });

  it('omits pubDate when publishedAt is missing and does not fake current time', () => {
    const item = makeItem({
      itemKey: 'no-date',
      publishedAt: undefined
    });
    const xml = renderRssFeed(feedMeta, [item], 'https://worker.example.com/feeds/3.xml');
    const parsed = parseXml(xml);

    expect(parsed.channel.items[0].pubDate).toBeNull();
    expect(parsed.channel.lastBuildDate).not.toBeNull();
  });

  it('omits pubDate for invalid publishedAt values instead of using the current time', () => {
    const item = makeItem({
      itemKey: 'invalid-date',
      publishedAt: 'not a date'
    });
    const xml = renderRssFeed(feedMeta, [item], 'https://worker.example.com/feeds/3.xml');
    const parsed = parseXml(xml);

    expect(parsed.channel.items[0].pubDate).toBeNull();
  });

  it('sorts items without a date after items with a date and preserves stable order', () => {
    const items = [
      makeItem({ itemKey: 'a', canonicalId: 'a', publishedAt: new Date(Date.UTC(2026, 6, 14, 1, 0, 0)) }, 0),
      makeItem({ itemKey: 'b', canonicalId: 'b', publishedAt: undefined }, 1),
      makeItem({ itemKey: 'c', canonicalId: 'c', publishedAt: new Date(Date.UTC(2026, 6, 14, 3, 0, 0)) }, 2),
      makeItem({ itemKey: 'd', canonicalId: 'd', publishedAt: undefined }, 3)
    ];
    const xml = renderRssFeed(feedMeta, items, 'https://worker.example.com/feeds/3.xml');
    const parsed = parseXml(xml);

    expect(parsed.channel.items.map(i => i.guid)).toEqual(['c', 'a', 'b', 'd']);
  });

  it('skips empty or non-string raw media URLs when building content and enclosure', () => {
    const item = makeItem({
      descriptionHtml: '',
      imageUrl: '   ',
      rawImages: ['', 'https://cdn.example.com/valid.jpg', '   ', 123, null]
    });
    const xml = renderRssFeed(feedMeta, [item], 'https://worker.example.com/feeds/3.xml');
    const parsed = parseXml(xml);

    expect(parsed.channel.items[0].contentEncoded).toContain('https://worker.example.com/img?url=https%3A%2F%2Fcdn.example.com%2Fvalid.jpg');
    expect(parsed.channel.items[0].enclosureUrl).toBe('https://worker.example.com/img?url=https%3A%2F%2Fcdn.example.com%2Fvalid.jpg');
  });

  it('falls back to the first non-empty rawImage when imageUrl is empty or whitespace', () => {
    const item = makeItem({
      descriptionHtml: '',
      imageUrl: '   ',
      rawImages: ['   ', 'https://cdn.example.com/fallback.jpg', '']
    });
    const xml = renderRssFeed(feedMeta, [item], 'https://worker.example.com/feeds/3.xml');
    const parsed = parseXml(xml);

    expect(parsed.channel.items[0].contentEncoded).toContain('https://worker.example.com/img?url=https%3A%2F%2Fcdn.example.com%2Ffallback.jpg');
    expect(parsed.channel.items[0].enclosureUrl).toBe('https://worker.example.com/img?url=https%3A%2F%2Fcdn.example.com%2Ffallback.jpg');
  });
});
