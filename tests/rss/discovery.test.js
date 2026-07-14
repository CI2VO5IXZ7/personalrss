import { describe, it, expect } from 'vitest';
import { discoverFeeds } from '../../src/rss/discovery.js';

describe('RSS Discovery', () => {
  it('should discover RSS feeds from HTML alternate link tags', () => {
    const html = `
      <html>
        <head>
          <link rel="alternate" type="application/rss+xml" title="RSS Feed" href="/feed.xml">
          <link rel="alternate" type="application/atom+xml" title="Atom Feed" href="https://example.com/atom.xml">
          <link rel="stylesheet" href="/style.css">
        </head>
        <body>Hello</body>
      </html>
    `;
    const feeds = discoverFeeds(html, 'https://example.com/blog/');
    expect(feeds).toHaveLength(2);
    expect(feeds[0]).toEqual({
      url: 'https://example.com/feed.xml',
      title: 'RSS Feed',
      type: 'application/rss+xml'
    });
    expect(feeds[1]).toEqual({
      url: 'https://example.com/atom.xml',
      title: 'Atom Feed',
      type: 'application/atom+xml'
    });
  });
});
