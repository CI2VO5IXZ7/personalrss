import { escapeHtml } from './html.js';

const COMMAND_SECTIONS = [
  {
    title: '订阅管理',
    items: [
      { command: 'add_ig', usage: '/add_ig <username> [displayName]', description: '添加 IG 订阅' },
      { command: 'remove_ig', usage: '/remove_ig <username>', description: '删除 IG 订阅' },
      { command: 'list', usage: '/list', description: '列出所有订阅' }
    ]
  },
  {
    title: '运维',
    items: [
      { command: 'feeds', usage: '/feeds', description: '列出 RSS 链接' },
      { command: 'status', usage: '/status', description: '查看服务状态' },
      { command: 'refresh', usage: '/refresh', description: '刷新全部缓存' },
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
