import { appendFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { cfg } from './config.js';

// One JSONL file per UTC day, the day Cloudflare bills by.
// kinds: session_start (ms 0), session_end (billed ms of that day), quick (X-Browser-Ms-Used), crawl (browserSecondsUsed*1000)
export interface Entry { t: string; kind: 'session_start' | 'session_end' | 'quick' | 'crawl'; id?: string; ms: number; engine?: string; what?: string }

const dir = () => join(cfg.dataDir, 'usage');
const day = (d: Date) => d.toISOString().slice(0, 10);

function append(e: Entry) {
  try {
    mkdirSync(dir(), { recursive: true, mode: 0o700 });
    appendFileSync(join(dir(), `${e.t.slice(0, 10)}.jsonl`), JSON.stringify(e) + '\n', { mode: 0o600 });
  } catch { /* usage is best effort; never fail a tool over it */ }
}

export function recordQuick(ms: number, engine: string, what: string) {
  append({ t: new Date().toISOString(), kind: 'quick', ms: Math.round(ms), engine, what });
}
export function recordCrawl(id: string, seconds: number) {
  append({ t: new Date().toISOString(), kind: 'crawl', id, ms: Math.round(seconds * 1000), engine: 'chromium' });
}
export function recordSessionStart(id: string) {
  append({ t: new Date().toISOString(), kind: 'session_start', id, ms: 0, engine: 'chromium' });
}

// Splits a session at UTC midnight so each day gets its own share.
export function recordSessionEnd(id: string, startMs: number, endMs: number) {
  let s = startMs;
  while (s < endMs) {
    const next = Date.UTC(new Date(s).getUTCFullYear(), new Date(s).getUTCMonth(), new Date(s).getUTCDate() + 1);
    const e = Math.min(endMs, next);
    append({ t: new Date(e === next ? next - 1 : e).toISOString(), kind: 'session_end', id, ms: e - s, engine: 'chromium' });
    s = e;
  }
}

function read(file: string): Entry[] {
  try {
    return readFileSync(join(dir(), file), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

export interface Totals { sessionMs: number; quickMs: number; crawlMs: number; kitesurfMs: number; sessions: number; quick: number }

function total(entries: Entry[]): Totals {
  const t: Totals = { sessionMs: 0, quickMs: 0, crawlMs: 0, kitesurfMs: 0, sessions: 0, quick: 0 };
  for (const e of entries) {
    if (e.engine === 'kitesurf') { t.kitesurfMs += e.ms; t.quick++; continue; }
    if (e.kind === 'session_end') t.sessionMs += e.ms;
    if (e.kind === 'session_start') t.sessions++;
    if (e.kind === 'quick') { t.quickMs += e.ms; t.quick++; }
    if (e.kind === 'crawl') t.crawlMs += e.ms;
  }
  return t;
}

export function today(): Totals { return total(read(`${day(new Date())}.jsonl`)); }

export function month(): Totals {
  const prefix = day(new Date()).slice(0, 7);
  let files: string[] = [];
  try { files = readdirSync(dir()).filter(f => f.startsWith(prefix) && f.endsWith('.jsonl')); } catch { /* none yet */ }
  return total(files.flatMap(read));
}

// Budgeted minutes today: finished sessions + live sessions so far + Quick Actions + crawls, Kitesurf excluded.
export function budgetUsedMin(liveMsToday: number): number {
  const t = today();
  return (t.sessionMs + t.quickMs + t.crawlMs + liveMsToday) / 60000;
}

export const startOfUtcDay = () => { const n = new Date(); return Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()); };
