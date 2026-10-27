import { request as httpRequest } from 'node:http';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fake.js';
import { serveManager } from '../src/broker.js';
import { cfg } from '../src/config.js';
import { textResult } from '../src/results.js';

test('shared HTTP broker authenticates local clients, deduplicates requests and rejects cross-origin control', async () => {
  const { m, backend, profile } = fixture();
  cfg.accountId = 'fixture-account'; cfg.token = 'fixture-credential';
  const { server, port, secret } = await serveManager(m, { root: m.root, build: 'fixture' });
  const base = `http://127.0.0.1:${port}`;
  const request = (id: string, rid: string, name: string, args: any) => fetch(base + '/rpc', { method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: JSON.stringify({ client: { id, pid: process.pid, label: id }, method: 'call', request_id: rid, name, arguments: args }) }).then(r => r.json()) as Promise<any>;
  const unwrap = async (r: any, c: string) => { if (r.status === 'running') { const op = m.operations.get(r.operation_id, c); await op.done; return m.operations.view(op).result; } return r.result; };
  try {
    assert.equal((await fetch(base + '/health')).status, 401);
    assert.equal((await fetch(base + '/health', { headers: { authorization: `Bearer ${secret}`, origin: 'https://hostile.test' } })).status, 403);
    assert.equal(await new Promise<number>(resolve => { const req = httpRequest(base + '/health', { headers: { authorization: `Bearer ${secret}`, Host: 'hostile.test' } }, res => { res.resume(); resolve(res.statusCode!); }); req.end(); }), 403);
    const [one, two] = await Promise.all([request('a', 'start-a', 'task_start', { profile }), request('b', 'start-b', 'task_start', { profile })]);
    const a = await unwrap(one, 'a'), b = await unwrap(two, 'b'); assert.equal(a.browser_id, b.browser_id); assert.equal(backend.creates, 1);
    const replay = await request('a', 'start-a', 'task_start', { profile }); assert.equal(replay.operation_id, one.operation_id); assert.equal(m.tasks.size, 2);
    const wrong = await request('a', 'start-a', 'task_start', { profile: 'different' }); assert.equal(wrong.error.code, 'REQUEST_ID_REUSED');
    const html = await (await fetch(base)).text(); assert.match(html, /Give back/); assert(!html.includes(secret)); assert.match(html, /textContent/);
    const response = await request('a', 'bad-args', 'act', { tab_id: a.tab.tab_id, action: 'fill' }); assert.equal(response.error.code, 'BAD_ARGS');
    await m.finish('a', a.task_id); assert.equal(backend.closes, 0); await m.finish('b', b.task_id); assert.equal(backend.live.size, 0);
  } finally { await new Promise<void>(r => server.close(() => r())); }
});
test('MCP images are native content and large results remain valid paged JSON', () => {
  const result = textResult({ operation_id: 'op_test', status: 'completed', result: { image: { type: 'image', data: 'AA==', mimeType: 'image/png' }, value: 'x'.repeat(30000) } });
  assert.equal(result.content[1].type, 'image');
  const parsed = JSON.parse(result.content[0].text); assert.equal(parsed.result_page.next_offset, 12000); assert(!parsed.result_page.text.includes('AA=='));
});
