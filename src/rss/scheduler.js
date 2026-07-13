import { fetchFeed } from './fetcher.js';
import { parseFeed } from './parser.js';
import { extractArticleText } from './sanitizer.js';
import { summarizeWithFallback } from '../summary/deepseek.js';
import { safeFetch, isSafeUrl, redactUrl, redactText } from '../security/url.js';
import {
  updateRssSubscriptionCheck,
  addRssEntry,
  hasRssEntry,
  atomicClaimAndEnqueueRssNotification
} from '../db.js';

export async function processSubscription(db, sub, env, options = {}) {
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
    parsed = await parseFeed(fetchResult.xml, sub.id);
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
  for (const entry of parsed.entries) {
    const exists = await hasRssEntry(
      db,
      sub.id,
      entry.entryKey,
      entry.link || '',
      entry.contentHash || ''
    );
    if (!exists) {
      newEntries.push(entry);
    }
  }

  newEntries.sort((a, b) => {
    const dateA = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
    const dateB = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
    return dateA - dateB;
  });

  const limit = parseInt(env.RSS_PROCESSING_LIMIT || '5', 10);
  const hasBacklog = !isFirstFetch && newEntries.length > limit;
  const entriesToProcess = isFirstFetch ? newEntries : newEntries.slice(0, limit);

  let processedCount = 0;
  if (isFirstFetch) {
    for (const entry of entriesToProcess) {
      if (await addRssEntry(db, sub.id, entry)) processedCount++;
    }
  } else {
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
          console.error(`[scheduler] failed to fetch original page for ${redactUrl(entry.link)}:`, redactText(e.message));
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
        return { success: false, error: cleanError };
      }
    }
  }

  const finalNextCheckAt = hasBacklog
    ? now.toISOString()
    : new Date(now.getTime() + sub.interval_minutes * 60 * 1000).toISOString();

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
  const limit = options.batchLimit || 5;
  const { getDueRssSubscriptions } = await import('../db.js');
  const due = await getDueRssSubscriptions(db, limit);
  let processedCount = 0;
  
  for (const sub of due) {
    await processSubscription(db, sub, env, options);
    processedCount++;
  }
  
  return processedCount;
}
