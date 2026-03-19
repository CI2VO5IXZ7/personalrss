// Telegram Bot API helpers

const TG_API = 'https://api.telegram.org/bot';

export async function sendMessage(token, chatId, text, parseMode = 'HTML') {
  const resp = await fetch(`${TG_API}${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: parseMode,
      disable_web_page_preview: true
    })
  });
  return resp.json();
}

export async function sendPhoto(token, chatId, photoBytes, caption = '') {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('photo', new Blob([photoBytes], { type: 'image/png' }), 'qr.png');
  if (caption) {
    form.append('caption', caption);
    form.append('parse_mode', 'HTML');
  }
  const resp = await fetch(`${TG_API}${token}/sendPhoto`, {
    method: 'POST',
    body: form
  });
  return resp.json();
}

export async function setWebhook(token, url, secretToken = '') {
  const body = { url };
  if (secretToken) body.secret_token = secretToken;
  const resp = await fetch(`${TG_API}${token}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return resp.json();
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
