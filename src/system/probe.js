import { Hono } from 'hono';
import { requireAdmin } from '../telegram/auth.js';
import { redactText } from '../security/url.js';
import { logInfo, logWarn } from '../log.js';
import { normalizeSymbol } from '../monitors/providers/stock/index.js';

export function createProbeRouter({ monitorService }) {
  const router = new Hono();

  router.get('/admin/probe-stock', async (c) => {
    const unauthorized = requireAdmin(c);
    if (unauthorized) return unauthorized;

    const codeQuery = (c.req.query('code') || '').trim();
    const colo = c.req.raw.cf?.colo || null;
    const ray = c.req.header('cf-ray') || null;

    if (!codeQuery) {
      return c.json({ ok: false, error: 'missing code', colo, ray, timestamp: new Date().toISOString() }, 400);
    }

    const normalizedCode = normalizeSymbol(codeQuery);
    if (!normalizedCode) {
      return c.json({ ok: false, error: 'invalid symbol format', colo, ray, timestamp: new Date().toISOString() }, 400);
    }

    logInfo('probe.stock.start', { code: normalizedCode, colo });
    const startedAt = Date.now();

    try {
      const quote = await monitorService.getQuote(c.env.DB, normalizedCode, {
        fetchFn: fetch,
        relativeTo: new Date()
      });
      const durationMs = Date.now() - startedAt;
      logInfo('probe.stock.finish', { code: normalizedCode, colo, durationMs });
      return c.json({
        ok: true,
        code: quote.symbol,
        quote: {
          latestPrice: quote.price,
          yesterdayClose: quote.yesterdayClose,
          observedAt: quote.observedAt,
          source: quote.source
        },
        durationMs,
        colo,
        placement: c.req.raw.cf?.placement || null,
        ray,
        timestamp: new Date().toISOString()
      });
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      const error = redactText(err?.message || 'probe failed');
      logWarn('probe.stock.failure', { code: normalizedCode, colo, durationMs, error });
      return c.json({
        ok: false,
        code: normalizedCode,
        error,
        durationMs,
        colo,
        placement: c.req.raw.cf?.placement || null,
        ray,
        timestamp: new Date().toISOString()
      });
    }
  });

  return router;
}
