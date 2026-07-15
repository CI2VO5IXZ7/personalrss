import { getBotSession, setBotSession, clearBotSession } from '../db.js';
import { sendMessage } from './api.js';
import { escapeHtml } from '../html.js';
import { redactText, redactUrl } from '../security/url.js';

function buildBaseUrl(env, req) {
  const raw = env.BASE_URL || `https://${new URL(req.url).host}`;
  return String(raw).replace(/\/+$/, '');
}

export async function cancelSession(db, chatId, token) {
  await clearBotSession(db, chatId);
  await sendMessage(token, chatId, '✅ 已取消当前会话。');
}

export async function startSession(db, chatId, flow, step, data, token, prompt) {
  const expiresAt = new Date(Date.now() + 300 * 1000).toISOString();
  await setBotSession(db, chatId, flow, step, data, expiresAt);
  await sendMessage(token, chatId, prompt);
}

export async function handleStockCodeInput(db, chatId, codeInput, token, monitorService) {
  await sendMessage(token, chatId, `🔎 正在查询股票 <code>${escapeHtml(codeInput)}</code> 行情...`);
  try {
    const quote = await monitorService.getQuote(db, codeInput, {
      fetchFn: globalThis.fetch,
      relativeTo: new Date()
    });
    const sessionData = {
      code: quote.symbol,
      currentPrice: quote.price,
      source: quote.source,
      observedAt: quote.observedAt
    };
    await startSession(
      db,
      chatId,
      'monitor_add',
      'await_condition_price',
      sessionData,
      token,
      `📈 股票：<code>${escapeHtml(quote.symbol)}</code>\n当前价格：<b>${quote.price}</b>\n\n请输入阈值条件和目标价格（例如：<code>gte 1800</code> 或 <code>lte 10</code>）：\n(发送 /cancel 退出)`
    );
  } catch (err) {
    const errorMsg = redactText(err.message || '未知错误');
    await startSession(
      db,
      chatId,
      'monitor_add',
      'await_code',
      {},
      token,
      `❌ 查询失败：${escapeHtml(errorMsg)}\n\n请输入正确的股票代码（例如：SHA:603986、SH:603986、SZ:000001 或 603986）：\n(发送 /cancel 退出)`
    );
  }
}

async function handleMonitorAddSession(session, text, {
  env, chatId, token, db, services, req
}) {
  const input = text.trim();
  const monitorService = services.monitor;

  if (session.step === 'await_code') {
    await handleStockCodeInput(db, chatId, input, token, monitorService);
    return;
  }

  if (session.step === 'await_condition_price') {
    const parts = input.toLowerCase().split(/\s+/);
    const condition = parts[0];
    const targetPrice = parseFloat(parts[1]);
    if ((condition !== 'gte' && condition !== 'lte') || Number.isNaN(targetPrice) || targetPrice <= 0) {
      await sendMessage(token, chatId, '❌ 格式错误。请输入正确的条件和目标价格（如 <code>gte 1800</code> 或 <code>lte 10</code>）：\n(发送 /cancel 退出)');
      return;
    }

    const sessionData = JSON.parse(session.data_json);
    const code = sessionData.code;
    const currentPrice = sessionData.currentPrice;

    let satisfied = false;
    if (condition === 'gte') satisfied = currentPrice >= targetPrice;
    else if (condition === 'lte') satisfied = currentPrice <= targetPrice;

    if (satisfied) {
      const nextData = { ...sessionData, condition, targetPrice };
      await startSession(
        db,
        chatId,
        'monitor_add',
        'await_confirmation',
        nextData,
        token,
        `⚠️ 当前价格为 <b>${currentPrice}</b>，已满足阈值条件 <b>${condition === 'gte' ? '≥' : '≤'} ${targetPrice}</b>！\n` +
        `是否确认创建该规则？（发送 “确认” 或 “yes” 确认，发送 /cancel 取消）`
      );
    } else {
      const rule = await monitorService.addStock(db, code, condition, targetPrice);
      await clearBotSession(db, chatId);
      await sendMessage(token, chatId,
        `✅ 已成功添加股票提醒规则：<code>${escapeHtml(rule.targetKey)}</code> ${condition === 'gte' ? '≥' : '≤'} ${rule.conditionValue}\n` +
        `ID: <b>${rule.id}</b>`
      );
    }
    return;
  }

  if (session.step === 'await_confirmation') {
    if (input === '确认' || input.toLowerCase() === 'yes') {
      const sessionData = JSON.parse(session.data_json);
      const { code, condition, targetPrice } = sessionData;
      const rule = await monitorService.addStock(db, code, condition, targetPrice);
      await clearBotSession(db, chatId);
      await sendMessage(token, chatId,
        `✅ 已成功添加股票提醒规则：<code>${escapeHtml(rule.targetKey)}</code> ${condition === 'gte' ? '≥' : '≤'} ${rule.conditionValue}\n` +
        `ID: <b>${rule.id}</b>`
      );
    } else {
      await sendMessage(token, chatId, '❌ 输入不符合要求。请输入 “确认” 或 “yes” 确认创建，或发送 /cancel 退出流程。');
    }
    return;
  }

  await clearBotSession(db, chatId);
  await sendMessage(token, chatId, '❌ 会话状态异常，已重置。');
}

async function handlePushAddSession(session, text, {
  env, chatId, token, db, services
}) {
  const url = text.trim();
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    await sendMessage(token, chatId, '❌ 链接格式错误。请输入以 http:// 或 https:// 开头的链接：\n(发送 /cancel 退出流程)');
    return;
  }

  try {
    const result = await services.push.addSubscription(db, url, env, {
      fetchFn: globalThis.fetch,
      resolver: env.SAFE_FETCH_RESOLVER
    });
    const sub = result.subscription;
    await clearBotSession(db, chatId);
    await sendMessage(token, chatId,
      `✅ 已添加 Push RSS\n\n` +
      `标题：<b>${escapeHtml(result.title || '未命名')}</b>\n` +
      `ID: <b>${sub.id}</b>\n` +
      `URL：<code>${escapeHtml(sub.feed_url_redacted || sub.feed_url)}</code>\n` +
      `首次已推送最新 <b>${result.processResult.count}</b> 篇。`
    );
  } catch (err) {
    await clearBotSession(db, chatId);
    await sendMessage(token, chatId, `❌ 添加失败：${escapeHtml(redactText(err.message))}`);
  }
}

async function handleGenAddSession(session, text, {
  env, chatId, token, db, services, req
}) {
  const baseUrl = buildBaseUrl(env, req);
  const parts = text.trim().split(/\s+/);
  if (parts.length < 2 || parts[0].toLowerCase() !== 'instagram') {
    await sendMessage(token, chatId, '❌ 格式错误。请输入：<code>instagram &lt;username&gt; [displayName]</code>\n(发送 /cancel 退出)');
    return;
  }
  const username = parts[1].trim();
  const displayName = parts.slice(2).join(' ').trim() || username;

  try {
    const instance = await services.generator.create(db, 'instagram', username, {}, displayName);
    const refreshContext = { db, fetch: globalThis.fetch, crypto: globalThis.crypto };
    const refreshResult = await services.generator.refresh(db, instance.id, {
      intervalMinutes: 10,
      retentionLimit: parseInt(env.CACHE_MAX_POSTS || '100', 10),
      context: refreshContext
    });
    const feedUrl = `${baseUrl}/feeds/${instance.id}.xml`;
    const summary = refreshResult.newCount > 0 ? `新增 ${refreshResult.newCount} 条` : '无新条目';
    await clearBotSession(db, chatId);
    await sendMessage(token, chatId,
      `✅ Generator 创建成功\n\n` +
      `类型：Instagram\n` +
      `实例：@${escapeHtml(instance.instanceKey)}\n` +
      `ID：${instance.id}\n` +
      `RSS：<code>${escapeHtml(feedUrl)}</code>\n` +
      `刷新结果：${summary}\n\n` +
      `当前只生成 RSS，尚未加入 Telegram Push。\n` +
      `需要推送时执行：/push_add rss ${escapeHtml(feedUrl)}`
    );
  } catch (err) {
    await clearBotSession(db, chatId);
    await sendMessage(token, chatId, `❌ 创建失败：${escapeHtml(redactText(err.message))}`);
  }
}

export async function handleSessionMessage({
  session,
  text,
  env,
  chatId,
  token,
  db,
  services,
  req
}) {
  const input = text.trim();
  if (input === '/cancel') {
    await cancelSession(db, chatId, token);
    return;
  }

  const context = { env, chatId, token, db, services, req };

  if (session.flow === 'monitor_add') {
    await handleMonitorAddSession(session, input, context);
  } else if (session.flow === 'push_add') {
    await handlePushAddSession(session, input, context);
  } else if (session.flow === 'gen_add') {
    await handleGenAddSession(session, input, context);
  } else {
    await clearBotSession(db, chatId);
    await sendMessage(token, chatId, '❌ 未知会话，已重置。');
  }
}
