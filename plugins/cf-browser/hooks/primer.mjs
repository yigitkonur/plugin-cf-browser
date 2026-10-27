#!/usr/bin/env node
import { off, readStdin, emit, codex } from './lib.mjs';
try {
  if (!off()) {
    await readStdin();
    const kind = process.argv[2] === 'subagent' ? 'SubagentStart' : 'SessionStart';
    emit({ hookSpecificOutput: { hookEventName: kind, additionalContext: `[cf-browser] Shared Cloudflare browser available (${codex ? 'cf_browser MCP tools' : 'browser MCP tools'}). Load the browse skill for web tasks. Use the default shared profile, your task's stable tabs, observed small actions, and task_finish when done. Other agents and human-owned tabs keep their work. Doctor diagnoses setup; advanced features are discovered only when relevant.` } });
  }
} catch { /* A primer failure does not block the host. */ }
