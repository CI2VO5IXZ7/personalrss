import { enqueue } from '../notifications/queue.js';
import { logError } from '../../log.js';
import { redactText } from '../../security/url.js';

export function getBeijingDate(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const parts = formatter.formatToParts(date);
  const year = parts.find(p => p.type === 'year').value;
  const month = parts.find(p => p.type === 'month').value;
  const day = parts.find(p => p.type === 'day').value;
  return `${year}-${month}-${day}`;
}

async function consumeDailyUsage(db, limit) {
  try {
    const dateStr = getBeijingDate();
    const type = 'deepseek_summary';

    await db.prepare(
      `INSERT OR IGNORE INTO daily_usage (usage_date, usage_type, count) VALUES (?, ?, 0)`
    ).bind(dateStr, type).run();

    const result = await db.prepare(
      `UPDATE daily_usage
       SET count = count + 1
       WHERE usage_date = ? AND usage_type = ? AND count < ?`
    ).bind(dateStr, type, limit).run();

    return {
      allowed: result.meta.changes > 0,
      reason: result.meta.changes > 0 ? 'allowed' : 'limit',
      date: dateStr
    };
  } catch (e) {
    logError('deepseek.check_usage_failed', { error: redactText(e.message) });
    return { allowed: false, reason: 'database_error', date: getBeijingDate() };
  }
}

export async function checkAndIncrementUsage(db, limit) {
  return (await consumeDailyUsage(db, limit)).allowed;
}

export function classifyError(errorOrStatus) {
  if (typeof errorOrStatus === 'number') {
    const status = errorOrStatus;
    if (status === 429 || (status >= 500 && status < 600)) {
      return { retryable: true, message: `HTTP status ${status}` };
    }
    return { retryable: false, message: `HTTP status ${status}` };
  }

  const errMsg = String(errorOrStatus?.message || errorOrStatus || '').toUpperCase();
  if (
    errMsg.includes('TIMEOUT') ||
    errMsg.includes('ABORT') ||
    errMsg.includes('NETWORK') ||
    errMsg.includes('FETCH') ||
    errMsg.includes('CONNECTION')
  ) {
    return { retryable: true, message: errMsg };
  }

  return { retryable: false, message: errMsg };
}

export async function summarizeContent(apiKey, content, options = {}) {
  const fetchFn = options.fetchFn || fetch;
  const model = options.model || 'deepseek-v4-flash';
  const timeoutMs = options.timeoutMs || 10000;
  const maxRetries = options.maxRetries !== undefined ? options.maxRetries : 2;
  const backoffMs = options.backoffMs !== undefined ? options.backoffMs : 1000;

  const truncatedContent = content.slice(0, 10000);
  const url = 'https://api.deepseek.com/chat/completions';

  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const sleepTime = backoffMs * Math.pow(2, attempt - 1);
      await new Promise(resolve => setTimeout(resolve, sleepTime));
    }

    const controller = new AbortController();
    let timeoutId;
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        controller.abort();
        reject(new Error(`DeepSeek API request timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    try {
      const request = (async () => {
        const response = await fetchFn(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            model,
            messages: [
              {
                role: 'system',
                content: 'Summarize RSS articles in Simplified Chinese. Be strictly factual and use only information present in the article. Do not fabricate, infer unsupported details, or add outside knowledge.'
              },
              {
                role: 'user',
                content: `Write 2-3 sentences totaling approximately 150-250 Chinese characters. Preserve the article's key facts accurately. Article:\n${truncatedContent}`
              }
            ],
            stream: false
          }),
          signal: controller.signal
        });

        if (response.ok) {
          const data = await response.json();
          const summary = data?.choices?.[0]?.message?.content;
          if (summary) {
            return { summary: summary.trim() };
          }
          throw new Error('Invalid response structure from DeepSeek API');
        }

        return { status: response.status };
      })();

      const result = await Promise.race([request, timeout]);
      if (result.summary !== undefined) {
        return result.summary;
      }

      const classification = classifyError(result.status);
      if (!classification.retryable) {
        throw new Error(`DeepSeek API request failed with non-retryable status ${result.status}`);
      }

      lastError = new Error(`DeepSeek API returned transient status ${result.status}`);
    } catch (err) {
      if (err.message && err.message.includes('non-retryable')) {
        throw err;
      }
      const classification = classifyError(err);
      if (!classification.retryable) {
        throw err;
      }
      lastError = err;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  throw lastError || new Error('Failed to summarize content after retries');
}

export async function summarizeWithFallback(db, apiKey, content, originalSummary, options = {}) {
  const limit = options.limit !== undefined ? options.limit : 200;

  const usage = await consumeDailyUsage(db, limit);
  if (!usage.allowed) {
    if (usage.reason === 'limit') {
      try {
        await enqueue(db, {
          kind: 'system',
          dedupeKey: `system:deepseek-soft-limit:${usage.date}`,
          payload: { message: `DeepSeek daily soft limit reached for Beijing day ${usage.date}; article summaries are using fallback text.` }
        });
      } catch (e) {
        logError('deepseek.soft_limit_enqueue_failed', { error: redactText(e.message) });
      }
    }
    return originalSummary;
  }

  try {
    const summary = await summarizeContent(apiKey, content, options);
    return summary;
  } catch (e) {
    logError('deepseek.summary_failed', { error: redactText(e.message) });
    return originalSummary;
  }
}
