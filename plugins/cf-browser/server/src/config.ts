import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

// A host value is unset when empty or when Claude Code left the ${user_config.x} placeholder in place.
function hostVal(name: string): string | undefined {
  const v = process.env[name]?.trim();
  if (!v || /^\$\{user_config\.[^}]*\}$/.test(v)) return undefined;
  return v;
}

// <profiles folder>/.env (default ~/.cf-browser/.env): KEY=VALUE lines with the same names as the environment.
// Codex has no plugin settings, so this is where its credentials live; in Claude Code it fills what /plugin left unset.
export const envFilePath = join(resolve(expandHome(hostVal('CFB_HOME') || '~/.cf-browser')), '.env');
const envFile: Record<string, string> = {};
try {
  for (const line of readFileSync(envFilePath, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) envFile[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch { /* no file */ }

function val(name: string): string | undefined {
  return hostVal(name) ?? (envFile[name]?.trim() || undefined);
}

function num(name: string, def: number, min: number, max: number): number {
  const n = Number(val(name));
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function bool(name: string, def: boolean): boolean {
  const v = val(name)?.toLowerCase();
  if (v === undefined) return def;
  return !['false', '0', 'no', 'off'].includes(v);
}

export function expandHome(p: string): string {
  return p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}

const plan = val('CFB_PLAN')?.toLowerCase() === 'free' ? 'free' : 'paid';

const idle = num('CFB_IDLE_TIMEOUT_S', 300, 60, 1140);

export const cfg = {
  accountId: val('CF_ACCOUNT_ID'),
  token: val('CF_API_TOKEN'),
  plan,
  defaultProfile: (val('CFB_DEFAULT_PROFILE') || 'main').toLowerCase(),
  idleTimeoutS: idle,
  openLiveView: bool('CFB_OPEN_LIVE_VIEW', true),
  home: resolve(expandHome(val('CFB_HOME') || '~/.cf-browser')),
  dataDir: join(resolve(expandHome(val('CFB_HOME') || '~/.cf-browser')), 'data'),
  // Test hook: how often the reaper runs. Not a user option.
  reapMs: num('CFB_REAP_MS', 30000, 1000, 60000),
};

export const keepAliveMs = (idleS: number) => Math.min(idleS + 60, 1200) * 1000;

export function configMissing(): string | null {
  if (cfg.accountId && cfg.token) return null;
  const missing = [!cfg.accountId && 'account_id', !cfg.token && 'api_token'].filter(Boolean).join(' and ');
  return `cf-browser is not configured (${missing} missing). Put CF_ACCOUNT_ID and CF_API_TOKEN in ${envFilePath} (mode 600), or in Claude Code run: claude plugin configure cf-browser@plugin-cf-browser --values-stdin. Then restart the session. The cf-browser setup skill walks through it.`;
}

export const credentialSources = () => Object.fromEntries(['CF_ACCOUNT_ID', 'CF_API_TOKEN'].map(k => [k, hostVal(k) ? 'environment' : envFile[k] ? 'credentials file' : 'missing']));
export const retiredSettings = ['CFB_MAX_SESSION_MIN', 'CFB_MAX_CONCURRENT', 'CFB_DAILY_BUDGET_MIN'].filter(k => val(k) !== undefined);
