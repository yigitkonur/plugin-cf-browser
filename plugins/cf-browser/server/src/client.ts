import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { buildId, PROTOCOL, readEndpoint, runtimeRoot, type Endpoint } from './runtime.js';
import { pidAlive } from './manager.js';
import { ToolError, sleep } from './cf.js';

export class BrokerClient {
  readonly identity = { id: randomUUID(), pid: process.pid, hostPid: process.ppid, label: process.env.CLAUDE_PROJECT_DIR ? 'Claude Code' : 'MCP agent', seenAt: Date.now() };
  endpoint?: Endpoint;
  private starting?: Promise<Endpoint>;
  async ensure(): Promise<Endpoint> {
    if (this.starting) return this.starting;
    const work = this.connect(); this.starting = work;
    try { this.endpoint = await work; return this.endpoint; } finally { this.starting = undefined; }
  }
  private async connect() {
    const root = runtimeRoot(), build = buildId();
    const probe = async (e?: Endpoint) => {
      if (!e || !pidAlive(e.pid)) return false;
      try {
        const r = await fetch(`http://127.0.0.1:${e.port}/health`, { headers: { authorization: `Bearer ${e.secret}` }, signal: AbortSignal.timeout(1000) });
        const h: any = await r.json(); return r.ok && h.pid === e.pid && h.protocol === PROTOCOL;
      } catch { return false; }
    };
    let endpoint = readEndpoint(root);
    if (await probe(endpoint)) {
      if (endpoint!.build === build) return endpoint!;
      const r = await fetch(`http://127.0.0.1:${endpoint!.port}/upgrade`, { method: 'POST', headers: { authorization: `Bearer ${endpoint!.secret}`, 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(12_000) });
      const out: any = await r.json();
      if (!out.idle) throw new ToolError('MANAGER_UPGRADE_PENDING', out.next, 'Existing sessions remain available through their current clients. Reconnect after they finish.');
      await sleep(200);
    } else if (endpoint && pidAlive(endpoint.pid)) {
      throw new ToolError('MANAGER_UNREACHABLE', 'The existing manager is alive but is not responding.', 'Retry doctor after a short wait. Starting a competing profile writer was avoided.');
    }
    rmSync(join(root, 'startup-error.json'), { force: true });
    const launch = fileURLToPath(new URL('../launch.mjs', import.meta.url));
    const child = spawn(process.execPath, [launch, '--manager'], { detached: true, stdio: 'ignore', env: process.env });
    let spawnError: any; child.on('error', e => { spawnError = e; }); child.unref();
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      endpoint = readEndpoint(root);
      if (endpoint?.build === build && await probe(endpoint)) return endpoint;
      try { const e = JSON.parse(readFileSync(join(root, 'startup-error.json'), 'utf8')); throw new ToolError(e.code, e.message, e.next); }
      catch (e: any) { if (e instanceof ToolError) throw e; }
      await sleep(100);
    }
    throw new ToolError('MANAGER_STARTING', 'The shared manager is still starting.', 'Retry doctor shortly; no browser action was submitted.');
  }
  private async post(endpoint: Endpoint, payload: any, timeout = 13_000) {
    const r = await fetch(`http://127.0.0.1:${endpoint.port}/rpc`, { method: 'POST', headers: { authorization: `Bearer ${endpoint.secret}`, 'content-type': 'application/json' }, body: JSON.stringify({ client: this.identity, ...payload }), signal: AbortSignal.timeout(timeout) });
    return r.json() as any;
  }
  async call(name: string, args: any) {
    const endpoint = await this.ensure();
    const requestId = randomUUID();
    try { return await this.post(endpoint, { method: 'call', request_id: requestId, name, arguments: args }); }
    catch {
      // Query the SAME request; never resubmit the operation after a transport error.
      try { return await this.post(endpoint, { method: 'result', request_id: requestId }, 1500); }
      catch { throw new ToolError('OUTCOME_UNKNOWN', `The manager connection was lost (request ${requestId}).`, 'Reconnect and inspect the task/tab before repeating any mutation.'); }
    }
  }
  async ping() { if (this.endpoint) return this.post(this.endpoint, { method: 'ping' }, 2000).catch(() => {}); }
  async detach() { if (this.endpoint) return this.post(this.endpoint, { method: 'detach' }, 1000).catch(() => {}); }
}
