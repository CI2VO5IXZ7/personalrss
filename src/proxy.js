// 图片代理 — 代理 Instagram/XHS CDN 图片，解决签名过期和跨域问题

// 允许代理的域名白名单
const ALLOWED_HOSTS = [
  'instagram.', 'cdninstagram.com', 'fbcdn.net',
  'xhscdn.com', 'xiaohongshu.com', 'sns-img'
];

function isAllowedUrl(url) {
  try {
    const parsed = new URL(url);
    return ALLOWED_HOSTS.some(h => parsed.hostname.includes(h));
  } catch { return false; }
}

export async function handleImageProxy(c) {
  const targetUrl = c.req.query('url');
  if (!targetUrl) {
    return c.text('Missing ?url= parameter', 400);
  }

  if (!isAllowedUrl(targetUrl)) {
    return c.text('URL domain not allowed', 403);
  }

  try {
    const resp = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
        'Referer': targetUrl.includes('instagram') ? 'https://www.instagram.com/' : 'https://www.xiaohongshu.com/'
      }
    });

    if (!resp.ok) {
      return c.text(`Upstream ${resp.status}`, resp.status);
    }

    const contentType = resp.headers.get('content-type') || 'image/jpeg';
    const body = await resp.arrayBuffer();

    return new Response(body, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=604800, immutable',
        'Access-Control-Allow-Origin': '*'
      }
    });
  } catch (e) {
    return c.text(`Proxy error: ${e.message}`, 502);
  }
}

// 将原始图片 URL 替换为代理 URL
export function proxyImageUrl(originalUrl, baseUrl) {
  if (!originalUrl) return '';
  return `${baseUrl}/img?url=${encodeURIComponent(originalUrl)}`;
}

// 替换 HTML 内容中的所有图片 URL 为代理 URL
export function proxyHtmlImages(html, baseUrl) {
  if (!html) return html;
  // 替换 <img src="..."> 和 <video poster="..."> 中的图片 URL
  return html.replace(
    /((?:src|poster)=")([^"]+(?:instagram|cdninstagram|fbcdn|xhscdn|xiaohongshu|sns-img)[^"]*")/g,
    (match, prefix, urlAndQuote) => {
      const url = urlAndQuote.slice(0, -1); // 去掉末尾引号
      return `${prefix}${baseUrl}/img?url=${encodeURIComponent(url)}"`;
    }
  );
}
