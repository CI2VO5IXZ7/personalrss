import { describe, it, expect } from 'vitest';
import { parseFeed } from '../../src/rss/parser.js';

describe('RSS/Atom Parser', () => {
  it('should parse a standard RSS 2.0 feed', async () => {
    const xml = `
      <rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/">
        <channel>
          <title>Test RSS Feed</title>
          <link>https://example.com</link>
          <description>A test feed</description>
          <item>
            <title>Test Item 1</title>
            <link>https://example.com/item1</link>
            <guid isPermaLink="false">guid-111</guid>
            <pubDate>Mon, 13 Jul 2026 14:00:00 GMT</pubDate>
            <description>Hello world from item 1</description>
            <media:content url="https://example.com/image1.jpg" medium="image" />
          </item>
          <item>
            <title>Test Item 2</title>
            <link>https://example.com/item2</link>
            <guid>https://example.com/item2</guid>
            <pubDate>Mon, 13 Jul 2026 14:15:00 GMT</pubDate>
            <description>&lt;p&gt;HTML description&lt;/p&gt;&lt;img src="https://example.com/image2.png" /&gt;</description>
          </item>
        </channel>
      </rss>
    `;

    const feed = await parseFeed(xml, 'sub-999');

    expect(feed.title).toBe('Test RSS Feed');
    expect(feed.siteUrl).toBe('https://example.com');
    expect(feed.entries).toHaveLength(2);

    // Entry 1
    const entry1 = feed.entries[0];
    expect(entry1.title).toBe('Test Item 1');
    expect(entry1.link).toBe('https://example.com/item1');
    expect(entry1.guid).toBe('guid-111');
    expect(entry1.entryKey).toBe('guid-111');
    expect(new Date(entry1.publishedAt).toISOString()).toBe('2026-07-13T14:00:00.000Z');
    expect(entry1.imageUrl).toBe('https://example.com/image1.jpg');
    expect(entry1.content).toBe('Hello world from item 1');

    // Entry 2
    const entry2 = feed.entries[1];
    expect(entry2.title).toBe('Test Item 2');
    expect(entry2.link).toBe('https://example.com/item2');
    expect(entry2.guid).toBe('https://example.com/item2');
    expect(entry2.entryKey).toBe('https://example.com/item2');
    expect(entry2.imageUrl).toBe('https://example.com/image2.png');
  });

  it('should parse a standard Atom feed', async () => {
    const xml = `
      <feed xmlns="http://www.w3.org/2005/Atom">
        <title>Test Atom Feed</title>
        <link href="https://example.com"/>
        <updated>2026-07-13T14:30:00Z</updated>
        <entry>
          <title>Atom Entry 1</title>
          <link href="https://example.com/entry1" rel="alternate"/>
          <id>urn:uuid:12345</id>
          <published>2026-07-13T14:10:00Z</published>
          <summary>Brief summary</summary>
          <content type="html">&lt;div&gt;&lt;img src="https://example.com/atom1.jpg"&gt;Content&lt;/div&gt;</content>
        </entry>
      </feed>
    `;

    const feed = await parseFeed(xml, 'sub-888');

    expect(feed.title).toBe('Test Atom Feed');
    expect(feed.siteUrl).toBe('https://example.com');
    expect(feed.entries).toHaveLength(1);

    const entry = feed.entries[0];
    expect(entry.title).toBe('Atom Entry 1');
    expect(entry.link).toBe('https://example.com/entry1');
    expect(entry.guid).toBe('urn:uuid:12345');
    expect(entry.entryKey).toBe('urn:uuid:12345');
    expect(entry.imageUrl).toBe('https://example.com/atom1.jpg');
    expect(entry.content).toBe('Brief summary');
  });

  it('should generate deterministic hash-based entryKey when guid and link are missing', async () => {
    const xml = `
      <rss version="2.0">
        <channel>
          <title>Hash Feed</title>
          <item>
            <title>No Identifiers</title>
            <pubDate>Mon, 13 Jul 2026 14:00:00 GMT</pubDate>
            <description>No link and no guid</description>
          </item>
        </channel>
      </rss>
    `;

    const feed = await parseFeed(xml, 'sub-777');
    expect(feed.entries).toHaveLength(1);
    const entry = feed.entries[0];
    expect(entry.guid).toBe('');
    expect(entry.link).toBe('');
    expect(entry.entryKey).toMatch(/^[a-f0-9]{64}$/); // SHA-256 hex
  });

  it('should hash normalized title and content stably while leaving meaningless content hashes empty', async () => {
    const meaningfulXml = `
      <rss version="2.0"><channel><title>Feed</title>
        <item><guid>one</guid><title> Same   article </title><description>Body\n text</description></item>
        <item><guid>two</guid><title>Same article</title><description> Body text </description></item>
        <item><guid>blank</guid></item>
      </channel></rss>`;

    const feed = await parseFeed(meaningfulXml, 'sub-1');

    expect(feed.entries[0].contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(feed.entries[1].contentHash).toBe(feed.entries[0].contentHash);
    expect(feed.entries[2].contentHash).toBe('');
  });
});
