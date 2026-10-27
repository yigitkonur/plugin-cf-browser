import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { basename, join } from 'node:path';
import { cfg, keepAliveMs } from './config.js';
import { ToolError } from './cf.js';
import * as profiles from './profiles.js';
import * as usage from './usage.js';
import { CloudBackend } from './backend.js';
import { Operations, failure, type Operation } from './operations.js';
import type { BrowserRecord, ClientRecord, Task, Tab } from './models.js';
import * as page from './page.js';

const id = (prefix: string) => `${prefix}_${randomUUID()}`;
export function pidAlive(pid: number) { try { process.kill(pid, 0); return true; } catch (e: any) { return e.code === 'EPERM'; } }

export class Manager {
  readonly browsers = new Map<string, BrowserRecord>();
  readonly tasks = new Map<string, Task>();
  readonly clients = new Map<string, ClientRecord>();
  readonly operations: Operations;
  readonly nonce = randomUUID();
  readonly uncertainCreates = new Map<string, { startedAt: number; waitUntil: number }>();
  readonly artifacts = new Map<string, any>();
  private downloads = new Map<string, any>();
  private queues = new Map<string, Promise<any>>();
  private checkpointing = new Map<string, Promise<any>>();
  private attaching = new Map<string, Promise<any>>();
  private ticking = false;
  private identityTabs = new Map<string, string>();
  readonly journal: string;
  dashboardUrl = '';
  constructor(readonly root: string, readonly backend = new CloudBackend(), replyMs = 10_000) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.journal = join(root, 'journal.json');
    this.operations = new Operations(replyMs);
  }
  async serial<T>(profile: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(profile) || Promise.resolve();
    const current = previous.catch(() => {}).then(fn);
    this.queues.set(profile, current);
    try { return await current; } finally { if (this.queues.get(profile) === current) this.queues.delete(profile); }
  }
  persist() {
    profiles.writeAtomic(this.journal, JSON.stringify({ version: 1, artifacts: [...this.artifacts.values()], uncertainCreates: [...this.uncertainCreates.entries()], clients: [...this.clients.values()], tasks: [...this.tasks.values()],
      browsers: [...this.browsers.values()].filter(r => r.state !== 'closed').map(r => ({ id: r.id, profile: r.profile, state: r.state, recording: r.recording, lab: r.lab, createdAt: r.createdAt, lastSaveAt: r.lastSaveAt,
        tabs: [...r.tabs.values()].filter(t => !t.closed).map(t => ({ id: t.id, taskId: t.taskId, targetId: t.targetId, title: t.title, operationMutates: !!t.operationId && t.operationMutates, control: t.control, humanScope: t.humanScope, humanSince: t.humanSince, handoff: t.handoff })) })) }));
  }
  async restore() {
    if (!existsSync(this.journal)) return;
    let state: any;
    try { state = JSON.parse(readFileSync(this.journal, 'utf8')); if (state.version !== 1 || !Array.isArray(state.browsers)) throw new Error(); }
    catch { throw new ToolError('JOURNAL_CORRUPT', 'Manager recovery journal is unreadable. Existing remote browsers have not been replaced.', 'Restore the journal or reconcile the account sessions before starting a new manager.'); }
    for (const [profile, intent] of state.uncertainCreates || []) this.uncertainCreates.set(profile, intent);
    for (const c of state.clients || []) this.clients.set(c.id, c);
    for (const t of state.tasks || []) this.tasks.set(t.id, t);
    for (const a of state.artifacts || []) this.artifacts.set(a.artifact_id, a.status === 'downloading' ? { ...a, status: 'failed', error: 'Download transfer was interrupted by manager restart.' } : a);
    for (const saved of state.browsers) {
      const r: BrowserRecord = { ...saved, tabs: new Map(), authEpoch: 1, connected: false };
      for (const t of saved.tabs) r.tabs.set(t.id, { ...t, interrupted: !!t.operationMutates, generation: 1, needsObservation: true, events: [{ type: 'recovered', note: 'Observe before continuing. Previous actions were not replayed.' }], closed: false });
      this.browsers.set(r.profile, r);
      if (['closing', 'close_unconfirmed'].includes(r.state)) continue;
      const lock = this.lock(r.profile, r.id);
      if (!lock.ok) throw new ToolError('LEGACY_WRITER_ACTIVE', `Profile "${r.profile}" still has an active writer.`, 'Let the existing session finish, then reconnect.');
      r.state = 'recovering';
    }
  }
  register(client: ClientRecord) {
    if (!client.id || !Number.isInteger(client.pid) || client.pid < 1) throw new ToolError('BAD_CLIENT', 'A local client id and PID are required.');
    const existing = this.clients.get(client.id);
    if (existing && existing.pid !== client.pid) throw new ToolError('BAD_CLIENT', 'The client id belongs to another process.');
    this.clients.set(client.id, { ...client, seenAt: Date.now() });
  }
  task(clientId: string, taskId: string) {
    const t = this.tasks.get(taskId);
    if (!t || t.clientId !== clientId || t.state !== 'active') throw new ToolError('TASK_NOT_FOUND', 'No active task with this id belongs to this client.', 'Use task_start to start or list your tasks.');
    return t;
  }
  findTab(tabId: string) {
    for (const r of this.browsers.values()) { const t = r.tabs.get(tabId); if (t) return { r, t }; }
    throw new ToolError('TAB_NOT_FOUND', 'This tab is not known to the manager.', 'List your tabs.');
  }
  ownedTab(clientId: string, tabId: string, allowHuman = false) {
    const { r, t } = this.findTab(tabId);
    if (t.closed) throw new ToolError('TAB_CLOSED', 'This tab has closed.', 'Open a new tab in your existing task; previous mutations are not replayed.');
    this.task(clientId, t.taskId!);
    if (!allowHuman && (t.control === 'human' || t.pendingHuman)) throw new ToolError('HUMAN_CONTROL', 'The user controls this tab.', 'Check human status; independent tabs can continue.');
    return { r, t };
  }
  private lock(profile: string, sessionId: string) {
    const old = profiles.readLock(profile);
    if (old?.nonce === this.nonce) return { ok: true as const };
    return profiles.acquireLock(profile, { serverPid: process.pid, claudePid: 0, nonce: this.nonce, sessionId, label: 'shared manager', since: new Date().toISOString(), updatedAt: new Date().toISOString() });
  }
  private async ensure(profile: string, options: any = {}) {
    const uncertain = this.uncertainCreates.get(profile);
    if (uncertain && Date.now() < uncertain.waitUntil) throw new ToolError('CREATE_UNCONFIRMED', 'A previous browser creation lost its response. No second browser was created.', 'Wait for the unconnected browser’s Cloudflare keep_alive window to expire; doctor shows recovery timing.');
    this.uncertainCreates.delete(profile);
    let r = this.browsers.get(profile);
    if (r && ['closing', 'close_unconfirmed'].includes(r.state)) {
      await this.close(r, false);
      if (r.state !== 'closed') throw new ToolError('CLOSE_UNCONFIRMED', 'The previous browser is still being closed.', 'Use doctor or operation status; cleanup retries automatically.');
    }
    if (r && r.state !== 'closed') {
      if ((options.record && !r.recording) || (options.lab && !r.lab)) throw new ToolError('BROWSER_OPTIONS_ACTIVE', 'Recording/lab options are chosen before the shared browser starts.', 'Finish the existing tasks, then start a task with these advanced options. Existing work was not interrupted.');
      await this.connected(r);
      if ((r as BrowserRecord).state !== 'closed') return r;
    }
    profiles.checkName(profile);
    const got = this.lock(profile, 'opening');
    if (!got.ok) throw new ToolError('LEGACY_WRITER_ACTIVE', `Profile "${profile}" is owned by an existing browser process.`, 'Let that session finish before migration; parallel agents on the new manager share the profile automatically.');
    let remoteId: string | undefined;
    try {
      const state = profiles.loadState(profile);
      this.uncertainCreates.set(profile, { startedAt: Date.now(), waitUntil: Date.now() + keepAliveMs(cfg.idleTimeoutS) + 60_000 }); this.persist();
      remoteId = await this.backend.create({ recording: !!options.record, lab: !!options.lab });
      r = { id: remoteId, profile, state: 'open', tabs: new Map(), authEpoch: 0, recording: !!options.record, lab: !!options.lab, createdAt: Date.now(), lastSaveAt: Date.now(), connected: false };
      this.browsers.set(profile, r); this.uncertainCreates.delete(profile); this.persist();
      const l = profiles.readLock(profile)!;
      profiles.writeAtomic(join(profiles.profileDir(profile), 'lock.json'), JSON.stringify({ ...l, sessionId: remoteId }));
      usage.recordSessionStart(remoteId);
      await this.backend.connect(r, state);
      this.listen(r); return r;
    } catch (e) {
      if (remoteId && r) await this.close(r, false);
      else {
        if ((e as any)?.code !== 'OUTCOME_UNKNOWN') this.uncertainCreates.delete(profile);
        profiles.releaseLock(profile, this.nonce); this.persist();
      }
      throw e;
    }
  }
  async connected(r: BrowserRecord) {
    if (r.connected) return;
    if (this.attaching.has(r.id)) return this.attaching.get(r.id);
    const flight = (async () => {
      r.state = 'recovering';
      if (!await this.backend.alive(r.id)) {
        r.state = 'closed';
        for (const t of r.tabs.values()) { t.closed = true; page.invalidate(t); }
        profiles.releaseLock(r.profile, this.nonce); this.persist(); return;
      }
      try {
        await this.backend.connect(r, undefined, true);
        for (const t of r.tabs.values()) page.invalidate(t);
        const previous = [...r.tabs.values()];
        for (const p of r.context.pages()) await this.adopt(r, p);
        for (const t of previous) if (t.interrupted && t.page && !t.closed) { await this.backend.stop(t); t.interrupted = false; page.invalidate(t); }
        for (const t of previous) if (!t.page || t.page.isClosed()) t.closed = true;
        r.state = 'open'; this.listen(r); this.persist();
      } catch (e: any) {
        r.connected = false;
        if (e.code === 'CONTEXT_LOST' && ![...r.tabs.values()].some(t => t.control === 'human')) {
          await this.close(r, false); return;
        }
        throw new ToolError('RECONNECT_PENDING', 'Cannot reconnect to the existing browser yet.', 'Retry status later. No action was replayed and the user browser was not replaced.');
      }
    })();
    this.attaching.set(r.id, flight);
    try { await flight; } finally { this.attaching.delete(r.id); }
  }
  private listen(r: BrowserRecord) {
    r.context.on('page', (p: any) => { this.adopt(r, p).catch(e => { r.closeError = failure(e); }); });
    r.browser?.on('disconnected', () => { if (r.state === 'open') { r.connected = false; r.state = 'recovering'; for (const t of r.tabs.values()) page.invalidate(t); this.persist(); } });
  }
  private adoption = new WeakMap<object, Promise<Tab>>();
  async adopt(r: BrowserRecord, p: any, taskId?: string): Promise<Tab> {
    const known = [...r.tabs.values()].find(t => t.page === p);
    if (known) { if (taskId) { known.taskId = taskId; known.control = 'agent'; known.humanScope = undefined; } return known; }
    if (this.adoption.has(p)) { const t = await this.adoption.get(p)!; if (taskId) { t.taskId = taskId; t.control = 'agent'; t.humanScope = undefined; } return t; }
    const flight = (async () => {
      const { targetId, cdp } = await this.backend.identify(r, p);
      let t = [...r.tabs.values()].find(t => t.targetId === targetId);
      const opener = await p.opener().catch(() => null);
      const parent = [...r.tabs.values()].find(t => t.page === opener);
      if (!t) {
        t = { id: id('tab'), taskId: taskId || parent?.taskId, targetId, page: p, cdp, generation: 0,
          control: taskId || parent?.control === 'agent' ? 'agent' : 'human',
          humanScope: !taskId && parent?.control !== 'agent' ? 'tab' : undefined,
          needsObservation: true, events: [], closed: false };
        r.tabs.set(t.id, t);
      } else { t.page = p; t.cdp = cdp; t.closed = false; }
      const tab = t;
      if (parent) parent.events.push({ type: 'popup', tab_id: tab.id, url: p.url() });
      p.on('framenavigated', () => { page.invalidate(tab); p.title().then((title: string) => { tab.title = title; }).catch(() => {}); });
      p.on('close', () => {
        if (tab.control === 'human' || tab.pendingHuman) this.resumeAfterHuman(r, tab);
        tab.closed = true; page.invalidate(tab); this.persist();
      });
      p.on('dialog', (dialog: any) => { tab.dialog = dialog; tab.events.push({ type: 'dialog', dialog_type: dialog.type(), message: dialog.message() }); });
      (tab as any).console = []; (tab as any).network = [];
      p.on('console', (msg: any) => { const log = (tab as any).console; log.push({ level: msg.type(), text: msg.text() }); if (log.length > 200) log.shift(); });
      p.on('response', (response: any) => { const log = (tab as any).network; log.push(response); if (log.length > 200) log.shift(); });
      p.on('filechooser', (chooser: any) => { tab.fileChooser = chooser; tab.events.push({ type: 'file_chooser' }); });
      p.on('download', (download: any) => {
        const artifactId = id('file'), path = join(this.root, 'artifacts', `${artifactId}-${basename(download.suggestedFilename())}`);
        mkdirSync(join(this.root, 'artifacts'), { recursive: true, mode: 0o700 });
        const a = { artifact_id: artifactId, tab_id: tab.id, task_id: tab.taskId, name: download.suggestedFilename(), path, status: 'downloading' };
        this.artifacts.set(artifactId, a); this.downloads.set(artifactId, download); tab.events.push({ type: 'download', artifact_id: artifactId }); this.persist();
        download.saveAs(path).then(() => { chmodSync(path, 0o600); if (a.status !== 'cancelled') a.status = 'ready'; }).catch(() => { if (a.status !== 'cancelled') a.status = 'failed'; })
          .finally(() => { this.downloads.delete(artifactId); this.persist(); });
      });
      cdp.on('Cloudflare.handoffComplete', (event: any) => {
        if (event.targetId && event.targetId !== tab.targetId) return;
        if (tab.handoff && (!event.handoffId || event.handoffId === tab.handoff.id)) {
          tab.handoff.status = event.success === true ? 'done' : event.success === false ? 'failed' : 'ended'; tab.handoff.reason = event.reason; this.persist();
        }
      });
      this.persist(); return tab;
    })();
    this.adoption.set(p, flight);
    try { return await flight; } finally { this.adoption.delete(p); }
  }
  describeTab(t: Tab) {
    return { tab_id: t.id, task_id: t.taskId || null, url: t.page?.url() || null, title: t.title || t.observation?.title || null, human_since: t.humanSince, control: t.control, human_scope: t.humanScope, closed: t.closed,
      operation_id: t.operationId, needs_observation: t.needsObservation, handoff: t.handoff, observation_id: t.observation?.id };
  }
  async start(clientId: string, a: any) {
    const profile = a.task_id ? this.task(clientId, a.task_id).profile : (a.profile || cfg.defaultProfile);
    return this.serial(profile, async () => {
      let task: Task;
      if (a.task_id) { task = this.task(clientId, a.task_id); if (task.profile !== profile) throw new ToolError('BAD_PROFILE', 'Resume this task with its existing profile.'); }
      else { task = { id: id('task'), clientId, profile, label: a.label || 'Browser task', lastActivity: Date.now(), state: 'active' }; this.tasks.set(task.id, task); }
      try {
        const r = await this.ensure(profile, a);
        task.lastActivity = Date.now();
        let tab = [...r.tabs.values()].find(t => t.taskId === task.id && !t.closed);
        if (!tab) tab = await this.adopt(r, await r.context.newPage(), task.id);
        for (const old of (r as any).bootstrapPages || []) if (old !== tab.page && !old.isClosed()) await old.close({ runBeforeUnload: false });
        (r as any).bootstrapPages = undefined;
        this.persist();
        return { task_id: task.id, profile, browser_id: r.id, tab: this.describeTab(tab), dashboard_url: this.dashboardUrl,
          observation: tab.control === 'agent' ? await page.observe(r, tab) : undefined,
          next: 'Use tab_id for page work. Open independent pages with tabs; finish with task_finish.' };
      } catch (e) { if (!a.task_id) { task.state = 'finished'; this.persist(); } throw e; }
    });
  }
  async finish(clientId: string, taskId: string, disconnect = false) {
    const prior = this.tasks.get(taskId);
    if (prior?.clientId === clientId && prior.state === 'finished') return { task_id: taskId, status: 'finished', already_finished: true, browser_state: this.browsers.get(prior.profile)?.state || 'closed' };
    const task = this.task(clientId, taskId);
    return this.serial(task.profile, async () => {
      const r = this.browsers.get(task.profile);
      let checkpointResult: any = { saved: false, next: 'The remote browser is unavailable; only the previous successful checkpoint can be restored.' };
      if (r) {
        if (!r.connected && !['closed', 'closing', 'close_unconfirmed'].includes(r.state)) await this.connected(r);
        const mine = [...r.tabs.values()].filter(t => t.taskId === taskId && !t.closed);
        const busy = mine.filter(t => t.operationId && this.operations.items.get(t.operationId)?.state === 'running');
        if (busy.length && !disconnect) throw new ToolError('TASK_BUSY', 'This task still has running operations.', `Wait or cancel: ${busy.map(t => t.operationId).join(', ')}`);
        if (!disconnect) this.checkDownloads(mine);
        else for (const t of mine) if (t.control !== 'human') await this.cancelDownloads(t);
        // Capture storage before closing the last tab of an origin (IndexedDB/localStorage).
        if (r.connected) {
          const checkpoint = await this.checkpoint(r);
          checkpointResult = checkpoint;
          if (!checkpoint.saved && !disconnect) throw new ToolError('CHECKPOINT_FAILED', 'The profile could not be saved; your task remains open.', 'Retry profile_save or task_finish after connectivity recovers. The last valid checkpoint is intact.');
        }
        for (const t of mine) {
          if (t.control === 'human' || t.pendingHuman) { t.taskId = undefined; continue; }
          if (t.operationId && disconnect) await this.operations.cancel(t.operationId, clientId).catch(() => {});
          if (!t.closed && r.connected) await t.page.close({ runBeforeUnload: false });
          t.closed = true;
        }
      }
      task.state = 'finished'; this.persist();
      if (r && !this.inUse(r)) await this.close(r, false);
      return { task_id: taskId, status: 'finished', browser_state: r?.state || 'closed', profile_checkpoint: checkpointResult,
        ...(r?.state === 'close_unconfirmed' ? { next: 'Remote close is unconfirmed. The manager retains the cleanup record and retries.' } : {}) };
    });
  }
  inUse(r: BrowserRecord) {
    return [...this.tasks.values()].some(t => t.profile === r.profile && t.state === 'active') || [...r.tabs.values()].some(t => !t.closed && (t.control === 'human' || t.pendingHuman || t.operationId));
  }
  private checkDownloads(tabs: Tab[]) {
    const ids = new Set(tabs.map(t => t.id));
    if ([...this.artifacts.values()].some(a => ids.has(a.tab_id) && a.status === 'downloading'))
      throw new ToolError('DOWNLOAD_PENDING', 'A file is still downloading; the tab remains open.', 'Use files action=list to check artifacts, or files action=cancel with artifact_id before finishing.');
  }
  private async cancelDownloads(t: Tab) {
    for (const a of this.artifacts.values()) if (a.tab_id === t.id && a.status === 'downloading') {
      await this.downloads.get(a.artifact_id)?.cancel(); a.status = 'cancelled';
    }
  }
  async finishBrowser(profile: string) {
    return this.serial(profile, async () => {
      const r = this.browsers.get(profile);
      if (!r || r.state === 'closed') return { state: 'closed' };
      // Reserve control before awaiting anything. A failed save never silently resumes agents.
      for (const t of r.tabs.values()) if (!t.closed) { t.control = 'human'; t.humanScope = 'browser'; t.pendingHuman = true; page.invalidate(t); }
      this.persist();
      for (const t of r.tabs.values()) if (t.operationId) {
        const op = this.operations.items.get(t.operationId); if (op) await this.operations.cancel(op.id, op.clientId);
      }
      if (!r.connected) await this.connected(r);
      if (r.state as string === 'closed') return { state: 'closed' };
      const checkpoint = await this.checkpoint(r);
      if (!checkpoint.saved) throw new ToolError('CHECKPOINT_FAILED', 'Profile save failed. The browser remains under your control.', 'Retry Finish and close after connectivity recovers, or explicitly give tabs back.');
      for (const t of r.tabs.values()) await this.cancelDownloads(t);
      for (const task of this.tasks.values()) if (task.profile === profile && task.state === 'active') task.state = 'finished';
      await this.close(r, false); return { state: r.state, checkpoint };
    });
  }
  async checkpoint(r: BrowserRecord) {
    if (this.checkpointing.has(r.id)) return this.checkpointing.get(r.id);
    const flight = (async () => {
      try {
        const state = await this.backend.checkpoint(r);
        profiles.save(r.profile, state, r.id);
        r.lastSaveAt = Date.now(); r.checkpointError = undefined;
        return { saved: true, profile: r.profile };
      } catch (e) { r.checkpointError = failure(e); return { saved: false, profile: r.profile, error: r.checkpointError, next: 'The previous valid checkpoint is intact. Retry checkpoint before closing if recent logins matter.' }; }
    })();
    this.checkpointing.set(r.id, flight);
    try { return await flight; } finally { this.checkpointing.delete(r.id); }
  }
  async close(r: BrowserRecord, save = true) {
    if (r.state === 'closed') return;
    if (save && r.connected) await this.checkpoint(r);
    r.state = 'closing'; this.persist();
    try {
      await this.backend.close(r);
      r.state = 'closed'; r.closeError = undefined;
      for (const t of r.tabs.values()) { t.closed = true; page.invalidate(t); }
      profiles.releaseLock(r.profile, this.nonce);
      usage.recordSessionEnd(r.id, r.createdAt, Date.now());
    } catch (e) { r.state = 'close_unconfirmed'; r.closeError = failure(e); }
    this.persist();
  }
  async runTab(clientId: string, a: any, fn: (r: BrowserRecord, t: Tab, op: Operation) => Promise<any>, mutate = false) {
    const { r, t } = this.ownedTab(clientId, a.tab_id);
    if (mutate && t.dialog && a.action !== 'dialog') throw new ToolError('DIALOG_PENDING', 'This tab has a pending browser dialog.', 'Use observe to read the dialog, then act action=dialog. Do not repeat the triggering action.');
    if (this.identityTabs.has(r.profile) && this.identityTabs.get(r.profile) !== t.id) throw new ToolError('IDENTITY_PAUSED', 'Another tab is changing the shared account state.', 'Wait for that operation, then observe again.');
    if ([...r.tabs.values()].some(x => !x.closed && (x.control === 'human' || x.pendingHuman) && ['identity', 'browser'].includes(x.humanScope!))) throw new ToolError('IDENTITY_PAUSED', 'Shared identity or browser control is with the user.', 'Check human status; resume with a fresh observation after release.');
    if (t.operationId) throw new ToolError('TAB_BUSY', 'This tab already has an operation in progress.', `Poll operation ${t.operationId}; independent tabs remain available.`);
    const op = this.operations.start(clientId, async operation => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await this.connected(r);
        if (r.state === 'closed' || t.closed) throw new ToolError('BROWSER_RESTART_REQUIRED', 'The previous remote browser ended.', 'Resume task_start with task_id to reopen from the checkpoint. No previous action will be replayed.');
        timer = setTimeout(() => { this.operations.cancel(operation.id, clientId).catch(() => {}); }, 30_000);
        const task = this.task(clientId, t.taskId!); task.lastActivity = Date.now();
        const result = await fn(r, t, operation);
        if (operation.cancelled) return;
        task.lastActivity = Date.now(); this.persist();
        return result;
      } catch (e) { if (mutate) t.needsObservation = true; throw e; }
      finally { if (timer) clearTimeout(timer); if (t.operationId === operation.id) { t.operationId = undefined; t.operationMutates = undefined; } this.persist(); }
    }, { tabId: t.id, cancel: async () => { await this.backend.stop(t); page.invalidate(t); this.persist(); } });
    t.operationId = op.id; t.operationMutates = mutate; this.persist();
    return this.operations.reply(op);
  }
  async observe(clientId: string, a: any) { return this.runTab(clientId, a, (r, t) => page.observe(r, t, a)); }
  async screenshot(clientId: string, a: any) { return this.runTab(clientId, a, (r, t) => this.serial(`capture:${r.id}`, () => page.screenshot(r, t, a, join(this.root, 'artifacts')))); }
  async act(clientId: string, a: any) {
    const { r, t } = this.ownedTab(clientId, a.tab_id);
    if (a.affects_identity) {
      if (this.identityTabs.has(r.profile) || [...r.tabs.values()].some(x => x.operationId || x.control === 'human' || x.pendingHuman))
        throw new ToolError('IDENTITY_BUSY', 'Let active operations or human control finish before changing the shared account.', 'Continue independent preparation, then retry this action with a fresh observation.');
      this.identityTabs.set(r.profile, t.id);
    }
    try {
      return await this.runTab(clientId, a, async (r, t) => {
        try {
          let dispatched;
          try { dispatched = await page.action(r, t, a); }
          catch (e) {
            if (t.dialog) return { action: a.action, dispatched: true, application_result: 'dialog_pending', outcome_unknown: true, observation: await page.observe(r, t), next: 'Resolve this dialog; do not repeat its triggering action.' };
            throw e;
          }
          if (a.affects_identity) { r.authEpoch++; for (const other of r.tabs.values()) page.invalidate(other); }
          let observation: any;
          try { observation = await page.observe(r, t); } catch (e) { observation = { error: failure(e), next: 'Observe again; the action itself was already dispatched.' }; }
          return { action: a.action, dispatched: true, application_result: 'verify_in_observation', ...dispatched, observation };
        } finally { if (a.affects_identity) { this.identityTabs.delete(r.profile); for (const other of r.tabs.values()) if (other !== t) page.invalidate(other); } }
      }, true);
    } catch (e) { if (a.affects_identity) this.identityTabs.delete(r.profile); throw e; }
  }
  async tabs(clientId: string, a: any) {
    const task = this.task(clientId, a.task_id), r = this.browsers.get(task.profile);
    if (!r) throw new ToolError('BROWSER_CLOSED', 'Resume task_start first.');
    if (a.action === 'list' || !a.action) return { task_id: task.id, tabs: [...r.tabs.values()].filter(t => t.taskId === task.id && !t.closed).map(t => this.describeTab(t)) };
    if (a.action === 'open') {
      const t = await this.serial(task.profile, async () => {
        this.task(clientId, task.id); // A queued finish may already have released this task.
        await this.connected(r);
        if (!r.connected) throw new ToolError('BROWSER_CLOSED', 'Resume task_start first.');
        task.lastActivity = Date.now();
        const tab = await this.adopt(r, await r.context.newPage(), task.id);
        this.persist(); return tab;
      });
      // Navigation is a normal tracked per-tab operation. Opening other tabs is independent.
      if (a.url) return { tab: this.describeTab(t), navigation: await this.act(clientId, { tab_id: t.id, action: 'navigate', url: a.url }) };
      const observation = await this.observe(clientId, { tab_id: t.id });
      return { tab: this.describeTab(t), observation: observation.status === 'completed' ? observation.result : observation };
    }
    const { t } = this.ownedTab(clientId, a.tab_id);
    if (t.taskId !== task.id) throw new ToolError('WRONG_TASK', 'The tab belongs to a different task.');
    if (t.operationId) throw new ToolError('TAB_BUSY', 'Wait for or cancel the current operation before closing or transferring the tab.');
    if (a.action === 'close') {
      this.checkDownloads([t]);
      const saved = await this.checkpoint(r);
      if (!saved.saved) throw new ToolError('CHECKPOINT_FAILED', 'Profile save failed; the tab remains open.', 'Retry after connectivity recovers.');
      await t.page.close({ runBeforeUnload: false }); t.closed = true; this.persist(); return { tab_id: t.id, closed: true, checkpoint: saved };
    }
    if (a.action === 'transfer') {
      const to = this.tasks.get(a.to_task_id);
      if (!to || to.state !== 'active' || to.profile !== r.profile) throw new ToolError('BAD_DESTINATION', 'Transfer to an active task in the same profile.');
      t.taskId = to.id; page.invalidate(t); this.persist(); return { transferred: this.describeTab(t) };
    }
    throw new ToolError('BAD_ARGS', 'Unknown tab action.');
  }
  async takeHuman(tabId: string, a: any = {}) {
    const { r, t } = this.findTab(tabId);
    if (t.closed) throw new ToolError('TAB_CLOSED', 'This tab closed.');
    await this.connected(r);
    const requested = a.mode === 'full' || a.mode === 'devtools' ? 'browser' : (a.scope || 'tab');
    const rank: Record<string, number> = { tab: 0, identity: 1, browser: 2 };
    t.humanScope = (t.control === 'human' || t.pendingHuman) && rank[t.humanScope || 'tab'] > rank[requested] ? t.humanScope : requested;
    t.pendingHuman = true; this.persist();
    const affected = t.humanScope === 'tab' ? [t] : [...r.tabs.values()];
    const busy = affected.filter(x => x.operationId && this.operations.items.get(x.operationId)?.state === 'running');
    if (busy.length) return { status: 'waiting_for_operations', tab_id: t.id, operations: busy.map(x => x.operationId), next: 'Retry takeover after these operations settle. New agent actions are paused.' };
    t.control = 'human'; t.pendingHuman = false; t.humanSince = Date.now();
    for (const x of affected) page.invalidate(x);
    this.persist();
    // Ownership is established BEFORE opening a viewer. Failure leaves a visible user-owned tab.
    if (a.instructions && (!t.handoff || t.handoff.status !== 'pending')) t.handoff = await this.backend.handoff(t, a.instructions);
    const url = await this.backend.liveView(r, t, a.mode || 'tab');
    this.persist();
    return { tab_id: t.id, status: 'human', scope: t.humanScope, live_view_url: url, dashboard_url: this.dashboardUrl, handoff: t.handoff,
      next: 'Use Done in the viewer for a handoff, or Give back in the control panel. Closing the viewer alone does not release ownership.' };
  }
  async releaseHuman(tabId: string) {
    const { r, t } = this.findTab(tabId);
    if (t.control !== 'human' && !t.pendingHuman) return { tab_id: t.id, status: 'agent' };
    if (t.handoff?.status === 'pending') { await this.backend.releaseHandoff(t); t.handoff.status = 'released'; }
    const checkpoint = r.connected ? await this.checkpoint(r) : { saved: false };
    this.resumeAfterHuman(r, t);
    t.control = 'agent'; t.pendingHuman = false; t.humanScope = undefined; t.humanSince = undefined; page.invalidate(t);
    // A human tab whose original agent exited stays accessible until explicit close/assignment.
    if (!t.taskId || this.tasks.get(t.taskId)?.state !== 'active') { t.control = 'human'; t.humanScope = 'tab'; }
    this.persist();
    return { tab_id: t.id, status: t.control, checkpoint, next: t.control === 'human' ? 'The original task ended. Keep using the tab or close it from the panel.' : 'Observe before continuing. Handoff completion alone does not prove login succeeded.' };
  }
  private resumeAfterHuman(r: BrowserRecord, t: Tab) {
    const shared = t.humanScope === 'identity' || t.humanScope === 'browser';
    if (shared) { r.authEpoch++; for (const x of r.tabs.values()) page.invalidate(x); }
    // Returning from explicit user work starts a new idle interval. Otherwise a
    // long login could immediately reap the task or its identity-paused peers.
    for (const task of this.tasks.values()) if (task.state === 'active' && task.profile === r.profile && (shared || task.id === t.taskId)) task.lastActivity = Date.now();
  }
  async human(clientId: string, a: any) {
    const { r, t } = this.ownedTab(clientId, a.tab_id, true);
    if (a.action === 'open' || a.action === 'handoff') return this.takeHuman(t.id, { ...a, scope: a.action === 'handoff' ? (a.scope || 'identity') : a.scope });
    if (a.action === 'release') return this.releaseHuman(t.id);
    if (a.action === 'status') {
      if (t.handoff?.status === 'pending') {
        const status = await this.backend.handoffState(t);
        // The completion event may arrive while the state request is in flight.
        if (t.handoff.status === 'pending') t.handoff.status = status;
      }
      if (t.handoff && t.handoff.status !== 'pending' && t.control === 'human') return { handoff: t.handoff, ...await this.releaseHuman(t.id) };
      return { tab_id: t.id, control: t.control, handoff: t.handoff, browser_state: r.state, next: t.control === 'human' ? 'The user still owns this tab. Continue independent work or check status later.' : 'Observe before acting.' };
    }
    throw new ToolError('BAD_ARGS', 'Unknown human action.');
  }
  async files(clientId: string, a: any) {
    if (a.action === 'list') {
      const task = this.tasks.get(a.task_id);
      if (!task || task.clientId !== clientId) throw new ToolError('TASK_NOT_FOUND', 'No task with this id belongs to this client.');
      return { artifacts: [...this.artifacts.values()].filter(x => x.task_id === task.id) };
    }
    if (a.action === 'cancel') {
      const artifact = this.artifacts.get(a.artifact_id);
      if (!artifact || this.tasks.get(artifact.task_id)?.clientId !== clientId) throw new ToolError('ARTIFACT_NOT_FOUND', 'No artifact with this id belongs to this client.');
      if (artifact.status === 'downloading') { await this.downloads.get(a.artifact_id)?.cancel(); artifact.status = 'cancelled'; this.persist(); }
      return { artifact };
    }
    return this.runTab(clientId, a, async (r, t) => {
      await page.validateObservation(r, t, a); page.invalidate(t);
      const result = await page.upload(t, a);
      return { ...result, observation: await page.observe(r, t) };
    }, true);
  }
  async script(clientId: string, a: any) {
    return this.runTab(clientId, a, async (r, t, op) => {
      await page.validateObservation(r, t, a); page.invalidate(t);
      // Browser-context JavaScript only; uses the existing tab. No local Node/browser process.
      const value = await t.page.evaluate(`(${a.code})(${JSON.stringify(a.argument ?? null)})`);
      if (op.cancelled || t.closed) return;
      return { value, observation: await page.observe(r, t), application_result: 'verify_in_observation' };
    }, true);
  }
  async wait(clientId: string, a: any) {
    return this.runTab(clientId, a, async (r, t) => {
      if (a.url) await t.page.waitForURL(a.url, { timeout: 8_000, waitUntil: 'domcontentloaded' });
      else if (a.target) await page.locator(t, a.target).waitFor({ state: a.state || 'visible', timeout: 8_000 });
      else throw new ToolError('BAD_ARGS', 'Wait for a URL or target; use operation status for running work.');
      return { observation: await page.observe(r, t) };
    });
  }
  async detach(clientId: string) {
    for (const t of this.tasks.values()) if (t.clientId === clientId && t.state === 'active') await this.finish(clientId, t.id, true).catch(() => {});
    this.clients.delete(clientId); this.persist();
  }
  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const c of this.clients.values()) if (!pidAlive(c.pid)) await this.detach(c.id);
      for (const t of this.tasks.values()) {
        if (t.state !== 'active' || Date.now() - t.lastActivity < cfg.idleTimeoutS * 1000) continue;
        const r = this.browsers.get(t.profile);
        if (this.identityTabs.has(t.profile) || (r && [...r.tabs.values()].some(x => !x.closed && (x.control === 'human' || x.pendingHuman) && ['identity', 'browser'].includes(x.humanScope!)))) continue;
        if (r && [...r.tabs.values()].some(x => x.taskId === t.id && !x.closed && (x.operationId || x.control === 'human' || x.pendingHuman))) continue;
        if ([...this.artifacts.values()].some(a => a.task_id === t.id && a.status === 'downloading')) continue;
        await this.finish(t.clientId, t.id).catch(() => {});
      }
      for (const r of this.browsers.values()) {
        if (r.state === 'closed') continue;
        profiles.touchLock(r.profile, this.nonce, r.id);
        if (r.state === 'closing' || r.state === 'close_unconfirmed') { await this.serial(r.profile, () => this.close(r, false)); continue; }
        if (!this.inUse(r)) { await this.serial(r.profile, () => this.close(r)); continue; }
        if (!r.connected) { await this.connected(r).catch(() => {}); continue; }
        if ([...r.tabs.values()].some(t => !t.closed && (t.control === 'human' || t.operationId))) await this.backend.heartbeat(r).catch(() => {});
        if (Date.now() - r.lastSaveAt > 300_000 && ![...r.tabs.values()].some(t => t.operationId)) await this.checkpoint(r);
      }
      this.operations.prune(); this.persist();
    } finally { this.ticking = false; }
  }
  status() {
    return { unconfirmed_creations: [...this.uncertainCreates.entries()].map(([profile, intent]) => ({ profile, ...intent })), tasks: [...this.tasks.values()].filter(t => t.state === 'active'), browsers: [...this.browsers.values()].filter(r => r.state !== 'closed').map(r => ({ browser_id: r.id, profile: r.profile, state: r.state, connected: r.connected,
      checkpoint_error: r.checkpointError, close_error: r.closeError, tabs: [...r.tabs.values()].filter(t => !t.closed).map(t => this.describeTab(t)) })) };
  }
}
