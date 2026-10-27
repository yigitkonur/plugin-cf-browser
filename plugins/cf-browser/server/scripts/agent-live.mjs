// Opt-in real Claude Code behavior smoke test. No changes to host configuration or saved profiles.
import { readFileSync, writeFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
const env = { ...process.env };
const credentials = join(env.CFB_HOME || join(homedir(), '.cf-browser'), '.env');
if (existsSync(credentials)) for (const line of readFileSync(credentials, 'utf8').split(/\r?\n/)) {
  const m = /^\s*(?:export\s+)?(CF_ACCOUNT_ID|CF_API_TOKEN)\s*=\s*(.*?)\s*$/.exec(line);
  if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
}
if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) { console.error('Cloudflare credentials are required.'); process.exit(2); }
const root = mkdtempSync(join(tmpdir(), 'cfb-agent-'));
Object.assign(env, { CFB_HOME: root, CFB_DEFAULT_PROFILE: 'agent-acceptance', CFB_DEV: '1', CFB_OPEN_LIVE_VIEW: 'false', CFB_REAP_MS: '1000' });
delete env.CLAUDE_PLUGIN_DATA; delete env.PLUGIN_DATA;
const config = join(root, 'mcp.json');
writeFileSync(config, JSON.stringify({ mcpServers: { browser: { command: process.execPath, args: [resolve('launch.mjs')] } } }), { mode: 0o600 });
const skill = readFileSync(resolve('../skills/browse/SKILL.md'), 'utf8');
const prompt = 'Use the browser tools to compare the page headings at https://the-internet.herokuapp.com/inputs and https://example.com in separate tabs. On the Inputs page enter 42 in the number field, verify its value from the returned observation, and take a screenshot to check the displayed value. Finish your browser task when done. Report the two headings and the verified input value. This is a public synthetic acceptance test; no login is needed.';
const args = ['--print', '--restricted', '--strict-mcp-config', '--mcp-config', config, '--tools', '', '--allowedTools', 'mcp__browser__*', '--permission-mode', 'dontAsk', '--no-session-persistence', '--no-chrome', '--output-format', 'stream-json', '--verbose', '--append-system-prompt', skill, prompt];
const calls = [], errors = []; let final, model, buffer = '', stderr = '';
const redact = s => String(s).split(env.CF_API_TOKEN).join('[redacted]').split(env.CF_ACCOUNT_ID).join('[account]').replace(/https?:\/\/(?:127\.0\.0\.1|live\.browser\.run)[^\s"<>]*/g, '[control-url]').replace(/(?:tab|task|obs|op)_[a-f0-9-]+/g, '[id]');
try {
  const proc = spawn('claude', args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const timer = setTimeout(() => { errors.push('host test timed out after 240 seconds'); proc.kill('SIGTERM'); }, 240000); timer.unref();
  proc.stdout.on('data', chunk => {
    buffer += chunk.toString();
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
      try {
        const e = JSON.parse(line);
        if (e.type === 'system' && e.subtype === 'init') model = e.model;
        if (e.type === 'assistant') for (const c of e.message?.content || []) if (c.type === 'tool_use') {
          calls.push({ tool: c.name, action: c.input?.action, url: c.input?.url, target: c.input?.target, text: c.input?.text, has_observation: !!c.input?.observation_id });
          console.log('CALL ' + c.name + (c.input?.action ? ' ' + c.input.action : ''));
        }
        if (e.type === 'user') for (const c of e.message?.content || []) if (c.type === 'tool_result' && c.is_error) errors.push(redact(JSON.stringify(c.content)).slice(0, 800));
        if (e.type === 'result') final = { subtype: e.subtype, is_error: e.is_error, result: redact(e.result), turns: e.num_turns, permission_denials: e.permission_denials?.length };
      } catch {}
    }
  });
  proc.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const code = await new Promise((resolve, reject) => { proc.once('error', reject); proc.once('close', resolve); });
  clearTimeout(timer);
  console.log(JSON.stringify({ host: 'Claude Code', model, exit_code: code, calls, errors, final, ...(code ? { stderr: redact(stderr).slice(-1500) } : {}) }, null, 2));
  if (code || final?.is_error || !calls.some(c => c.tool.endsWith('__task_finish'))) process.exitCode = 1;
} finally {
  let clean = true;
  const runtimes = join(root, 'runtime');
  for (const dir of existsSync(runtimes) ? readdirSync(runtimes) : []) {
    const path = join(runtimes, dir);
    try {
      const ep = JSON.parse(readFileSync(join(path, 'endpoint.json'), 'utf8'));
      const journal = JSON.parse(readFileSync(join(path, 'journal.json'), 'utf8'));
      if (journal.browsers.length) {
        console.log('INFO harness cleanup was needed after the agent exited');
        const out = await (await fetch(`http://127.0.0.1:${ep.port}/control`, { method: 'POST', headers: { authorization: `Bearer ${ep.secret}`, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'finish_browser', profile: 'agent-acceptance' }) })).json();
        if (out.state !== 'closed') { clean = false; continue; }
      }
      if (journal.uncertainCreates?.length) { clean = false; continue; }
      process.kill(ep.pid, 'SIGTERM');
    } catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ESRCH') clean = false; }
  }
  if (clean) { await new Promise(r => setTimeout(r, 250)); rmSync(root, { recursive: true, force: true }); console.log('PASS agent-test browser cleanup confirmed'); }
  else { console.error('CLEANUP_PENDING manager retained at ' + root); process.exitCode = 1; }
}
