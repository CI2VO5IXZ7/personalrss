import { Hono } from 'hono';
import { deriveWebhookSecret, verifyWebhookSecret, sendMessage, parseCommand, setMyCommands, setWebhook, answerCallbackQuery } from './api.js';
import { handleCommand, isKnownCommand } from './commands.js';
import { handleSessionMessage, cancelSession } from './sessions.js';
import { getTelegramBotCommands, buildTelegramHelpMessage } from '../telegram_commands.js';
import { getBotSession, clearBotSession } from '../db.js';
import { escapeHtml } from '../html.js';
import { redactText } from '../security/url.js';
import { logError, logInfo, logWarn } from '../log.js';
import { requireAdmin } from './auth.js';

function getBaseUrl(env, req) {
  const raw = env.BASE_URL || `https://${new URL(req.url).host}`;
  return String(raw).replace(/\/+$/, '');
}

function truncate(value, max = 120) {
  if (!value) return '';
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

function safeTelegramSetupFailure(c, stage, error) {
  let message = redactText(error?.message || 'Telegram request failed');
  for (const secret of [c.env.ADMIN_TOKEN, c.env.TELEGRAM_BOT_TOKEN]) {
    if (typeof secret === 'string' && secret) {
      message = message.split(secret).join('***');
    }
  }

  const failure = {
    ok: false,
    stage,
    status: Number.isInteger(error?.status) ? error.status : null,
    message: truncate(message, 300)
  };
  logError('telegram.setup_failed', failure);
  return c.json(failure, 502);
}

export function createTelegramRouter({ generatorService, monitorService, pushService }) {
  const router = new Hono();

  router.post('/telegram', async (c) => {
    let expectedWebhookSecret;
    try {
      expectedWebhookSecret = await deriveWebhookSecret(c.env.ADMIN_TOKEN);
    } catch {
      logError('telegram.webhook_secret_unavailable', {});
      return c.text('ok');
    }

    if (!verifyWebhookSecret(c.req.raw, expectedWebhookSecret)) {
      logWarn('telegram.webhook_secret_rejected', {});
      return c.text('ok');
    }

    let update;
    try {
      update = await c.req.json();
    } catch {
      return c.text('ok');
    }

    const callbackQuery = update.callback_query;
    if (callbackQuery) {
      const callbackQueryId = callbackQuery.id;
      const msg = callbackQuery.message;
      const chatId = msg?.chat?.id;
      const fromUserId = callbackQuery.from?.id;
      const chatType = msg?.chat?.type;
      const callbackData = callbackQuery.data;
      const token = c.env.TELEGRAM_BOT_TOKEN;
      const allowedChat = c.env.TELEGRAM_CHAT_ID;
      const adminUserId = c.env.TELEGRAM_ADMIN_USER_ID;

      if (chatType !== 'private') {
        logWarn('telegram.callback_chat_type_rejected', { chatType });
        return c.text('ok');
      }

      if (String(chatId) !== String(allowedChat)) {
        logWarn('telegram.callback_chat_rejected', { chatId });
        return c.text('ok');
      }

      if (!adminUserId || String(fromUserId || '') !== String(adminUserId)) {
        logWarn('telegram.callback_user_rejected', { fromUserId });
        return c.text('ok');
      }

      const db = c.env.DB;
      const session = await getBotSession(db, chatId);

      const { getProviderByCallbackData, getProviderSelectionTransition } = await import('../monitors/catalog.js');
      const provider = getProviderByCallbackData(callbackData);

      if (session && session.flow === 'monitor_add' && session.step === 'await_type' && provider) {
        c.executionCtx.waitUntil((async () => {
          try {
            await answerCallbackQuery(token, callbackQueryId);
            const transition = getProviderSelectionTransition(provider);
            const { startSession } = await import('./sessions.js');
            await startSession(
              db,
              chatId,
              'monitor_add',
              transition.nextStep,
              transition.sessionData,
              token,
              transition.prompt
            );
          } catch (err) {
            logError('telegram.callback_transition_failed', {
              error: redactText(err.message || String(err))
            });
          }
        })());
        return c.text('ok');
      } else {
        c.executionCtx.waitUntil((async () => {
          try {
            await answerCallbackQuery(token, callbackQueryId, {
              text: '操作已过期或无效。',
              show_alert: false
            });
          } catch (err) {
            logError('telegram.callback_answer_failed', {
              error: redactText(err.message || String(err))
            });
          }
        })());
        return c.text('ok');
      }
    }

    const msg = update.message;
    if (!msg?.text) return c.text('ok');

    const chatId = msg.chat?.id;
    const token = c.env.TELEGRAM_BOT_TOKEN;
    const allowedChat = c.env.TELEGRAM_CHAT_ID;

    if (msg.chat?.type !== 'private') {
      logWarn('telegram.chat_type_rejected', { chatType: msg.chat?.type });
      return c.text('ok');
    }

    if (String(chatId) !== String(allowedChat)) {
      logWarn('telegram.chat_rejected', { chatId });
      return c.text('ok');
    }

    const adminUserId = c.env.TELEGRAM_ADMIN_USER_ID;
    if (!adminUserId || String(msg.from?.id || '') !== String(adminUserId)) {
      logWarn('telegram.user_rejected', { fromUserId: msg.from?.id });
      return c.text('ok');
    }

    const db = c.env.DB;
    const session = await getBotSession(db, chatId);

    if (session) {
      const parsed = parseCommand(msg.text);
      if (parsed) {
        if (parsed.cmd === 'cancel') {
          c.executionCtx.waitUntil(cancelSession(db, chatId, token));
          return c.text('ok');
        }
        if (isKnownCommand(parsed.cmd)) {
          c.executionCtx.waitUntil((async () => {
            await clearBotSession(db, chatId);
            await handleCommand({
              cmd: parsed.cmd,
              args: parsed.args,
              env: c.env,
              chatId,
              token,
              db,
              services: { generator: generatorService, monitor: monitorService, push: pushService },
              req: c.req.raw
            });
          })());
          return c.text('ok');
        }
        // Unknown slash command
        c.executionCtx.waitUntil(sendMessage(
          token,
          chatId,
          `未知命令 /${escapeHtml(parsed.cmd)}，发送 /help 查看可用命令，或发送 /cancel 退出当前会话。`
        ));
        return c.text('ok');
      }
      c.executionCtx.waitUntil(handleSessionMessage({
        session,
        text: msg.text,
        env: c.env,
        chatId,
        token,
        db,
        services: { generator: generatorService, monitor: monitorService, push: pushService },
        req: c.req.raw
      }));
      return c.text('ok');
    }

    const parsed = parseCommand(msg.text);
    if (!parsed || !isKnownCommand(parsed.cmd)) {
      if (parsed) {
        c.executionCtx.waitUntil(sendMessage(token, chatId, `未知命令 /${escapeHtml(parsed.cmd)}，发送 /help 查看可用命令。`));
      }
      return c.text('ok');
    }

    c.executionCtx.waitUntil(handleCommand({
      cmd: parsed.cmd,
      args: parsed.args,
      env: c.env,
      chatId,
      token,
      db,
      services: { generator: generatorService, monitor: monitorService, push: pushService },
      req: c.req.raw
    }));
    return c.text('ok');
  });

  router.post('/setup-webhook', async (c) => {
    const unauthorized = requireAdmin(c);
    if (unauthorized) return unauthorized;

    const baseUrl = getBaseUrl(c.env, c.req.raw);
    let webhook;
    try {
      const secretToken = await deriveWebhookSecret(c.env.ADMIN_TOKEN);
      webhook = await setWebhook(c.env.TELEGRAM_BOT_TOKEN, `${baseUrl}/telegram`, secretToken);
    } catch (error) {
      return safeTelegramSetupFailure(c, 'setWebhook', error);
    }

    let commands;
    try {
      commands = await setMyCommands(c.env.TELEGRAM_BOT_TOKEN, getTelegramBotCommands());
      logInfo('telegram.commands_synced', { count: getTelegramBotCommands().length });
    } catch (error) {
      return safeTelegramSetupFailure(c, 'setMyCommands', error);
    }

    return c.json({ webhook, commands });
  });

  router.post('/admin/sync-telegram-commands', async (c) => {
    const unauthorized = requireAdmin(c);
    if (unauthorized) return unauthorized;

    const result = await setMyCommands(c.env.TELEGRAM_BOT_TOKEN, getTelegramBotCommands());
    logInfo('telegram.commands_synced', { count: getTelegramBotCommands().length });
    return c.json({ commands: result });
  });

  return router;
}
