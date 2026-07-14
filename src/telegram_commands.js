import { escapeHtml } from './html.js';

const COMMAND_SECTIONS = [
  {
    title: '🧩 RSS Generator',
    items: [
      { command: 'gen_add', usage: '/gen_add instagram <username> [displayName]', description: '添加 Instagram Generator' },
      { command: 'gen_list', usage: '/gen_list', description: '列出所有 Generator' },
      { command: 'gen_feed', usage: '/gen_feed <id>', description: '查看 Generator RSS 链接' },
      { command: 'gen_refresh', usage: '/gen_refresh <id>', description: '手动刷新 Generator' },
      { command: 'gen_pause', usage: '/gen_pause <id>', description: '暂停 Generator' },
      { command: 'gen_resume', usage: '/gen_resume <id>', description: '恢复 Generator' },
      { command: 'gen_remove', usage: '/gen_remove <id>', description: '删除 Generator' }
    ]
  },
  {
    title: '📡 Information Monitor',
    items: [
      { command: 'monitor_add', usage: '/monitor_add stock <code> <gte|lte> <price>', description: '添加股票提醒' },
      { command: 'monitor_list', usage: '/monitor_list', description: '列出股票提醒' },
      { command: 'monitor_quote', usage: '/monitor_quote stock <code>', description: '查询股票行情' },
      { command: 'monitor_pause', usage: '/monitor_pause <id>', description: '暂停股票提醒' },
      { command: 'monitor_resume', usage: '/monitor_resume <id>', description: '恢复股票提醒' },
      { command: 'monitor_remove', usage: '/monitor_remove <id>', description: '删除股票提醒' }
    ]
  },
  {
    title: '📨 Information Push',
    items: [
      { command: 'push_add', usage: '/push_add rss <url>', description: '添加 RSS 到 Push' },
      { command: 'push_list', usage: '/push_list', description: '列出 Push 订阅' },
      { command: 'push_refresh', usage: '/push_refresh <id>', description: '手动刷新 Push 订阅' },
      { command: 'push_pause', usage: '/push_pause <id>', description: '暂停 Push 订阅' },
      { command: 'push_resume', usage: '/push_resume <id>', description: '恢复 Push 订阅' },
      { command: 'push_remove', usage: '/push_remove <id>', description: '删除 Push 订阅' }
    ]
  },
  {
    title: '⚙️ System',
    items: [
      { command: 'status', usage: '/status', description: '查看服务状态' },
      { command: 'help', usage: '/help', description: '显示帮助' },
      { command: 'cancel', usage: '/cancel', description: '取消当前会话' },
      { command: 'sync_commands', usage: '/sync_commands', description: '同步机器人命令菜单' }
    ]
  }
];

export function getTelegramBotCommands() {
  return COMMAND_SECTIONS.flatMap(section =>
    section.items.map(item => ({
      command: item.command,
      description: item.description
    }))
  );
}

export function buildTelegramHelpMessage() {
  const lines = ['🤖 <b>PersonalRSS 整合信息输出平台</b>', ''];

  for (const section of COMMAND_SECTIONS) {
    lines.push(`<b>${escapeHtml(section.title)}</b>`);
    for (const item of section.items) {
      lines.push(`<code>${escapeHtml(item.usage)}</code> — ${escapeHtml(item.description)}`);
    }
    lines.push('');
  }

  return lines.join('\n').trim();
}
