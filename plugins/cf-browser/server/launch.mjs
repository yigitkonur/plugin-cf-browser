#!/usr/bin/env node
// cf-browser launcher: Node built-ins only. Starts the MCP server at once and installs the browser
// driver (playwright-core) in the background on first start. Never writes to stdout.
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const log = m => process.stderr.write(`[cf-browser] ${m}\n`);
const [maj, min] = process.versions.node.split('.').map(Number);
if (maj < 20 || (maj === 20 && min < 19)) { log(`needs Node 20.19 or newer (found ${process.versions.node})`); process.exit(1); }

const here = dirname(fileURLToPath(import.meta.url));
const lock = join(here, 'package-lock.json');
const h = createHash('sha256').update(readFileSync(lock)).digest('hex').slice(0, 12);
const configuredHome = process.env.CFB_HOME && !process.env.CFB_HOME.startsWith('${') ? process.env.CFB_HOME : join(homedir(), '.cf-browser');
const sharedHome = configuredHome === '~' ? homedir() : configuredHome.startsWith('~/') ? join(homedir(), configuredHome.slice(2)) : configuredHome;
const dataDir = join(sharedHome, 'data');
const depsRoot = join(dataDir, 'deps');
const final = join(depsRoot, h);
const ready = dir => existsSync(join(dir, 'node_modules', '.complete'));

let listener = () => {};
let deps;
if (process.env.CFB_DEV === '1' && existsSync(join(here, 'node_modules', '@playwright', 'mcp'))) deps = { state: 'ready', dir: here };
else if (ready(final)) { deps = { state: 'ready', dir: final }; prune(); }
else { deps = { state: 'installing', startedAt: Date.now() }; install().then(d => { deps = d; listener(d); }); }

function npmCommand() {
  const bin = dirname(process.execPath);
  for (const p of [join(bin, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), join(bin, 'node_modules', 'npm', 'bin', 'npm-cli.js')]) {
    if (existsSync(p)) return [process.execPath, [p]];
  }
  return [platform() === 'win32' ? 'npm.cmd' : 'npm', []];
}

async function install() {
  const tmp = join(depsRoot, `${h}.tmp-${process.pid}`);
  try {
    mkdirSync(tmp, { recursive: true, mode: 0o700 });
    copyFileSync(join(here, 'package.json'), join(tmp, 'package.json'));
    copyFileSync(lock, join(tmp, 'package-lock.json'));
    const env = { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' };
    delete env.CF_API_TOKEN; delete env.CF_ACCOUNT_ID;
    const [cmd, pre] = npmCommand();
    log(`installing browser driver into ${tmp}`);
    const err = await new Promise(resolve => {
      const child = spawn(cmd, [...pre, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: tmp, env, stdio: ['ignore', 'ignore', 'pipe'], shell: cmd.endsWith('.cmd') });
      let stderr = '';
      child.stderr.on('data', d => { stderr = (stderr + d).slice(-2000); });
      const kill = setTimeout(() => { child.kill('SIGKILL'); stderr += '\ntimed out after 180 s'; }, 180000);
      child.on('error', e => { clearTimeout(kill); resolve(String(e.message)); });
      child.on('exit', code => { clearTimeout(kill); resolve(code === 0 ? null : stderr.trim().split('\n').slice(-3).join(' ') || `npm exited ${code}`); });
    });
    if (err) throw new Error(err);
    writeFileSync(join(tmp, 'node_modules', '.complete'), new Date().toISOString());
    try { renameSync(tmp, final); }
    catch { if (!ready(final)) throw new Error('could not move the installed driver into place'); rmSync(tmp, { recursive: true, force: true }); }
    prune();
    log('browser driver ready');
    return { state: 'ready', dir: final };
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    log(`driver install failed: ${e.message}`);
    return { state: 'failed', error: String(e.message).replace(/Bearer\s+\S+/g, 'Bearer ***') };
  }
}

// Old driver folders go after 7 days, half-done installs of dead launchers at once; the current one always stays.
function prune() {
  try {
    for (const d of readdirSync(depsRoot)) {
      if (d === h) continue;
      const p = join(depsRoot, d);
      const pid = Number(d.match(/\.tmp-(\d+)$/)?.[1]);
      if (pid && pid !== process.pid && !alive(pid)) { rmSync(p, { recursive: true, force: true }); continue; }
      if (!pid && Date.now() - statSync(p).mtimeMs > 7 * 86400e3) rmSync(p, { recursive: true, force: true });
    }
  } catch { /* nothing to prune */ }
}

function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

const runtime = await import(pathToFileURL(join(here, 'dist', 'server.mjs')).href);
const main = process.argv[2] === '--manager' ? runtime.managerMain : runtime.main;
await main({ deps, onDeps: cb => { listener = cb; if (deps.state !== 'installing') cb(deps); } });
