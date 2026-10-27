import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(join(process.cwd(), 'package.json'));
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

test('ordinary stdio tools and doctor are usable without credentials', { timeout: 15_000 }, async () => {
  const client = new Client({ name: 'ci', version: '1' });
  const env: any = { ...process.env, CFB_DEV: '1' }; delete env.CF_ACCOUNT_ID; delete env.CF_API_TOKEN;
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('launch.mjs')], env, stderr: 'pipe', cwd: resolve('..') });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    for (const required of ['task_start', 'task_finish', 'tabs', 'observe', 'act', 'human', 'operation', 'doctor']) assert(tools.some((t: any) => t.name === required));
    assert(!tools.some((t: any) => t.name === 'profile_clone'));
    const result = await client.callTool({ name: 'doctor', arguments: {} });
    assert(!result.isError); const d = JSON.parse(result.content[0].text);
    assert.equal(d.api.status, 'not_configured'); assert.equal(d.manager.status, 'not_started'); assert.match(d.next, /\.env/);
  } finally { await client.close(); }
});
test('steering sources keep the shared small-step workflow consistent', () => {
  const root = resolve('..');
  const browse = readFileSync(join(root, 'skills/browse/SKILL.md'), 'utf8');
  const primer = readFileSync(join(root, 'hooks/primer.mjs'), 'utf8');
  assert.match(browse, /task_finish/); assert.match(browse, /observation_id/); assert.match(browse, /script/i); assert.match(browse, /screenshots?/i);
  for (const stale of ['one browser per task', 'confirm submits', 'profile_mode "read"', 'BUDGET_EXCEEDED', 'allowed_domains']) { assert(!browse.includes(stale)); assert(!primer.includes(stale)); }
  for (const file of ['hooks/hooks.json', 'hooks/codex-hooks.json']) assert(!JSON.parse(readFileSync(join(root, file), 'utf8')).hooks.PreToolUse);
});
