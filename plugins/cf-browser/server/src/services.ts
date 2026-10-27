// Advanced Cloudflare services, discovered only when needed. They do not own agent browsers.
import { mkdirSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { cfg } from './config.js';
import { rest, ToolError, sleep } from './cf.js';
import * as profiles from './profiles.js';
import * as usage from './usage.js';
import { obj, str, int, bool, strArr, type ToolDef } from './schema.js';
type Json = Record<string, any>;
const SID = str('Cloudflare browser id from task_start (not task_id).');
const outDir = (...p: string[]) => { const d = join(cfg.home, 'artifacts', ...p); mkdirSync(d, { recursive: true, mode: 0o700 }); return d; };
const opaqueId = (value: unknown) => { const id = String(value); if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new ToolError('BAD_ID', 'Use the opaque id returned by Cloudflare.'); return id; };
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
// ---- Quick Actions ----
function cookiesFor(profile: string | undefined, url: string) {
  if (!profile) return { cookies: undefined, note: undefined };
  const { cookies, hasLocalStorage } = profiles.cookiesFor(profile.toLowerCase(), url);
  const note = !cookies.length
    ? (hasLocalStorage ? 'This site keeps its login in localStorage, which Quick Actions cannot carry; start a shared browser task (task_start) instead.' : `Profile "${profile}" has no cookies for this site.`)
    : undefined;
  return { cookies: cookies.length ? cookies : undefined, note };
}

function cap(text: string, max: number, ext: string) {
  if (text.length <= max) return { text, truncated: false };
  const file = join(outDir('reads'), `${stamp()}.${ext}`);
  writeFileSync(file, text, { mode: 0o600 });
  return { text: text.slice(0, max), truncated: true, full_text_file: file, full_length: text.length };
}

async function quick(endpoint: string, body: Json, engine: 'chromium' | 'kitesurf', raw = false) {
  return rest('POST', endpoint, { json: body, quick: true, engine, raw, timeoutMs: 90000, query: engine === 'kitesurf' ? { browser: 'kitesurf' } : undefined });
}

const READS: Record<string, { ep: string; kite: boolean }> = {
  markdown: { ep: '/markdown', kite: true }, html: { ep: '/content', kite: true }, text: { ep: '/scrape', kite: true }, links: { ep: '/links', kite: true },
  accessibility: { ep: '/accessibilityTree', kite: false }, screenshot: { ep: '/screenshot', kite: false }, pdf: { ep: '/pdf', kite: false },
};

async function pageRead(a: Json) {
  const as = a.as || 'markdown';
  const spec = READS[as];
  if (!spec) throw new ToolError('BAD_ARGS', `as must be one of ${Object.keys(READS).join(', ')}`);
  const { cookies, note } = cookiesFor(a.profile, a.url);
  const body: Json = { url: a.url, ...(cookies ? { cookies } : {}), ...(a.wait_for_selector ? { waitForSelector: { selector: a.wait_for_selector, timeout: 30000 } } : {}) };
  if (as === 'text') body.elements = [{ selector: 'body' }];
  const want = a.engine || 'auto';
  const kiteOk = spec.kite && !cookies;
  if (want === 'kitesurf' && !kiteOk) throw new ToolError('BAD_ARGS', `Kitesurf cannot do "${as}"${cookies ? ' with a profile' : ''}; use engine "chromium" or "auto".`);
  let engine: 'chromium' | 'kitesurf' = want === 'chromium' || !kiteOk ? 'chromium' : 'kitesurf';
  let r: any, fellBack: string | undefined;
  try { r = await quick(spec.ep, body, engine, as === 'screenshot' || as === 'pdf'); }
  catch (e: any) {
    if (engine !== 'kitesurf' || want === 'kitesurf' || e?.code === 'AUTH') throw e;
    fellBack = `Kitesurf failed (${e.code}), used Chromium`;
    engine = 'chromium';
    r = await quick(spec.ep, body, engine, false);
  }
  const meta = { url: a.url, as, engine, browser_ms: r.msUsed, fell_back: fellBack, profile_note: note };
  const max = Math.min(Math.max(Number(a.max_chars) || 20000, 500), 100000);
  if (as === 'screenshot') return { __content: [{ type: 'image', data: r.bytes.toString('base64'), mimeType: 'image/png' }, { type: 'text', text: JSON.stringify(meta) }] };
  if (as === 'pdf') { const file = join(outDir('reads'), `${stamp()}.pdf`); writeFileSync(file, r.bytes, { mode: 0o600 }); return { ...meta, file, bytes: r.bytes.length }; }
  if (as === 'links') { const links: string[] = r.data || []; const c = cap(links.join('\n'), max, 'txt'); return { ...meta, count: links.length, links: c.text.split('\n'), ...(c.truncated ? { full_list_file: c.full_text_file } : {}) }; }
  if (as === 'text') { const t = (r.data?.[0]?.results || []).map((x: any) => x.text).join('\n'); return { ...meta, ...cap(t, max, 'txt') }; }
  if (as === 'accessibility') return { ...meta, ...cap(JSON.stringify(r.data?.accessibilityTree ?? r.data), max, 'json') };
  return { ...meta, ...cap(typeof r.data === 'string' ? r.data : JSON.stringify(r.data), max, as === 'html' ? 'html' : 'md') };
}

// ---- crawl ----
const TERMINAL = ['completed', 'errored', 'cancelled_due_to_timeout', 'cancelled_due_to_limits', 'cancelled_by_user'];

async function crawlStatus(a: Json) {
  const id = opaqueId(a.job_id);
  const head = (await rest('GET', `/crawl/${id}`, { query: { limit: 1 } })).data;
  const out: Json = { job_id: id, status: head.status, total: head.total, finished: head.finished, browser_seconds: head.browserSecondsUsed };
  if (!TERMINAL.includes(head.status)) return { ...out, next: 'Still running. Call crawl_status again in 30–60 s.' };
  const file = join(outDir('crawls'), `${id}.jsonl`);
  writeFileSync(file, '', { mode: 0o600 });
  let cursor: any = a.cursor, pages = 0, written = 0, errored = 0;
  do {
    const page = (await rest('GET', `/crawl/${id}`, { query: { cursor, limit: 100 }, timeoutMs: 60000 })).data;
    for (const rec of page.records || []) { appendFileSync(file, JSON.stringify(rec) + '\n'); written++; if (rec.status === 'errored') errored++; }
    cursor = page.cursor; pages++;
    if (!(page.records || []).length) break;
  } while (cursor !== undefined && cursor !== null && pages < 50);
  const marker = join(outDir('crawls'), `${id}.usage`);
  if (!existsSync(marker)) { usage.recordCrawl(id, Number(head.browserSecondsUsed) || 0); writeFileSync(marker, String(head.browserSecondsUsed || 0)); }
  return { ...out, records_written: written, errored_records: errored, file, next: 'Read the file (one JSON record per line: url, status, markdown/html, metadata) instead of asking for the pages in chat.' };
}

// ---- recording ----
const RRWEB = { version: '2.1.7', js: 'sha384-Wf8KIaDOsBd/cL8haF8eb323WjiOJg7lQ0hNwCTImrgJrbyMt3oVqrJH5UVM2H/I', css: 'sha384-Vtd2JJi08a5lmE5TOd+EV1z2Qvs17Ufa6/rlyqHiHhRpk1M34rmdExK5oVQ5cMmf' };

function replayHtml(events: Record<string, any[]>) {
  const tabs = Object.keys(events);
  const data = JSON.stringify(events).replace(/</g, '\\u003c');
  return `<!doctype html><html><head><meta charset="utf-8"><title>cf-browser replay</title>
<link rel="stylesheet" href="https://unpkg.com/rrweb-player@${RRWEB.version}/dist/style.min.css" integrity="${RRWEB.css}" crossorigin="anonymous">
<style>body{font-family:system-ui;margin:16px}select{margin-bottom:12px}</style></head><body>
<h3>cf-browser session replay</h3><select id="tab">${tabs.map((t, i) => `<option value="${t.replace(/[&<>"']/g, "_")}">tab ${i + 1} (${events[t].length} events)</option>`).join('')}</select><div id="p"></div>
<script src="https://unpkg.com/rrweb-player@${RRWEB.version}/dist/rrweb-player.umd.min.cjs" integrity="${RRWEB.js}" crossorigin="anonymous"></script>
<script>const EV=${data};let player;function show(t){document.getElementById('p').innerHTML='';const ev=EV[t];if(!ev||ev.length<2){document.getElementById('p').textContent='Not enough events in this tab to replay.';return;}const P=rrwebPlayer.default||rrwebPlayer.Player||rrwebPlayer;player=new P({target:document.getElementById('p'),props:{events:ev,width:1024,height:640,autoPlay:false}});}
const sel=document.getElementById('tab');sel.onchange=()=>show(sel.value);show(sel.value);</script></body></html>`;
}

async function recordingFetch(a: Json) {
  const id = opaqueId(a.session_id);
  const deadline = Date.now() + 60000;
  let data: any;
  for (;;) {
    const r = await rest('GET', `/recording/${id}`, { allow404: true, timeoutMs: 60000 });
    if (r.status !== 404) { data = r.data; break; }
    if (Date.now() > deadline) throw new ToolError('NOT_FOUND', 'No recording for this session (Cloudflare returned 404 for 60 s). Recordings exist only for sessions created with record:true, and are kept 30 days.');
    await sleep(5000);
  }
  const dir = outDir('recordings', id);
  const events: Record<string, any[]> = data.events || {};
  writeFileSync(join(dir, 'events.json'), JSON.stringify(data), { mode: 0o600 });
  const har: string[] = [];
  if (a.include_network !== false) {
    for (const t of Object.keys(events)) {
      try {
        const r = await rest('GET', `/recording/${id}/network`, { query: { target: t, format: 'har' }, timeoutMs: 60000 });
        const f = join(dir, `network-${t.slice(0, 8)}.har`);
        writeFileSync(f, typeof r.data === 'string' ? r.data : JSON.stringify(r.data), { mode: 0o600 });
        har.push(f);
      } catch { /* network data is optional */ }
    }
  }
  const replay = join(dir, 'replay.html');
  writeFileSync(replay, replayHtml(events), { mode: 0o600 });
  return {
    session_id: id, duration_s: Math.round((data.duration || 0) / 1000), tabs: Object.fromEntries(Object.entries(events).map(([t, ev], i) => [`tab ${i + 1}`, ev.length])),
    files: { events: join(dir, 'events.json'), replay_html: replay, har },
    next: 'Open replay_html in the user\'s browser to watch it. Do not print the events into chat.',
  };
}

export const services: ToolDef[] = [
  {
    name: 'page_read',
    description: 'Read a page without opening a browser session (Cloudflare Quick Action): markdown, html, text, links, accessibility tree, screenshot or pdf. Cheapest way to read public pages. engine auto uses Kitesurf (free during its beta) for markdown/html/text/links of public pages and falls back to Chromium. With profile it sends that profile\'s cookies (cookie logins only). Large output goes to a file.',
    inputSchema: obj({
      url: str('Page URL'), as: { type: 'string', enum: Object.keys(READS), description: 'Default markdown.' },
      engine: { type: 'string', enum: ['auto', 'chromium', 'kitesurf'], description: 'Default auto.' },
      profile: str('Send this profile\'s cookies for the site.'), wait_for_selector: str('CSS selector to wait for before reading.'),
      max_chars: int('Default 20000.', 500, 100000),
    }, ['url']),
    annotations: { readOnlyHint: true },
    handler: pageRead,
  },
  {
    name: 'page_extract',
    description: 'Extract structured data from a page with AI (Cloudflare /json Quick Action). Uses Workers AI: extra cost on top of browser time. Prefer page_read or page_scrape when they can answer.',
    inputSchema: obj({ url: str('Page URL'), prompt: str('What to extract'), schema: { type: 'object', description: 'Optional JSON Schema for the result.' }, profile: str('Send this profile\'s cookies.') }, ['url']),
    annotations: { readOnlyHint: true },
    handler: async a => {
      const { cookies, note } = cookiesFor(a.profile, a.url);
      const r = await quick('/json', { url: a.url, ...(a.prompt ? { prompt: a.prompt } : {}), ...(a.schema ? { response_format: { type: 'json_schema', schema: a.schema } } : {}), ...(cookies ? { cookies } : {}) }, 'chromium');
      return { url: a.url, browser_ms: r.msUsed, data: r.data, profile_note: note };
    },
  },
  {
    name: 'page_scrape',
    description: 'Get the text of elements matching CSS selectors on a page (Cloudflare /scrape Quick Action), without a session.',
    inputSchema: obj({ url: str('Page URL'), selectors: strArr('CSS selectors'), profile: str('Send this profile\'s cookies.') }, ['url', 'selectors']),
    annotations: { readOnlyHint: true },
    handler: async a => {
      const { cookies, note } = cookiesFor(a.profile, a.url);
      const r = await quick('/scrape', { url: a.url, elements: (a.selectors || []).map((s: string) => ({ selector: s })), ...(cookies ? { cookies } : {}) }, 'chromium');
      const results = (r.data || []).map((x: any) => ({ selector: x.selector, matches: (x.results || []).length, items: (x.results || []).slice(0, 200).map((m: any) => ({ text: String(m.text ?? '').slice(0, 2000), ...(m.attributes ? { attributes: m.attributes } : {}) })) }));
      const text = JSON.stringify(results);
      if (text.length > 20000) { const f = join(outDir('reads'), `${stamp()}-scrape.json`); writeFileSync(f, text, { mode: 0o600 }); return { url: a.url, browser_ms: r.msUsed, file: f, selectors: results.map((x: any) => ({ selector: x.selector, matches: x.matches })), profile_note: note }; }
      return { url: a.url, browser_ms: r.msUsed, results, profile_note: note };
    },
  },
  {
    name: 'crawl_start',
    description: 'Start an async crawl of a site (Cloudflare /crawl): follows links from url up to limit pages. Respects robots.txt. render:false does a fast HTML fetch without a browser (cheaper). Then poll crawl_status.',
    inputSchema: obj({
      url: str('Start URL'), limit: int('Max pages (default 10).', 1, 200), depth: int('Max link depth.', 1, 100),
      formats: { type: 'array', items: { type: 'string', enum: ['html', 'markdown'] }, description: 'Default ["markdown"].' },
      render: bool('Default true (runs JavaScript). false = plain HTML fetch, much cheaper.'),
      include: strArr('Only URLs matching these wildcard patterns (* = any chars except /, ** = any).'), exclude: strArr('Skip URLs matching these patterns.'),
    }, ['url']),
    handler: async a => {
      const body: Json = { url: a.url, limit: Math.min(200, a.limit || 10), formats: a.formats?.length ? a.formats : ['markdown'], ...(a.depth ? { depth: a.depth } : {}), ...(a.render === false ? { render: false } : {}) };
      if (a.include?.length || a.exclude?.length) body.options = { ...(a.include?.length ? { includePatterns: a.include } : {}), ...(a.exclude?.length ? { excludePatterns: a.exclude } : {}) };
      const r = await rest('POST', '/crawl', { json: body });
      return { job_id: r.data, next: 'Call crawl_status with this job_id in 30–60 s.' };
    },
  },
  { name: 'crawl_status', description: 'Check a crawl job. When it is finished, writes every page to a JSONL file and returns the path and counts (not the pages).', inputSchema: obj({ job_id: str('From crawl_start'), cursor: str('Pagination cursor, rarely needed') }, ['job_id']), annotations: { readOnlyHint: true }, handler: crawlStatus },
  { name: 'crawl_cancel', description: 'Cancel a running crawl job.', inputSchema: obj({ job_id: str('From crawl_start') }, ['job_id']), handler: async a => { await rest('DELETE', `/crawl/${opaqueId(a.job_id)}`); return { job_id: a.job_id, cancelled: true }; } },
  {
    name: 'recording_fetch',
    description: 'Download the recording of a closed browser that was created with record:true: rrweb events, network HAR per tab, and a replay.html to watch it. Returns file paths and counts, never the events.',
    inputSchema: obj({ session_id: SID, include_network: bool('Default true.') }, ['session_id']),
    handler: recordingFetch,
  },
];
