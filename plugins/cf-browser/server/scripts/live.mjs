// Explicit opt-in live acceptance. Uses isolated profiles; never reads the user's saved login state.
import { readFileSync, mkdtempSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
const env = { ...process.env };
const credentialPath = join(env.CFB_HOME || join(homedir(), '.cf-browser'), '.env');
if (existsSync(credentialPath)) for (const line of readFileSync(credentialPath, 'utf8').split(/\r?\n/)) {
  const m = /^\s*(?:export\s+)?(CF_ACCOUNT_ID|CF_API_TOKEN)\s*=\s*(.*?)\s*$/.exec(line);
  if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
}
if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) { console.error('Live tests need Cloudflare credentials in the environment or the standard credentials file.'); process.exit(2); }
const home = mkdtempSync(join(tmpdir(), 'cfb-live-'));
Object.assign(env, { CFB_HOME: home, CFB_DEFAULT_PROFILE: 'acceptance', CFB_DEV: '1', CFB_OPEN_LIVE_VIEW: 'false', CFB_REAP_MS: '1000' });
delete env.CLAUDE_PLUGIN_DATA; delete env.PLUGIN_DATA;
const clients = [], tasks = [];
let cleanupConfirmed = false, dashboard, viewerBrowser, remoteIds = new Set();
const pause = ms => new Promise(r => setTimeout(r, ms));
function check(condition, label) { assert(condition, label); console.log('PASS ' + label); }
async function makeClient(label) {
  const c = new Client({ name: label, version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('launch.mjs')], env, stderr: 'pipe' });
  // Capture only to avoid dumping any credential-bearing diagnostic content.
  await c.connect(transport); clients.push(c); return c;
}
async function call(c, name, args = {}, allowError = false, includeContent = false) {
  let out = await c.callTool({ name, arguments: args }, undefined, { timeout: 60000 });
  let data = JSON.parse(out.content.find(x => x.type === 'text').text);
  const deadline = Date.now() + 90000;
  while (data.status === 'running' && Date.now() < deadline) {
    await pause(250); out = await c.callTool({ name: 'operation', arguments: { operation_id: data.operation_id } }, undefined, { timeout: 15000 });
    data = JSON.parse(out.content.find(x => x.type === 'text').text);
  }
  if (!allowError && (data.error || data.status === 'failed' || data.status === 'cancelled')) throw Error(`${name}: ${JSON.stringify(data.error)}`);
  return includeContent ? { value: data.result ?? data, content: out.content } : data.result ?? data;
}
try {
  const [a, b] = await Promise.all([makeClient('acceptance-a'), makeClient('acceptance-b')]);
  const [ta, tb] = await Promise.all([call(a, 'task_start', { label: 'Acceptance A' }), call(b, 'task_start', { label: 'Acceptance B' })]);
  tasks.push([a, ta.task_id], [b, tb.task_id]); remoteIds.add(ta.browser_id); remoteIds.add(tb.browser_id); dashboard = ta.dashboard_url;
  if (process.env.CFB_PROTOCOL_PROBE === '1') {
    const protocol = await (await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/browser-rendering/devtools/browser/${ta.browser_id}/json/protocol`, { headers: { authorization: `Bearer ${env.CF_API_TOKEN}` } })).json();
    const domain = (protocol.domains || protocol.result?.domains || []).find(d => d.domain === 'Cloudflare');
    console.log('INFO handoff protocol ' + JSON.stringify(domain?.commands?.filter(c => /handoff/i.test(c.name))));
  }
  check(ta.browser_id === tb.browser_id && ta.tab.tab_id !== tb.tab.tab_id, 'two stdio clients share one remote browser with separate tabs');
  let na = await call(a, 'act', { tab_id: ta.tab.tab_id, action: 'navigate', url: 'https://the-internet.herokuapp.com/inputs' });
  if (!na.observation?.snapshot?.text?.includes('Inputs')) throw Error('native snapshot: '+JSON.stringify({http:na.http_status, observation:na.observation}));
  check(true, 'native default-context snapshot/ref path');
  const code = `async () => { localStorage.setItem('cfb-acceptance','synthetic'); document.cookie='cfb_acceptance=synthetic;path=/;Secure'; await new Promise((resolve,reject)=>{const q=indexedDB.open('cfb-acceptance',1);q.onupgradeneeded=()=>q.result.createObjectStore('auth');q.onerror=()=>reject(q.error);q.onsuccess=()=>{const tx=q.result.transaction('auth','readwrite');tx.objectStore('auth').put('synthetic','login');tx.oncomplete=()=>{q.result.close();resolve()}}}); return 'saved'; }`;
  await call(a, 'advanced', { action: 'call', name: 'script', arguments: { tab_id: ta.tab.tab_id, observation_id: na.observation.observation_id, code } });
  let nb = await call(b, 'act', { tab_id: tb.tab.tab_id, action: 'navigate', url: 'https://the-internet.herokuapp.com/inputs' });
  const read = `async () => ({ local: localStorage.getItem('cfb-acceptance'), cookie:document.cookie.includes('cfb_acceptance=synthetic'), idb: await new Promise(resolve=>{const q=indexedDB.open('cfb-acceptance',1);q.onsuccess=()=>{const r=q.result.transaction('auth').objectStore('auth').get('login');r.onsuccess=()=>{resolve(r.result);q.result.close()}}}) })`;
  const login = await call(b, 'advanced', { action: 'call', name: 'script', arguments: { tab_id: tb.tab.tab_id, observation_id: nb.observation.observation_id, code: read } });
  check(login.value.local === 'synthetic' && login.value.cookie && login.value.idb === 'synthetic', 'synthetic cookies/localStorage/IndexedDB shared across clients');
  const raw = await call(a, 'screenshot', { tab_id: ta.tab.tab_id }, false, true);
  check(raw.content.some(c => c.type === 'image'), 'screenshot delivered as native MCP image');
  const h = await call(b, 'human', { tab_id: tb.tab.tab_id, action: 'open', open_locally: false });
  check(h.status === 'human' && h.scope === 'tab' && !!h.live_view_url, 'interactive target Live View generated without readonly guardrails');
  const blocked = await call(b, 'act', { tab_id: tb.tab.tab_id, action: 'navigate', url: 'https://the-internet.herokuapp.com/inputs' }, true);
  check(blocked.error?.code === 'HUMAN_CONTROL', 'agent pauses on human tab');
  const other = await call(a, 'observe', { tab_id: ta.tab.tab_id }); check(!!other.observation_id, 'other agent continues during tab takeover');
  const response = await fetch(h.live_view_url); check(response.ok, 'native hosted viewer loads');
  console.log('INFO viewer frame policy: ' + (response.headers.get('x-frame-options') || response.headers.get('content-security-policy') || 'no restrictive HTTP frame header'));
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  viewerBrowser = await chromium.launch({ headless: true, ...(existsSync(chrome) ? { executablePath: chrome } : {}) });
  const panel = await viewerBrowser.newPage({ viewport: { width: 1100, height: 900 } });
  await panel.goto(dashboard);
  await panel.getByText('You have control', { exact: true }).waitFor();
  check(await panel.getByRole('button', { name: 'Open viewer', exact: true }).count() === 1, 'control panel shows tab ownership');
  const popupPromise = panel.waitForEvent('popup');
  await panel.getByRole('button', { name: 'Open viewer', exact: true }).click();
  const viewer = await popupPromise;
  await viewer.waitForURL('https://live.browser.run/**');
  await viewer.waitForTimeout(2500);
  check(await viewer.locator('canvas').count() === 1, 'native viewer renders the target canvas');
  await viewer.mouse.click(550, 480); await viewer.keyboard.type('31415');
  await pause(500);
  if (process.env.CFB_LIVE_ARTIFACTS) {
    await panel.screenshot({ path: join(process.env.CFB_LIVE_ARTIFACTS, 'control-panel.png') });
    await viewer.screenshot({ path: join(process.env.CFB_LIVE_ARTIFACTS, 'native-viewer.png') });
  }
  await call(b, 'human', { tab_id: tb.tab.tab_id, action: 'release', open_locally: false });
  const changed = await call(b, 'observe', { tab_id: tb.tab.tab_id });
  check(changed.snapshot.text.includes('31415'), 'typing through interactive Live View changes the remote page');
  await panel.getByRole('button', { name: 'Refresh', exact: true }).click();
  await panel.locator('.tab').filter({ has: panel.getByText('Acceptance B', { exact: true }) }).getByRole('button', { name: 'Show inline', exact: true }).click();
  await panel.frameLocator('#viewer').locator('canvas').waitFor({ timeout: 15000 });
  check(true, 'native Live View renders inside the local control panel iframe');
  await call(b, 'human', { tab_id: tb.tab.tab_id, action: 'release', open_locally: false });
  const handoff = await call(b, 'human', { tab_id: tb.tab.tab_id, action: 'handoff', instructions: 'Synthetic acceptance: select Done to return control. No real login is required.', open_locally: false });
  const handoffViewer = await viewerBrowser.newPage({ viewport: { width: 1100, height: 900 } });
  await handoffViewer.goto(handoff.live_view_url);
  await handoffViewer.getByRole('button', { name: 'Done', exact: true }).click({ timeout: 15000 });
  let returned;
  for (let n = 0; n < 10; n++) {
    returned = await call(b, 'human', { tab_id: tb.tab.tab_id, action: 'status' });
    if (returned.status === 'agent') break;
    await pause(250);
  }
  check(returned.status === 'agent' && ['done', 'ended'].includes(returned.handoff?.status) && returned.checkpoint?.saved, 'native structured handoff Done returns control and checkpoints');
  await call(b, 'human', { tab_id: tb.tab.tab_id, action: 'handoff', instructions: 'Synthetic manual release acceptance.', open_locally: false });
  await call(b, 'human', { tab_id: tb.tab.tab_id, action: 'release', open_locally: false });
  const manual = await call(b, 'human', { tab_id: tb.tab.tab_id, action: 'status' });
  check(manual.control === 'agent' && manual.handoff.status === 'released', 'manual release ends pending native handoff without claiming login success');
  const endA = await call(a, 'task_finish', { task_id: ta.task_id }); tasks.shift(); check(endA.browser_state !== 'closed', 'finishing one client preserves the other');
  let endB = await call(b, 'task_finish', { task_id: tb.task_id }); tasks.shift();
  for (let n = 0; endB.browser_state === 'close_unconfirmed' && n < 10; n++) {
    await pause(1000); endB = await call(b, 'task_finish', { task_id: tb.task_id });
  }
  if (endB.browser_state !== 'closed') {
    const state = await call(b, 'doctor');
    console.log('INFO remaining acceptance browser ' + JSON.stringify(state.browsers?.map(r => ({state:r.state, close_error:r.close_error, tabs:r.tabs.map(t=>({control:t.control, url:t.url, task:!!t.task_id}))}))));
  }
  check(endB.browser_state === 'closed', 'last task checkpoints and confirms remote close');
  const tc = await call(a, 'task_start', { label: 'Persistence reopen' }); tasks.push([a, tc.task_id]); remoteIds.add(tc.browser_id);
  const nc = await call(a, 'act', { tab_id: tc.tab.tab_id, action: 'navigate', url: 'https://the-internet.herokuapp.com/inputs' });
  const restored = await call(a, 'advanced', { action: 'call', name: 'script', arguments: { tab_id: tc.tab.tab_id, observation_id: nc.observation.observation_id, code: read } });
  check(restored.value.local === 'synthetic' && restored.value.cookie && restored.value.idb === 'synthetic', 'default context restores all three storage types after remote restart');
  const endC = await call(a, 'task_finish', { task_id: tc.task_id }); tasks.pop(); check(endC.browser_state === 'closed', 'reopened browser also closes'); cleanupConfirmed = true;
} catch (e) {
  const clean = String(e.message).split(env.CF_API_TOKEN).join('[redacted]').split(env.CF_ACCOUNT_ID).join('[account]').replace(/https:\/\/live\.browser\.run\/\S+/g, '[viewer-url]');
  console.error('FAIL ' + clean); process.exitCode = 1;
} finally {
  for (const [c, id] of tasks) await call(c, 'task_finish', { task_id: id }, true).catch(() => {});
  // Explicit cleanup targets only browsers opened by this isolated run, never account-wide sessions.
  if (dashboard) {
    const url = new URL(dashboard), key = new URLSearchParams(url.hash.slice(1)).get('key');
    try { const r = await fetch(url.origin + '/control', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'finish_browser', profile: 'acceptance' }) }); const out = await r.json(); if (out.state === 'closed') cleanupConfirmed = true; } catch {}
  }
  await viewerBrowser?.close().catch(() => {});
  for (const c of clients) await c.close().catch(() => {});
  const dirs = existsSync(join(home, 'runtime')) ? readdirSync(join(home, 'runtime')) : [];
  for (const d of dirs) {
    const root = join(home, 'runtime', d);
    try { const ep = JSON.parse(readFileSync(join(root, 'endpoint.json'), 'utf8')); const journal = JSON.parse(readFileSync(join(root, 'journal.json'), 'utf8'));
      if (!journal.browsers.length && !journal.uncertainCreates?.length) { cleanupConfirmed = true; process.kill(ep.pid, 'SIGTERM'); }
    } catch {}
  }
  if (cleanupConfirmed) { await pause(250); rmSync(home, { recursive: true, force: true }); console.log('PASS isolated test browsers closed and temporary profile removed'); }
  else { console.error('CLEANUP_PENDING isolated manager retained for automatic retry at ' + home); process.exitCode = 1; }
}
