import { cfg, keepAliveMs } from './config.js';
import { pw } from './deps.js';
import { rest, wsUrl, authHeaders, ToolError } from './cf.js';
import type { BrowserRecord, Tab } from './models.js';

async function deadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([work, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new ToolError('DRIVER_TIMEOUT', 'The browser driver did not respond in time.')), ms); })]); }
  finally { clearTimeout(timer!); }
}

export class CloudBackend {
  async create(options: { recording: boolean; lab: boolean }) {
    pw();
    const r = await rest('POST', '/devtools/browser', { query: { keep_alive: keepAliveMs(cfg.idleTimeoutS), recording: options.recording, lab: options.lab } });
    if (!r.data?.sessionId) throw new ToolError('OUTCOME_UNKNOWN', 'Cloudflare did not return a browser id.', 'Inspect account sessions before starting another browser.');
    return String(r.data.sessionId);
  }
  async connect(r: BrowserRecord, storageState?: any, recovering = false) {
    const browser = await pw().chromium.connectOverCDP(await wsUrl(r.id), { headers: authHeaders(), timeout: 10_000 });
    r.browser = browser;
    if (recovering) {
      const wanted = new Set([...r.tabs.values()].map(t => t.targetId));
      for (const context of browser.contexts()) {
        for (const page of context.pages()) {
          const c = await context.newCDPSession(page);
          const id = (await c.send('Target.getTargetInfo')).targetInfo.targetId;
          await c.detach();
          if (wanted.has(id)) { r.context = context; break; }
        }
        if (r.context) break;
      }
      if (!r.context) throw new ToolError('CONTEXT_LOST', 'The shared context is no longer available.', 'Resume the task to reopen from its last checkpoint.');
    } else {
      // Native Live View creates tabs in Chrome's default context. Use that SAME context.
      r.context = browser.contexts()[0];
      if (!r.context) throw new ToolError('CONTEXT_MISSING', 'Cloudflare did not expose a default browser context.');
      if (storageState) await deadline(r.context.setStorageState(storageState), 8000);
      (r as any).bootstrapPages = r.context.pages();
    }
    r.context.setDefaultTimeout(8_000);
    r.context.setDefaultNavigationTimeout(8_000);
    r.connected = true;
    browser.on('disconnected', () => { r.connected = false; });
  }
  async identify(r: BrowserRecord, page: any) {
    const cdp = await r.context.newCDPSession(page);
    return { cdp, targetId: (await cdp.send('Target.getTargetInfo')).targetInfo.targetId };
  }
  async alive(id: string) {
    try {
      const r = await rest('GET', `/devtools/session/${encodeURIComponent(id)}`, { allow404: true, timeoutMs: 8_000 });
      return r.status !== 404 && !/session not found/i.test(r.data?.error || '');
    } catch (e: any) { if (e.code === 'NOT_FOUND') return false; throw e; }
  }
  async close(r: BrowserRecord) {
    // DELETE is idempotent. A failed DELETE stays in the durable cleanup journal.
    try {
      await rest('DELETE', `/devtools/browser/${encodeURIComponent(r.id)}`, { allow404: true, timeoutMs: 8_000 });
      if (await this.alive(r.id)) throw new ToolError('CLOSE_UNCONFIRMED', 'Cloudflare still reports the browser as open.');
    } finally {
      // No owners remain on this close path. Drop our transport even when the
      // REST result is uncertain so keep_alive can act as the final backstop.
      await r.browser?.close().catch(() => {});
      r.connected = false;
    }
  }
  async checkpoint(r: BrowserRecord) { return deadline(r.context.storageState({ indexedDB: true }), 8000); }
  async heartbeat(r: BrowserRecord) {
    const t = [...r.tabs.values()].find(t => !t.closed && t.cdp);
    if (t) await t.cdp.send('Target.getTargetInfo');
  }
  async liveView(r: BrowserRecord, t: Tab, mode: string, readonly = false) {
    const res = await rest('POST', `/devtools/browser/${encodeURIComponent(r.id)}/live_view`, {
      json: { mode, targetId: t.targetId, expiresInMs: 300_000, ...(readonly ? { guardrails: { mode: 'readonly' } } : {}) }, timeoutMs: 8_000,
    });
    if (!res.data?.devtoolsFrontendUrl) throw new ToolError('LIVE_VIEW_FAILED', 'Cloudflare returned no Live View URL.');
    return res.data.devtoolsFrontendUrl as string;
  }
  async handoff(t: Tab, instructions: string) {
    const r = await t.cdp.send('Cloudflare.handoff', { targetId: t.targetId, instructions });
    return { id: r.handoffId, status: 'pending' };
  }
  async handoffState(t: Tab) {
    const r = await t.cdp.send('Cloudflare.getHandoffState', { targetId: t.targetId });
    return r.active ? 'pending' : 'ended';
  }
  async releaseHandoff(t: Tab) {
    if (await this.handoffState(t) === 'pending')
      await t.cdp.send('Cloudflare.handoffComplete', { targetId: t.targetId, success: false, reason: 'Control explicitly released; application outcome must be observed.' });
  }
  async stop(t: Tab) {
    // Closing only the affected target cancels Playwright calls AND delayed JS continuations.
    // Runtime.terminateExecution alone cannot cancel promises/timers in an async script.
    const closed = await t.cdp.send('Target.closeTarget', { targetId: t.targetId });
    if (closed.success === false) throw new ToolError('CANCEL_FAILED', 'The remote target did not close.');
    if (!t.page.isClosed()) await t.page.close({ runBeforeUnload: false });
    t.closed = true; t.generation++;
  }
}
