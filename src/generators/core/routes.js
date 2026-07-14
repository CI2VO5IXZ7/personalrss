import { Hono } from 'hono';
import { redactText } from '../../security/url.js';
import { logError } from '../../log.js';

export function createGeneratorRouter(service) {
  const router = new Hono();

  router.get('/feeds/:id', async (c) => {
    const param = c.req.param('id');
    if (!param.endsWith('.xml')) {
      return c.text('Not Found', 404);
    }

    const idParam = param.slice(0, -4);
    if (!/^[1-9]\d*$/.test(idParam)) {
      return c.text('Not Found', 404);
    }

    const id = parseInt(idParam, 10);
    const db = c.env?.DB;
    if (!db) {
      return c.text('Internal Server Error', 500);
    }

    const feedUrl = c.req.url;

    try {
      const feedXml = await service.getFeed(db, id, feedUrl);
      if (feedXml === null) {
        return c.text('Not Found', 404);
      }

      c.header('Content-Type', 'application/rss+xml; charset=utf-8');
      c.header('Cache-Control', 'public, max-age=600');
      return c.body(feedXml);
    } catch (err) {
      const cleanError = redactText(err.message || String(err));
      logError('generator.route_failed', {
        id,
        error: cleanError
      });
      return c.text('Internal Server Error', 500);
    }
  });

  return router;
}
