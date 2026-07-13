import { describe, it, expect, vi } from 'vitest';
import app from '../../src/index.js';

describe('Telegram Command Authentication', () => {
  const dbMock = {
    prepare: vi.fn().mockImplementation(() => {
      const stmt = {
        bind: vi.fn().mockImplementation(() => stmt),
        first: vi.fn().mockResolvedValue(null)
      };
      return stmt;
    })
  };

  it('should validate only chat ID if TELEGRAM_ADMIN_USER_ID is not configured', async () => {
    const payload = {
      message: {
        text: '/help',
        chat: { id: 'allowed_chat_123' },
        from: { id: 'some_user_999' }
      }
    };

    const req = new Request('https://worker.local/telegram', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': 'secret-token'
      },
      body: JSON.stringify(payload)
    });

    const env = {
      DB: dbMock,
      TELEGRAM_CHAT_ID: 'allowed_chat_123',
      ADMIN_TOKEN: 'secret-token',
      TELEGRAM_BOT_TOKEN: 'bot-token'
    };

    const ctx = {
      waitUntil: vi.fn()
    };

    const res = await app.fetch(req, env, ctx);
    expect(res.status).toBe(200);
    // Since it matches chat ID and no admin user id is configured, it should call handleCommand
    expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
  });

  it('should reject request if chat ID matches but TELEGRAM_ADMIN_USER_ID is configured and does not match', async () => {
    const payload = {
      message: {
        text: '/help',
        chat: { id: 'allowed_chat_123' },
        from: { id: 'unauthorized_user_888' }
      }
    };

    const req = new Request('https://worker.local/telegram', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': 'secret-token'
      },
      body: JSON.stringify(payload)
    });

    const env = {
      DB: dbMock,
      TELEGRAM_CHAT_ID: 'allowed_chat_123',
      TELEGRAM_ADMIN_USER_ID: 'authorized_admin_777',
      ADMIN_TOKEN: 'secret-token',
      TELEGRAM_BOT_TOKEN: 'bot-token'
    };

    const ctx = {
      waitUntil: vi.fn()
    };

    const res = await app.fetch(req, env, ctx);
    expect(res.status).toBe(200);
    // Should NOT spawn command handler because user ID did not match
    expect(ctx.waitUntil).not.toHaveBeenCalled();
  });

  it('should accept request if chat ID matches and TELEGRAM_ADMIN_USER_ID is configured and matches', async () => {
    const payload = {
      message: {
        text: '/help',
        chat: { id: 'allowed_chat_123' },
        from: { id: 'authorized_admin_777' }
      }
    };

    const req = new Request('https://worker.local/telegram', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': 'secret-token'
      },
      body: JSON.stringify(payload)
    });

    const env = {
      DB: dbMock,
      TELEGRAM_CHAT_ID: 'allowed_chat_123',
      TELEGRAM_ADMIN_USER_ID: 'authorized_admin_777',
      ADMIN_TOKEN: 'secret-token',
      TELEGRAM_BOT_TOKEN: 'bot-token'
    };

    const ctx = {
      waitUntil: vi.fn()
    };

    const res = await app.fetch(req, env, ctx);
    expect(res.status).toBe(200);
    // Should spawn command handler
    expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
  });
});
