import { cfg } from './config.js';
import { recordQuick } from './usage.js';

export class ToolError extends Error {
  constructor(public code: string, message: string, public next?: string) { super(message); }
}

// Strips anything that would let a reader drive the browser: the token, CDP/WebSocket URLs, Live View URLs.
export function mask(s: unknown): string {
  let out = String(s);
  if (cfg.accountId) out = out.split(cfg.accountId).join('<account-id>');
  if (cfg.token) out = out.split(cfg.token).join('***');
  return out
    .replace(/wss?:\/\/[^\s"'<>)]+/g, '<ws-url>')
    .replace(/https:\/\/live\.browser\.run\/[^\s"'<>)]+/g, '<live-view-url>')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer ***');
}

const API = 'https://api.cloudflare.com/client/v4/accounts';
let prefix: string | null = null;

async function detectPrefix(): Promise<string> {
  if (prefix) return prefix;
  for (const p of ['/browser-run', '/browser-rendering']) {
    const r = await fetch(`${API}/${cfg.accountId}${p}/devtools/session?limit=1`, { headers: auth(), signal: AbortSignal.timeout(30000) });
    if (r.status === 401 || r.status === 403) throw authError(r.status);
    if (r.ok) return (prefix = p);
  }
  throw new ToolError('API_NOT_FOUND', 'Neither /browser-run nor /browser-rendering answered for this account id.', 'Check the account id in the plugin settings.');
}

function auth() { return { Authorization: `Bearer ${cfg.token}` }; }

function authError(status: number) {
  return new ToolError('AUTH', `Cloudflare refused the token (HTTP ${status}): the token lacks the Browser Run Edit/Write permission or the account id is wrong.`, 'Fix the token or account id with the cf-browser:setup skill.');
}

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export interface RestOpts { query?: Record<string, string | number | boolean | undefined>; json?: unknown; raw?: boolean; timeoutMs?: number; engine?: string; quick?: boolean; allow404?: boolean }
export interface RestResult { status: number; data: any; bytes?: Buffer; contentType: string; msUsed?: number }

export async function rest(method: string, path: string, o: RestOpts = {}): Promise<RestResult> {
  const p = await detectPrefix();
  const qs = Object.entries(o.query || {}).filter(([, v]) => v !== undefined && v !== false).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');
  const url = `${API}/${cfg.accountId}${p}${path}${qs ? (path.includes('?') ? '&' : '?') + qs : ''}`;
  const init: RequestInit = { method, headers: { ...auth(), ...(o.json !== undefined ? { 'content-type': 'application/json' } : {}) }, body: o.json !== undefined ? JSON.stringify(o.json) : undefined };
  for (let attempt = 0; ; attempt++) {
    let r: Response;
    try {
      r = await fetch(url, { ...init, signal: AbortSignal.timeout(o.timeoutMs ?? 30000) });
    } catch (e: any) {
      if (method === 'GET' && attempt === 0 && e?.name !== 'TimeoutError') { await sleep(2000); continue; }
      throw new ToolError(method === 'POST' ? 'OUTCOME_UNKNOWN' : 'NETWORK', `Cloudflare API request failed: ${mask(e?.message || e)}`);
    }
    if (r.status === 429) {
      const ra = Number(r.headers.get('retry-after') || '0');
      if (attempt === 0 && ra > 0 && ra <= 20) { await sleep(ra * 1000); continue; }
      throw new ToolError('RATE_LIMITED', `Cloudflare rate limit hit${ra ? `; retry after ${ra} s` : ''}.`, 'Wait, then retry once. Do not loop.');
    }
    if (method === 'GET' && r.status >= 500 && attempt === 0) { await sleep(2000); continue; }
    const contentType = r.headers.get('content-type') || '';
    const msUsed = r.headers.has('x-browser-ms-used') ? Number(r.headers.get('x-browser-ms-used')) : undefined;
    if (o.quick && msUsed !== undefined) recordQuick(msUsed, o.engine || 'chromium', path.split('?')[0]);
    if (r.status === 401 || r.status === 403) {
      const body = await r.text();
      // A guardrails block on a Quick Action is a 403 too; only a plain auth failure gets the auth message.
      if (!/guardrail/i.test(body)) throw authError(r.status);
      throw new ToolError('BLOCKED', mask(body).slice(0, 500));
    }
    if (o.raw && r.ok && !contentType.includes('application/json')) {
      return { status: r.status, data: null, bytes: Buffer.from(await r.arrayBuffer()), contentType, msUsed };
    }
    const text = await r.text();
    let data: any = text;
    try { data = JSON.parse(text); } catch { /* not JSON */ }
    if (r.status === 404 && o.allow404) return { status: 404, data, contentType, msUsed };
    if (!r.ok || (data && data.success === false)) {
      const msg = data?.errors?.map((e: any) => e.message + (e.code ? ` [${e.code}]` : '')).join('; ') || data?.error || (typeof data === 'string' ? data.slice(0, 300) : `HTTP ${r.status}`);
      throw new ToolError(method === 'POST' && r.status >= 500 ? 'OUTCOME_UNKNOWN' : r.status === 404 ? 'NOT_FOUND' : 'CLOUDFLARE', `Cloudflare API ${method} ${path.split('?')[0]} → HTTP ${r.status}: ${mask(msg)}`);
    }
    if (data && typeof data === 'object' && 'success' in data && 'result' in data) data = data.result;
    return { status: r.status, data, contentType, msUsed };
  }
}

export async function wsUrl(id: string): Promise<string> {
  const p = await detectPrefix();
  return `wss://api.cloudflare.com/client/v4/accounts/${cfg.accountId}${p}/devtools/browser/${id}`;
}

export const authHeaders = auth;
