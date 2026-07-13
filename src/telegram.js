// Telegram Bot API helpers

import { escapeHtml } from './html.js';
import { logError } from './log.js';
import { redactUrl, redactText } from './security/url.js';

const TG_API = 'https://api.telegram.org/bot';

export class TelegramError extends Error {
  constructor(message, status, retryAfter = null) {
    super(message);
    this.name = 'TelegramError';
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

async function parseTelegramResponse(resp, action) {
  let data = null;
  try {
    data = await resp.json();
  } catch {
    logError('telegram.response_parse_failed', { action, status: resp.status });
    throw new TelegramError(`Telegram ${action} returned a non-JSON response`, resp.status);
  }

  if (!resp.ok || !data?.ok) {
    const description = data?.description || `Telegram ${action} HTTP ${resp.status}`;
    logError('telegram.request_failed', {
      action,
      status: resp.status,
      description
    });
    const retryAfter = data?.parameters?.retry_after || null;
    throw new TelegramError(description, resp.status, retryAfter);
  }

  return data;
}

export async function sendMessage(token, chatId, text, parseModeOrOptions = 'HTML', options = {}) {
  let parseMode = 'HTML';
  let opts = {};
  if (typeof parseModeOrOptions === 'object' && parseModeOrOptions !== null) {
    opts = parseModeOrOptions;
    parseMode = opts.parseMode || 'HTML';
  } else {
    parseMode = parseModeOrOptions;
    opts = options || {};
  }
  const fetchFn = opts.fetchFn || fetch;
  const resp = await fetchFn(`${TG_API}${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: parseMode,
      disable_web_page_preview: true
    })
  });
  return parseTelegramResponse(resp, 'sendMessage');
}

export async function sendPhotoWithFallback(token, chatId, photoUrl, caption = '', options = {}) {
  const fetchFn = options?.fetchFn || fetch;
  if (!photoUrl) {
    return sendMessage(token, chatId, caption, 'HTML', options);
  }
  try {
    const resp = await fetchFn(`${TG_API}${token}/sendPhoto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        photo: photoUrl,
        caption: caption,
        parse_mode: 'HTML'
      })
    });
    return await parseTelegramResponse(resp, 'sendPhoto');
  } catch (err) {
    if (err instanceof TelegramError && err.status === 429) {
      throw err;
    }
    console.warn(`[telegram] sendPhoto failed for ${redactUrl(photoUrl)}, falling back to sendMessage:`, redactText(err.message));
    return sendMessage(token, chatId, caption, 'HTML', options);
  }
}

export async function sendPhoto(token, chatId, photoBytes, caption = '', options = {}) {
  const fetchFn = options?.fetchFn || fetch;
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('photo', new Blob([photoBytes], { type: 'image/png' }), 'qr.png');
  if (caption) {
    form.append('caption', caption);
    form.append('parse_mode', 'HTML');
  }
  const resp = await fetchFn(`${TG_API}${token}/sendPhoto`, {
    method: 'POST',
    body: form
  });
  return parseTelegramResponse(resp, 'sendPhoto');
}

export async function setWebhook(token, url, secretTokenOrOptions = '', options = {}) {
  let secretToken = '';
  let opts = {};
  if (typeof secretTokenOrOptions === 'object' && secretTokenOrOptions !== null) {
    opts = secretTokenOrOptions;
    secretToken = opts.secretToken || '';
  } else {
    secretToken = secretTokenOrOptions;
    opts = options || {};
  }
  const fetchFn = opts.fetchFn || fetch;
  const body = { url };
  if (secretToken) body.secret_token = secretToken;
  const resp = await fetchFn(`${TG_API}${token}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return parseTelegramResponse(resp, 'setWebhook');
}

export async function setMyCommands(token, commands, options = {}) {
  const fetchFn = options?.fetchFn || fetch;
  const resp = await fetchFn(`${TG_API}${token}/setMyCommands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ commands })
  });
  return parseTelegramResponse(resp, 'setMyCommands');
}

export function verifyWebhookSecret(request, expectedSecret) {
  if (!expectedSecret) return true;
  const header = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
  return header === expectedSecret;
}

export function parseCommand(text) {
  if (!text || !text.startsWith('/')) return null;
  const parts = text.split(/\s+/);
  const cmd = parts[0].replace('/', '').replace(/@.*$/, '').toLowerCase();
  return { cmd, args: parts.slice(1) };
}

export { escapeHtml };
