// 图片与媒体代理

import { logError, logWarn } from './log.js';

const ALLOWED_HOSTS = [
  'instagram.com',
  'cdninstagram.com',
  'fbcdn.net'
];

const PASS_THROUGH_HEADERS = [
  'content-length',
  'content-range',
  'accept-ranges',
  'etag',
  'last-modified'
];

function isAllowedHostname(hostname) {
  return ALLOWED_HOSTS.some(allowed => hostname === allowed || hostname.endsWith(`.${allowed}`));
}

function parseTargetUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    if (!isAllowedHostname(parsed.hostname)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function isLikelyMediaUrl(url) {
  try {
    return /(\.mp4|\.mov|\.m4v|\.webm|\.m3u8)(\?|$)/i.test(url);
  } catch {
    return false;
  }
}

function buildReferer() {
  return 'https://www.instagram.com/';
}

function buildProxyHeaders(upstream, kind) {
  const headers = new Headers();
  headers.set('Content-Type', upstream.headers.get('content-type') || (kind === 'image' ? 'image/jpeg' : 'video/mp4'));
  headers.set('Cache-Control', kind === 'image'
    ? 'public, max-age=604800, stale-while-revalidate=86400'
    : 'public, max-age=3600, stale-while-revalidate=86400');
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('X-Content-Type-Options', 'nosniff');

  for (const key of PASS_THROUGH_HEADERS) {
    const value = upstream.headers.get(key);
    if (value) headers.set(key, value);
  }

  return headers;
}

function validateUpstreamContentType(kind, contentType, targetUrl) {
  if (!contentType) return true;
  if (kind === 'image') return contentType.startsWith('image/');
  if (contentType.startsWith('video/')) return true;
  if (contentType.includes('application/octet-stream')) return isLikelyMediaUrl(targetUrl.toString());
  return false;
}

async function handleProxy(c, kind) {
  const rawTargetUrl = c.req.query('url');
  if (!rawTargetUrl) {
    return c.text('Missing ?url= parameter', 400);
  }

  const targetUrl = parseTargetUrl(rawTargetUrl);
  if (!targetUrl) {
    logWarn('proxy.target_rejected', { kind, targetUrl: rawTargetUrl });
    return c.text('URL domain not allowed', 403);
  }

  try {
    const headers = new Headers({
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Accept': kind === 'image' ? 'image/*,*/*;q=0.8' : 'video/*,*/*;q=0.8',
      'Referer': buildReferer()
    });

    if (kind === 'media') {
      const range = c.req.raw.headers.get('Range');
      if (range) headers.set('Range', range);
    }

    const resp = await fetch(targetUrl.toString(), {
      headers,
      redirect: 'follow'
    });

    if (!resp.ok) {
      logWarn('proxy.upstream_error', {
        kind,
        status: resp.status,
        targetUrl: targetUrl.toString()
      });
      return c.text(`Upstream ${resp.status}`, resp.status);
    }

    const contentType = resp.headers.get('content-type') || '';
    if (!validateUpstreamContentType(kind, contentType, targetUrl)) {
      logWarn('proxy.unexpected_content_type', {
        kind,
        contentType,
        targetUrl: targetUrl.toString()
      });
      return c.text('Unexpected upstream content type', 415);
    }

    return new Response(resp.body, {
      status: resp.status,
      headers: buildProxyHeaders(resp, kind)
    });
  } catch (e) {
    logError('proxy.fetch_failed', {
      kind,
      targetUrl: targetUrl.toString(),
      error: e
    });
    return c.text(`Proxy error: ${e.message}`, 502);
  }
}

export function handleImageProxy(c) {
  return handleProxy(c, 'image');
}

export function handleMediaProxy(c) {
  return handleProxy(c, 'media');
}

// 将原始图片 URL 替换为代理 URL
export function proxyImageUrl(originalUrl, baseUrl) {
  if (!originalUrl) return '';
  return `${baseUrl}/img?url=${encodeURIComponent(originalUrl)}`;
}

export function proxyMediaUrl(originalUrl, baseUrl) {
  if (!originalUrl) return '';
  return `${baseUrl}/media?url=${encodeURIComponent(originalUrl)}`;
}

// 替换 HTML 内容中的媒体 URL 为代理 URL
export function proxyHtmlAssets(html, baseUrl) {
  if (!html) return html;

  return html.replace(/\b(src|poster)="([^"]+)"/gi, (match, attr, url) => {
    const parsed = parseTargetUrl(url);
    if (!parsed) return match;

    const proxied = attr.toLowerCase() === 'poster' || !isLikelyMediaUrl(parsed.toString())
      ? proxyImageUrl(parsed.toString(), baseUrl)
      : proxyMediaUrl(parsed.toString(), baseUrl);

    return `${attr}="${proxied}"`;
  });
}

export const proxyHtmlImages = proxyHtmlAssets;
