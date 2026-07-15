import { sendMessage, setMyCommands } from './api.js';
import { getTelegramBotCommands } from '../telegram_commands.js';
import { escapeHtml } from '../html.js';
import { redactText } from '../security/url.js';
import { clearBotSession } from '../db.js';
import { startSession, handleStockCodeInput } from './sessions.js';
import { buildMonitorCategoryKeyboard } from '../monitors/catalog.js';

function parsePositiveInteger(value) {
  const str = String(value).trim();
  if (!/^[1-9]\d*$/.test(str)) {
    return null;
  }
  return parseInt(str, 10);
}

function getCacheMaxPosts(env) {
  const val = env?.CACHE_MAX_POSTS;
  if (val === undefined || val === null) {
    return 100;
  }
  const str = String(val).trim();
  if (!/^[1-9]\d*$/.test(str)) {
    return 100;
  }
  return parseInt(str, 10);
}

function buildBaseUrl(env, req) {
  const raw = env.BASE_URL || `https://${new URL(req.url).host}`;
  return String(raw).replace(/\/+$/, '');
}

function handleError(token, chatId, err) {
  const message = redactText(err?.message || '未知错误');
  return sendMessage(token, chatId, `❌ 命令执行失败：${escapeHtml(message)}`);
}

export async function handleCommand({
  cmd,
  args,
  env,
  chatId,
  token,
  db,
  services,
  req
}) {
  const baseUrl = buildBaseUrl(env, req);
  const { generator: generatorService, monitor: monitorService, push: pushService } = services;

  try {
    switch (cmd) {
      case 'help': {
        const { buildTelegramHelpMessage } = await import('../telegram_commands.js');
        await sendMessage(token, chatId, buildTelegramHelpMessage());
        break;
      }

      case 'gen_add': {
        if (args.length < 2) {
          await startSession(
            db, chatId, 'gen_add', 'await_type_username', {}, token,
            '请选择 Generator 类型并输入用户名（目前支持 <code>instagram &lt;username&gt; [displayName]</code>）：\n(发送 /cancel 退出)'
          );
          break;
        }
        if (args[0].toLowerCase() !== 'instagram') {
          await sendMessage(token, chatId, '❌ 用法：/gen_add instagram &lt;username&gt; [displayName]');
          break;
        }
        if (!args[1]) {
          await startSession(
            db, chatId, 'gen_add', 'await_type_username', {}, token,
            '请输入 Instagram 用户名：\n(发送 /cancel 退出)'
          );
          break;
        }
        const username = args[1].trim();
        const displayName = args.slice(2).join(' ').trim() || username;

        await sendMessage(token, chatId, `🔎 正在创建 Instagram Generator <code>${escapeHtml(username)}</code>...`);
        const instance = await generatorService.create(db, 'instagram', username, {}, displayName);

        await sendMessage(token, chatId, `🔄 正在立即刷新实例 ${instance.id}...`);
        const refreshContext = {
          db,
          fetch: globalThis.fetch,
          crypto: globalThis.crypto
        };
        const refreshResult = await generatorService.refresh(db, instance.id, {
          intervalMinutes: 10,
          retentionLimit: getCacheMaxPosts(env),
          context: refreshContext
        });

        const feedUrl = `${baseUrl}/feeds/${instance.id}.xml`;
        const summary = refreshResult.newCount > 0
          ? `新增 ${refreshResult.newCount} 条`
          : '无新条目';

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
        break;
      }

      case 'gen_list': {
        const instances = await generatorService.list(db);
        if (instances.length === 0) {
          await sendMessage(token, chatId, '📭 暂无 Generator，使用 /gen_add 添加。');
          break;
        }
        let msg = '📋 <b>Generator 列表</b>\n\n';
        for (const inst of instances) {
          msg += `ID: <b>${inst.id}</b> - ${escapeHtml(inst.displayName || inst.instanceKey)} (${escapeHtml(inst.providerType)}, ${escapeHtml(inst.status)})\n`;
          msg += `RSS: <code>${escapeHtml(`${baseUrl}/feeds/${inst.id}.xml`)}</code>\n\n`;
        }
        await sendMessage(token, chatId, msg);
        break;
      }

      case 'gen_feed': {
        const id = parsePositiveInteger(args[0]);
        if (!id) {
          await sendMessage(token, chatId, '❌ 用法：/gen_feed &lt;id&gt;');
          break;
        }
        const instance = await generatorService.get(db, id);
        if (!instance) {
          await sendMessage(token, chatId, `⚠️ 未找到 ID 为 <b>${id}</b> 的 Generator。`);
          break;
        }
        const feedUrl = `${baseUrl}/feeds/${instance.id}.xml`;
        await sendMessage(token, chatId,
          `📡 <b>${escapeHtml(instance.displayName || instance.instanceKey)}</b>\n` +
          `ID: <b>${instance.id}</b>\n` +
          `RSS：<code>${escapeHtml(feedUrl)}</code>`
        );
        break;
      }

      case 'gen_refresh': {
        const id = parsePositiveInteger(args[0]);
        if (!id) {
          await sendMessage(token, chatId, '❌ 用法：/gen_refresh &lt;id&gt;');
          break;
        }
        const instance = await generatorService.get(db, id);
        if (!instance) {
          await sendMessage(token, chatId, `⚠️ 未找到 ID 为 <b>${id}</b> 的 Generator。`);
          break;
        }
        await sendMessage(token, chatId, `🔄 正在刷新 Generator ${id}...`);
        const refreshContext = { db, fetch: globalThis.fetch, crypto: globalThis.crypto };
        const result = await generatorService.refresh(db, id, {
          intervalMinutes: 10,
          retentionLimit: getCacheMaxPosts(env),
          context: refreshContext
        });
        const summary = result.newCount > 0
          ? `✅ 刷新完成：新增 ${result.newCount} 条，共 ${result.itemCount} 条`
          : '✅ 刷新完成：无新条目';
        await sendMessage(token, chatId, summary);
        break;
      }

      case 'gen_pause':
      case 'gen_resume':
      case 'gen_remove': {
        const id = parsePositiveInteger(args[0]);
        if (!id) {
          await sendMessage(token, chatId, `❌ 用法：/${cmd} &lt;id&gt;`);
          break;
        }
        const instance = await generatorService.get(db, id);
        if (!instance) {
          await sendMessage(token, chatId, `⚠️ 未找到 ID 为 <b>${id}</b> 的 Generator。`);
          break;
        }
        let ok = false;
        if (cmd === 'gen_pause') ok = await generatorService.pause(db, id);
        else if (cmd === 'gen_resume') ok = await generatorService.resume(db, id);
        else ok = await generatorService.remove(db, id);

        const actionMap = { gen_pause: '暂停', gen_resume: '恢复', gen_remove: '删除' };
        await sendMessage(token, chatId, ok
          ? `✅ 已${actionMap[cmd]} Generator ID: <b>${id}</b>`
          : `⚠️ ${actionMap[cmd]} Generator ID: <b>${id}</b> 失败。`
        );
        break;
      }

      case 'push_add': {
        if (args.length < 2 || args[0].toLowerCase() !== 'rss') {
          if (args.length > 0 && args[0].toLowerCase() !== 'rss') {
            await sendMessage(token, chatId, '❌ 用法：/push_add rss &lt;url&gt;');
            break;
          }
          await startSession(
            db, chatId, 'push_add', 'await_url', {}, token,
            '请输入要订阅的 RSS 链接：\n(发送 /cancel 退出)'
          );
          break;
        }
        const url = args[1].trim();
        await sendMessage(token, chatId, `🔎 正在检测并添加 RSS 订阅源...`);
        const result = await pushService.addSubscription(db, url, env, {
          fetchFn: globalThis.fetch,
          resolver: env.SAFE_FETCH_RESOLVER
        });
        const sub = result.subscription;
        await sendMessage(token, chatId,
          `✅ 已添加 Push RSS\n\n` +
          `标题：<b>${escapeHtml(result.title || '未命名')}</b>\n` +
          `ID: <b>${sub.id}</b>\n` +
          `URL：<code>${escapeHtml(sub.feed_url_redacted || sub.feed_url)}</code>\n` +
          `首次已推送最新 <b>${result.processResult.count}</b> 篇。`
        );
        break;
      }

      case 'push_list': {
        const subs = await pushService.listSubscriptions(db);
        if (subs.length === 0) {
          await sendMessage(token, chatId, '📭 暂无 Push 订阅，使用 /push_add rss &lt;url&gt; 添加。');
          break;
        }
        let msg = '📋 <b>Push RSS 订阅列表</b>\n\n';
        for (const s of subs) {
          msg += `ID: <b>${s.id}</b> - ${escapeHtml(s.title || '未命名')} (${escapeHtml(s.status)}, ${s.interval_minutes}m)\n`;
          msg += `URL: <code>${escapeHtml(s.feed_url_redacted || s.feed_url)}</code>\n\n`;
        }
        await sendMessage(token, chatId, msg);
        break;
      }

      case 'push_refresh':
      case 'push_pause':
      case 'push_resume':
      case 'push_remove': {
        const id = parsePositiveInteger(args[0]);
        if (!id) {
          await sendMessage(token, chatId, `❌ 用法：/${cmd} &lt;id&gt;`);
          break;
        }
        let ok = false;
        let result = null;
        try {
          if (cmd === 'push_refresh') {
            result = await pushService.refreshSubscription(db, id, env, {
              fetchFn: globalThis.fetch,
              resolver: env.SAFE_FETCH_RESOLVER
            });
            ok = result && result.success;
          } else if (cmd === 'push_pause') {
            ok = await pushService.pauseSubscription(db, id);
          } else if (cmd === 'push_resume') {
            ok = await pushService.resumeSubscription(db, id);
          } else {
            ok = await pushService.removeSubscription(db, id);
          }
        } catch (err) {
          return handleError(token, chatId, err);
        }
        const actionMap = { push_refresh: '刷新', push_pause: '暂停', push_resume: '恢复', push_remove: '删除' };
        if (cmd === 'push_refresh') {
          await sendMessage(token, chatId, ok
            ? `✅ 已刷新 Push 订阅 ID: <b>${id}</b>，入队 ${result.count} 篇`
            : `⚠️ 刷新 Push 订阅 ID: <b>${id}</b> 失败。`
          );
        } else {
          await sendMessage(token, chatId, ok
            ? `✅ 已${actionMap[cmd]} Push 订阅 ID: <b>${id}</b>`
            : `⚠️ ${actionMap[cmd]} Push 订阅 ID: <b>${id}</b> 失败。`
          );
        }
        break;
      }

      case 'monitor_add': {
        // Case 1: Full 4 parameters: /monitor_add stock <code> <gte|lte> <price>
        if (args.length >= 4 && args[0].toLowerCase() === 'stock') {
          const code = args[1].trim();
          const condition = args[2].trim().toLowerCase();
          const price = parseFloat(args[3].trim());
          if (condition !== 'gte' && condition !== 'lte') {
            await sendMessage(token, chatId, '❌ 条件必须为 gte 或 lte。');
            break;
          }
          if (Number.isNaN(price) || price <= 0) {
            await sendMessage(token, chatId, '❌ 目标价必须是正数。');
            break;
          }
          const rule = await monitorService.addStock(db, code, condition, price);
          const condSymbol = condition === 'gte' ? '≥' : '≤';
          await sendMessage(token, chatId,
            `✅ 已添加股票提醒规则：<code>${escapeHtml(rule.targetKey)}</code> ${condSymbol} ${rule.conditionValue}\n` +
            `ID: <b>${rule.id}</b>`
          );
          break;
        }

        // Case 2: Incomplete args but with stock and code: /monitor_add stock <code>
        if (args.length === 2 && args[0].toLowerCase() === 'stock') {
          const code = args[1].trim();
          await handleStockCodeInput(db, chatId, code, token, monitorService);
          break;
        }

        // Case 3: One arg 'stock': /monitor_add stock
        if (args.length === 1 && args[0].toLowerCase() === 'stock') {
          await startSession(
            db, chatId, 'monitor_add', 'await_code', {}, token,
            '请输入股票代码：\n(发送 /cancel 退出)'
          );
          break;
        }

        // Case 4: Zero args: /monitor_add
        if (args.length === 0) {
          await startSession(
            db, chatId, 'monitor_add', 'await_type', {}, token,
            '请选择监控类别：\n(发送 /cancel 退出)',
            { reply_markup: buildMonitorCategoryKeyboard() }
          );
          break;
        }

        // Case 5: Other invalid formats (e.g. /monitor_add invalid_provider)
        await sendMessage(token, chatId, '❌ 用法：/monitor_add stock &lt;code&gt; &lt;gte|lte&gt; &lt;price&gt;');
        break;
      }

      case 'monitor_list': {
        const rules = await monitorService.list(db);
        if (rules.length === 0) {
          await sendMessage(token, chatId, '📭 暂无股票提醒，使用 /monitor_add 添加。');
          break;
        }
        let msg = '📋 <b>股票提醒列表</b>\n\n';
        for (const r of rules) {
          const cond = r.conditionType === 'gte' ? 'gte (≥)' : 'lte (≤)';
          msg += `ID: <b>${r.id}</b> - <code>${escapeHtml(r.targetKey)}</code> ${cond} <b>${r.conditionValue}</b> (${escapeHtml(r.status)})\n`;
          if (r.lastValue !== null && r.lastValue !== undefined) {
            msg += `最新值: <b>${r.lastValue}</b> (时间: ${escapeHtml(r.lastObservedAt || '')})\n`;
          }
          msg += '\n';
        }
        await sendMessage(token, chatId, msg);
        break;
      }

      case 'monitor_quote': {
        if (args.length < 2 || args[0].toLowerCase() !== 'stock') {
          await sendMessage(token, chatId, '❌ 用法：/monitor_quote stock &lt;code&gt;');
          break;
        }
        const code = args[1].trim();
        const quote = await monitorService.getQuote(db, code, {
          fetchFn: globalThis.fetch,
          relativeTo: new Date()
        });
        const change = quote.price - quote.yesterdayClose;
        const pct = quote.yesterdayClose ? ((change / quote.yesterdayClose) * 100).toFixed(2) : '0.00';
        const sign = change > 0 ? '+' : '';
        await sendMessage(token, chatId,
          `📈 <b>股票行情: ${escapeHtml(quote.symbol)}</b>\n\n` +
          `最新价: <b>${quote.price}</b>\n` +
          `昨收价: <b>${quote.yesterdayClose}</b>\n` +
          `涨跌幅: <b>${sign}${pct}%</b>\n` +
          `更新时间: <code>${escapeHtml(quote.observedAt)}</code>\n` +
          `数据源: <code>${escapeHtml(quote.source)}</code>`
        );
        break;
      }

      case 'monitor_pause':
      case 'monitor_resume':
      case 'monitor_remove': {
        const id = parsePositiveInteger(args[0]);
        if (!id) {
          await sendMessage(token, chatId, `❌ 用法：/${cmd} &lt;id&gt;`);
          break;
        }
        const rule = await monitorService.get(db, id);
        if (!rule) {
          await sendMessage(token, chatId, `⚠️ 未找到 ID 为 <b>${id}</b> 的规则。`);
          break;
        }
        let ok = false;
        if (cmd === 'monitor_pause') ok = await monitorService.pause(db, id);
        else if (cmd === 'monitor_resume') ok = await monitorService.resume(db, id);
        else ok = await monitorService.remove(db, id);

        const actionMap = { monitor_pause: '暂停', monitor_resume: '恢复', monitor_remove: '删除' };
        await sendMessage(token, chatId, ok
          ? `✅ 已${actionMap[cmd]}股票提醒规则 ID: <b>${id}</b>`
          : `⚠️ ${actionMap[cmd]}股票提醒规则 ID: <b>${id}</b> 失败。`
        );
        break;
      }

      case 'status': {
        const { createStatusService } = await import('../system/status.js');
        const statusService = createStatusService({ db, generatorService, monitorService, pushService, env });
        const summary = await statusService.getSummary();
        await sendMessage(token, chatId, summary);
        break;
      }

      case 'cancel': {
        await clearBotSession(db, chatId);
        await sendMessage(token, chatId, '✅ 已取消当前会话。');
        break;
      }

      case 'sync_commands': {
        const commands = getTelegramBotCommands();
        await setMyCommands(token, commands);
        await sendMessage(token, chatId, '✅ Telegram 机器人命令菜单已同步。');
        break;
      }

      default: {
        await sendMessage(token, chatId, `未知命令 /${escapeHtml(cmd)}，发送 /help 查看可用命令。`);
      }
    }
  } catch (err) {
    return handleError(token, chatId, err);
  }
}

export function isKnownCommand(cmd) {
  const known = new Set([
    'help', 'cancel', 'sync_commands', 'status',
    'gen_add', 'gen_list', 'gen_feed', 'gen_refresh', 'gen_pause', 'gen_resume', 'gen_remove',
    'monitor_add', 'monitor_list', 'monitor_quote', 'monitor_pause', 'monitor_resume', 'monitor_remove',
    'push_add', 'push_list', 'push_refresh', 'push_pause', 'push_resume', 'push_remove'
  ]);
  return known.has(cmd);
}
