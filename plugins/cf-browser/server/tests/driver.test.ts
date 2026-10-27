import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { Manager } from '../src/manager.js';
import { CloudBackend } from '../src/backend.js';
const req = createRequire(join(process.cwd(), 'package.json'));
const { chromium } = req('playwright-core');
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const fixture = `<!doctype html><title>Browser contract</title><button id="save" onclick="document.querySelector('#result').textContent='Saved once';window.saves=(window.saves||0)+1">Save</button><p id="result">Waiting</p><input aria-label="Name"><input type="file" aria-label="Upload"><div id="shadow"></div><iframe title="frame" src="/frame"></iframe><canvas width="200" height="100" aria-label="Drawing"></canvas><button onclick="window.open('/popup')">Popup</button><button onclick="confirm('Confirm fixture')">Dialog</button><a download="fixture.txt" href="/download">Download</a><div style="height:1500px"></div><script>document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<button>Shadow button</button>';document.querySelector('canvas').onclick=()=>window.canvasClicks=(window.canvasClicks||0)+1;</script>`;

// A real Chromium contract test, isolated from personal profiles. Production only connects over CDP.
test('pinned page adapter: refs, frames, shadow DOM, visual actions, persistence and cancellation', { skip: process.env.CFB_SKIP_BROWSER_TESTS === '1', timeout: 60_000 }, async () => {
  const server = createServer((req, res) => { if (req.url === '/download') { res.setHeader('Content-Disposition', 'attachment; filename=fixture.txt'); res.end('fixture'); } else { res.setHeader('Content-Type', 'text/html'); res.end(req.url === '/frame' ? '<button>Frame button</button>' : fixture); } });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.CFB_TEST_BROWSER ? { executablePath: process.env.CFB_TEST_BROWSER } : existsSync(chrome) ? { executablePath: chrome } : {}) });
  class LocalBackend extends CloudBackend {
    contexts = new Map<string, any>(); counter = 0;
    async create() { return `test-browser-${++this.counter}`; }
    async connect(r: any, state?: any, recovery = false) { r.browser = browser; r.context = recovery ? this.contexts.get(r.id) : await browser.newContext({ storageState: state, viewport: { width: 1280, height: 800 }, acceptDownloads: true }); r.context.setDefaultTimeout(3000); this.contexts.set(r.id, r.context); r.connected = true; }
    async alive(id: string) { return this.contexts.has(id); }
    async close(r: any) { await this.contexts.get(r.id)?.close(); this.contexts.delete(r.id); r.connected = false; }
  }
  const backend = new LocalBackend(), m = new Manager(mkdtempSync(join(tmpdir(), 'cfb-driver-')), backend, 10);
  m.register({ id: 'a', pid: process.pid, label: 'A', seenAt: Date.now() }); m.register({ id: 'b', pid: process.pid, label: 'B', seenAt: Date.now() });
  const done = async (response: any, client = 'a') => { const op = m.operations.get(response.operation_id, client); await op.done; const out = m.operations.view(op); assert.equal(out.status, 'completed', JSON.stringify(out)); return out.result; };
  try {
    const a = await m.start('a', { profile: 'driver' }), b = await m.start('b', { profile: 'driver' });
    const tabId = a.tab.tab_id;
    let out = await done(await m.act('a', { tab_id: tabId, action: 'navigate', url }));
    assert(out.observation.snapshot, JSON.stringify(out));
    const snapshot = out.observation.snapshot.text;
    assert.match(snapshot, /Shadow button/); assert.match(snapshot, /Frame button/);
    const ref = snapshot.match(/button "Save" \[ref=(\w+)\]/)?.[1]; assert(ref);
    out = await done(await m.act('a', { tab_id: tabId, action: 'click', target: ref, observation_id: out.observation.observation_id }));
    assert.match(out.observation.snapshot.text, /Saved once/);
    const { t, r } = m.findTab(tabId);
    assert.equal(await t.page.evaluate(() => (window as any).saves), 1);
    await t.page.evaluate(async () => {
      localStorage.setItem('login', 'saved'); document.cookie = 'login=saved;path=/';
      await new Promise<void>((resolve, reject) => { const q = indexedDB.open('auth', 1); q.onupgradeneeded = () => q.result.createObjectStore('tokens'); q.onerror = () => reject(q.error); q.onsuccess = () => { const tx = q.result.transaction('tokens', 'readwrite'); tx.objectStore('tokens').put('saved', 'token'); tx.oncomplete = () => { q.result.close(); resolve(); }; }; });
    });
    await done(await m.act('b', { tab_id: b.tab.tab_id, action: 'navigate', url }), 'b');
    assert.equal(await m.findTab(b.tab.tab_id).t.page.evaluate(() => localStorage.getItem('login')), 'saved');
    const pic = await done(await m.screenshot('a', { tab_id: tabId })); assert.equal(pic.image.mimeType, 'image/png'); assert(pic.image.data.length > 100);
    const box = await t.page.locator('canvas').boundingBox();
    await done(await m.act('a', { tab_id: tabId, action: 'click', x: box.x + 20, y: box.y + 20, observation_id: pic.observation_id }));
    assert.equal(await t.page.evaluate(() => (window as any).canvasClicks), 1);
    const picture = await done(await m.screenshot('a', { tab_id: tabId })); await t.page.evaluate(() => scrollTo(0, 300));
    const stale = await m.act('a', { tab_id: tabId, action: 'click', x: 10, y: 10, observation_id: picture.observation_id }); await m.operations.get(stale.operation_id, 'a').done;
    assert.equal(m.operations.view(m.operations.get(stale.operation_id, 'a')).error.code, 'STALE_SCREENSHOT');
    await t.page.evaluate(() => scrollTo(0, 0));
    const uploadPath = join(m.root, 'authorized file.txt'); writeFileSync(uploadPath, 'hello');
    const ob = await done(await m.observe('a', { tab_id: tabId }));
    await done(await m.files('a', { action: 'upload', tab_id: tabId, observation_id: ob.observation_id, target: 'input[type=file]', paths: [uploadPath] }));
    assert.equal(await t.page.locator('input[type=file]').evaluate((e: any) => e.files[0].name), 'authorized file.txt');
    const popup = t.page.waitForEvent('popup'); await t.page.getByText('Popup', { exact: true }).click(); await popup;
    await new Promise(resolve => setTimeout(resolve, 50)); assert.equal([...r.tabs.values()].filter(t => t.taskId === a.task_id).length, 2);
    const beforeDialog = await done(await m.observe('a', { tab_id: tabId }));
    const dialog = await done(await m.act('a', { tab_id: tabId, action: 'click', target: 'text=Dialog', observation_id: beforeDialog.observation_id }));
    assert.equal(dialog.observation.dialog.message, 'Confirm fixture');
    await assert.rejects(m.act('a', { tab_id: tabId, action: 'navigate', url }), /pending browser dialog/);
    const afterDialog = await done(await m.act('a', { tab_id: tabId, action: 'dialog', accept: true }));
    assert(afterDialog.observation.observation_id);
    await done(await m.act('a', { tab_id: tabId, action: 'click', target: 'text=Download', observation_id: afterDialog.observation.observation_id }));
    for (let n = 0; n < 100 && ![...m.artifacts.values()].some(a => a.status === 'ready'); n++) await new Promise(r => setTimeout(r, 20));
    const artifact = (await m.files('a', { action: 'list', task_id: a.task_id })).artifacts[0];
    assert.equal(artifact.status, 'ready'); assert.equal(readFileSync(artifact.path, 'utf8'), 'fixture');
    const ob2 = await done(await m.observe('a', { tab_id: tabId }));
    const script = await m.script('a', { tab_id: tabId, observation_id: ob2.observation_id, code: 'async () => { await new Promise(r => setTimeout(r, 20000)); document.body.textContent="late mutation"; }' });
    assert.equal(script.status, 'running');
    await m.operations.cancel(script.operation_id, 'a'); assert.equal(t.page.isClosed(), true); assert.equal(m.findTab(b.tab.tab_id).t.page.isClosed(), false);
    await m.finish('a', a.task_id); await m.finish('b', b.task_id);
    assert.equal((await m.files('a', { action: 'list', task_id: a.task_id })).artifacts[0].status, 'ready');
    const c = await m.start('a', { profile: 'driver' });
    await done(await m.act('a', { tab_id: c.tab.tab_id, action: 'navigate', url }));
    const p = m.findTab(c.tab.tab_id).t.page;
    assert.equal(await p.evaluate(() => localStorage.getItem('login')), 'saved');
    assert.match(await p.evaluate(() => document.cookie), /login=saved/);
    assert.equal(await p.evaluate(async () => new Promise(resolve => { const q = indexedDB.open('auth', 1); q.onsuccess = () => { const req = q.result.transaction('tokens').objectStore('tokens').get('token'); req.onsuccess = () => { resolve(req.result); q.result.close(); }; }; })), 'saved');
    await m.finish('a', c.task_id);
  } finally { await browser.close(); await new Promise<void>(r => server.close(() => r())); }
});
