
function isPrivateOrUnsafeIPv4(parts) {
  if (parts.some(p => p < 0 || p > 255 || Number.isNaN(p))) {
    return true;
  }
  const first = parts[0];
  // 127.0.0.0/8 (loopback)
  if (first === 127) return true;
  // 10.0.0.0/8 (private)
  if (first === 10) return true;
  // 172.16.0.0/12 (private)
  if (first === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  // 192.168.0.0/16 (private)
  if (first === 192 && parts[1] === 168) return true;
  // 169.254.0.0/16 (link-local)
  if (first === 169 && parts[1] === 254) return true;
  // 0.0.0.0/8 (broadcast/any)
  if (first === 0) return true;
  // 224.0.0.0/4 (multicast)
  if (first >= 224 && first <= 239) return true;
  // 240.0.0.0/4 (reserved)
  if (first >= 240) return true;
  // CGNAT 100.64.0.0/10
  if (first === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
  // Test-nets and IETF protocol / reserved:
  // 192.0.2.0/24, 192.0.0.0/24, 192.88.99.0/24
  if (first === 192) {
    if (parts[1] === 0 && (parts[2] === 0 || parts[2] === 2)) return true;
    if (parts[1] === 88 && parts[2] === 99) return true;
  }
  // 198.51.100.0/24
  if (first === 198 && parts[1] === 51 && parts[2] === 100) return true;
  // 203.0.113.0/24
  if (first === 203 && parts[1] === 0 && parts[2] === 113) return true;
  // 198.18.0.0/15 (benchmarking)
  if (first === 198 && parts[1] >= 18 && parts[1] <= 19) return true;

  return false;
}

function parseIPv4(host) {
  const cleanHost = host.replace(/\.$/, '');
  if (!/^[0-9a-fx\.]+$/i.test(cleanHost)) {
    return null;
  }
  const partsStr = cleanHost.split('.');
  if (partsStr.length > 4 || partsStr.length === 0) {
    return null;
  }
  const parts = [];
  for (const p of partsStr) {
    if (p === '') return null;
    let val;
    if (/^0x[0-9a-f]+$/i.test(p)) {
      val = parseInt(p, 16);
    } else if (/^0[0-7]*$/.test(p)) {
      val = parseInt(p, 8);
    } else if (/^[0-9]+$/.test(p)) {
      val = parseInt(p, 10);
    } else {
      return null;
    }
    if (isNaN(val) || val < 0 || val > 0xffffffff) {
      return null;
    }
    parts.push(val);
  }

  const N = parts.length;
  if (N === 4) {
    if (parts[0] > 255 || parts[1] > 255 || parts[2] > 255 || parts[3] > 255) return null;
    return [parts[0], parts[1], parts[2], parts[3]];
  }
  if (N === 3) {
    if (parts[0] > 255 || parts[1] > 255 || parts[2] > 65535) return null;
    return [parts[0], parts[1], (parts[2] >> 8) & 0xff, parts[2] & 0xff];
  }
  if (N === 2) {
    if (parts[0] > 255 || parts[1] > 16777215) return null;
    return [parts[0], (parts[1] >> 16) & 0xff, (parts[1] >> 8) & 0xff, parts[1] & 0xff];
  }
  if (N === 1) {
    const val = parts[0];
    return [(val >>> 24) & 0xff, (val >>> 16) & 0xff, (val >>> 8) & 0xff, val & 0xff];
  }
  return null;
}

function parseIPv6(ip) {
  const lastColon = ip.lastIndexOf(':');
  if (lastColon !== -1) {
    const suffix = ip.substring(lastColon + 1);
    if (suffix.includes('.')) {
      const parts = suffix.split('.').map(Number);
      if (parts.length !== 4 || parts.some(p => p < 0 || p > 255 || isNaN(p))) {
        return null;
      }
      const high = (parts[0] << 8) + parts[1];
      const low = (parts[2] << 8) + parts[3];
      ip = ip.substring(0, lastColon + 1) + high.toString(16) + ':' + low.toString(16);
    }
  }

  const doubleColonParts = ip.split('::');
  if (doubleColonParts.length > 2) return null;

  let left = doubleColonParts[0] ? doubleColonParts[0].split(':') : [];
  let right = doubleColonParts[1] ? doubleColonParts[1].split(':') : [];

  if (doubleColonParts.length === 2) {
    if (ip.startsWith('::')) left = [];
    if (ip.endsWith('::')) right = [];
  }

  const parsedLeft = [];
  for (const p of left) {
    if (p === '') continue;
    const val = parseInt(p, 16);
    if (isNaN(val) || val < 0 || val > 65535 || !/^[0-9a-fA-F]{1,4}$/.test(p)) {
      return null;
    }
    parsedLeft.push(val);
  }

  const parsedRight = [];
  for (const p of right) {
    if (p === '') continue;
    const val = parseInt(p, 16);
    if (isNaN(val) || val < 0 || val > 65535 || !/^[0-9a-fA-F]{1,4}$/.test(p)) {
      return null;
    }
    parsedRight.push(val);
  }

  const totalParsedCount = parsedLeft.length + parsedRight.length;
  if (doubleColonParts.length === 2) {
    if (totalParsedCount > 7) return null;
    const zerosCount = 8 - totalParsedCount;
    const zeros = Array(zerosCount).fill(0);
    return [...parsedLeft, ...zeros, ...parsedRight];
  } else {
    if (totalParsedCount !== 8) return null;
    return parsedLeft;
  }
}

function isPrivateOrUnsafeIPv6(blocks) {
  // Unspecified ::/128
  if (blocks.every(b => b === 0)) return true;
  // Loopback ::1/128
  if (blocks.slice(0, 7).every(b => b === 0) && blocks[7] === 1) return true;
  // Link-local fe80::/10
  if ((blocks[0] & 0xffc0) === 0xfe80) return true;
  // Unique local fc00::/7
  if ((blocks[0] & 0xfe00) === 0xfc00) return true;
  // Multicast ff00::/8
  if ((blocks[0] & 0xff00) === 0xff00) return true;
  // Documentation 2001:db8::/32
  if (blocks[0] === 0x2001 && blocks[1] === 0xdb8) return true;
  // ORCHIDv2 2001:10::/28
  if (blocks[0] === 0x2001 && (blocks[1] & 0xfff0) === 0x10) return true;
  // Discard-only 100::/64
  if (blocks[0] === 0x100 && blocks[1] === 0 && blocks[2] === 0 && blocks[3] === 0) return true;

  return false;
}

function parseIpAddress(host) {
  const normalized = host.toLowerCase().replace(/\.$/, '');
  const ipv4 = parseIPv4(normalized);
  if (ipv4) return { family: 4, parts: ipv4 };

  const unwrapped = normalized.startsWith('[') && normalized.endsWith(']')
    ? normalized.slice(1, -1)
    : normalized;
  if (!unwrapped.includes(':')) return null;
  const ipv6 = parseIPv6(unwrapped);
  return ipv6 ? { family: 6, parts: ipv6 } : null;
}

function isUnsafeIpAddress(address) {
  const parsed = parseIpAddress(address);
  if (!parsed) return null;
  if (parsed.family === 4) return isPrivateOrUnsafeIPv4(parsed.parts);

  if (isPrivateOrUnsafeIPv6(parsed.parts)) return true;
  const isIPv4Mapped = parsed.parts.slice(0, 5).every(block => block === 0)
    && parsed.parts[5] === 0xffff;
  const isIPv4Compatible = parsed.parts.slice(0, 6).every(block => block === 0);
  if (isIPv4Mapped || isIPv4Compatible) {
    return isPrivateOrUnsafeIPv4([
      (parsed.parts[6] >> 8) & 0xff,
      parsed.parts[6] & 0xff,
      (parsed.parts[7] >> 8) & 0xff,
      parsed.parts[7] & 0xff
    ]);
  }
  return false;
}

function isUnsafeHostname(host) {
  const normalized = host.toLowerCase().replace(/\.$/, '');
  return normalized === 'localhost'
    || normalized.endsWith('.localhost')
    || normalized === 'local'
    || normalized.endsWith('.local')
    || normalized === 'internal'
    || normalized.endsWith('.internal')
    || normalized === 'localdomain'
    || normalized.endsWith('.localdomain')
    || normalized === 'metadata'
    || normalized === 'instance-data';
}

const DOH_ENDPOINT = 'https://cloudflare-dns.com/dns-query';
const DOH_TIMEOUT_MS = 3000;

async function resolveHostnameWithDoH(hostname) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DOH_TIMEOUT_MS);
  const query = async type => {
    const url = `${DOH_ENDPOINT}?name=${encodeURIComponent(hostname)}&type=${type}`;
    const response = await fetch(url, {
      headers: { Accept: 'application/dns-json' },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`DoH request failed with status ${response.status}`);
    const body = await response.json();
    if (body.Status !== 0) throw new Error(`DoH lookup failed with status ${body.Status}`);
    return Array.isArray(body.Answer)
      ? body.Answer.filter(answer => answer.type === type).map(answer => answer.data)
      : [];
  };

  try {
    const [ipv4, ipv6] = await Promise.all([query(1), query(28)]);
    return [...ipv4, ...ipv6];
  } catch (err) {
    controller.abort();
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

export function isSafeUrl(urlStr) {
  try {
    const url = new URL(urlStr);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return false;
    }
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    
    // Loopback, private-use, and cloud metadata hostnames
    if (isUnsafeHostname(host)) {
      return false;
    }

    // Try parsing as IPv4
    const ipv4Parts = parseIPv4(host);
    if (ipv4Parts) {
      return !isPrivateOrUnsafeIPv4(ipv4Parts);
    }

    // IPv6 validation (surrounded by brackets in URLs)
    if (host.startsWith('[') && host.endsWith(']')) {
      const ip = host.slice(1, -1);
      const ipv6Blocks = parseIPv6(ip);
      if (!ipv6Blocks) {
        return false;
      }
      if (isPrivateOrUnsafeIPv6(ipv6Blocks)) {
        return false;
      }
      const isIPv4Mapped = (ipv6Blocks[0] === 0 && ipv6Blocks[1] === 0 && ipv6Blocks[2] === 0 && ipv6Blocks[3] === 0 && ipv6Blocks[4] === 0 && ipv6Blocks[5] === 0xffff);
      const isIPv4Compatible = (ipv6Blocks[0] === 0 && ipv6Blocks[1] === 0 && ipv6Blocks[2] === 0 && ipv6Blocks[3] === 0 && ipv6Blocks[4] === 0 && ipv6Blocks[5] === 0);
      if (isIPv4Mapped || isIPv4Compatible) {
        const parts = [
          (ipv6Blocks[6] >> 8) & 0xff,
          ipv6Blocks[6] & 0xff,
          (ipv6Blocks[7] >> 8) & 0xff,
          ipv6Blocks[7] & 0xff
        ];
        return !isPrivateOrUnsafeIPv4(parts);
      }
      return true;
    }

    return true;
  } catch {
    return false;
  }
}

const SENSITIVE_KEYS = new Set([
  'token',
  'key',
  'auth',
  'pass',
  'password',
  'secret',
  'api_key',
  'apikey',
  'signature',
  'sig',
  'code',
  'access_token',
  'auth_token',
  'credential',
  'expires',
  'x-amz-signature',
  'x-amz-credential',
  'x-amz-security-token',
  'x-goog-signature',
  'x-goog-credential',
  'x-goog-security-token',
  'googleaccessid',
  'policy',
  'key-pair-id'
]);

export function redactUrl(urlStr) {
  try {
    const url = new URL(urlStr);
    // Redact username/password
    if (url.username || url.password) {
      if (url.password) {
        url.password = '***';
      } else if (url.username) {
        url.username = '***';
      }
    }
    // Redact query params
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_KEYS.has(key.toLowerCase())) {
        url.searchParams.set(key, '***');
      }
    }
    return url.toString().replace(/%2A/g, '*');
  } catch {
    return urlStr;
  }
}

function cancelResponseBody(response) {
  if (!response?.body || typeof response.body.cancel !== 'function') return;
  try {
    Promise.resolve(response.body.cancel()).catch(() => {});
  } catch {
    // The body may already be locked, aborted, or cancelled.
  }
}

function cancelReader(reader) {
  if (!reader || typeof reader.cancel !== 'function') return;
  try {
    Promise.resolve(reader.cancel()).catch(() => {});
  } catch {
    // The reader may already be closed or cancelled.
  }
}

async function consumeBoundedText(response, maxBytes, race, controller) {
  const sizeError = () => new Error(`Response text size exceeds limit of ${maxBytes} bytes`);

  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const textChunks = [];
    let totalBytes = 0;

    try {
      while (true) {
        const { done, value } = await race(reader.read());
        if (done) break;

        const bytes = value instanceof Uint8Array
          ? value
          : ArrayBuffer.isView(value)
            ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
            : new Uint8Array(value);
        if (totalBytes + bytes.byteLength > maxBytes) {
          controller.abort();
          cancelReader(reader);
          throw sizeError();
        }
        totalBytes += bytes.byteLength;
        textChunks.push(decoder.decode(bytes, { stream: true }));
      }
    } catch (err) {
      cancelReader(reader);
      throw err;
    }

    textChunks.push(decoder.decode());
    return textChunks.join('');
  }

  if (typeof response.text !== 'function') return '';
  const text = await race(Promise.resolve().then(() => response.text()));
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    controller.abort();
    throw sizeError();
  }
  return text;
}

export async function safeFetch(urlStr, options = {}) {
  const {
    fetchFn = fetch,
    resolver = resolveHostnameWithDoH,
    maxRedirects = 5,
    timeoutMs = 10000,
    maxBytes = 2 * 1024 * 1024,
    allowedContentTypes,
    ...cleanOptions
  } = options;

  let currentUrl = urlStr;
  let redirectCount = 0;
  const resolutionCache = new Map();

  try {
    while (true) {
      if (!isSafeUrl(currentUrl)) {
        throw new Error(`Unsafe redirect URL: ${redactUrl(currentUrl)}`);
      }

      const parsedUrl = new URL(currentUrl);
      const hostname = parsedUrl.hostname.toLowerCase().replace(/\.$/, '');
      if (!parseIpAddress(hostname)) {
        let resolution = resolutionCache.get(hostname);
        if (!resolution) {
          resolution = Promise.resolve().then(() => resolver(hostname));
          resolutionCache.set(hostname, resolution);
        }

        let addresses;
        try {
          addresses = await resolution;
        } catch (err) {
          throw new Error(
            `Hostname resolution failed for ${redactUrl(currentUrl)}: ${redactText(err?.message || String(err))}`
          );
        }

        if (!Array.isArray(addresses) || addresses.length === 0) {
          throw new Error(`Hostname resolution failed for ${redactUrl(currentUrl)}: no usable address`);
        }
        const safety = addresses.map(address => isUnsafeIpAddress(String(address)));
        if (safety.some(result => result === null)) {
          throw new Error(`Hostname resolution failed for ${redactUrl(currentUrl)}: invalid address answer`);
        }
        if (safety.some(Boolean)) {
          throw new Error(`Unsafe hostname resolution for ${redactUrl(currentUrl)}`);
        }
      }

      const controller = new AbortController();
      let response;
      let timeoutId;
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          controller.abort();
          reject(new Error(`Request timed out after ${timeoutMs} ms`));
        }, timeoutMs);
      });
      const race = operation => Promise.race([Promise.resolve(operation), timeoutPromise]);

      try {
        try {
          response = await race(Promise.resolve().then(() => fetchFn(currentUrl, {
            ...cleanOptions,
            redirect: 'manual',
            signal: controller.signal
          })));
        } catch (err) {
          throw new Error(redactText(err.message || String(err)));
        }

        if (response.status >= 300 && response.status < 400 && response.status !== 304) {
          const location = response.headers.get('location');
          if (!location) {
            throw new Error(`Redirect status ${response.status} with no Location header`);
          }
          redirectCount++;
          if (redirectCount > maxRedirects) {
            throw new Error('Too many redirects');
          }
          try {
            currentUrl = new URL(location, currentUrl).toString();
          } catch (err) {
            throw new Error(redactText(err.message || String(err)));
          }
          controller.abort();
          await cancelResponseBody(response);
          continue;
        }

        if (allowedContentTypes) {
          const contentType = response.headers.get('content-type') || '';
          const isAllowed = allowedContentTypes.some(t => contentType.toLowerCase().includes(t.toLowerCase()));
          if (!isAllowed) {
            throw new Error(`Content type ${contentType} not allowed`);
          }
        }

        const contentLength = response.headers.get('content-length');
        if (contentLength && parseInt(contentLength, 10) > maxBytes) {
          controller.abort();
          await cancelResponseBody(response);
          throw new Error(`Response size exceeds limit of ${maxBytes} bytes`);
        }

        const boundedText = await consumeBoundedText(response, maxBytes, race, controller);
        response.text = async () => boundedText;
        return response;
      } catch (err) {
        controller.abort();
        await cancelResponseBody(response);
        throw err;
      } finally {
        clearTimeout(timeoutId);
      }
    }
  } catch (err) {
    const msg = redactText(err.message || String(err));
    const newErr = new Error(msg);
    if (err.name) {
      newErr.name = err.name;
    }
    if (err.stack) {
      newErr.stack = redactText(err.stack);
    }
    throw newErr;
  }
}

export function redactText(str) {
  if (typeof str !== 'string') return str;
  let sanitized = str.replace(/https?:\/\/[^\s"'<>]+/g, (match) => {
    try {
      return redactUrl(match);
    } catch {
      return '[REDACTED_URL]';
    }
  });

  for (const key of SENSITIVE_KEYS) {
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(
      `(^|[^a-zA-Z0-9_-])(${escapedKey})\\s*([=:]+)\\s*("[^"]*"|'[^']*'|[^\\s,;]+)`,
      'gi'
    );
    sanitized = sanitized.replace(regex, '$1$2$3***');
  }

  return sanitized;
}
