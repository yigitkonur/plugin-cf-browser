#!/usr/bin/env bash
set -eu
cd "$(git rev-parse --show-toplevel)/plugins/cf-browser/hooks"
task_home="$(mktemp -d)"
trap 'rm -rf "$task_home"' EXIT
export CFB_HOME="$task_home"
for kind in session subagent; do
  result="$(printf '{}' | node primer.mjs "$kind")"
  printf '%s' "$result" | node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8"));const s=j.hookSpecificOutput.additionalContext;if(!s.includes("task_finish")||s.includes("profile_mode")||s.includes("confirm submits"))process.exit(1)'
done
printf '{}' | node primer.mjs session --host=codex | node -e 'const s=require("fs").readFileSync(0,"utf8");if(!s.includes("cf_browser MCP tools"))process.exit(1)'
[ -z "$(printf '{}' | CF_BROWSER_HOOKS=off node primer.mjs session)" ]
mkdir -p "$task_home/runtime/test"
printf '{"clients":[{"id":"a","hostPid":%s}],"tasks":[{"id":"t","clientId":"a","state":"active"}]}' "$$" > "$task_home/runtime/test/journal.json"
printf '{}' | node stop-notice.mjs | node -e 'const s=require("fs").readFileSync(0,"utf8");if(!s.includes("unfinished browser task"))process.exit(1)'
[ -z "$(printf '{}' | node stop-notice.mjs)" ]
node -e 'for(const f of ["hooks.json","codex-hooks.json"]){const j=require("./"+f);if(j.hooks.PreToolUse)throw Error("Unrequested permission hook");}'
echo 'hook-smoke: OK'
