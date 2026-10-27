import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, mkdirSync, openSync, writeFileSync, closeSync, unlinkSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { cfg } from './config.js';
import { pidAlive } from './manager.js';

export const PROTOCOL = 1;
export const runtimeRoot = () => join(cfg.home, 'runtime', createHash('sha256').update(cfg.accountId || 'unconfigured').digest('hex').slice(0, 16));
const runningBuild = createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex').slice(0, 16);
export function buildId() { return runningBuild; }
export interface Endpoint { pid: number; port: number; secret: string; build: string; protocol: number }
export function readEndpoint(root = runtimeRoot()): Endpoint | undefined {
  try { return JSON.parse(readFileSync(join(root, 'endpoint.json'), 'utf8')); } catch { return undefined; }
}

// Atomic creation, followed by guarded stale-PID reclamation. Never expire a live owner by age.
export function claimManager(root: string) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = join(root, 'manager.lock'), nonce = randomUUID();
  for (let i = 0; i < 2; i++) {
    try { const fd = openSync(path, 'wx', 0o600); try { writeFileSync(fd, JSON.stringify({ pid: process.pid, nonce })); } finally { closeSync(fd); } return () => { try { if (JSON.parse(readFileSync(path, 'utf8')).nonce === nonce) unlinkSync(path); } catch {} }; }
    catch (e: any) { if (e.code !== 'EEXIST') throw e; }
    let owner: any;
    try { owner = JSON.parse(readFileSync(path, 'utf8')); } catch { if (Date.now() - statSync(path).mtimeMs < 30_000) return; }
    if (owner && pidAlive(owner.pid)) return;
    const guard = join(root, 'reclaim.lock');
    try { const fd = openSync(guard, 'wx', 0o600); writeFileSync(fd, String(process.pid)); closeSync(fd); }
    catch {
      try { const pid = Number(readFileSync(guard, 'utf8')); if (pid && !pidAlive(pid)) unlinkSync(guard); } catch {}
      return;
    }
    try {
      let current: any; try { current = JSON.parse(readFileSync(path, 'utf8')); } catch {}
      if (current && pidAlive(current.pid)) return;
      if (JSON.stringify(current) === JSON.stringify(owner)) rmSync(path, { force: true });
    } finally { rmSync(guard, { force: true }); }
  }
}
