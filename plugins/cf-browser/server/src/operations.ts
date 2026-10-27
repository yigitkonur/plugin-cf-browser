import { randomUUID } from 'node:crypto';
import { ToolError, mask } from './cf.js';

export interface Operation {
  id: string; clientId: string; tabId?: string; state: 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: number; finishedAt?: number; result?: any; error?: any;
  cancelled: boolean; cancel?: () => Promise<void>; done: Promise<void>;
}
export function failure(e: any, unknown = false) {
  return { code: e?.code || (e?.name === 'TimeoutError' ? 'ACTION_TIMEOUT' : 'ERROR'),
    message: mask(e?.message || e).replace(/\u001b\[[0-9;]*m/g, '').split('\n').slice(0, 10).join(' ').slice(0, 1800),
    outcome_unknown: unknown || e?.code === 'OUTCOME_UNKNOWN',
    next: e?.next || (unknown ? 'Observe the tab before another mutation; do not repeat the previous action.' : 'Inspect the current state and correct the request.') };
}

// Retain completed results so status polling and lost HTTP replies never repeat a mutation.
export class Operations {
  readonly items = new Map<string, Operation>();
  constructor(readonly replyMs = 10_000) {}
  start(clientId: string, fn: (op: Operation) => Promise<any>, options: { tabId?: string; cancel?: () => Promise<void> } = {}) {
    const op: Operation = { id: `op_${randomUUID()}`, clientId, tabId: options.tabId, state: 'running', startedAt: Date.now(), cancelled: false, cancel: options.cancel, done: Promise.resolve() };
    this.items.set(op.id, op);
    op.done = Promise.resolve().then(() => fn(op)).then(result => {
      if (!op.cancelled) { op.result = result; op.state = 'completed'; }
    }, error => {
      if (!op.cancelled) { op.error = failure(error, !!op.tabId); op.state = 'failed'; }
    }).finally(() => { op.finishedAt = Date.now(); });
    return op;
  }
  view(op: Operation): any {
    if (op.state === 'completed') return { operation_id: op.id, status: op.state, result: op.result };
    return { operation_id: op.id, status: op.state, ...(op.tabId ? { tab_id: op.tabId } : {}), ...(op.error ? { error: op.error } : {}), ...(op.state === 'running' ? { next: 'Poll operation with this operation_id. Do not send the action again.' } : {}) };
  }
  async reply(op: Operation, waitMs = this.replyMs) {
    let timer: ReturnType<typeof setTimeout>;
    await Promise.race([op.done, new Promise<void>(r => { timer = setTimeout(r, waitMs); })]);
    clearTimeout(timer!);
    return this.view(op);
  }
  get(id: string, clientId: string) {
    const op = this.items.get(id);
    if (!op || op.clientId !== clientId) throw new ToolError('OPERATION_NOT_FOUND', 'No operation with that id belongs to this client.');
    return op;
  }
  async cancel(id: string, clientId: string) {
    const op = this.get(id, clientId);
    if (op.state !== 'running') return this.view(op);
    if (!op.cancel) throw new ToolError('NOT_CANCELLABLE', 'This operation is reconciling browser or profile state.', 'Poll its status; do not repeat it.');
    // Do not announce cancellation until the target has actually been stopped/closed.
    try { await op.cancel(); } catch (e) { op.error = { ...failure(e, true), code: 'CANCEL_FAILED', next: 'The target did not confirm stopping. Keep this operation pending; do not repeat the action.' }; throw e; }
    op.cancelled = true; op.state = 'cancelled'; op.finishedAt = Date.now();
    op.error = { code: 'CANCELLED', outcome_unknown: true, message: 'The operation was stopped. Earlier site effects may already have occurred.', next: 'Inspect the site in a fresh tab before repeating any mutation.' };
    return this.view(op);
  }
  prune() {
    for (const [id, op] of this.items) if (op.finishedAt && Date.now() - op.finishedAt > 60 * 60_000) this.items.delete(id);
  }
}
