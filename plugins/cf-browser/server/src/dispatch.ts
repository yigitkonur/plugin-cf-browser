import { plainResult } from './results.js';
import { Manager } from './manager.js';
import { tools } from './tools.js';
import { validate } from './schema.js';
import { advancedTools, callAdvanced, doctor } from './advanced.js';
import { Compatibility } from './compatibility.js';
import { configMissing } from './config.js';
import { ToolError } from './cf.js';

export class Dispatcher {
  readonly compatibility: Compatibility;
  constructor(readonly m: Manager) { this.compatibility = new Compatibility(m); }
  async call(clientId: string, name: string, a: any = {}) {
    const m = this.m, def = tools.find(t => t.name === name);
    if (def) validate(def.inputSchema, a);
    if (name === 'operation' && a.action === 'read') {
      const op = m.operations.get(a.operation_id, clientId);
      if (op.state !== 'completed') return m.operations.view(op);
      const text = plainResult(op.result), offset = a.offset || 0;
      return { operation_id: op.id, status: op.state, result_page: { encoding: 'json', text: text.slice(offset, offset + 12000), offset, total_chars: text.length, next_offset: offset + 12000 < text.length ? offset + 12000 : null } };
    }
    if (name === 'operation') return a.action === 'cancel' ? m.operations.cancel(a.operation_id, clientId) : m.operations.reply(m.operations.get(a.operation_id, clientId), 1000);
    if (name === 'advanced' && a.action === 'discover') return { tools: advancedTools.filter(t => !a.topic || t.topic === a.topic).map(({ handler, ...t }) => t), ...(a.topic === 'compatibility' ? { note: 'Legacy session_* and browser_* names remain callable for one transition release. session_id is task-scoped. Use the everyday tools for new work.' } : {}) };
    if (name !== 'doctor' && configMissing()) throw new ToolError('NOT_CONFIGURED', configMissing()!);
    if (name === 'observe') return m.observe(clientId, a);
    if (name === 'screenshot') return m.screenshot(clientId, a);
    if (name === 'act') return m.act(clientId, a);
    if (name === 'wait') return m.wait(clientId, a);
    if (name === 'files' && a.action === 'upload') return m.files(clientId, a);
    if (name === 'advanced' && a.action === 'call' && ['script', 'webmcp_list', 'webmcp_call'].includes(a.name)) return callAdvanced(m, clientId, a.name, a.arguments || {});
    // Non-page work may involve API/connection/storage IO too. It has the same bounded reply contract.
    const op = m.operations.start(clientId, async () => {
      switch (name) {
        case 'task_start': return m.start(clientId, a);
        case 'task_finish': return m.finish(clientId, a.task_id);
        case 'tabs': return m.tabs(clientId, a);
        case 'human': return m.human(clientId, a);
        case 'files': return m.files(clientId, a);
        case 'doctor': return doctor(m);
        case 'advanced': return callAdvanced(m, clientId, a.name, a.arguments || {});
        default: return this.compatibility.call(clientId, name, a);
      }
    });
    return m.operations.reply(op);
  }
}
