import { isSafeUrl, redactUrl, safeFetch, redactText } from '../../security/url.js';
import { discoverFeeds } from './discovery.js';
import { parseFeed } from './parser.js';
import { processSubscription } from './scheduler.js';
import {
  addSubscription as repoAdd,
  getSubscriptions as repoList,
  getSubscription as repoGet,
  getSubscriptionByUrl as repoGetByUrl,
  pauseSubscription as repoPause,
  resumeSubscription as repoResume,
  removeSubscription as repoRemove
} from './repository.js';

function validatePositiveInteger(name, value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid ${name}: must be a positive integer`);
  }
}

function sanitizeBoundaryError(err) {
  const msg = redactText(err.message || String(err));
  const newErr = new Error(msg);
  newErr.name = err.name || 'Error';
  if (err.stack) {
    newErr.stack = redactText(err.stack);
  }
  return newErr;
}

export async function addSubscription(db, url, env, options = {}) {
  try {
    if (!isSafeUrl(url)) {
      throw new Error('Link is unsafe');
    }

    const redacted = redactUrl(url);
    const existing = await repoGetByUrl(db, url);
    if (existing) {
      throw new Error(`Subscription already exists: ${redacted}`);
    }

    let finalUrl = url;
    let isHtml = false;
    let responseText = '';
    let contentType = '';

    const fetchFn = options.fetchFn || fetch;
    const resolver = options.resolver || env.SAFE_FETCH_RESOLVER;

    const res = await safeFetch(url, {
      timeoutMs: 8000,
      ...(resolver ? { resolver } : {}),
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; PersonalRSS/2.0; +https://github.com/CI2VO5IXZ7/personalrss)'
      },
      fetchFn
    });

    contentType = res.headers.get('content-type') || '';
    responseText = await res.text();

    if (contentType.toLowerCase().includes('text/html')) {
      isHtml = true;
    }

    if (isHtml) {
      const discovered = discoverFeeds(responseText, url);
      if (discovered.length === 0) {
        throw new Error('No RSS/Atom feed found in HTML');
      }
      finalUrl = discovered[0].url;
      if (!isSafeUrl(finalUrl)) {
        throw new Error('Discovered feed URL is unsafe');
      }
      const existingDiscovered = await repoGetByUrl(db, finalUrl);
      if (existingDiscovered) {
        throw new Error(`Discovered feed subscription already exists: ${redactUrl(finalUrl)}`);
      }
      const feedRes = await safeFetch(finalUrl, {
        timeoutMs: 5000,
        ...(resolver ? { resolver } : {}),
        fetchFn
      });
      responseText = await feedRes.text();
    }

    const parsed = await parseFeed(responseText, '', finalUrl);
    const title = parsed.title || 'Untitled Feed';
    const siteUrl = parsed.siteUrl || '';

    const added = await repoAdd(db, finalUrl, redactUrl(finalUrl), siteUrl, title, 10);
    if (!added) {
      throw new Error('Failed to save subscription');
    }

    const newSub = await repoGetByUrl(db, finalUrl);
    // Trigger initial check/baseline
    const processRes = await processSubscription(db, newSub, env, options);

    return {
      subscription: newSub,
      title,
      siteUrl,
      processResult: processRes
    };
  } catch (err) {
    throw sanitizeBoundaryError(err);
  }
}

export async function listSubscriptions(db) {
  try {
    return await repoList(db);
  } catch (err) {
    throw sanitizeBoundaryError(err);
  }
}

export async function pauseSubscription(db, id) {
  try {
    validatePositiveInteger('id', id);
    const success = await repoPause(db, id);
    if (!success) {
      throw new Error(`Failed to pause subscription ${id}`);
    }
    return true;
  } catch (err) {
    throw sanitizeBoundaryError(err);
  }
}

export async function resumeSubscription(db, id) {
  try {
    validatePositiveInteger('id', id);
    const success = await repoResume(db, id);
    if (!success) {
      throw new Error(`Failed to resume subscription ${id}`);
    }
    return true;
  } catch (err) {
    throw sanitizeBoundaryError(err);
  }
}

export async function removeSubscription(db, id) {
  try {
    validatePositiveInteger('id', id);
    const success = await repoRemove(db, id);
    if (!success) {
      throw new Error(`Failed to remove subscription ${id}`);
    }
    return true;
  } catch (err) {
    throw sanitizeBoundaryError(err);
  }
}

export async function refreshSubscription(db, id, env, options = {}) {
  try {
    validatePositiveInteger('id', id);
    const sub = await repoGet(db, id);
    if (!sub) {
      throw new Error('Subscription not found');
    }
    return await processSubscription(db, sub, env, options);
  } catch (err) {
    throw sanitizeBoundaryError(err);
  }
}
