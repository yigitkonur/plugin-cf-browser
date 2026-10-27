// Writes dist/page-tools.json: the pinned @playwright/mcp tool schemas, allowlisted, every `filename`
// argument removed (a page could otherwise talk the agent into writing files), and a required session_id added.
// Usage: node scripts/gen-page-tools.mjs > dist/page-tools.json
import { createRequire } from 'node:module';
const require = createRequire(new URL('../package.json', import.meta.url));
const { createConnection } = require('@playwright/mcp');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

// Frozen legacy discovery contract for the transition adapter; not the ordinary tool list.
const CAPABILITIES = ['core', 'core-navigation', 'core-tabs', 'core-input', 'vision', 'network'];
const ALLOW = [
  'browser_navigate', 'browser_navigate_back', 'browser_snapshot', 'browser_find', 'browser_click', 'browser_type', 'browser_fill_form',
  'browser_select_option', 'browser_hover', 'browser_drag', 'browser_press_key', 'browser_wait_for', 'browser_take_screenshot',
  'browser_evaluate', 'browser_tabs', 'browser_handle_dialog', 'browser_file_upload', 'browser_console_messages',
  'browser_network_requests', 'browser_network_request', 'browser_resize', 'browser_emulate_media',
  'browser_mouse_move_xy', 'browser_mouse_click_xy', 'browser_mouse_drag_xy', 'browser_mouse_down', 'browser_mouse_up', 'browser_mouse_wheel',
];

const server = await createConnection({ capabilities: CAPABILITIES, codegen: 'none', webmcp: true }, async () => { throw new Error('no browser at build time'); });
const [a, b] = InMemoryTransport.createLinkedPair();
await server.connect(b);
const client = new Client({ name: 'gen-page-tools', version: '1' });
await client.connect(a);
const { tools } = await client.listTools();
const byName = new Map(tools.map(t => [t.name, t]));
const missing = ALLOW.filter(n => !byName.has(n));
if (missing.length) { console.error(`allowlisted tools missing from @playwright/mcp: ${missing.join(', ')}`); process.exit(1); }

const out = ALLOW.map(name => {
  const t = structuredClone(byName.get(name));
  const s = t.inputSchema;
  s.properties = s.properties || {};
  delete s.properties.filename;
  if (Array.isArray(s.required)) s.required = s.required.filter(r => r !== 'filename');
  s.properties = { session_id: { type: 'string', description: 'The cf-browser session_id (from session_create or session_list).' }, ...s.properties };
  s.required = ['session_id', ...(s.required || [])];
  if (name === 'browser_file_upload') t.description += ' Only files inside the project folder or the system temp folder; never dotfiles or secrets.';
  return { name: t.name, ...(t.title ? { title: t.title } : {}), description: t.description, inputSchema: s, ...(t.annotations ? { annotations: t.annotations } : {}) };
});
process.stdout.write(JSON.stringify(out, null, 2) + '\n');
await client.close();
process.exit(0);
