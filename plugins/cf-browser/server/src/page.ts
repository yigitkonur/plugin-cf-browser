import { randomUUID } from 'node:crypto';
import { mkdirSync, statSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, join, isAbsolute } from 'node:path';
import { ToolError } from './cf.js';
import type { BrowserRecord, Tab } from './models.js';

export function invalidate(t: Tab) { t.generation++; t.observation = undefined; t.needsObservation = true; }
export function locator(t: Tab, target: string) {
  if (!target) throw new ToolError('BAD_ARGS', 'Provide a target from the current observation.');
  return t.page.locator(/^(f\d+)?e\d+$/.test(target) ? `aria-ref=${target}` : target);
}
const windowSlice = (s: string, offset = 0, size = 12_000) => ({ text: s.slice(offset, offset + size), offset, total_chars: s.length, next_offset: offset + size < s.length ? offset + size : null });
export async function observe(r: BrowserRecord, t: Tab, a: any = {}) {
  if (a.observation_id && a.offset !== undefined) {
    if (!t.observation || t.observation.id !== a.observation_id || t.observation.generation !== t.generation) throw new ToolError('STALE_OBSERVATION', 'The observation changed; observe the tab again.');
    return { tab_id: t.id, observation_id: t.observation.id, snapshot: windowSlice(t.observation.snapshot, a.offset) };
  }
  if (t.dialog) return { tab_id: t.id, observation_id: null, dialog: { type: t.dialog.type(), message: t.dialog.message() }, next: 'Resolve the dialog with act action=dialog, then observe.' };
  const generation = t.generation;
  const snapshot = await (a.selector ? t.page.locator(a.selector) : t.page).ariaSnapshot({ mode: 'ai', timeout: 8_000 });
  const observation = { id: `obs_${randomUUID()}`, generation, authEpoch: r.authEpoch, url: t.page.url(), title: await t.page.title(), snapshot };
  if (generation !== t.generation) {
    if ((a._retry || 0) < 2) return observe(r, t, { ...a, _retry: (a._retry || 0) + 1 });
    throw new ToolError('PAGE_CHANGED', 'The page kept navigating during observation; observe again.');
  }
  t.title = observation.title; t.observation = observation; t.needsObservation = false;
  const lines: string[] = snapshot.split('\n');
  const matching = a.query ? lines.filter(l => l.toLowerCase().includes(String(a.query).toLowerCase())).join('\n') : snapshot;
  return { tab_id: t.id, observation_id: observation.id, url: observation.url, title: observation.title, control: t.control,
    snapshot: windowSlice(matching), ...(a.query ? { query: a.query, matches: matching ? matching.split('\n').length : 0 } : {}), events: t.events.splice(0) };
}

export async function screenshot(r: BrowserRecord, t: Tab, a: any, dir: string) {
  const generation = t.generation;
  // Cloudflare's compositor may stall on a background target. Serialize only
  // capture/activation in the manager; all semantic actions still target their Page.
  await t.page.bringToFront();
  const geometry = await t.page.evaluate(() => ({ width: innerWidth, height: innerHeight, scrollX, scrollY }));
  const bytes = await t.page.screenshot({ fullPage: !!a.full_page, scale: 'css', timeout: 15_000 });
  if (generation !== t.generation) throw new ToolError('PAGE_CHANGED', 'The page navigated while taking the screenshot. Take a new screenshot.');
  const id = `obs_${randomUUID()}`;
  t.observation = { id, generation, authEpoch: r.authEpoch, url: t.page.url(), title: await t.page.title(), snapshot: '', screenshot: { ...geometry, fullPage: !!a.full_page } };
  t.needsObservation = false;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${id}.png`); writeFileSync(path, bytes, { mode: 0o600 });
  return { tab_id: t.id, observation_id: id, url: t.page.url(), control: t.control, viewport: geometry,
    image_size: { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) },
    coordinates: a.full_page ? 'Full-page reference image; take a viewport screenshot before coordinate actions.' : 'Actions use viewport CSS pixels, origin top-left. If image_size differs from viewport, scale image x/y by viewport width/height divided by image width/height.',
    artifact: { path, mime_type: 'image/png', bytes: bytes.length }, image: { type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' } };
}

export async function validateObservation(r: BrowserRecord, t: Tab, a: any, coordinate = false) {
  const o = t.observation;
  if (!o || o.id !== a.observation_id || o.generation !== t.generation || o.authEpoch !== r.authEpoch || t.needsObservation)
    throw new ToolError('STALE_OBSERVATION', 'Use an observation from this tab after its last action, navigation or control change.', 'Call observe (or screenshot for coordinates), then choose the next action.');
  if (coordinate) {
    if (!o.screenshot || o.screenshot.fullPage) throw new ToolError('SCREENSHOT_REQUIRED', 'Coordinate actions require a current viewport screenshot.');
    const now = await t.page.evaluate(() => ({ width: innerWidth, height: innerHeight, scrollX, scrollY }));
    for (const k of ['width', 'height', 'scrollX', 'scrollY'] as const) if (now[k] !== o.screenshot[k]) throw new ToolError('STALE_SCREENSHOT', `The viewport changed (${k}: ${o.screenshot[k]} → ${now[k]}). Take a fresh screenshot.`);
    for (const [x, y] of [[a.x, a.y], [a.to_x, a.to_y]]) if (x !== undefined || y !== undefined) {
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= now.width || y >= now.height) throw new ToolError('BAD_COORDINATES', 'Use CSS coordinates inside the screenshot viewport.');
    }
  }
}

export async function action(r: BrowserRecord, t: Tab, a: any) {
  const p = t.page, opts = { timeout: 8_000 };
  const coordinate = a.x !== undefined || a.action === 'drag_xy';
  if (!['navigate', 'back', 'dialog'].includes(a.action)) await validateObservation(r, t, a, coordinate);
  invalidate(t);
  switch (a.action) {
    case 'navigate': { const res = await p.goto(a.url, { ...opts, waitUntil: 'domcontentloaded' }); return { http_status: res?.status() }; }
    case 'back': await p.goBack({ ...opts, waitUntil: 'domcontentloaded' }); break;
    case 'click': if (coordinate) await p.mouse.click(a.x, a.y, { button: a.button || 'left', clickCount: a.double ? 2 : 1 }); else await locator(t, a.target).click({ ...opts, button: a.button || 'left', clickCount: a.double ? 2 : 1 }); break;
    case 'fill': await locator(t, a.target).fill(a.text, opts); break;
    case 'type': if (a.target) await locator(t, a.target).pressSequentially(a.text, opts); else await p.keyboard.type(a.text); break;
    case 'press': if (a.target) await locator(t, a.target).press(a.key, opts); else await p.keyboard.press(a.key); break;
    case 'select': await locator(t, a.target).selectOption(a.values, opts); break;
    case 'check': await locator(t, a.target).setChecked(a.checked, opts); break;
    case 'hover': if (coordinate) await p.mouse.move(a.x, a.y); else await locator(t, a.target).hover(opts); break;
    case 'scroll': await p.mouse.wheel(a.delta_x || 0, a.delta_y || 0); break;
    case 'drag': await locator(t, a.target).dragTo(locator(t, a.to_target), opts); break;
    case 'drag_xy': await p.mouse.move(a.x, a.y); await p.mouse.down(); try { await p.mouse.move(a.to_x, a.to_y, { steps: 8 }); } finally { await p.mouse.up(); } break;
    case 'dialog': if (!t.dialog) throw new ToolError('NO_DIALOG', 'There is no pending dialog.'); if (a.accept) await t.dialog.accept(a.text); else await t.dialog.dismiss(); t.dialog = undefined; break;
    case 'resize': await p.setViewportSize({ width: a.width, height: a.height }); break;
    default: throw new ToolError('BAD_ARGS', `Unknown action ${a.action}.`);
  }
  return {};
}

export async function upload(t: Tab, a: any) {
  const paths = (a.paths || []).map((p: string) => {
    if (!isAbsolute(p)) throw new ToolError('BAD_PATH', 'Use the absolute file path the user supplied.');
    const real = realpathSync(p); if (!statSync(real).isFile()) throw new ToolError('BAD_PATH', 'Upload paths must be regular files.'); return real;
  });
  if (!paths.length) throw new ToolError('BAD_ARGS', 'Provide at least one file.');
  if (t.fileChooser) { await t.fileChooser.setFiles(paths, { timeout: 8_000 }); t.fileChooser = undefined; }
  else await locator(t, a.target).setInputFiles(paths, { timeout: 8_000 });
  return { uploaded: paths.map((p: string) => ({ name: basename(p), bytes: statSync(p).size })) };
}
