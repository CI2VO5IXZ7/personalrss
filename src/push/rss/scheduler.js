import { fetchFeed } from './fetcher.js';
import { parseFeed } from './parser.js';
import { extractArticleText } from './sanitizer.js';
import { summarizeWithFallback } from '../summary/deepseek.js';
import { safeFetch, isSafeUrl, redactUrl, redactText } from '../../security/url.js';
import {
  updateRssSubscriptionCheck,
  addRssEntry,
  hasRssEntry,
  atomicClaimAndEnqueueRssNotification
} from '../../db.js';
import { logInfo, logError } from '../../log.js';

function sanitizeBoundaryError(err) {
  const msg = redactText(err.message || String(err));
  const newErr = new Error(msg);
  newErr.name = err.name || 'Error';
  if (err.stack) {
    newErr.stack = redactText(err.stack);
  }
  return newErr;
}

export async function processSubscription(db, sub, env, options = {}) {
  try {
    const res = await _processSubscriptionInner(db, sub, env, options);
    if (res && res.error) {
      res.error = redactText(res.error);
    }
    return res;
  } catch (err) {
    return { success: false, error: redactText(err.message) };
  }
}

async function _processSubscriptionInner(db, sub, env, options = {}) {
  const deepseekApiKey = env.DEEPSEEK_API_KEY;
  const deepseekLimit = parseInt(env.DEEPSEEK_DAILY_LIMIT || '200', 10);
  const fetchFn = options.fetchFn || fetch;
  const resolver = options.resolver;

  const now = new Date();
  const nextCheckAt = new Date(now.getTime() + sub.interval_minutes * 60 * 1000).toISOString();

  let fetchResult;
  try {
    fetchResult = await fetchFeed(sub.feed_url, {
      etag: sub.etag,
      lastModified: sub.last_modified,
      fetchFn,
      ...(resolver ? { resolver } : {})
    });
  } catch (err) {
    const consecutiveFailures = (sub.consecutive_failures || 0) + 1;
    await updateRssSubscriptionCheck(db, sub.id, {
      status: consecutiveFailures >= 6 ? 'error' : 'active',
      etag: sub.etag,
      lastModified: sub.last_modified,
      lastCheckedAt: now.toISOString(),
      lastSuccessAt: sub.last_success_at,
      consecutiveFailures,
      lastError: err.message,
      nextCheckAt
    });
    return { success: false, error: err.message };
  }

  if (fetchResult.status === 304) {
    await updateRssSubscriptionCheck(db, sub.id, {
      status: 'active',
      etag: sub.etag,
      lastModified: sub.last_modified,
      lastCheckedAt: now.toISOString(),
      lastSuccessAt: sub.last_success_at,
      consecutiveFailures: 0,
      lastError: '',
      nextCheckAt
    });
    return { success: true, count: 0 };
  }

  let parsed;
  try {
    parsed = await parseFeed(fetchResult.xml, sub.id, sub.feed_url);
  } catch (err) {
    const consecutiveFailures = (sub.consecutive_failures || 0) + 1;
    await updateRssSubscriptionCheck(db, sub.id, {
      status: consecutiveFailures >= 6 ? 'error' : 'active',
      etag: sub.etag,
      lastModified: sub.last_modified,
      lastCheckedAt: now.toISOString(),
      lastSuccessAt: sub.last_success_at,
      consecutiveFailures,
      lastError: err.message,
      nextCheckAt
    });
    return { success: false, error: err.message };
  }

  const updatedTitle = sub.title || parsed.title || 'Untitled Feed';
  const updatedSiteUrl = sub.site_url || parsed.siteUrl || '';

  // Validate and sanitize links and images of all parsed entries
  for (const entry of parsed.entries) {
    if (entry.link && !isSafeUrl(entry.link)) {
      entry.link = '';
    }
    if (entry.imageUrl && !isSafeUrl(entry.imageUrl)) {
      entry.imageUrl = '';
    }
  }

  const isFirstFetch = !sub.last_success_at;

  const newEntries = [];
  for (let i = 0; i < parsed.entries.length; i++) {
    const entry = parsed.entries[i];
    const exists = await hasRssEntry(
      db,
      sub.id,
      entry.entryKey,
      entry.link || '',
      entry.contentHash || ''
    );
    if (!exists) {
      entry.sourceIndex = i;
      newEntries.push(entry);
    }
  }

  if (!isFirstFetch) {
    newEntries.sort((a, b) => {
      const dateA = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
      const dateB = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
      return dateA - dateB;
    });
  }

  let processedCount = 0;
  let finalNextCheckAt = new Date(now.getTime() + sub.interval_minutes * 60 * 1000).toISOString();

  if (isFirstFetch) {
    if (newEntries.length > 0) {
      // Find the latest 1 entry based on publishedAt and sourceFeed order
      let latestEntry = null;
      for (const entry of newEntries) {
        if (!latestEntry) {
          latestEntry = entry;
          continue;
        }

        const timeCur = entry.publishedAt ? new Date(entry.publishedAt).getTime() : NaN;
        const timeBest = latestEntry.publishedAt ? new Date(latestEntry.publishedAt).getTime() : NaN;

        const isCurValid = !isNaN(timeCur);
        const isBestValid = !isNaN(timeBest);

        if (isCurValid && isBestValid) {
          if (timeCur > timeBest) {
            latestEntry = entry;
          } else if (timeCur === timeBest) {
            if (entry.sourceIndex < latestEntry.sourceIndex) {
              latestEntry = entry;
            }
          }
        } else if (isCurValid && !isBestValid) {
          latestEntry = entry;
        } else if (!isCurValid && isBestValid) {
          // Keep best
        } else {
          // Both have invalid dates
          if (entry.sourceIndex < latestEntry.sourceIndex) {
            latestEntry = entry;
          }
        }
      }

      // 1. Establish baseline for all other entries (no notifications for these)
      for (const entry of newEntries) {
        if (entry !== latestEntry) {
          await addRssEntry(db, sub.id, entry);
        }
      }

      // 2. Fetch original page content if newest is short
      let contentToSummarize = latestEntry.content || '';
      const contentLen = contentToSummarize.trim().length;

      if (contentLen < 150 && latestEntry.link) {
        try {
          const pageRes = await safeFetch(latestEntry.link, {
            fetchFn,
            ...(resolver ? { resolver } : {}),
            timeoutMs: 5000,
            allowedContentTypes: ['text/html']
          });
          if (pageRes.ok) {
            const pageHtml = await pageRes.text();
            const extractedText = extractArticleText(pageHtml);
            if (extractedText.trim().length >= 150) {
              contentToSummarize = extractedText;
            }
          }
        } catch (e) {
          logError('scheduler.fetch_page_failed', {
            link: redactUrl(latestEntry.link),
            error: redactText(e.message)
          });
        }
      }

      // 3. DeepSeek summary
      let summary = latestEntry.content || '';
      if (deepseekApiKey) {
        summary = await summarizeWithFallback(
          db,
          deepseekApiKey,
          contentToSummarize,
          latestEntry.content || '',
          { limit: deepseekLimit, fetchFn }
        );
      }

      const payload = {
        subscriptionId: sub.id,
        feedTitle: updatedTitle,
        entryTitle: latestEntry.title,
        summary,
        link: latestEntry.link,
        imageUrl: latestEntry.imageUrl
      };

      // 4. Atomic claim and enqueue for newest entry (ensures concurrency safety: at most once)
      try {
        const claimed = await atomicClaimAndEnqueueRssNotification(db, sub.id, latestEntry, payload);
        if (claimed) processedCount++;
      } catch (err) {
        const cleanError = redactText(err.message);
        const consecutiveFailures = (sub.consecutive_failures || 0) + 1;
        await updateRssSubscriptionCheck(db, sub.id, {
          status: consecutiveFailures >= 6 ? 'error' : 'active',
          etag: sub.etag,
          lastModified: sub.last_modified,
          lastCheckedAt: now.toISOString(),
          lastSuccessAt: sub.last_success_at,
          consecutiveFailures,
          lastError: cleanError,
          nextCheckAt: now.toISOString()
        });
        throw err;
      }
    }
  } else {
    // Normal subsequent checks: process new entries up to limit
    const limit = parseInt(env.RSS_PROCESSING_LIMIT || '5', 10);
    const hasBacklog = newEntries.length > limit;
    const entriesToProcess = newEntries.slice(0, limit);

    for (const entry of entriesToProcess) {
      let contentToSummarize = entry.content || '';
      const contentLen = contentToSummarize.trim().length;

      if (contentLen < 150 && entry.link) {
        try {
          const pageRes = await safeFetch(entry.link, {
            fetchFn,
            ...(resolver ? { resolver } : {}),
            timeoutMs: 5000,
            allowedContentTypes: ['text/html']
          });
          if (pageRes.ok) {
            const pageHtml = await pageRes.text();
            const extractedText = extractArticleText(pageHtml);
            if (extractedText.trim().length >= 150) {
              contentToSummarize = extractedText;
            }
          }
        } catch (e) {
          logError('scheduler.fetch_page_failed', {
            link: redactUrl(entry.link),
            error: redactText(e.message)
          });
        }
      }

      let summary = entry.content || '';
      if (deepseekApiKey) {
        summary = await summarizeWithFallback(
          db,
          deepseekApiKey,
          contentToSummarize,
          entry.content || '',
          { limit: deepseekLimit, fetchFn }
        );
      }

      const payload = {
        subscriptionId: sub.id,
        feedTitle: updatedTitle,
        entryTitle: entry.title,
        summary,
        link: entry.link,
        imageUrl: entry.imageUrl
      };

      try {
        const claimed = await atomicClaimAndEnqueueRssNotification(db, sub.id, entry, payload);
        if (claimed) processedCount++;
      } catch (err) {
        const cleanError = redactText(err.message);
        const consecutiveFailures = (sub.consecutive_failures || 0) + 1;
        await updateRssSubscriptionCheck(db, sub.id, {
          status: consecutiveFailures >= 6 ? 'error' : 'active',
          etag: sub.etag,
          lastModified: sub.last_modified,
          lastCheckedAt: now.toISOString(),
          lastSuccessAt: sub.last_success_at,
          consecutiveFailures,
          lastError: cleanError,
          nextCheckAt: now.toISOString()
        });
        throw err;
      }
    }

    if (hasBacklog) {
      finalNextCheckAt = now.toISOString();
    }
  }

  await updateRssSubscriptionCheck(db, sub.id, {
    status: 'active',
    etag: fetchResult.etag,
    lastModified: fetchResult.lastModified,
    lastCheckedAt: now.toISOString(),
    lastSuccessAt: now.toISOString(),
    consecutiveFailures: 0,
    lastError: '',
    nextCheckAt: finalNextCheckAt
  });

  if (!sub.title || !sub.site_url) {
    await db.prepare('UPDATE rss_subscriptions SET title = ?, site_url = ? WHERE id = ?')
      .bind(updatedTitle, updatedSiteUrl, sub.id).run();
  }

  return { success: true, count: processedCount };
}

export async function processDueSubscriptions(db, env, options = {}) {
  try {
    return await _processDueSubscriptionsInner(db, env, options);
  } catch (err) {
    throw sanitizeBoundaryError(err);
  }
}

async function _processDueSubscriptionsInner(db, env, options = {}) {
  const limit = options.batchLimit || 5;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit <= 0) {
    throw new Error('Invalid batchLimit: must be a positive integer');
  }

  const { getDueRssSubscriptions } = await import('../../db.js');
  const due = await getDueRssSubscriptions(db, limit);
  let processedCount = 0;

  for (const sub of due) {
    try {
      await processSubscription(db, sub, env, options);
    } catch (err) {
      logError('scheduler.due_subscription_processing_failed', {
        subscriptionId: sub.id,
        error: redactText(err.message)
      });
    }
    processedCount++;
  }

  return processedCount;
}
