#!/usr/bin/env bash
# hook-smoke.sh -- runs every hook with sample input and checks the output. Needs only node.
set -u
cd "$(git rev-parse --show-toplevel)/plugins/cf-browser/hooks"
fail=0
check() { if printf '%s' "$2" | grep -q -- "$3"; then echo "ok   $1"; else echo "FAIL $1: got: $2" >&2; fail=1; fi; }
none() { if [ -z "$2" ]; then echo "ok   $1"; else echo "FAIL $1: expected no output, got: $2" >&2; fail=1; fi; }
export CLAUDE_PLUGIN_OPTION_API_TOKEN="smoke_token_0123456789abcdefghijklmnop"
check "guard denies profile file read" "$(echo '{"tool_name":"Read","tool_input":{"file_path":"'"$HOME"'/.cf-browser/profiles/main/state.json"}}' | node guard.mjs)" '"permissionDecision":"deny"'
check "guard denies ~ form in Bash" "$(echo '{"tool_name":"Bash","tool_input":{"command":"cat ~/.cf-browser/profiles/main/state.json"}}' | node guard.mjs)" '"deny"'
check "guard denies token literal" "$(echo '{"tool_name":"Bash","tool_input":{"command":"echo smoke_token_0123456789abcdefghijklmnop"}}' | node guard.mjs)" 'API token'
none  "guard allows other reads" "$(echo '{"tool_name":"Read","tool_input":{"file_path":"/tmp/notes.txt"}}' | node guard.mjs)"
check "primer session" "$(echo '{}' | node primer.mjs session)" '"hookEventName":"SessionStart"'
check "primer subagent mentions read-only" "$(echo '{}' | node primer.mjs subagent)" 'profile_mode'
none  "hooks off" "$(echo '{}' | CF_BROWSER_HOOKS=off node primer.mjs session)"
tmp="$(mktemp -d)"; mkdir -p "$tmp/state/servers"
printf '{"serverPid":%s,"claudePid":%s,"sessions":[{"id":"a","label":"shop","state":"open","idleTimeoutS":300}]}' "$$" "$$" > "$tmp/state/servers/$$-x.json"
check "stop notice when a browser is open" "$(echo '{"session_id":"s1"}' | CLAUDE_PLUGIN_DATA="$tmp" node stop-notice.mjs)" 'systemMessage'
none  "stop notice only once per set" "$(echo '{"session_id":"s1"}' | CLAUDE_PLUGIN_DATA="$tmp" node stop-notice.mjs)"
rm -rf "$tmp"
exit $fail
