#!/usr/bin/env node
// stop-notice.mjs: Stop. Non-blocking. If this window's cf-browser server has browsers open, tell the USER once per
// set of open browsers that they are still open and close themselves when idle. Never blocks the agent.
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { off, readStdin, emit, dataDir, parentPids, pidAlive, codex } from './lib.mjs';

try {
  if (!off()) {
    const input = await readStdin();
    const dir = join(dataDir(), 'state', 'servers');
    const mine = new Set(parentPids());
    const open = [];
    let idle = 0;
    if (existsSync(dir)) for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      let s; try { s = JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { continue; }
      if (!pidAlive(s.serverPid)) continue;
      if (![s.claudePid, s.claudeGrandPid].some(p => mine.has(p))) continue;
      for (const x of s.sessions || []) if (x.state === 'open') { open.push(x); idle = Math.max(idle, x.idleTimeoutS || 0); }
    }
    if (open.length) {
      const key = open.map(x => x.id).sort().join(',');
      const marker = join(dataDir(), 'state', `stop-notice-${input.session_id || 'x'}`);
      const seen = existsSync(marker) ? readFileSync(marker, 'utf8') : '';
      if (seen !== key) {
        mkdirSync(join(dataDir(), 'state'), { recursive: true });
        writeFileSync(marker, key);
        const labels = open.map(x => x.label).join(', ');
        const mins = Math.max(1, Math.round(idle / 60));
        emit({ systemMessage: `cf-browser: ${open.length} browser${open.length > 1 ? 's' : ''} open (${labels}); idle ones close automatically in ≤${mins} min, and all close when ${codex ? 'Codex' : 'Claude Code'} exits.` });
      }
    }
  }
} catch { /* fail open */ }
