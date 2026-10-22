// Shared helpers for the cf-browser hooks. Node built-ins only; every hook fails open.
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const off = () => process.env.CF_BROWSER_HOOKS === 'off';

export function opt(key) {
  const v = process.env[`CLAUDE_PLUGIN_OPTION_${key}`]?.trim();
  return v && !v.startsWith('${') ? v : undefined;
}

const expand = p => (p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);
export const home = () => resolve(expand(opt('PROFILES_DIR') || '~/.cf-browser'));
export const dataDir = () => {
  const d = process.env.CLAUDE_PLUGIN_DATA;
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
