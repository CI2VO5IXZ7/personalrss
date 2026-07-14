import { escapeHtml } from '../html.js';
import { getBeijingDate } from '../push/summary/deepseek.js';

export function createStatusService({ db, generatorService, monitorService, pushService, env }) {
  async function getGeneratorCounts() {
    const instances = await generatorService.list(db);
    const active = instances.filter(i => i.status === 'active').length;
    const paused = instances.filter(i => i.status === 'paused').length;
    return { total: instances.length, active, paused };
  }

  async function getMonitorCounts() {
    const rules = await monitorService.list(db);
    const active = rules.filter(r => r.status === 'active').length;
    const paused = rules.filter(r => r.status === 'paused').length;
    const triggered = rules.filter(r => r.status === 'triggered').length;
    const triggerPending = rules.filter(r => r.status === 'trigger_pending').length;
    return { total: rules.length, active, paused, triggered, triggerPending };
  }

  async function getPushCounts() {
    const subs = await pushService.listSubscriptions(db);
    const active = subs.filter(s => s.status === 'active').length;
    const paused = subs.filter(s => s.status === 'paused').length;
    const error = subs.filter(s => s.status === 'error').length;
    return { total: subs.length, active, paused, error };
  }

  async function getQueueCounts() {
    const { results } = await db.prepare(
      `SELECT status, COUNT(*) as count FROM notification_queue GROUP BY status`
    ).all().catch(() => ({ results: [] }));
    const counts = { pending: 0, processing: 0, sent: 0, failed: 0, dead: 0 };
    for (const row of results || []) {
      const status = row.status;
      if (status in counts) {
        counts[status] = row.count || 0;
      }
    }
    return counts;
  }

  async function getDeepSeekUsage() {
    try {
      const dateStr = getBeijingDate();
      const row = await db.prepare(
        `SELECT count FROM daily_usage WHERE usage_date = ? AND usage_type = 'deepseek_summary'`
      ).bind(dateStr).first();
      const count = row?.count || 0;
      const limit = parseInt(env.DEEPSEEK_DAILY_LIMIT || '200', 10);
      return { count, limit };
    } catch {
      return { count: 0, limit: parseInt(env.DEEPSEEK_DAILY_LIMIT || '200', 10) };
    }
  }

  return {
    async getSummary() {
      const [gen, mon, push, queue, ds] = await Promise.all([
        getGeneratorCounts(),
        getMonitorCounts(),
        getPushCounts(),
        getQueueCounts(),
        getDeepSeekUsage()
      ]);

      let msg = '📊 <b>服务状态</b>\n\n';

      msg += '🧩 <b>Generator</b>\n';
      msg += `总数：<b>${gen.total}</b> | 活跃：<b>${gen.active}</b> | 暂停：<b>${gen.paused}</b>\n\n`;

      msg += '📡 <b>Monitor</b>\n';
      msg += `总数：<b>${mon.total}</b> | 活跃：<b>${mon.active}</b> | 暂停：<b>${mon.paused}</b> | 已触发：<b>${mon.triggered}</b> | 待发送：<b>${mon.triggerPending}</b>\n\n`;

      msg += '📨 <b>Push RSS</b>\n';
      msg += `总数：<b>${push.total}</b> | 活跃：<b>${push.active}</b> | 暂停：<b>${push.paused}</b> | 异常：<b>${push.error}</b>\n\n`;

      msg += '✉️ <b>通知队列</b>\n';
      msg += `pending：<b>${queue.pending}</b> | processing：<b>${queue.processing}</b> | sent：<b>${queue.sent}</b> | failed：<b>${queue.failed}</b> | dead：<b>${queue.dead}</b>\n\n`;

      msg += '🤖 <b>AI 摘要 (DeepSeek)</b>\n';
      msg += `今日已用：<b>${ds.count}</b> / ${ds.limit}\n`;

      return msg;
    }
  };
}
