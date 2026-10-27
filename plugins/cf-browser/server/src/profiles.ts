import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, statSync, unlinkSync, writeSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { cfg } from './config.js';
import { ToolError } from './cf.js';

// Everyday profile, clones, separate profiles. One writer per profile, enforced by lock.json.
// ~/.cf-browser/profiles/<name>/{state.json, state.prev.json, meta.json, lock.json}

export const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export interface LockInfo { serverPid: number; nonce: string; claudePid: number; sessionId: string; label: string; since: string; updatedAt: string }
export interface Meta { name: string; createdAt: string; updatedAt?: string; savedFromSession?: string; sites: string[]; cookieCount: number; earliestExpiry?: string }

const root = () => join(cfg.home, 'profiles');
export const profileDir = (name: string) => join(root(), name);

export function checkName(name: string) {
  if (!NAME_RE.test(name)) throw new ToolError('BAD_PROFILE_NAME', `Profile names are lowercase letters, digits, ".", "_" and "-", starting with a letter or digit (got "${name}").`);
}

function ensureDir(p: string) { mkdirSync(p, { recursive: true, mode: 0o700 }); try { chmodSync(p, 0o700); } catch { /* not ours */ } }

// Writes via a temp file opened 'wx' with mode 0600, fsync, rename: a reader never sees half a file.
export function writeAtomic(path: string, content: string) {
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  const fd = openSync(tmp, 'wx', 0o600);
  try { writeSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
}

function readJson<T>(path: string): T | undefined {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; }
}

export const exists = (name: string) => existsSync(join(profileDir(name), 'meta.json')) || existsSync(join(profileDir(name), 'state.json'));

export function create(name: string): Meta {
  checkName(name);
  if (exists(name)) throw new ToolError('PROFILE_EXISTS', `Profile "${name}" already exists.`);
  ensureDir(root()); ensureDir(profileDir(name));
  const meta: Meta = { name, createdAt: new Date().toISOString(), sites: [], cookieCount: 0 };
  writeAtomic(join(profileDir(name), 'meta.json'), JSON.stringify(meta, null, 2));
  return meta;
}

export function loadState(name: string): any | undefined {
  checkName(name);
  const path = join(profileDir(name), 'state.json');
  let text: string;
  try { text = readFileSync(path, 'utf8'); }
  catch (e: any) { if (e.code === 'ENOENT') return undefined; throw new ToolError('PROFILE_UNREADABLE', `Cannot read profile "${name}" (${e.code}).`, 'Repair file permissions; the existing profile was not changed.'); }
  try { const state = JSON.parse(text); validateState(state); return state; }
  catch { throw new ToolError('PROFILE_CORRUPT', `Profile "${name}" has invalid storage state.`, 'Use profile_restore_previous after all tasks finish; no empty profile has replaced it.'); }
}

function summarize(state: any): Pick<Meta, 'sites' | 'cookieCount' | 'earliestExpiry'> {
  const cookies: any[] = state?.cookies || [];
  const sites = new Set<string>();
  for (const c of cookies) sites.add(String(c.domain || '').replace(/^\./, ''));
  for (const o of state?.origins || []) { try { sites.add(new URL(o.origin).hostname); } catch { /* skip */ } }
  const exp = cookies.map(c => c.expires).filter((e: number) => e > 0).sort((a: number, b: number) => a - b)[0];
  return { sites: [...sites].filter(Boolean).sort(), cookieCount: cookies.length, earliestExpiry: exp ? new Date(exp * 1000).toISOString() : undefined };
}

// Validate before replacing any previously successful checkpoint.
export function validateState(state: any) {
  if (!state || !Array.isArray(state.cookies) || !Array.isArray(state.origins)) throw new Error('Invalid storage state');
  for (const c of state.cookies) if (typeof c.name !== 'string' || typeof c.value !== 'string' || typeof c.domain !== 'string') throw new Error('Invalid cookie');
  for (const o of state.origins) if (typeof o.origin !== 'string' || !Array.isArray(o.localStorage) || (o.indexedDB !== undefined && !Array.isArray(o.indexedDB))) throw new Error('Invalid origin');
}

export function save(name: string, state: any, sessionId: string, rotate = true) {
  checkName(name);
  validateState(state);
  ensureDir(root()); ensureDir(profileDir(name));
  const dir = profileDir(name);
  // Copy the last valid checkpoint before atomic replacement; state.json is never absent.
  if (rotate && existsSync(join(dir, 'state.json'))) {
    const previous = loadState(name);
    writeAtomic(join(dir, 'state.prev.json'), JSON.stringify(previous));
  }
  writeAtomic(join(dir, 'state.json'), JSON.stringify(state));
  const old = readJson<Meta>(join(dir, 'meta.json'));
  const meta: Meta = { name, createdAt: old?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString(), savedFromSession: sessionId, ...summarize(state) };
  writeAtomic(join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
}

export function clone(from: string, to: string) {
  checkName(from); checkName(to);
  if (!exists(from)) throw new ToolError('PROFILE_NOT_FOUND', `Profile "${from}" does not exist.`, 'profile_list shows the profiles.');
  if (exists(to)) throw new ToolError('PROFILE_EXISTS', `Profile "${to}" already exists.`, 'Pick another name, e.g. ' + `${from}-2`);
  ensureDir(profileDir(to));
  const state = loadState(from);
  if (state) writeAtomic(join(profileDir(to), 'state.json'), JSON.stringify(state));
  const meta: Meta = { name: to, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), savedFromSession: `clone of ${from}`, ...summarize(state) };
  writeAtomic(join(profileDir(to), 'meta.json'), JSON.stringify(meta, null, 2));
  return { lockedFrom: readLock(from) };
}

export function remove(name: string) {
  checkName(name);
  if (!exists(name)) throw new ToolError('PROFILE_NOT_FOUND', `Profile "${name}" does not exist.`);
  const l = readLock(name);
  if (l && !isStale(l)) throw new ToolError('PROFILE_IN_USE', `Profile "${name}" is open in browser ${l.label}; close it first.`);
  rmSync(profileDir(name), { recursive: true, force: true });
}

export function restorePrevious(name: string) {
  checkName(name);
  const dir = profileDir(name);
  const l = readLock(name);
  if (l && !isStale(l)) throw new ToolError('PROFILE_IN_USE', `Profile "${name}" is open in browser ${l.label}; finish its tasks and human control first.`);
  if (!existsSync(join(dir, 'state.prev.json'))) throw new ToolError('NO_BACKUP', `Profile "${name}" has no previous state to restore.`);
  try { validateState(JSON.parse(readFileSync(join(dir, 'state.prev.json'), 'utf8'))); }
  catch { throw new ToolError('PROFILE_BACKUP_CORRUPT', 'The backup is invalid; the current state was not changed.'); }
  const cur = join(dir, 'state.json');
  const tmp = join(dir, `state.swap-${process.pid}`);
  if (existsSync(cur)) renameSync(cur, tmp);
  renameSync(join(dir, 'state.prev.json'), cur);
  if (existsSync(tmp)) renameSync(tmp, join(dir, 'state.prev.json'));
  const state = loadState(name);
  const old = readJson<Meta>(join(dir, 'meta.json'));
  writeAtomic(join(dir, 'meta.json'), JSON.stringify({ ...old, name, updatedAt: new Date().toISOString(), savedFromSession: 'restored previous', ...summarize(state) }, null, 2));
}

// ---- locks ----
export function readLock(name: string): LockInfo | undefined { return readJson(join(profileDir(name), 'lock.json')); }

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === 'EPERM'; }
}

export function isStale(l: LockInfo): boolean {
  // A live legacy writer may be suspended or blocked. Never steal its profile on age alone.
  return !pidAlive(l.serverPid);
}

export function acquireLock(name: string, info: LockInfo): { ok: true } | { ok: false; holder: LockInfo } {
  ensureDir(root()); ensureDir(profileDir(name));
  const path = join(profileDir(name), 'lock.json');
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      try { writeSync(fd, JSON.stringify(info)); fsyncSync(fd); } finally { closeSync(fd); }
      return { ok: true };
    } catch (e: any) {
      if (e?.code !== 'EEXIST') throw e;
      const holder = readLock(name);
      if (!holder && existsSync(path)) throw new ToolError('PROFILE_LOCK_UNREADABLE', `Profile "${name}" has an unreadable ownership lock.`, 'Reconcile its previous writer before removing the lock; no new writer was started.');
      if (holder && !isStale(holder)) return { ok: false, holder };
      // Stale (or unreadable): take it over only while holding the takeover guard (atomic mkdir), and only if it is
      // still the same stale lock once inside, so a fresh lock another window just took is never removed.
      const guard = join(profileDir(name), 'lock.takeover');
      try { mkdirSync(guard, { mode: 0o700 }); } catch {
        try { if (Date.now() - statSync(guard).mtimeMs > 10000) rmdirSync(guard); } catch { /* gone */ }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
        continue;
      }
      try {
        const again = readLock(name);
        if (again && !isStale(again)) return { ok: false, holder: again };
        if (JSON.stringify(again) === JSON.stringify(holder)) try { unlinkSync(path); } catch { /* gone */ }
      } finally { try { rmdirSync(guard); } catch { /* gone */ } }
    }
  }
  const holder = readLock(name);
  return holder ? { ok: false, holder } : { ok: false, holder: { label: '?', since: '', updatedAt: '', serverPid: 0, nonce: '', claudePid: 0, sessionId: '' } };
}

export function touchLock(name: string, nonce: string, sessionId: string) {
  const l = readLock(name);
  if (!l || l.nonce !== nonce || l.sessionId !== sessionId) return;
  try { writeAtomic(join(profileDir(name), 'lock.json'), JSON.stringify({ ...l, updatedAt: new Date().toISOString() })); } catch { /* next tick */ }
}

export function releaseLock(name: string, nonce: string, sessionId?: string) {
  const l = readLock(name);
  if (!l || l.nonce !== nonce || (sessionId && l.sessionId !== sessionId)) return;
  try { unlinkSync(join(profileDir(name), 'lock.json')); } catch { /* gone */ }
}

// ---- listing ----
export function list() {
  let names: string[] = [];
  try { names = readdirSync(root()).filter(n => NAME_RE.test(n) && statSync(profileDir(n)).isDirectory()); } catch { /* none */ }
  return names.map(name => {
    const meta = readJson<Meta>(join(profileDir(name), 'meta.json')) || ({ name, sites: [], cookieCount: 0 } as any);
    const l = readLock(name);
    const inUse = l && !isStale(l) ? { label: l.label, since: l.since, this_window: l.serverPid === process.pid } : null;
    return {
      name,
      default: name === cfg.defaultProfile,
      sites: meta.sites,
      cookie_count: meta.cookieCount,
      earliest_cookie_expiry: meta.earliestExpiry || null,
      last_saved: meta.updatedAt || null,
      backup_present: existsSync(join(profileDir(name), 'state.prev.json')),
      in_use_by: inUse,
    };
  });
}

// Quick Actions take cookies only: pick the profile's cookies for this host or a parent domain.
export function cookiesFor(name: string, url: string) {
  const state = loadState(name);
  if (!state) throw new ToolError('PROFILE_EMPTY', `Profile "${name}" has no saved logins yet.`, 'Log in first with the cf-browser:login skill.');
  const host = new URL(url).hostname;
  const cookies = (state.cookies || []).filter((c: any) => {
    const d = String(c.domain || '').replace(/^\./, '');
    return host === d || host.endsWith('.' + d);
  }).map((c: any) => ({
    name: c.name, value: c.value, domain: c.domain, path: c.path || '/',
    ...(c.expires > 0 ? { expires: c.expires } : {}),
    httpOnly: !!c.httpOnly, secure: !!c.secure,
    sameSite: ({ strict: 'Strict', lax: 'Lax', none: 'None' } as any)[String(c.sameSite || 'Lax').toLowerCase()] || 'Lax',
  }));
  const hasLocalStorage = (state.origins || []).some((o: any) => { try { return new URL(o.origin).hostname === host && o.localStorage?.length; } catch { return false; } });
  return { cookies, hasLocalStorage };
}
