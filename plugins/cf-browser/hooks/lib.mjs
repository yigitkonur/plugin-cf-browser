// Shared helpers for the cf-browser hooks. Node built-ins only; every hook fails open.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const off = () => process.env.CF_BROWSER_HOOKS === 'off';

// Codex runs these hooks from hooks/codex-hooks.json with --host=codex.
export const codex = process.argv.includes('--host=codex');

const expand = p => (p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);
const fromHost = key => { const v = process.env[`CLAUDE_PLUGIN_OPTION_${key}`]?.trim(); return v && !v.startsWith('${') ? v : undefined; };

// The same <profiles folder>/.env the MCP server reads (Codex has no plugin settings; in Claude Code it fills gaps).
export const envFilePath = () => join(resolve(expand(fromHost('PROFILES_DIR') || process.env.CFB_HOME || '~/.cf-browser')), '.env');
let envFile;
function fileVal(name) {
  if (!envFile) {
    envFile = {};
    try {
      for (const line of readFileSync(envFilePath(), 'utf8').split(/\r?\n/)) {
        const m = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
        if (m) envFile[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
      }
    } catch { /* no file */ }
  }
  return envFile[name] || undefined;
}
const ENV_NAME = { ACCOUNT_ID: 'CF_ACCOUNT_ID', API_TOKEN: 'CF_API_TOKEN', PROFILES_DIR: 'CFB_HOME', DEFAULT_PROFILE: 'CFB_DEFAULT_PROFILE' };
export function opt(key) {
  return fromHost(key) ?? (ENV_NAME[key] ? process.env[ENV_NAME[key]]?.trim() || fileVal(ENV_NAME[key]) : undefined);
}

export const home = () => resolve(expand(opt('PROFILES_DIR') || '~/.cf-browser'));
// Where the MCP server keeps its state: Claude Code gives both the same plugin data folder; Codex gives the server none.
export const dataDir = () => {
  const d = codex ? undefined : process.env.CLAUDE_PLUGIN_DATA;
  return resolve(d && !d.startsWith('${') ? d : join(homedir(), '.cf-browser', 'data'));
};

export async function readStdin() {
  let s = '';
  for await (const c of process.stdin) s += c;
  try { return JSON.parse(s); } catch { return {}; }
}

// The Claude Code process, seen from a child: our parent, or its parent when a node version shim sits in between.
export function parentPids() {
  const pids = [process.ppid];
  if (process.platform !== 'win32') {
    try { const g = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(process.ppid)], { encoding: 'utf8', timeout: 2000 }).trim()); if (g > 1) pids.push(g); } catch { /* no ps */ }
  }
  return pids;
}

export function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

export function emit(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
