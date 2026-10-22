import { mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { pathToFileURL } from 'node:url';
import { cfg, keepAliveMs } from './config.js';
import { rest, wsUrl, authHeaders, ToolError, mask, sleep } from './cf.js';
import { pw } from './deps.js';
import * as profiles from './profiles.js';
import * as usage from './usage.js';

// Claude Code's pid, or its parent's when a node version shim sits in between (the stop notice matches either).
const GRAND_PID = (() => { if (process.platform === 'win32') return undefined; try { return Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(process.ppid)], { encoding: 'utf8', timeout: 2000 }).trim()) || undefined; } catch { return undefined; } })();

export const SERVER_NONCE = randomBytes(6).toString('hex');
export const PAGE_CAPABILITIES = ['core', 'core-navigation', 'core-tabs', 'core-input', 'vision', 'network'];

export interface Handoff { id: string; startedAt: number; timeoutMs: number; instructions: string; result: { status: 'done' | 'failed' | 'timeout' | 'ended'; reason?: string; at: number } | null; saved?: boolean }
export interface Rec {
  id: string; label: string; createdAt: number; lastActivityAt: number; closedAt?: number;
  profile: string | null; profileMode: 'write' | 'read' | 'none'; recording: boolean; lab: boolean; guardrails: any;
  idleTimeoutS: number; maxAgeMin: number; state: 'open' | 'closing' | 'closed'; closeReason?: string;
  handoff: Handoff | null; firstSaveDone: boolean; lastSaveAt: number; disconnected?: boolean;
  chain: Promise<unknown>; browser?: any; context?: any; page?: any; cdp?: any; browserCdp?: any; targetId?: string;
  client?: Client; server?: any;
  inflight: number; currentPage?: any; hcdp?: any; htarget?: string; remoteCloseUnconfirmed?: boolean;
}

export const records = new Map<string, Rec>();
export const own = () => [...records.values()].filter(r => r.state !== 'closed');

const stateDir = () => join(cfg.dataDir, 'state', 'servers');
const stateFile = () => join(stateDir(), `${process.pid}-${SERVER_NONCE}.json`);
export const stateFilePath = stateFile;

export function writeState() {
  try {
    mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
    profiles.writeAtomic(stateFile(), JSON.stringify({
      serverPid: process.pid, nonce: SERVER_NONCE, claudePid: process.ppid, claudeGrandPid: GRAND_PID, updatedAt: new Date().toISOString(),
      sessions: own().map(r => ({ id: r.id, label: r.label, profile: r.profile, mode: r.profileMode, createdAt: r.createdAt, lastActivityAt: r.lastActivityAt, keepAliveS: keepAliveMs(r.idleTimeoutS) / 1000, idleTimeoutS: r.idleTimeoutS, state: r.state })),
    }));
  } catch (e) { process.stderr.write(`[cf-browser] state write failed: ${mask(e)}\n`); }
}

const ago = (ms: number) => { const s = Math.round(ms / 1000); return s < 90 ? `${s}s` : `${Math.round(s / 60)}m`; };

export function liveMsToday() {
  const day0 = usage.startOfUtcDay();
  return own().reduce((n, r) => n + (Date.now() - Math.max(r.createdAt, day0)), 0) + otherWindowsLiveMs(day0);
}

// Browsers other live Claude Code windows have open on this machine: their time reaches the ledger only at close.
function otherWindowsLiveMs(day0: number) {
  let n = 0, files: string[] = [];
  try { files = readdirSync(stateDir()).filter(f => f.endsWith('.json') && f !== `${process.pid}-${SERVER_NONCE}.json`); } catch { return 0; }
  for (const f of files) {
    try {
      const s = JSON.parse(readFileSync(join(stateDir(), f), 'utf8'));
      if (Date.now() - Date.parse(s.updatedAt) >= profiles.STALE_MS) continue;
      try { process.kill(s.serverPid, 0); } catch (e: any) { if (e?.code !== 'EPERM') continue; }
      for (const x of s.sessions || []) if (x.state !== 'closed') n += Date.now() - Math.max(x.createdAt, day0);
    } catch { /* unreadable: skip */ }
  }
  return n;
}

function uniqueLabel(want?: string) {
  const taken = new Set(own().map(r => r.label));
  let base = (want || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
  if (!base) { let n = 1; while (taken.has(`b${n}`)) n++; return `b${n}`; }
  let label = base, n = 2;
  while (taken.has(label)) label = `${base}-${n++}`;
  return label;
}

export function describe(r: Rec) {
  const now = Date.now();
  return {
    session_id: r.id, label: r.label, state: r.state,
    profile: r.profile, profile_mode: r.profileMode,
    age: ago(now - r.createdAt), idle: ago(now - r.lastActivityAt),
    closes_if_idle_in: r.state === 'open' ? ago(Math.max(0, r.idleTimeoutS * 1000 - (now - r.lastActivityAt))) : undefined,
    recording: r.recording, lab: r.lab, guardrails: r.guardrails ? r.guardrails.allowedDomains || r.guardrails.allowedDomainSets : undefined,
    handoff: r.handoff ? (r.handoff.result ? r.handoff.result.status : 'active') : undefined,
    close_reason: r.closeReason,
  };
}

export interface CreateArgs {
  profile?: string; profile_mode?: 'write' | 'read' | 'none'; record?: boolean; lab?: boolean;
  allowed_domains?: string[]; allowed_domain_sets?: string[]; idle_timeout_s?: number; start_url?: string; label?: string; confirm_over_budget?: boolean;
}

export async function createSession(a: CreateArgs) {
  const { chromium, createConnection } = pw();
  const warnings: string[] = [];

  // 1. budget
  const used = usage.budgetUsedMin(liveMsToday());
  if (used >= cfg.dailyBudgetMin && !a.confirm_over_budget) {
    throw new ToolError('BUDGET_EXCEEDED', `Today's browser time is ${used.toFixed(1)} min of the ${cfg.dailyBudgetMin} min daily budget (UTC day, this machine's ledger).`, 'Ask the user. If they agree, retry with confirm_over_budget:true, or they can raise daily_budget_minutes in /plugin → cf-browser → configure.');
  }
  if (used >= cfg.dailyBudgetMin * 0.8) warnings.push(`Budget: ${used.toFixed(1)} of ${cfg.dailyBudgetMin} min used today.`);

  // 2. concurrency (browsers still being created count too, so parallel calls cannot overshoot)
  const open = own();
  if (open.length + creating >= cfg.maxConcurrent) {
    throw new ToolError('TOO_MANY_SESSIONS', `This window already has ${open.length + creating} open browser(s), the max_concurrent_sessions limit: ${open.map(r => `${r.label} (${r.id}, profile ${r.profile ?? 'none'}, idle ${ago(Date.now() - r.lastActivityAt)})`).concat(creating ? [`${creating} still opening`] : []).join('; ')}.`, 'Reuse one of them (pass its session_id), or session_close one first.');
  }

  creating++;
  let reserved = true;
  const unreserve = () => { if (reserved) { reserved = false; creating--; } };
  try {
  // 3. profile
  const mode = a.profile_mode || 'write';
  let profile: string | null = null;
  let storageState: any;
  const pendingId = `pending-${randomBytes(4).toString('hex')}`;
  const label = uniqueLabel(a.label);
  if (mode !== 'none') {
    profile = (a.profile || cfg.defaultProfile).toLowerCase();
    profiles.checkName(profile);
    if (mode === 'write') {
      const got = profiles.acquireLock(profile, { serverPid: process.pid, nonce: SERVER_NONCE, claudePid: process.ppid, sessionId: pendingId, label, since: new Date().toISOString(), updatedAt: new Date().toISOString() });
      if (!got.ok) throw profileInUse(profile, got.holder);
    } else if (!profiles.exists(profile)) {
      throw new ToolError('PROFILE_NOT_FOUND', `Profile "${profile}" does not exist yet, so there is nothing to open read-only.`, 'Use profile_mode:"none" for an empty browser, or log in first (cf-browser:login).');
    }
    storageState = profiles.loadState(profile);
  }

  const idleTimeoutS = Math.min(cfg.plan === 'free' ? 300 : 1140, Math.max(60, Math.round(a.idle_timeout_s || cfg.idleTimeoutS)));
  const guardrails = a.allowed_domains?.length || a.allowed_domain_sets?.length
    ? { ...(a.allowed_domains?.length ? { allowedDomains: a.allowed_domains } : {}), ...(a.allowed_domain_sets?.length ? { allowedDomainSets: a.allowed_domain_sets } : {}) }
    : null;

  // 4. acquire
  let id: string;
  try {
    const r = await rest('POST', '/devtools/browser', { query: { keep_alive: keepAliveMs(idleTimeoutS), recording: !!a.record, lab: !!a.lab }, json: guardrails ? { guardrails } : undefined });
    id = r.data?.sessionId;
    if (!id) throw new ToolError('CLOUDFLARE', `Cloudflare did not return a session id: ${mask(JSON.stringify(r.data)).slice(0, 200)}`);
  } catch (e) {
    if (profile && mode === 'write') profiles.releaseLock(profile, SERVER_NONCE, pendingId);
    throw e;
  }

  const now = Date.now();
  const rec: Rec = {
    id, label, createdAt: now, lastActivityAt: now, profile, profileMode: mode, recording: !!a.record, lab: !!a.lab, guardrails,
    idleTimeoutS, maxAgeMin: cfg.maxSessionMin, state: 'open', handoff: null, firstSaveDone: false, lastSaveAt: now, chain: Promise.resolve(), inflight: 0,
  };
  records.set(id, rec);
  unreserve();
  if (profile && mode === 'write') rewriteLock(profile, pendingId, id);
  writeState();
  usage.recordSessionStart(id);

  try {
    // 5. connect, our own context with the profile's storage state, drop the default about:blank
    const browser = await chromium.connectOverCDP(await wsUrl(id), { headers: authHeaders(), timeout: 30000 });
    rec.browser = browser;
    browser.on('disconnected', () => onDisconnect(rec));
    const context = await browser.newContext({ storageState, viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    for (const c of browser.contexts()) if (c !== context) for (const p of c.pages()) await p.close().catch(() => {});
    rec.context = context; rec.page = page;
    rec.cdp = await context.newCDPSession(page);
    rec.targetId = (await rec.cdp.send('Target.getTargetInfo')).targetInfo.targetId;
    rec.browserCdp = await browser.newBrowserCDPSession();

    // 6. page tools: one embedded @playwright/mcp server bound to this context
    const server = await createConnection({
      capabilities: PAGE_CAPABILITIES, codegen: 'none', webmcp: !!a.lab, timeouts: { idle: 0 },
      outputDir: join(cfg.dataDir, 'out', id), filePaths: 'absolute', allowUnrestrictedFileAccess: false,
    }, async () => { if (rec.state !== 'open') throw new Error('SESSION_CLOSED'); return context; });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: 'cf-browser', version: '1' }, { capabilities: { roots: {} } });
    client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: [{ uri: pathToFileURL(cfg.projectDir || tmpdir()).href, name: 'project' }] }));
    await client.connect(clientT);
    rec.client = client; rec.server = server;

    // 7. start page
    let start: any;
    if (a.start_url) {
      try {
        const resp = await page.goto(a.start_url, { timeout: 30000, waitUntil: 'domcontentloaded' });
        start = { url: page.url(), status: resp?.status(), title: await page.title().catch(() => '') };
        if (resp?.status() === 403 && (await resp.allHeaders())['cf-mitigated'] === 'guardrails') start.blocked = 'guardrails: this host is not in allowed_domains';
      } catch (e: any) { start = { url: a.start_url, error: mask(e?.message || e).split('\n')[0] }; }
    }
    rec.lastActivityAt = Date.now();
    writeState();
    return {
      session_id: id, label, profile, profile_mode: mode,
      profile_note: profile ? (storageState ? `loaded saved logins (${(storageState.cookies || []).length} cookies)` : 'profile is empty; logins made in this browser are saved to it on close') : 'throwaway browser, nothing saved',
      idle_close_after_s: idleTimeoutS, max_age_min: rec.maxAgeMin, recording: rec.recording, lab: rec.lab,
      guardrails: guardrails || 'none', start,
      warnings: warnings.length ? warnings : undefined,
      next: 'Call browser_snapshot with this session_id to see the page and its element refs. Close with session_close when the task is done.',
    };
  } catch (e) {
    await closeSession(rec, { save: false, reason: 'create failed' }).catch(() => {});
    throw e instanceof ToolError ? e : new ToolError('CREATE_FAILED', `Could not set up the browser: ${mask((e as any)?.message || e).split('\n')[0]}`);
  }
  } finally { unreserve(); }
}
let creating = 0;

function rewriteLock(profile: string, oldSession: string, newSession: string) {
  const l = profiles.readLock(profile);
  if (!l || l.nonce !== SERVER_NONCE || l.sessionId !== oldSession) return;
  profiles.writeAtomic(join(profiles.profileDir(profile), 'lock.json'), JSON.stringify({ ...l, sessionId: newSession, updatedAt: new Date().toISOString() }));
}

export function profileInUse(profile: string, h: profiles.LockInfo) {
  const where = h.serverPid === process.pid ? 'this session' : 'another agent session on this computer';
  const since = h.since ? ago(Date.now() - Date.parse(h.since)) : '?';
  return new ToolError('PROFILE_IN_USE',
    `Profile "${profile}" is already open in browser ${h.label} (since ${since}, in ${where}). Two browsers saving one profile overwrite each other's logins. Choose:\n` +
    `1. Clone it (best for parallel work): profile_clone from=${profile} to=${profile}-2, then use ${profile}-2. It starts with the same logins and keeps its own cookies from then on. If a site signs one of them out (some allow only one active session per login), log in again inside the clone.\n` +
    `2. Open read-only: session_create with profile_mode:"read" — same logins, nothing saved back.\n` +
    `3. Wait, or close the other browser (session_close ${h.sessionId?.startsWith('pending') ? '' : h.sessionId}).`,
    'Ask the user which option they want (a subagent that cannot ask picks option 2 and reports it).');
}

// ---- running a tool against a session ----
export function getRec(id: string): Rec {
  const rec = records.get(id);
  if (!rec) {
    const open = own();
    throw new ToolError('SESSION_NOT_FOUND', `No browser with session_id "${id}" in this window.${open.length ? ' Open: ' + open.map(r => `${r.label}=${r.id}`).join(', ') : ' None are open.'}`, 'Use session_list, or session_create a new one.');
  }
  if (rec.state !== 'open') throw new ToolError('SESSION_CLOSED', `Browser ${rec.label} is ${rec.state}${rec.closeReason ? ` (${rec.closeReason})` : ''}.`, 'session_create a new one; a write-mode profile keeps the logins saved before close.');
  return rec;
}

export function handoffActive(r: Rec) {
  return !!(r.handoff && !r.handoff.result && Date.now() < r.handoff.startedAt + r.handoff.timeoutMs + 5000);
}

export async function withSession<T>(id: string, fn: (r: Rec) => Promise<T>, opts: { pageTool?: boolean } = {}): Promise<T> {
  const rec = getRec(id);
  if (opts.pageTool && handoffActive(rec)) throw new ToolError('HANDOFF_ACTIVE', `A human is using browser ${rec.label} right now (handoff in progress).`, 'Call human_wait with this session_id until it reports done; do not ask the user whether they are finished.');
  const prev = rec.chain;
  let release!: () => void;
  rec.chain = new Promise<void>(r => (release = r));
  try {
    await prev;
    if (rec.state !== 'open') getRec(id);
    // Checked again here: a handoff may have started while this call waited in the queue.
    if (opts.pageTool && handoffActive(rec)) throw new ToolError('HANDOFF_ACTIVE', `A human is using browser ${rec.label} right now (handoff in progress).`, 'Call human_wait with this session_id until it reports done; do not ask the user whether they are finished.');
    rec.lastActivityAt = Date.now();
    rec.inflight++;
    let out: T;
    try { out = await fn(rec); } finally { rec.inflight--; }
    rec.lastActivityAt = Date.now();
    await ping(rec);
    return out;
  } catch (e: any) {
    if (rec.state !== 'open' || /Target (page, context or browser )?(has been )?closed|Browser has been closed|disconnected/i.test(String(e?.message))) {
      throw new ToolError('SESSION_CLOSED', `Browser ${rec.label} is closed${rec.closeReason ? ` (${rec.closeReason})` : ''}.`, 'session_create a new one.');
    }
    throw e;
  } finally { release(); }
}

async function ping(r: Rec) {
  // One cheap CDP command so Cloudflare's idle timer moves with ours.
  try { await Promise.race([r.browserCdp?.send('Browser.getVersion'), sleep(5000)]); } catch { /* disconnect handler deals with it */ }
}

// ---- saving ----
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: any;
  try { return await Promise.race([p, new Promise<T>((_, rej) => (t = setTimeout(() => rej(new Error('timeout')), ms)))]); } finally { clearTimeout(t); }
}

export async function saveProfile(r: Rec) {
  if (r.profileMode !== 'write' || !r.profile) throw new ToolError('NOT_WRITE_MODE', `Browser ${r.label} is in ${r.profileMode} mode; nothing is saved.`);
  let state: any;
  try { state = await withTimeout(r.context.storageState({ indexedDB: true }), 3000); }
  catch { state = await withTimeout(r.context.storageState(), 3000); }
  profiles.save(r.profile, state, r.id, !r.firstSaveDone);
  r.firstSaveDone = true;
  r.lastSaveAt = Date.now();
  return { profile: r.profile, cookies: (state.cookies || []).length, origins_with_storage: (state.origins || []).length };
}

// ---- closing ----
export async function closeSession(r: Rec, o: { save?: boolean; reason: string }) {
  if (r.state !== 'open') return { saved: null as any, already: r.state };
  r.state = 'closing'; r.closeReason = o.reason;
  await Promise.race([r.chain, sleep(10000)]);
  let saved: any = null;
  if (r.profileMode === 'write' && o.save !== false && !r.disconnected && r.context) {
    try { saved = await saveProfile(r); } catch (e: any) { saved = { error: mask(e?.message || e).split('\n')[0] }; }
  }
  await finish(r, true);
  return { saved, ...(r.remoteCloseUnconfirmed ? { remote_close: `unconfirmed: Cloudflare did not answer the close; with no client connected it ends the browser within ${keepAliveMs(r.idleTimeoutS) / 1000}s (keep_alive)` } : {}) };
}

async function finish(r: Rec, deleteRemote: boolean) {
  await r.client?.close().catch(() => {});
  await r.server?.close?.().catch(() => {});
  await r.browser?.close().catch(() => {});
  if (deleteRemote) await rest('DELETE', `/devtools/browser/${r.id}`, { allow404: true, timeoutMs: 10000 }).catch(() => { r.remoteCloseUnconfirmed = true; });
  r.state = 'closed'; r.closedAt = Date.now();
  if (r.profile && r.profileMode === 'write') profiles.releaseLock(r.profile, SERVER_NONCE, r.id);
  writeState();
  usage.recordSessionEnd(r.id, r.createdAt, r.closedAt);
}

function onDisconnect(r: Rec) {
  if (r.state !== 'open') return;
  r.disconnected = true;
  r.closeReason = 'Cloudflare ended the browser (idle timeout, eviction or crash); the profile was not saved at that moment';
  r.state = 'closing';
  finish(r, true).catch(() => {});
}

// ---- reaper ----
let reaper: NodeJS.Timeout | undefined;
export function startReaper() { reaper = setInterval(() => { reapTick().catch(e => process.stderr.write(`[cf-browser] reaper: ${mask(e)}\n`)); }, cfg.reapMs); reaper.unref(); }

async function reapTick() {
  const now = Date.now();
  for (const r of own()) {
    if (r.state !== 'open') continue;
    if (r.profile && r.profileMode === 'write') profiles.touchLock(r.profile, SERVER_NONCE, r.id);
    if (r.handoff && !r.handoff.result) {
      // A handoff does not keep the session alive by itself (verified): keep it warm and watch the state.
      await ping(r);
      try {
        const s = await (r.hcdp || r.cdp).send('Cloudflare.getHandoffState', { targetId: r.htarget || r.targetId });
        if (!s.active && !r.handoff.result) r.handoff.result = { status: 'ended', at: Date.now() };
      } catch { /* next tick */ }
      if (!r.handoff.result && now > r.handoff.startedAt + r.handoff.timeoutMs + 5000) r.handoff.result = { status: 'timeout', at: now };
      if (!r.handoff.result) continue;
      r.lastActivityAt = now;
    }
    if (r.inflight === 0 && now - r.lastActivityAt >= r.idleTimeoutS * 1000) { await closeSession(r, { save: true, reason: `idle for ${r.idleTimeoutS}s` }); continue; }
    if (now - r.createdAt >= r.maxAgeMin * 60000) { await closeSession(r, { save: true, reason: `reached max age ${r.maxAgeMin} min` }); continue; }
    if (r.profileMode === 'write' && now - r.lastActivityAt < 300000 && now - r.lastSaveAt >= 300000) {
      await saveProfile(r).catch(() => {});
    }
  }
  writeState();
}

// ---- shutdown ----
let shuttingDown = false;
export async function shutdown(why: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (reaper) clearInterval(reaper);
  const open = own();
  process.stderr.write(`[cf-browser] ${why}: closing ${open.length} browser(s)\n`);
  await Promise.race([Promise.all(open.map(r => closeSession(r, { save: true, reason: 'the agent session ended' }).catch(() => {}))), sleep(4000)]);
  const left = open.filter(r => r.state !== 'closed');
  await Promise.race([Promise.all(left.map(r => rest('DELETE', `/devtools/browser/${r.id}`, { allow404: true, timeoutMs: 3000 }).then(() => {
    r.state = 'closed'; r.closedAt = Date.now();
    if (r.profile && r.profileMode === 'write') profiles.releaseLock(r.profile, SERVER_NONCE, r.id);
    usage.recordSessionEnd(r.id, r.createdAt, r.closedAt);
  }).catch(() => {}))), sleep(3000)]);
  if (own().length === 0) { try { unlinkSync(stateFile()); } catch { /* gone */ } } else writeState();
}

// ---- startup sweep of browsers a crashed earlier server left behind ----
export let sweepReport: { closed: number; files: number } = { closed: 0, files: 0 };
export async function sweepOrphans() {
  let files: string[] = [];
  try { files = readdirSync(stateDir()).filter(f => f.endsWith('.json')); } catch { return; }
  for (const f of files) {
    if (f === `${process.pid}-${SERVER_NONCE}.json`) continue;
    let s: any;
    try { s = JSON.parse(readFileSync(join(stateDir(), f), 'utf8')); } catch { continue; }
    let alive = false;
    try { process.kill(s.serverPid, 0); alive = true; } catch (e: any) { alive = e?.code === 'EPERM'; }
    if (alive && Date.now() - Date.parse(s.updatedAt) < profiles.STALE_MS) continue;
    for (const x of s.sessions || []) {
      let end = Math.min(Date.now(), (x.lastActivityAt || x.createdAt) + (x.keepAliveS || 1200) * 1000);
      try {
        const d = await rest('DELETE', `/devtools/browser/${x.id}`, { allow404: true, timeoutMs: 10000 });
        if (d.status !== 404) { end = Date.now(); sweepReport.closed++; }
      } catch { /* leave it to keep_alive */ }
      usage.recordSessionEnd(x.id, x.createdAt, Math.max(end, x.createdAt));
      if (x.profile && x.mode === 'write') profiles.releaseLock(x.profile, s.nonce);
    }
    try { unlinkSync(join(stateDir(), f)); sweepReport.files++; } catch { /* gone */ }
  }
  if (sweepReport.files) process.stderr.write(`[cf-browser] sweep: ${sweepReport.files} stale state file(s), ${sweepReport.closed} browser(s) still running were closed\n`);
}
