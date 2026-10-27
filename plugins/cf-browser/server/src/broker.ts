import { createServer, type IncomingMessage } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { Manager } from './manager.js';
import { Dispatcher } from './dispatch.js';
import { buildId, claimManager, PROTOCOL, readEndpoint, runtimeRoot } from './runtime.js';
import { dashboard } from './dashboard.js';
import { writeAtomic } from './profiles.js';
import { cfg } from './config.js';
import { ToolError } from './cf.js';
import { failure } from './operations.js';

async function body(req: IncomingMessage) {
  let text = '';
  for await (const chunk of req) { text += chunk; if (text.length > 4_000_000) throw new ToolError('REQUEST_TOO_LARGE', 'Request body exceeds 4 MB.'); }
  try { return JSON.parse(text); } catch { throw new ToolError('BAD_JSON', 'Send a JSON object.'); }
}
export function authorized(header: string | undefined, secret: string) {
  const got = Buffer.from(header || ''), want = Buffer.from(`Bearer ${secret}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

export async function serveManager(m: Manager, options: { root: string; secret?: string; port?: number; build?: string; onStop?: () => void }) {
  const secret = options.secret || randomBytes(32).toString('hex');
  const dispatch = new Dispatcher(m);
  const requests = new Map<string, { fingerprint: string; at: number; result: Promise<any> }>();
  const panelClient = { id: 'control-panel', label: 'Your tabs', pid: process.pid, seenAt: Date.now() };
  m.register(panelClient);
  let port = 0;
  const server = createServer(async (req, res) => {
    const origin = `http://127.0.0.1:${port}`;
    const send = (data: any, status = 200) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(data)); };
    try {
      if (req.headers.host !== `127.0.0.1:${port}` || (req.headers.origin && req.headers.origin !== origin)) return send({ error: { code: 'LOCAL_ONLY', message: 'Use the local control-panel address.' } }, 403);
      if (req.method === 'GET' && req.url === '/') {
        const nonce = randomBytes(16).toString('hex');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; frame-src https://live.browser.run; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` });
        res.end(dashboard(nonce)); return;
      }
      if (!authorized(req.headers.authorization, secret)) return send({ error: { code: 'UNAUTHORIZED', message: 'Open the current control-panel link from your agent.' } }, 401);
      if (req.method === 'GET' && req.url === '/health') return send({ protocol: PROTOCOL, build: options.build || buildId(), pid: process.pid });
      if (req.method !== 'POST') return send({ error: { code: 'NOT_FOUND', message: 'Unknown route.' } }, 404);
      const a = await body(req);
      if (req.url === '/upgrade') {
        if ([...m.browsers.values()].some(r => m.inUse(r))) return send({ idle: false, next: 'Existing tasks or human control must finish before this manager can upgrade.' });
        await m.tick();
        if ([...m.browsers.values()].some(r => r.state !== 'closed')) return send({ idle: false, next: 'Remote browser cleanup is still pending.' });
        send({ idle: true }); setTimeout(() => { server.close(); options.onStop?.(); }, 100); return;
      }
      if (req.url === '/control') {
        let out: any;
        if (a.action === 'status') out = m.status();
        else if (a.action === 'take') out = await m.takeHuman(a.tab_id, a);
        else if (a.action === 'release') out = await m.releaseHuman(a.tab_id);
        else if (a.action === 'new_tab') {
          const task = await m.start(panelClient.id, { label: 'Your tab' });
          if (a.url) await m.act(panelClient.id, { tab_id: task.tab.tab_id, action: 'navigate', url: a.url });
          out = await m.takeHuman(task.tab.tab_id);
        } else if (a.action === 'close_tab') {
          const { r, t } = m.findTab(a.tab_id);
          if (t.control !== 'human') throw new ToolError('AGENT_CONTROL', 'Take the tab before closing it from the panel.');
          const checkpoint = await m.checkpoint(r);
          if (!checkpoint.saved) return send({ error: { code: 'CHECKPOINT_FAILED', message: 'Profile save failed. The tab remains open; retry after the connection recovers.' } });
          await t.page.close({ runBeforeUnload: false }); t.closed = true;
          if (t.taskId && m.tasks.get(t.taskId)?.clientId === panelClient.id) await m.finish(panelClient.id, t.taskId);
          if (!m.inUse(r)) await m.close(r, false);
          m.persist(); out = { closed: true, browser_state: r.state };
        } else if (a.action === 'finish_browser') {
          out = await m.finishBrowser(a.profile);
        } else throw new ToolError('BAD_ACTION', 'Unknown panel action.');
        return send(out);
      }
      if (req.url !== '/rpc') return send({ error: { code: 'NOT_FOUND', message: 'Unknown route.' } }, 404);
      m.register(a.client);
      if (a.method === 'ping') return send({ ok: true, dashboard_url: m.dashboardUrl });
      if (a.method === 'detach') { await m.detach(a.client.id); return send({ detached: true }); }
      if (typeof a.request_id !== 'string') throw new ToolError('BAD_REQUEST', 'A unique request_id is required.');
      const key = `${a.client.id}:${a.request_id}`;
      const seen = requests.get(key);
      if (a.method === 'result') return seen ? send(await seen.result) : send({ error: { code: 'OUTCOME_UNKNOWN', outcome_unknown: true, message: 'No result is available for that request. A manager restart may have occurred.', next: 'Observe current state before repeating any mutation.' } });
      const fingerprint = JSON.stringify({ name: a.name, arguments: a.arguments });
      if (seen) {
        if (seen.fingerprint !== fingerprint) throw new ToolError('REQUEST_ID_REUSED', 'This request_id belongs to a different call.');
        return send(await seen.result);
      }
      const result = dispatch.call(a.client.id, a.name, a.arguments || {}).catch(e => ({ error: failure(e) }));
      requests.set(key, { fingerprint, result, at: Date.now() });
      send(await result);
      for (const [key, r] of requests) if (Date.now() - r.at > 3_600_000) requests.delete(key);
    } catch (e) { send({ error: failure(e) }); }
  });
  server.requestTimeout = 30_000; server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port || 0, '127.0.0.1', resolve); });
  port = (server.address() as any).port;
  m.dashboardUrl = `http://127.0.0.1:${port}/#key=${secret}`;
  writeAtomic(join(options.root, 'endpoint.json'), JSON.stringify({ pid: process.pid, port, secret, protocol: PROTOCOL, build: options.build || buildId() }));
  return { server, secret, port };
}

export async function startManager() {
  const root = runtimeRoot(), release = claimManager(root);
  if (!release) return;
  let interval: ReturnType<typeof setInterval> | undefined;
  try {
    const m = new Manager(root); await m.restore();
    const previous = readEndpoint(root);
    const onStop = () => { if (interval) clearInterval(interval); rmSync(join(root, 'endpoint.json'), { force: true }); release(); process.exit(0); };
    let running;
    try { running = await serveManager(m, { root, port: previous?.port, onStop }); }
    catch (e: any) { if (e.code !== 'EADDRINUSE') throw e; running = await serveManager(m, { root, onStop }); }
    interval = setInterval(() => { m.tick().catch(() => {}); }, cfg.reapMs);
    for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(sig, () => { m.persist(); running.server.close(); onStop(); });
    // A manager restart reconnects a recorded browser; it does not replay actions.
    await m.tick();
  } catch (e) {
    writeAtomic(join(root, 'startup-error.json'), JSON.stringify(failure(e)));
    release(); throw e;
  }
}
