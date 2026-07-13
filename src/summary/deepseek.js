export function getBeijingDate() {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const parts = formatter.formatToParts(new Date());
  const year = parts.find(p => p.type === 'year').value;
  const month = parts.find(p => p.type === 'month').value;
  const day = parts.find(p => p.type === 'day').value;
  return `${year}-${month}-${day}`;
}

export async function checkAndIncrementUsage(db, limit) {
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

    return result.meta.changes > 0;
  } catch (e) {
    console.error('[deepseek] checkAndIncrementUsage error:', e.message);
    return false;
  }
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
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
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
              content: 'You are a helpful assistant summarizing RSS articles in Chinese.'
            },
            {
              role: 'user',
              content: `Summarize this content in 2-3 sentences: ${truncatedContent}`
            }
          ],
          stream: false
        }),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        const data = await response.json();
        const summary = data?.choices?.[0]?.message?.content;
        if (summary) {
          return summary.trim();
        }
        throw new Error('Invalid response structure from DeepSeek API');
      }

      const status = response.status;
      const classification = classifyError(status);
      if (!classification.retryable) {
        throw new Error(`DeepSeek API request failed with non-retryable status ${status}`);
      }
      
      lastError = new Error(`DeepSeek API returned transient status ${status}`);
    } catch (err) {
      clearTimeout(timeoutId);
      if (err.message && err.message.includes('non-retryable')) {
        throw err;
      }
      const classification = classifyError(err);
      if (!classification.retryable) {
        throw err;
      }
      lastError = err;
    }
  }

  throw lastError || new Error('Failed to summarize content after retries');
}

export async function summarizeWithFallback(db, apiKey, content, originalSummary, options = {}) {
  const limit = options.limit !== undefined ? options.limit : 200;
  
  const allowed = await checkAndIncrementUsage(db, limit);
  if (!allowed) {
    return originalSummary;
  }

  try {
    const summary = await summarizeContent(apiKey, content, options);
    return summary;
  } catch (e) {
    console.error('[deepseek] Summary failed, falling back to original description:', e.message);
    return originalSummary;
  }
}
