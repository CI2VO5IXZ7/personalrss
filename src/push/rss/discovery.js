export function discoverFeeds(htmlContent, baseUrl) {
  const feeds = [];
  const linkRegex = /<link\s+([^>]+)>/gi;
  let match;
  while ((match = linkRegex.exec(htmlContent)) !== null) {
    const attrsStr = match[1];

    // Extract attributes rel, href, type, title safely
    const relMatch = attrsStr.match(/rel=["']([^"']*)["']/i);
    const hrefMatch = attrsStr.match(/href=["']([^"']*)["']/i);
    const typeMatch = attrsStr.match(/type=["']([^"']*)["']/i);
    const titleMatch = attrsStr.match(/title=["']([^"']*)["']/i);

    if (relMatch && hrefMatch) {
      const rel = relMatch[1].toLowerCase().trim();
      const href = hrefMatch[1].trim();
      const type = typeMatch ? typeMatch[1].toLowerCase().trim() : '';
      const title = titleMatch ? titleMatch[1].trim() : '';

      if (
        rel === 'alternate' &&
        (type.includes('rss+xml') ||
         type.includes('atom+xml') ||
         type.includes('xml') ||
         href.match(/\.(rss|xml|atom)$/i))
      ) {
        try {
          const absoluteUrl = new URL(href, baseUrl).toString();
          feeds.push({
            url: absoluteUrl,
            title: title || '',
            type: type || (href.match(/\.atom$/i) ? 'application/atom+xml' : 'application/rss+xml')
          });
        } catch (e) {
          // ignore invalid URLs
        }
      }
    }
  }
  return feeds;
}
