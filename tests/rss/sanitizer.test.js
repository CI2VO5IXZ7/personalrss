import { describe, it, expect } from 'vitest';
import { extractArticleText } from '../../src/rss/sanitizer.js';

describe('Article Text Extractor', () => {
  it('should strip scripts, styles, navs and other noise', () => {
    const html = `
      <html>
        <head>
          <style>body { color: red; }</style>
          <script>console.log("hello");</script>
        </head>
        <body>
          <nav>
            <a href="/">Home</a>
          </nav>
          <article>
            <h1>Main Title</h1>
            <p>First paragraph with &lt;strong&gt;bold text&lt;/strong&gt; &amp; entities.</p>
            <div>Second paragraph.<br>With line break.</div>
          </article>
          <footer>Footer info</footer>
        </body>
      </html>
    `;

    const text = extractArticleText(html);
    expect(text).toContain('Main Title');
    expect(text).toContain('First paragraph with bold text & entities.');
    expect(text).toContain('Second paragraph.\nWith line break.');
    expect(text).not.toContain('color: red');
    expect(text).not.toContain('console.log');
    expect(text).not.toContain('Home');
    expect(text).not.toContain('Footer info');
  });

  it('should bound output text to 10000 characters', () => {
    const longHtml = '<div>' + 'A'.repeat(12000) + '</div>';
    const text = extractArticleText(longHtml);
    expect(text.length).toBe(10000);
  });
});
