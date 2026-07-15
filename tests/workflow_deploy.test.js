import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflow = fs.readFileSync(path.join(root, '.github/workflows/deploy.yml'), 'utf8');

const runtimeSecrets = [
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
  'TELEGRAM_ADMIN_USER_ID',
  'ADMIN_TOKEN',
  'DEEPSEEK_API_KEY',
  'PUSH_TELEGRAM_BOT_TOKEN',
  'PUSH_TELEGRAM_CHANNEL_ID',
];

function stepBody(name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return workflow.match(new RegExp(`- name: ${escaped}\\n([\\s\\S]*?)(?=\\n\\s*- name:|$)`))?.[1] ?? '';
}

describe('manual deployment workflow', () => {
  it('is manual-only, least privilege, and serialized', () => {
    expect(workflow).toMatch(/^on:\s*\n\s+workflow_dispatch:\s*$/m);
    expect(workflow).toMatch(/^permissions:\s*\n\s+contents:\s*read\s*$/m);
    expect(workflow).toMatch(/^concurrency:\s*\n\s+group:\s*[^\n]+\n\s+cancel-in-progress:\s*false\s*$/m);
  });

  it('installs, tests, checks, and audits before release work', () => {
    const commands = ['npm ci', 'npm test', 'npm run check', 'npm audit --omit=dev'];
    const positions = commands.map(command => workflow.indexOf(`run: ${command}`));

    expect(positions.every(position => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(Math.max(...positions)).toBeLessThan(workflow.indexOf('Apply D1 Migrations'));
  });

  it('applies remote D1 migrations with Cloudflare credentials before deploy', () => {
    const migration = stepBody('Apply D1 Migrations');

    expect(workflow).toContain('CLOUDFLARE_API_TOKEN: ${{ secrets.CF_API_TOKEN }}');
    expect(workflow).toContain('CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CF_ACCOUNT_ID }}');
    expect(migration).toContain('npx wrangler d1 migrations apply social-rss-bridge-db --remote');
    expect(workflow.indexOf('Apply D1 Migrations')).toBeLessThan(workflow.indexOf('- name: Deploy'));
  });

  it('validates and bulk-syncs exactly the seven runtime secrets through stdin', () => {
    const sync = stepBody('Sync Worker Secrets');
    const declared = [...workflow.matchAll(/^\s{6}([A-Z][A-Z0-9_]+): \$\{\{ secrets\.\1 \}\}\s*$/gm)]
      .map(match => match[1])
      .filter(name => runtimeSecrets.includes(name));
    const bulkArray = sync.match(/const names = \[([\s\S]*?)\];/)?.[1] ?? '';
    const synced = [...bulkArray.matchAll(/'([A-Z][A-Z0-9_]+)'/g)].map(match => match[1]);

    expect(declared).toEqual(runtimeSecrets);
    expect(synced).toEqual(runtimeSecrets);
    expect(sync).toContain('set -euo pipefail');
    expect(sync).toMatch(/for secret_name in [\s\S]*TELEGRAM_BOT_TOKEN[\s\S]*PUSH_TELEGRAM_CHANNEL_ID/);
    expect(sync).toContain('${!secret_name:-}');
    expect(sync).toContain('exit 1');
    expect(sync).toMatch(/node[\s\S]*\|\s*npx wrangler secret bulk(?:\s|$)/);
    expect(sync).not.toMatch(/(?:>|tee\b).*secret/i);
    expect(workflow.indexOf('- name: Deploy')).toBeLessThan(workflow.indexOf('Sync Worker Secrets'));
    expect(workflow.indexOf('Sync Worker Secrets')).toBeLessThan(workflow.indexOf('Validate Management Telegram Bot'));
    expect(workflow.indexOf('Validate Management Telegram Bot')).toBeLessThan(workflow.indexOf('Setup Telegram Webhook'));
    expect(workflow.indexOf('Sync Worker Secrets')).toBeLessThan(workflow.indexOf('Verify Push Telegram Delivery'));
    expect(workflow.indexOf('Setup Telegram Webhook')).toBeLessThan(workflow.indexOf('Verify Push Telegram Delivery'));
  });

  it('never enables xtrace or expands GitHub secrets inside shell scripts', () => {
    const runBlocks = [...workflow.matchAll(/^\s+run:\s*(?:\|)?\s*\n?([\s\S]*?)(?=\n\s{6}(?:-|[a-zA-Z])|$)/gm)]
      .map(match => match[0])
      .join('\n');

    expect(workflow).not.toMatch(/set\s+-(?:[^\n]*x|[^\n]*o\s+xtrace)|set\s+-x/);
    expect(runBlocks).not.toContain('${{ secrets.');
    expect(runBlocks).not.toMatch(/^\s*(?:echo|printf|tee|logger)\b[^\n]*\$\{?(?:TELEGRAM_|ADMIN_TOKEN|DEEPSEEK_|PUSH_)/m);
  });

  it('deploys after migrations but before secret synchronization', () => {
    const deploy = stepBody('Deploy');
    const deployPosition = workflow.indexOf('- name: Deploy');

    expect(deploy).toContain('npx wrangler deploy');
    expect(workflow.indexOf('Apply D1 Migrations')).toBeLessThan(deployPosition);
    expect(deployPosition).toBeLessThan(workflow.indexOf('Sync Worker Secrets'));
  });

  it('preflights the management bot with getMe without printing its token or response body', () => {
    const preflight = stepBody('Validate Management Telegram Bot');

    expect(preflight).toContain('set -euo pipefail');
    expect(preflight).toContain('bot${TELEGRAM_BOT_TOKEN}/getMe');
    expect(preflight).toContain('--output "$response_file"');
    expect(preflight).toMatch(/payload\.ok[\s\S]*payload\.result\?\.id/);
    expect(preflight).not.toMatch(/(?:cat|less|more)\s+[^\n]*response_file/);
    expect(preflight).not.toMatch(/^\s*(?:echo|printf|tee|logger)\b[^\n]*TELEGRAM_BOT_TOKEN/m);
  });

  it('safely parses BASE_URL and authenticates the webhook POST', () => {
    const webhook = stepBody('Setup Telegram Webhook');

    expect(webhook).toContain('set -euo pipefail');
    expect(webhook).toContain("fs.readFileSync('wrangler.toml', 'utf8')");
    expect(webhook).toContain('JSON.parse(match[1])');
    expect(webhook).not.toMatch(/\b(?:source|eval|grep|sed|awk)\b/);
    expect(webhook).toContain('--request POST');
    expect(webhook).toContain('Authorization: Bearer ${' + 'ADMIN_TOKEN}');
    expect(webhook).not.toContain('--fail-with-body');
    expect(webhook).toMatch(/payload\.webhook\?\.ok[\s\S]*payload\.commands\?\.ok/);
    expect(webhook).toContain('getWebhookInfo');
    expect(webhook).toContain('Telegram webhook URL verification failed');
    expect(webhook).toContain('actual !== expected');
    expect(webhook).not.toMatch(/^\s*(?:echo|printf|tee|logger)\b[^\n]*ADMIN_TOKEN/m);
    expect(webhook).not.toMatch(/(?:cat|less|more)\s+[^\n]*response_file/);
  });

  it('bounds webhook retries for 401 and 5xx responses before validating success', () => {
    const webhook = stepBody('Setup Telegram Webhook');

    expect(webhook).toContain('max_attempts=10');
    expect(webhook).toContain('retry_delay_seconds=3');
    expect(webhook).toMatch(/for \(\( attempt=1; attempt<=max_attempts; attempt\+\+ \)\)/);
    expect(webhook).toContain("--write-out '%{http_code}'");
    expect(webhook).toMatch(/http_status[\s\S]*==\s*"401"/);
    expect(webhook).toMatch(/http_status[\s\S]*\^5\[0-9\]\[0-9\]\$/);
    expect(webhook).toMatch(/attempt\s*==\s*max_attempts[\s\S]*exit 1/);
    expect(webhook).toContain('sleep "$retry_delay_seconds"');
    expect(webhook.indexOf('for (( attempt=1')).toBeLessThan(webhook.indexOf('WEBHOOK_RESPONSE_FILE='));
    expect(webhook).toMatch(/attempt\s*==\s*max_attempts[\s\S]*print_safe_setup_failure/);
    expect(webhook).toContain('const diagnostic = { stage, status, message };');
    expect(webhook).toContain('process.stderr.write(`${JSON.stringify(diagnostic)}\\n`);');
    expect(webhook).not.toMatch(/JSON\.stringify\(payload\)/);
  });

  it('performs a failing-fast real push delivery smoke test without logging secrets', () => {
    const smoke = stepBody('Verify Push Telegram Delivery');

    expect(smoke).toContain('set -euo pipefail');
    expect(smoke).toContain('--fail-with-body');
    expect(smoke).toContain('chat_id=${PUSH_TELEGRAM_CHANNEL_ID}');
    expect(smoke).toContain('bot${PUSH_TELEGRAM_BOT_TOKEN}/sendMessage');
    expect(smoke).toMatch(/payload\.ok[\s\S]*payload\.result\?\.message_id/);
    expect(smoke).not.toMatch(/^\s*(?:echo|printf|tee|logger)\b[^\n]*(?:PUSH_TELEGRAM_BOT_TOKEN|PUSH_TELEGRAM_CHANNEL_ID)/m);
  });

  it('performs a failing-fast management bot delivery smoke test without logging secrets', () => {
    const smoke = stepBody('Verify Management Telegram Delivery');

    // 1) Verify step exists
    expect(smoke).toBeTruthy();

    // 2) Verify step order: Setup Telegram Webhook < Verify Management Telegram Delivery < Verify Push Telegram Delivery
    const setupPos = workflow.indexOf('- name: Setup Telegram Webhook');
    const mgmtPos = workflow.indexOf('- name: Verify Management Telegram Delivery');
    const pushPos = workflow.indexOf('- name: Verify Push Telegram Delivery');
    expect(setupPos).toBeLessThan(mgmtPos);
    expect(mgmtPos).toBeLessThan(pushPos);

    // 3) Verify token/chat variables used
    expect(smoke).toContain('bot${TELEGRAM_BOT_TOKEN}/sendMessage');
    expect(smoke).toContain('chat_id=${TELEGRAM_CHAT_ID}');

    // 4) Verify message_id and ok verification in Node
    expect(smoke).toMatch(/payload\.ok\s*===\s*true/);
    expect(smoke).toMatch(/payload\.result\?\.message_id/);

    // 5) Verify fail-fast / shell flags
    expect(smoke).toContain('set -euo pipefail');
    expect(smoke).toContain('--silent');
    expect(smoke).toContain('--show-error');
    expect(smoke).toContain('--fail-with-body');

    // 6) Verify response file lifecycle and no cat
    expect(smoke).toContain('response_file="$(mktemp)"');
    expect(smoke).toMatch(/trap\s+['"][^'"]*rm\s+-f\s+["']\$response_file["'][^'"]*['"]\s+EXIT/);
    expect(smoke).not.toMatch(/(?:cat|less|more)\s+[^\n]*response_file/);

    // 7) Verify no xtrace and no secrets leaked via echo/printf
    expect(smoke).not.toMatch(/set\s+-(?:[^\n]*x|[^\n]*o\s+xtrace)|set\s+-x/);
    expect(smoke).not.toMatch(/^\s*(?:echo|printf|tee|logger)\b[^\n]*(?:TELEGRAM_BOT_TOKEN|TELEGRAM_CHAT_ID)/m);
  });

  it('defines workflow_dispatch inputs for management_smoke_command with /help and /monitor_add', () => {
    // Verify management_smoke_command input is defined under workflow_dispatch
    expect(workflow).toMatch(/management_smoke_command:\s*\n/);
    expect(workflow).toMatch(/type:\s*choice\s*\n/);
    expect(workflow).toMatch(/default:\s*['"]?\/help['"]?\s*\n/);
    expect(workflow).toMatch(/options:\s*\n\s+-\s+['"]?\/help['"]?\s*\n\s+-\s+['"]?\/monitor_add['"]?/);
  });

  it('performs a failing-fast management bot command validation without logging secrets or tokens', () => {
    const commandStep = stepBody('Verify Management Command');

    // 1) Verify step exists
    expect(commandStep).toBeTruthy();

    // 2) Verify step order: Verify Management Telegram Delivery < Verify Management Command < Verify Push Telegram Delivery
    const mgmtPos = workflow.indexOf('- name: Verify Management Telegram Delivery');
    const cmdPos = workflow.indexOf('- name: Verify Management Command');
    const pushPos = workflow.indexOf('- name: Verify Push Telegram Delivery');
    expect(mgmtPos).toBeLessThan(cmdPos);
    expect(cmdPos).toBeLessThan(pushPos);

    // 3) Verify BASE_URL parsed from wrangler.toml with HTTPS and no trailing slash
    expect(commandStep).toContain("fs.readFileSync('wrangler.toml', 'utf8')");
    expect(commandStep).toContain('JSON.parse(match[1])');
    expect(commandStep).toContain("parsed.protocol !== 'https:'");
    expect(commandStep).toContain("parsed.href.replace(/\\/$/, '')");

    // 4) Verify webhook secret derivation using crypto.createHash(\"sha256\").update(process.env.ADMIN_TOKEN,\"utf8\").digest(\"hex\")
    expect(commandStep).toContain('crypto.createHash("sha256").update(process.env.ADMIN_TOKEN,"utf8").digest("hex")');

    // 5) Verify webhook header X-Telegram-Bot-Api-Secret-Token
    expect(commandStep).toContain('X-Telegram-Bot-Api-Secret-Token');

    // 6) Verify variables TELEGRAM_CHAT_ID and TELEGRAM_ADMIN_USER_ID used in payload
    expect(commandStep).toContain('TELEGRAM_CHAT_ID');
    expect(commandStep).toContain('TELEGRAM_ADMIN_USER_ID');
    expect(commandStep).toMatch(/chat:\s*\{[^}]*type:\s*['"]private['"]/);

    // 7) Verify MANAGEMENT_SMOKE_COMMAND env is read inside the script and not hardcoded to /help
    expect(commandStep).toContain('process.env.MANAGEMENT_SMOKE_COMMAND');
    expect(commandStep).not.toMatch(/text:\s*['"]\/help['"]/);

    // 8) Verify payload/response files created via mktemp and deleted with trap EXIT
    expect(commandStep).toContain('mktemp');
    expect(commandStep).toMatch(/trap\s+['"][^']*rm\s+-f\s+[^']*payload_file[^']*response_file[^']*['"]\s+EXIT/);

    // 9) Verify curl fails fast, silent, show error, fail with body, data-binary, POST to BASE_URL/telegram
    expect(commandStep).toContain('curl');
    expect(commandStep).toContain('--silent');
    expect(commandStep).toContain('--show-error');
    expect(commandStep).toContain('--fail-with-body');
    expect(commandStep).toContain('--data-binary');
    expect(commandStep).toContain('/telegram');

    // 10) Verify HTTP response is ok, verify precise response validation and generic error description
    expect(commandStep).toMatch(/['"]ok['"]/);
    expect(commandStep).toContain('Telegram management command response was not ok');
    expect(commandStep).not.toContain('Telegram /help command response was not ok');

    // 11) Verify no xtrace or secrets leaked via echo/printf/cat of secret files
    expect(commandStep).not.toMatch(/set\s+-(?:[^\n]*x|[^\n]*o\s+xtrace)|set\s+-x/);
    expect(commandStep).not.toMatch(/^\s*(?:echo|printf|tee|logger)\b[^\n]*(?:ADMIN_TOKEN|SECRET)/m);
    expect(commandStep).not.toMatch(/(?:cat|less|more)\s+[^\n]*response_file/);

    // 12) Verify step has safe default for environment variable
    expect(commandStep).toMatch(/MANAGEMENT_SMOKE_COMMAND:\s*['"]?\$\{\{\s*(?:github\.event\.)?inputs\.management_smoke_command\s*\|\|\s*['"]\/help['"]\s*\}\}['"]?/);
  });
});
