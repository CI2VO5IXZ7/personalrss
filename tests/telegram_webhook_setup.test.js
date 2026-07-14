import { describe, expect, it, vi } from 'vitest';
import app from '../src/index.js';
import { deriveWebhookSecret } from '../src/telegram.js';

const adminToken = 'Adm!n:T0ken/with?punctuation&symbols=%23+[]{}';
const botToken = 'management-bot-token';

function telegramOk(result = true) {
  return {
    status: 200,
    ok: true,
    json: async () => ({ ok: true, result })
  };
}

function telegramFailure(status, description) {
  return {
    status,
    ok: false,
    json: async () => ({ ok: false, description })
  };
}

function setupRequest(token = adminToken) {
  return new Request('https://worker.example/setup-webhook', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` }
  });
}

function webhookRequest(secret) {
  return new Request('https://worker.example/telegram', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Bot-Api-Secret-Token': secret
    },
    body: JSON.stringify({
      message: {
        text: '/help',
        chat: { id: '12345', type: 'private' },
        from: { id: '67890' }
      }
    })
  });
}

function webhookEnv(adminTokenValue = adminToken) {
  const statement = { bind: vi.fn(), first: vi.fn().mockResolvedValue(null) };
  statement.bind.mockReturnValue(statement);
  return {
    ADMIN_TOKEN: adminTokenValue,
    TELEGRAM_BOT_TOKEN: botToken,
    TELEGRAM_CHAT_ID: '12345',
    TELEGRAM_ADMIN_USER_ID: '67890',
    DB: { prepare: vi.fn().mockReturnValue(statement) }
  };
}

describe('Telegram webhook setup and verification', () => {
  it('uses the derived webhook secret for setWebhook while keeping raw admin authorization', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(telegramOk());
    globalThis.fetch = fetchSpy;

    const response = await app.fetch(setupRequest(), {
      ADMIN_TOKEN: adminToken,
      TELEGRAM_BOT_TOKEN: botToken,
      BASE_URL: 'https://worker.example'
    });

    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const setWebhookBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
    const derivedSecret = await deriveWebhookSecret(adminToken);
    expect(setWebhookBody.secret_token).toBe(derivedSecret);
    expect(setWebhookBody.secret_token).not.toBe(adminToken);
  });

  it('returns and logs a safe structured setWebhook failure', async () => {
    const credential = 'url-credential-value';
    const description = `Rejected ADMIN_TOKEN=${adminToken} at https://user:password@example.com/hook?token=${credential}`;
    globalThis.fetch = vi.fn().mockResolvedValue(telegramFailure(400, description));
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await app.fetch(setupRequest(), {
      ADMIN_TOKEN: adminToken,
      TELEGRAM_BOT_TOKEN: botToken,
      BASE_URL: 'https://worker.example'
    });
    const payload = await response.json();
    const logged = errorLog.mock.calls.flat().join(' ');
    errorLog.mockRestore();

    expect(response.status).toBe(502);
    expect(payload).toEqual({
      ok: false,
      stage: 'setWebhook',
      status: 400,
      message: expect.any(String)
    });
    for (const secret of [adminToken, botToken, credential, 'password']) {
      expect(JSON.stringify(payload)).not.toContain(secret);
      expect(logged).not.toContain(secret);
    }
    expect(payload.message).toContain('***');
  });

  it('returns a separately staged safe setMyCommands failure', async () => {
    const credential = 'commands-url-credential';
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(telegramOk())
      .mockResolvedValueOnce(telegramFailure(
        429,
        `Command sync failed at https://user:password@example.com/sync?secret=${credential}`
      ));
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await app.fetch(setupRequest(), {
      ADMIN_TOKEN: adminToken,
      TELEGRAM_BOT_TOKEN: botToken,
      BASE_URL: 'https://worker.example'
    });
    const payload = await response.json();
    const logged = errorLog.mock.calls.flat().join(' ');
    errorLog.mockRestore();

    expect(response.status).toBe(502);
    expect(payload).toEqual({
      ok: false,
      stage: 'setMyCommands',
      status: 429,
      message: expect.any(String)
    });
    for (const secret of [adminToken, botToken, credential, 'password']) {
      expect(JSON.stringify(payload)).not.toContain(secret);
      expect(logged).not.toContain(secret);
    }
  });

  it('rejects the raw ADMIN_TOKEN as a webhook header', async () => {
    const ctx = { waitUntil: vi.fn() };

    const response = await app.fetch(webhookRequest(adminToken), webhookEnv(), ctx);

    expect(response.status).toBe(200);
    expect(ctx.waitUntil).not.toHaveBeenCalled();
  });

  it('accepts the derived webhook header', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(telegramOk({ message_id: 1 }));
    const ctx = { waitUntil: vi.fn() };
    const derivedSecret = await deriveWebhookSecret(adminToken);

    const response = await app.fetch(webhookRequest(derivedSecret), webhookEnv(), ctx);

    expect(response.status).toBe(200);
    expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
    await ctx.waitUntil.mock.calls[0][0];
  });

  it('fails closed when webhook ADMIN_TOKEN configuration is empty', async () => {
    const ctx = { waitUntil: vi.fn() };

    const response = await app.fetch(webhookRequest('anything'), webhookEnv(''), ctx);

    expect(response.status).toBe(200);
    expect(ctx.waitUntil).not.toHaveBeenCalled();
  });
});
