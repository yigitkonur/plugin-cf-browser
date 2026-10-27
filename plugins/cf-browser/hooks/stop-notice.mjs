#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { off, readStdin, emit, home, parentPids } from './lib.mjs';
try {
  if (!off()) {
    await readStdin();
    const runtime = join(home(), 'runtime'), parents = new Set(parentPids());
    const tasks = [];
    if (existsSync(runtime)) for (const folder of readdirSync(runtime)) {
      let j; try { j = JSON.parse(readFileSync(join(runtime, folder, 'journal.json'), 'utf8')); } catch { continue; }
      const clients = new Set((j.clients || []).filter(c => parents.has(c.hostPid)).map(c => c.id));
      tasks.push(...(j.tasks || []).filter(t => clients.has(t.clientId) && t.state === 'active'));
    }
    if (tasks.length) {
      const key = tasks.map(t => t.id).sort().join(','), marker = join(runtime, `notice-${createHash('sha256').update(key).digest('hex').slice(0, 16)}`);
      let seen; try { seen = readFileSync(marker, 'utf8'); } catch {}
      if (seen !== key) {
        mkdirSync(runtime, { recursive: true, mode: 0o700 }); writeFileSync(marker, key, { mode: 0o600 });
        emit({ systemMessage: `cf-browser: ${tasks.length} unfinished browser task(s). Use task_finish when the work is done. Other agents and tabs under your control remain open.` });
      }
    }
  }
} catch { /* Informational only. */ }
