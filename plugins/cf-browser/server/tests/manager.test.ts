import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Manager } from '../src/manager.js';
import * as profiles from '../src/profiles.js';
import { cfg } from '../src/config.js';
import { tools } from '../src/tools.js';
import { validate } from '../src/schema.js';

import { fixture, FakeBackend } from './fake.js';
async function result(m: Manager, response: any, client = 'a') { const op = m.operations.get(response.operation_id, client); await op.done; const view = m.operations.view(op); if (view.status === 'failed') throw new Error(JSON.stringify(view.error)); return view.result; }

test('two clients share one context and login; finish never closes another task', async () => {
  const { m, backend, profile } = fixture();
  const [a, b] = await Promise.all([m.start('a', { profile }), m.start('b', { profile })]);
  assert.equal(backend.creates, 1); assert.equal(a.browser_id, b.browser_id); assert.notEqual(a.tab.tab_id, b.tab.tab_id);
  const r = m.browsers.get(profile)!; r.context.state.cookies.push({ name: 'login', value: 'test', domain: 'example.test', path: '/' });
  assert.equal(m.findTab(b.tab.tab_id).r.context.state.cookies.length, 1);
  await m.finish('a', a.task_id); assert.equal(backend.closes, 0);
  const finished = await m.finish('b', b.task_id); assert.equal(finished.browser_state, 'closed'); assert.equal(backend.live.size, 0);
  assert.equal(profiles.loadState(profile).cookies.length, 1);
});
test('cross-task access is rejected and explicit transfer invalidates refs', async () => {
  const { m, profile } = fixture(); const a = await m.start('a', { profile }), b = await m.start('b', { profile });
  await assert.rejects(m.observe('b', { tab_id: a.tab.tab_id }), /belongs to this client/);
  await m.tabs('a', { task_id: a.task_id, action: 'transfer', tab_id: a.tab.tab_id, to_task_id: b.task_id });
  assert.equal(m.findTab(a.tab.tab_id).t.needsObservation, true);
  const got = await result(m, await m.observe('b', { tab_id: a.tab.tab_id }), 'b'); assert.equal(got.tab_id, a.tab.tab_id);
  await m.detach('a'); await m.detach('b');
});
test('a slow tab does not serialize an independent tab, and a running mutation is not repeated', async () => {
  const { m, profile } = fixture(); const a = await m.start('a', { profile }), b = await m.start('b', { profile });
  let release!: () => void;
  const slow = await m.runTab('a', { tab_id: a.tab.tab_id }, async () => { await new Promise<void>(r => release = r); return 'done'; });
  assert.equal(slow.status, 'running');
  await assert.rejects(m.observe('a', { tab_id: a.tab.tab_id }), /operation in progress/);
  const fast = await result(m, await m.observe('b', { tab_id: b.tab.tab_id }), 'b'); assert.equal(fast.tab_id, b.tab.tab_id);
  release(); await m.operations.get(slow.operation_id, 'a').done;
  await m.detach('a'); await m.detach('b');
});
test('human takeover is tab-scoped; human tab survives task and client exit', async () => {
  const { m, backend, profile } = fixture(); const a = await m.start('a', { profile }), b = await m.start('b', { profile });
  await m.takeHuman(a.tab.tab_id);
  await assert.rejects(m.act('a', { tab_id: a.tab.tab_id, action: 'navigate', url: 'https://example.test' }), /user controls/);
  await result(m, await m.observe('b', { tab_id: b.tab.tab_id }), 'b');
  await m.detach('a'); await m.detach('b'); await m.tick();
  assert.equal(backend.closes, 0); assert.equal(m.findTab(a.tab.tab_id).t.control, 'human');
});
test('identity handoff pauses other tabs and invalidates their observations on return', async () => {
  const { m, profile } = fixture(); const a = await m.start('a', { profile }), b = await m.start('b', { profile });
  await m.takeHuman(a.tab.tab_id, { scope: 'identity', instructions: 'Sign in' });
  await assert.rejects(m.observe('b', { tab_id: b.tab.tab_id }), /Shared identity/);
  await m.releaseHuman(a.tab.tab_id);
  const res = await m.act('b', { tab_id: b.tab.tab_id, action: 'click', target: 'e1', observation_id: b.observation!.observation_id });
  await m.operations.get(res.operation_id, 'b').done;
  assert.equal(m.operations.view(m.operations.get(res.operation_id, 'b')).error.code, 'STALE_OBSERVATION');
  await m.detach('a'); await m.detach('b');
});
test('failed remote close stays journaled and is retried', async () => {
  const { m, backend, profile } = fixture(); const a = await m.start('a', { profile }); backend.failClose = true;
  const out = await m.finish('a', a.task_id); assert.equal(out.browser_state, 'close_unconfirmed');
  assert.equal(JSON.parse(readFileSync(m.journal, 'utf8')).browsers.length, 1);
  backend.failClose = false; await m.tick();
  assert.equal(backend.live.size, 0); assert.equal(JSON.parse(readFileSync(m.journal, 'utf8')).browsers.length, 0);
});
test('IndexedDB checkpoint failure preserves the good file; corrupt state is not treated as empty', async () => {
  const { m, backend, profile } = fixture(); const a = await m.start('a', { profile }); const r = m.browsers.get(profile)!;
  r.context.state.origins.push({ origin: 'https://example.test', localStorage: [], indexedDB: [{ name: 'login', version: 1, stores: [] }] });
  await m.checkpoint(r); const path = join(profiles.profileDir(profile), 'state.json'), before = readFileSync(path, 'utf8');
  backend.failSave = true; assert.equal((await m.checkpoint(r)).saved, false); assert.equal(readFileSync(path, 'utf8'), before);
  await assert.rejects(m.finish('a', a.task_id), /could not be saved/);
  assert.equal(m.tasks.get(a.task_id)?.state, 'active');
  backend.failSave = false; await m.finish('a', a.task_id);
  writeFileSync(path, '{broken'); assert.throws(() => profiles.loadState(profile), /invalid storage state/);
});
test('a live legacy profile writer is not stolen when its heartbeat is old', () => {
  assert.equal(profiles.isStale({ serverPid: process.pid, updatedAt: '2000-01-01', nonce: 'old' } as any), false);
});
test('native action returns inline observation and stale refs cannot mutate', async () => {
  const { m, profile } = fixture(); const a = await m.start('a', { profile });
  const input = { tab_id: a.tab.tab_id, action: 'click', target: 'e1', observation_id: a.observation!.observation_id };
  const out = await result(m, await m.act('a', input)); assert.equal(out.dispatched, true); assert.match(out.observation.snapshot.text, /Save/);
  const res = await m.act('a', input); await m.operations.get(res.operation_id, 'a').done;
  assert.equal(m.operations.view(m.operations.get(res.operation_id, 'a')).error.code, 'STALE_OBSERVATION');
  assert.equal(m.findTab(a.tab.tab_id).t.page.clicks, 1); await m.detach('a');
});
test('idle cleanup excludes running work and polling never extends activity', async () => {
  const { m, backend, profile } = fixture(); const a = await m.start('a', { profile }); const task = m.tasks.get(a.task_id)!;
  task.lastActivity = Date.now() - 1000 * (cfg.idleTimeoutS + 1);
  const t = m.findTab(a.tab.tab_id).t; t.operationId = 'inflight'; await m.tick(); assert.equal(backend.closes, 0);
  t.operationId = undefined; await m.tick(); assert.equal(backend.live.size, 0);
});
test('compact tool schemas validate action requirements, without a tool-count quota', () => {
  const schema = tools.find(t => t.name === 'act')!.inputSchema;
  assert.throws(() => validate(schema, { tab_id: 'a', action: 'fill', observation_id: 'o' }), /required/);
  validate(schema, { tab_id: 'a', action: 'click', observation_id: 'o', x: 10, y: 20 });
  assert(tools.some(t => t.name === 'doctor')); assert(!tools.some(t => t.name === 'profile_clone'));
});

test('dead client cleanup preserves a second client and is idempotent', async () => {
  const { m, backend, profile } = fixture(); const a = await m.start('a', { profile }), b = await m.start('b', { profile });
  m.clients.get('a')!.pid = 2147483647;
  await m.tick(); assert.equal(m.tasks.get(a.task_id)?.state, 'finished'); assert.equal(backend.closes, 0);
  assert.equal((await m.finish('a', a.task_id)).status, 'finished');
  await m.finish('b', b.task_id); assert.equal(backend.live.size, 0);
});
test('full viewer cannot narrow ownership to one tab', async () => {
  const { m, profile } = fixture(); const a = await m.start('a', { profile }), b = await m.start('b', { profile });
  await m.takeHuman(a.tab.tab_id, { mode: 'full', scope: 'tab' });
  assert.equal(m.findTab(a.tab.tab_id).t.humanScope, 'browser');
  await m.takeHuman(a.tab.tab_id, { mode: 'tab', scope: 'tab' });
  assert.equal(m.findTab(a.tab.tab_id).t.humanScope, 'browser');
  await assert.rejects(m.observe('b', { tab_id: b.tab.tab_id }), /Shared identity/);
  await m.releaseHuman(a.tab.tab_id); await m.detach('a'); await m.detach('b');
});
test('manager restart reconnects targets, invalidates refs and stops interrupted mutation only', async () => {
  const { m, backend, profile } = fixture(); const a = await m.start('a', { profile }), b = await m.start('b', { profile });
  const ta = m.findTab(a.tab.tab_id).t, tb = m.findTab(b.tab.tab_id).t;
  ta.operationId = 'interrupted-write'; ta.operationMutates = true;
  await m.takeHuman(tb.id); m.persist();
  for (const t of m.browsers.get(profile)!.tabs.values()) t.page.removeAllListeners();
  m.browsers.get(profile)!.context.removeAllListeners();
  // Simulate an exited process without killing the test runner.
  const lockPath = join(profiles.profileDir(profile), 'lock.json');
  const lock = JSON.parse(readFileSync(lockPath, 'utf8')); lock.serverPid = 2147483647; writeFileSync(lockPath, JSON.stringify(lock));
  const recovered = new Manager(m.root, backend as any, 2); await recovered.restore();
  await recovered.connected(recovered.browsers.get(profile)!);
  assert.equal(backend.creates, 1); assert.equal(recovered.findTab(ta.id).t.closed, true);
  assert.equal(recovered.findTab(tb.id).t.closed, false); assert.equal(recovered.findTab(tb.id).t.control, 'human');
  assert.equal(recovered.findTab(tb.id).t.observation, undefined);
  await recovered.releaseHuman(tb.id); await recovered.detach('a'); await recovered.detach('b');
});
test('lost create response is journaled and cannot trigger a duplicate creation', async () => {
  const { m, backend, profile } = fixture(); let calls = 0;
  backend.create = async () => { calls++; const e: any = new Error('response lost'); e.code = 'OUTCOME_UNKNOWN'; throw e; };
  await assert.rejects(m.start('a', { profile }), /response lost/);
  await assert.rejects(m.start('b', { profile }), /previous browser creation lost/);
  assert.equal(calls, 1); assert.equal(JSON.parse(readFileSync(m.journal, 'utf8')).uncertainCreates.length, 1);
});
test('failed panel finish keeps control with the user until an explicit retry or release', async () => {
  const { m, backend, profile } = fixture(); const a = await m.start('a', { profile }), b = await m.start('b', { profile });
  backend.failSave = true;
  await assert.rejects(m.finishBrowser(profile), /remains under your control/);
  await assert.rejects(m.observe('b', { tab_id: b.tab.tab_id }), /user controls/);
  assert.equal(m.tasks.get(a.task_id)?.state, 'active'); assert.equal(backend.closes, 0);
  backend.failSave = false; assert.equal((await m.finishBrowser(profile)).state, 'closed');
  assert.equal((await m.finishBrowser(profile)).state, 'closed');
});
test('pending downloads block task and tab closure until completion or explicit cancellation', async () => {
  const { m, backend, profile } = fixture(); const a = await m.start('a', { profile });
  const artifact = { artifact_id: 'file_test', task_id: a.task_id, tab_id: a.tab.tab_id, status: 'downloading' };
  m.artifacts.set(artifact.artifact_id, artifact);
  await assert.rejects(m.finish('a', a.task_id), /still downloading/);
  await assert.rejects(m.tabs('a', { task_id: a.task_id, tab_id: a.tab.tab_id, action: 'close' }), /still downloading/);
  m.tasks.get(a.task_id)!.lastActivity = 0; await m.tick(); assert.equal(backend.closes, 0);
  await assert.rejects(m.files('b', { action: 'cancel', artifact_id: artifact.artifact_id }), /belongs to this client/);
  await m.files('a', { action: 'cancel', artifact_id: artifact.artifact_id }); await m.finish('a', a.task_id);
  assert.equal((await m.files('a', { action: 'list', task_id: a.task_id })).artifacts[0].status, 'cancelled');
});
test('handoff completion event is not overwritten by a concurrent status reply', async () => {
  const { m, backend, profile } = fixture(); const a = await m.start('a', { profile });
  await m.takeHuman(a.tab.tab_id, { instructions: 'Synthetic login', scope: 'identity' });
  const t = m.findTab(a.tab.tab_id).t;
  backend.handoffState = async () => { t.cdp.emit('Cloudflare.handoffComplete', { targetId: t.targetId, handoffId: 'handoff', success: true }); return 'ended'; };
  const out: any = await m.human('a', { tab_id: t.id, action: 'status' });
  assert.equal(out.handoff?.status, 'done'); assert.equal(out.status, 'agent'); await m.finish('a', a.task_id);
});
test('opening a tab concurrently with task finish cannot create an orphan', async () => {
  const { m, backend, profile } = fixture(); const a = await m.start('a', { profile });
  const finishing = m.finish('a', a.task_id);
  await assert.rejects(m.tabs('a', { task_id: a.task_id, action: 'open' }), /No active task/);
  await finishing; assert.equal(backend.live.size, 0);
  assert.equal([...m.browsers.get(profile)!.tabs.values()].filter(t => !t.closed).length, 0);
});
test('an already-ended remote browser does not claim a fresh profile checkpoint', async () => {
  const { m, backend, profile } = fixture(); const a = await m.start('a', { profile });
  const r = m.browsers.get(profile)!; r.connected = false; backend.live.delete(r.id);
  const out = await m.finish('a', a.task_id);
  assert.equal(out.browser_state, 'closed'); assert('profile_checkpoint' in out); assert.equal(out.profile_checkpoint.saved, false);
});
test('long identity handoff preserves paused tasks and gives fresh idle grace after return', async () => {
  const { m, backend, profile } = fixture(); const a = await m.start('a', { profile }), b = await m.start('b', { profile });
  await m.takeHuman(a.tab.tab_id, { scope: 'identity' });
  for (const task of m.tasks.values()) task.lastActivity = 0;
  await m.tick();
  assert.equal(m.tasks.get(b.task_id)?.state, 'active'); assert.equal(backend.closes, 0);
  await m.releaseHuman(a.tab.tab_id); await m.tick();
  assert.equal(m.tasks.get(a.task_id)?.state, 'active'); assert.equal(m.tasks.get(b.task_id)?.state, 'active');
  await m.detach('a'); await m.detach('b');
});
test('filtered snapshot continuation preserves the same filtered result', async () => {
  const { m, profile } = fixture(); const a = await m.start('a', { profile });
  const raw = ['irrelevant '.repeat(1400), 'needle '+ 'a'.repeat(13000), 'different result', 'needle final'].join('\n');
  m.findTab(a.tab.tab_id).t.page.ariaSnapshot = async () => raw;
  const first = await result(m, await m.observe('a', { tab_id: a.tab.tab_id, query: 'needle' }));
  const second = await result(m, await m.observe('a', { tab_id: a.tab.tab_id, observation_id: first.observation_id, offset: first.snapshot.next_offset }));
  assert.equal(first.snapshot.text + second.snapshot.text, raw.split('\n').filter(line => line.includes('needle')).join('\n'));
  await m.finish('a', a.task_id);
});
