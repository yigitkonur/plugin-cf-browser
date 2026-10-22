#!/usr/bin/env node
// guard.mjs: PreToolUse on Read|Grep|Glob|Bash|Edit|Write|MultiEdit|NotebookEdit. Denies a call whose input mentions
// the cf-browser profiles folder (saved logins are as sensitive as passwords) or carries the Cloudflare API token
// literal. A speed bump, not a vault: globs, cd or a page script can get around it. Fail-open.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { off, opt, readStdin, emit, home } from './lib.mjs';

function deny(reason) {
  emit({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
}

try {
  if (!off()) {
    const input = await readStdin();
    const text = JSON.stringify(input.tool_input || {});
    const profiles = join(home(), 'profiles');
    const forms = [profiles];
    if (profiles.startsWith(homedir())) forms.push('~' + profiles.slice(homedir().length), '$HOME' + profiles.slice(homedir().length), '${HOME}' + profiles.slice(homedir().length));
    const token = opt('API_TOKEN');
    if (token && token.length >= 20 && text.includes(token)) {
      deny('cf-browser: this call contains the Cloudflare API token. Never print, write or pass the token; the cf-browser MCP server already has it.');
    } else if (forms.some(f => text.includes(f)) || /\.cf-browser[\\/]+profiles/.test(text)) {
      deny(`cf-browser: ${profiles} holds saved browser logins (as sensitive as passwords). Do not read, search, copy or edit it; use the profile_list / profile_* tools, which return metadata only.`);
    }
  }
} catch { /* fail open */ }
