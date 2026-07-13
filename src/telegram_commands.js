import { escapeHtml } from './html.js';

const COMMAND_SECTIONS = [
  {
    title: '📸 Instagram 订阅管理',
    items: [
      { command: 'add_ig', usage: '/add_ig <username> [displayName]', description: '添加 IG 订阅' },
      { command: 'remove_ig', usage: '/remove_ig <username>', description: '删除 IG 订阅' },
      { command: 'list', usage: '/list', description: '列出所有 IG 订阅' }
    ]
  },
  {
    title: '📰 RSS 订阅管理',
    items: [
      { command: 'rss_add', usage: '/rss_add [url]', description: '添加 RSS 订阅' },
      { command: 'rss_list', usage: '/rss_list', description: '列出 RSS 订阅' },
      { command: 'rss_remove', usage: '/rss_remove <id>', description: '删除 RSS 订阅' },
      { command: 'rss_pause', usage: '/rss_pause <id>', description: '暂停 RSS 订阅' },
      { command: 'rss_resume', usage: '/rss_resume <id>', description: '恢复 RSS 订阅' },
      { command: 'rss_refresh', usage: '/rss_refresh <id>', description: '刷新 RSS 订阅' },
      { command: 'rss_set_interval', usage: '/rss_set_interval <id> <minutes>', description: '设置刷新间隔' }
    ]
  },
  {
    title: '📈 股票价格追踪',
    items: [
      { command: 'stock_add', usage: '/stock_add <code> [gte/lte] [targetPrice]', description: '添加股票提醒' },
      { command: 'stock_list', usage: '/stock_list', description: '列出股票提醒' },
      { command: 'stock_pause', usage: '/stock_pause <id>', description: '暂停股票提醒' },
      { command: 'stock_resume', usage: '/stock_resume <id>', description: '恢复股票提醒' },
      { command: 'stock_remove', usage: '/stock_remove <id>', description: '删除股票提醒' },
      { command: 'stock_quote', usage: '/stock_quote <code>', description: '查询当前股票价格' }
    ]
  },
  {
    title: '运维与系统',
    items: [
      { command: 'feeds', usage: '/feeds', description: '列出 RSS 链接' },
      { command: 'status', usage: '/status', description: '查看服务状态' },
      { command: 'refresh', usage: '/refresh', description: '刷新全部 IG 缓存' },
      { command: 'refresh_ig', usage: '/refresh_ig <username>', description: '刷新单个 IG' },
      { command: 'purge_ig', usage: '/purge_ig', description: '清理全部 IG 缓存' },
      { command: 'sync_commands', usage: '/sync_commands', description: '同步机器人命令菜单' },
      { command: 'help', usage: '/help', description: '显示帮助' }
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
  const lines = ['🤖 <b>Social RSS Bridge</b>', ''];

  for (const section of COMMAND_SECTIONS) {
    lines.push(`<b>${escapeHtml(section.title)}</b>`);
    for (const item of section.items) {
      lines.push(`<code>${escapeHtml(item.usage)}</code> — ${escapeHtml(item.description)}`);
    }
    lines.push('');
  }

  lines.push('<code>/start</code> — 显示帮助');
  return lines.join('\n').trim();
}
