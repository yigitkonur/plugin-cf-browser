import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Manager } from '../src/manager.js';
let seq = 0;
class FakePage extends EventEmitter {
  id = String(++seq); closed = false; href = 'about:blank'; clicks = 0; data: any; context: FakeContext;
  constructor(context: FakeContext) { super(); this.context = context; }
  url() { return this.href; } title() { return Promise.resolve('Test page'); } isClosed() { return this.closed; }
  opener() { return Promise.resolve(null); }
  async ariaSnapshot() { return '- button "Save" [ref=e1]'; }
  async goto(url: string) { this.href = url; this.emit('framenavigated'); return { status: () => 200 }; }
  async close() { this.closed = true; this.emit('close'); }
  locator() { return { click: async () => { this.clicks++; }, fill: async (s: string) => { this.data = s; }, waitFor: async () => {}, ariaSnapshot: () => this.ariaSnapshot() }; }
  async evaluate() { return { width: 1280, height: 800, scrollX: 0, scrollY: 0 }; }
  async screenshot() { return Buffer.from('fake-image'); }
  async bringToFront() {}
}
class FakeContext extends EventEmitter {
  list: FakePage[] = []; state: any;
  constructor(state: any) { super(); this.state = state || { cookies: [], origins: [] }; }
  async newPage() { const p = new FakePage(this); this.list.push(p); this.emit('page', p); return p; }
  pages() { return this.list.filter(p => !p.closed); }
  setDefaultTimeout() {} setDefaultNavigationTimeout() {}
}
export class FakeBackend {
  creates = 0; closes = 0; failClose = false; failSave = false; live = new Set<string>(); contexts = new Map<string, FakeContext>();
  async create() { const id = `remote-${++this.creates}`; this.live.add(id); return id; }
  async connect(r: any, state?: any, recovery = false) { r.context = recovery ? this.contexts.get(r.id) : new FakeContext(state); this.contexts.set(r.id, r.context); r.connected = true; r.browser = new EventEmitter(); }
  async identify(r: any, page: FakePage) { const cdp: any = new EventEmitter(); cdp.send = async (name: string) => {
    if (name === 'Page.captureScreenshot') { const b = Buffer.alloc(24); b.writeUInt32BE(1280, 16); b.writeUInt32BE(800, 20); return { data: b.toString('base64') }; }
  }; return { targetId: page.id, cdp }; }
  async alive(id: string) { return this.live.has(id); }
  async close(r: any) { this.closes++; if (this.failClose) throw new Error('network offline'); this.live.delete(r.id); r.connected = false; }
  async checkpoint(r: any) { if (this.failSave) throw new Error('IndexedDB snapshot failed'); return r.context.state; }
  async heartbeat() {} async liveView() { return 'https://live.browser.run/test'; } async handoff() { return { id: 'handoff', status: 'pending' }; }
  async handoffState() { return 'pending'; } async releaseHandoff() {} async stop(t: any) { await t.page.close(); t.closed = true; }
}
export function fixture() {
  const backend = new FakeBackend(), m = new Manager(mkdtempSync(join(tmpdir(), 'cfb-test-')), backend as any, 2);
  const profile = `test-${process.pid}-${++seq}`;
  m.register({ id: 'a', pid: process.pid, seenAt: Date.now(), label: 'Agent A' });
  m.register({ id: 'b', pid: process.pid, seenAt: Date.now(), label: 'Agent B' });
  return { m, backend, profile };
}
