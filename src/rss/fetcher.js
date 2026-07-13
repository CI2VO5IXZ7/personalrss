import { safeFetch } from '../security/url.js';

export async function fetchFeed(urlStr, options = {}) {
  const headers = { ...options.headers };
  
  if (options.etag) {
    headers['If-None-Match'] = options.etag;
  }
  if (options.lastModified) {
    headers['If-Modified-Since'] = options.lastModified;
  }

  // Use a default user-agent that looks like a standard browser/feed-fetcher
  if (!headers['User-Agent'] && !headers['user-agent']) {
    headers['User-Agent'] = 'Mozilla/5.0 (compatible; PersonalRSS/2.0; +https://github.com/CI2VO5IXZ7/personalrss)';
  }

  const fetchOptions = {
    ...options,
    headers
  };

  const response = await safeFetch(urlStr, fetchOptions);

  if (response.status === 304) {
    return {
      status: 304,
      xml: '',
      etag: options.etag || '',
      lastModified: options.lastModified || ''
    };
  }

  const xml = await response.text();
  const newEtag = response.headers.get('etag') || '';
  const newLastModified = response.headers.get('last-modified') || '';

  return {
    status: response.status,
    xml,
    etag: newEtag,
    lastModified: newLastModified
  };
}
