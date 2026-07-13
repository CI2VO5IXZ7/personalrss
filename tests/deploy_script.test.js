import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const deployScript = fs.readFileSync(path.join(root, 'deploy.sh'), 'utf8');

describe('deploy.sh Telegram security configuration', () => {
  it('requires TELEGRAM_ADMIN_USER_ID during environment validation', () => {
    const requiredVars = deployScript.match(/^REQUIRED_VARS="([^"]+)"/m)?.[1]?.split(/\s+/) ?? [];

    expect(requiredVars).toContain('TELEGRAM_ADMIN_USER_ID');
  });

  it('authenticates the automatic setup-webhook curl with the ADMIN_TOKEN variable', () => {
    const webhookRequest = deployScript.match(/WEBHOOK_RESP=\$\([\s\S]*?\) \|\| true/)?.[0] ?? '';
    const adminTokenReference = '$' + '{ADMIN_TOKEN}';

    expect(webhookRequest).toContain(`-H "Authorization: Bearer ${adminTokenReference}"`);
    expect(webhookRequest).not.toContain('Authorization: Bearer ***');
  });

  it('does not interpolate ADMIN_TOKEN in output or logging commands', () => {
    const unsafeOutputCommands = deployScript
      .split('\n')
      .filter((line) => /^\s*(echo|printf|logger)\b/.test(line))
      .map((line) => line.replaceAll('<ADMIN_TOKEN>', ''))
      .filter((line) => line.includes('ADMIN_TOKEN'));

    expect(unsafeOutputCommands).toEqual([]);
  });

  it('prints only an ADMIN_TOKEN placeholder in the manual webhook command', () => {
    const manualCommand = deployScript.match(/^\s*echo "\s+curl .*setup-webhook.*$/m)?.[0] ?? '';
    const adminTokenReference = /\$(?:ADMIN_TOKEN|\{ADMIN_TOKEN\})/;

    expect(manualCommand).toContain('<ADMIN_TOKEN>');
    expect(manualCommand).not.toMatch(adminTokenReference);
  });
});
