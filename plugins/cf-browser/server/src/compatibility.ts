import { Manager } from './manager.js';
import { ToolError } from './cf.js';
import { callAdvanced } from './advanced.js';
import * as page from './page.js';

// One transition release: old names are callable but absent from tools/list.
// A legacy session is a TASK, never the shared Cloudflare browser id.
export class Compatibility {
  selected = new Map<string, string>();
  browserIds = new Map<string, string>();
  constructor(readonly m: Manager) {}
  async call(client: string, name: string, a: any) {
    const m = this.m;
    if (name === 'session_create') {
      if (a.profile_mode && a.profile_mode !== 'write') throw new ToolError('LEGACY_PROFILE_MODE', 'Shared tasks use a persistent profile.', 'Use task_start with an explicitly separate profile when a separate account environment is needed.');
      if (a.allowed_domains?.length || a.allowed_domain_sets?.length) throw new ToolError('LEGACY_GUARDRAILS', 'Session-local domain guardrails cannot be applied to a shared browser.', 'Use task_start for shared browsing; no existing browser policy was changed.');
      const r = await m.start(client, a); this.selected.set(r.task_id, r.tab.tab_id); this.browserIds.set(r.task_id, r.browser_id);
      return { ...r, session_id: r.task_id, migration: 'session_id now identifies your task. session_close releases only your task.', ...(a.start_url ? { navigation: await m.act(client, { tab_id: r.tab.tab_id, action: 'navigate', url: a.start_url }) } : {}) };
    }
    if (name === 'session_list') return { this_window: [...m.tasks.values()].filter(t => t.clientId === client && t.state === 'active').map(t => ({ session_id: t.id, task_id: t.id, profile: t.profile, label: t.label, state: 'open' })) };
    if (name === 'session_close') return m.finish(client, a.session_id);
    if (name === 'recording_fetch') return callAdvanced(m, client, name, { ...a, session_id: this.browserIds.get(a.session_id) || a.session_id });
    if (['profile_list', 'profile_create', 'profile_clone', 'profile_delete', 'profile_restore_previous', 'page_read', 'page_extract', 'page_scrape', 'crawl_start', 'crawl_status', 'crawl_cancel', 'usage_report'].includes(name)) return callAdvanced(m, client, name, a);
    if (name === 'profile_save') return callAdvanced(m, client, name, { task_id: a.session_id });
    const task = m.task(client, a.session_id), r = m.browsers.get(task.profile)!;
    const tabs = [...r.tabs.values()].filter(t => t.taskId === task.id && !t.closed);
    let t = tabs.find(t => t.id === this.selected.get(task.id)) || tabs[0];
    if (name === 'browser_tabs') {
      if (a.action === 'list') return { tabs: tabs.map((t, index) => ({ ...m.describeTab(t), index })) };
      if (a.action === 'new') { const out = await m.tabs(client, { task_id: task.id, action: 'open', url: a.url }); this.selected.set(task.id, out.tab!.tab_id); return out; }
      if (a.index !== undefined) t = tabs[a.index];
      if (!t) throw new ToolError('TAB_NOT_FOUND', 'List this task’s tabs and choose a current index.');
      if (a.action === 'select') { this.selected.set(task.id, t.id); return m.observe(client, { tab_id: t.id }); }
      return m.tabs(client, { task_id: task.id, action: 'close', tab_id: t.id });
    }
    if (!t) throw new ToolError('TAB_NOT_FOUND', 'This task has no open tab.', 'Open a tab in your task.');
    const base = { tab_id: t.id, observation_id: t.observation?.id };
    if (name === 'browser_snapshot') return m.observe(client, { ...base, selector: a.target && (/^(f\d+)?e\d+$/.test(a.target) ? `aria-ref=${a.target}` : a.target) });
    if (name === 'browser_find') return m.observe(client, { ...base, query: a.text || a.regex });
    if (name === 'browser_take_screenshot') return m.screenshot(client, { ...base, full_page: a.fullPage });
    if (name === 'live_view_open') return m.human(client, { ...base, action: 'open', mode: a.mode, scope: a.mode && a.mode !== 'tab' ? 'browser' : 'tab' });
    if (name === 'human_handoff') return m.human(client, { ...base, action: 'handoff', instructions: a.instructions });
    if (name === 'human_wait') return m.human(client, { ...base, action: 'status' });
    if (name === 'browser_file_upload') return m.files(client, { ...base, action: 'upload', paths: a.paths });
    if (name === 'webmcp_call') throw new ToolError('DISCOVER_WEBMCP', 'WebMCP now identifies the originating frame explicitly.', 'Use advanced discover topic=webmcp, then webmcp_list and webmcp_call.');
    const mappings: Record<string, any> = {
      browser_navigate: { action: 'navigate', url: a.url }, browser_navigate_back: { action: 'back' },
      browser_click: { action: 'click', target: a.target, button: a.button, double: a.doubleClick },
      browser_select_option: { action: 'select', target: a.target, values: a.values },
      browser_hover: { action: 'hover', target: a.target }, browser_drag: { action: 'drag', target: a.startTarget, to_target: a.endTarget },
      browser_press_key: { action: 'press', key: a.key }, browser_handle_dialog: { action: 'dialog', accept: a.accept, text: a.promptText },
      browser_resize: { action: 'resize', width: a.width, height: a.height },
      browser_mouse_move_xy: { action: 'hover', x: a.x, y: a.y }, browser_mouse_click_xy: { action: 'click', x: a.x, y: a.y, button: a.button, double: a.clickCount === 2 },
      browser_mouse_drag_xy: { action: 'drag_xy', x: a.startX, y: a.startY, to_x: a.endX, to_y: a.endY },
      browser_mouse_wheel: { action: 'scroll', delta_x: a.deltaX, delta_y: a.deltaY },
    };
    if (mappings[name]) return m.act(client, { ...base, ...mappings[name] });
    return m.runTab(client, base, async (r, t) => {
      if (name === 'browser_console_messages') return { messages: (t as any).console || [] };
      if (name === 'browser_network_requests') return { requests: ((t as any).network || []).map((x: any, index: number) => ({ index: index + 1, url: x.url(), status: x.status() })) };
      if (name === 'browser_network_request') {
        const response = (t as any).network?.[a.index - 1];
        if (!response) throw new ToolError('REQUEST_NOT_FOUND', 'List requests before selecting an index.');
        const redacted = (headers: any) => Object.fromEntries(Object.entries(headers).map(([k, v]) => [/authorization|cookie/i.test(k) ? k : k, /authorization|cookie/i.test(k) ? '[redacted]' : v]));
        return { url: response.url(), status: response.status(), ...(a.part === 'response-body' ? { body: (await response.text()).slice(0, 12000) } : a.part === 'request-body' ? { body: response.request().postData() } : { request_headers: redacted(await response.request().allHeaders()), response_headers: redacted(await response.allHeaders()) }) };
      }
      if (name === 'browser_wait_for') {
        if (a.text) await t.page.getByText(a.text).first().waitFor({ state: 'visible', timeout: 8_000 });
        else if (a.textGone) await t.page.getByText(a.textGone).first().waitFor({ state: 'hidden', timeout: 8_000 });
        else await new Promise(resolve => setTimeout(resolve, Math.min(a.time || 0, 8) * 1000));
        return page.observe(r, t);
      }
      await page.validateObservation(r, t, base, name.startsWith('browser_mouse_'));
      page.invalidate(t);
      let value;
      if (name === 'browser_type') { const loc = page.locator(t, a.target); if (a.slowly) await loc.pressSequentially(a.text, { timeout: 8_000 }); else await loc.fill(a.text, { timeout: 8_000 }); if (a.submit) await loc.press('Enter', { timeout: 8_000 }); }
      else if (name === 'browser_fill_form') {
        for (const f of a.fields || []) {
          const loc = page.locator(t, f.target);
          if (f.type === 'checkbox' || f.type === 'radio') await loc.setChecked(f.value === 'true', { timeout: 8_000 });
          else if (f.type === 'combobox') await loc.selectOption({ label: f.value }, { timeout: 8_000 });
          else await loc.fill(f.value, { timeout: 8_000 });
        }
      } else if (name === 'browser_evaluate') value = a.target ? await page.locator(t, a.target).evaluate(a.function) : await t.page.evaluate(`(${a.function})()`);
      else if (name === 'browser_emulate_media') { const { session_id, ...options } = a; await t.page.emulateMedia(options); }
      else if (name === 'browser_mouse_down') await t.page.mouse.down({ button: a.button });
      else if (name === 'browser_mouse_up') await t.page.mouse.up({ button: a.button });
      else throw new ToolError('UNKNOWN_TOOL', `Unknown compatibility tool ${name}.`, 'Use the everyday tools or advanced discovery.');
      return { value, observation: await page.observe(r, t) };
    }, true);
  }
}
