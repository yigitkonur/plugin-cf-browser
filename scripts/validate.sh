#!/usr/bin/env bash
# validate.sh -- structural checks for the plugin repo. Exit 1 on any failure.
#  1 claude plugin validate (marketplace, plugin) when `claude` is installed
#  2 every .json parses
#  3 SKILL.md frontmatter is valid YAML with name == directory; description <= 600 chars; SKILL.md <= 300 lines; references <= 350 lines
#  4 every references/ path named in a SKILL.md, and every ${CLAUDE_PLUGIN_ROOT}/ path in hooks.json, .mcp.json or a SKILL.md, exists
#  5 plugin.json version == its marketplace entry version == server VERSION
#  6 THIRD_PARTY_NOTICES.md ships inside the plugin and matches the root copy
#  7 no $N / $ARGUMENTS in SKILL.md bodies (Claude Code rewrites them)
#  8 the committed page-tools.json has no `filename` argument and every tool requires session_id
set -u; shopt -s nullglob
cd "$(git rev-parse --show-toplevel)" || exit 2
fail=0
bad() { echo "validate: $*" >&2; fail=1; }
P=plugins/cf-browser

# 1
if command -v claude >/dev/null 2>&1; then
  for t in . "$P"; do claude plugin validate "$t" >/dev/null 2>&1 || { bad "claude plugin validate failed on $t"; claude plugin validate "$t" 2>&1 | sed 's/^/  /' >&2; }; done
else echo "validate: claude not installed, skipping claude plugin validate" >&2; fi

# 2
while IFS= read -r f; do node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$f" 2>/dev/null || bad "invalid JSON: $f"; done < <(git ls-files -co --exclude-standard '*.json' | grep -v node_modules)

# 3
for f in "$P"/skills/*/SKILL.md; do
  fm="$(awk 'NR==1&&$0!="---"{exit} NR>1&&$0=="---"{exit} NR>1{print}' "$f")"
  [ -z "$fm" ] && { bad "no frontmatter: $f"; continue; }
  if python3 -c 'import yaml' 2>/dev/null; then
    printf '%s\n' "$fm" | python3 -I -c 'import sys,yaml; d=yaml.safe_load(sys.stdin); assert isinstance(d,dict) and isinstance(d.get("name"),str) and isinstance(d.get("description"),str) and len(d["description"])<=600' 2>/dev/null || bad "frontmatter is not valid YAML with name+description (<=600 chars): $f"
  fi
  name="$(printf '%s\n' "$fm" | sed -n 's/^name:[[:space:]]*//p' | head -1)"; [ "$name" = "$(basename "$(dirname "$f")")" ] || bad "name '$name' != directory: $f"
  [ "$(wc -l < "$f")" -le 300 ] || bad "SKILL.md over 300 lines: $f"
done
for f in "$P"/skills/*/references/*.md; do [ "$(wc -l < "$f")" -le 350 ] || bad "reference over 350 lines: $f"; done

# 4
for f in "$P"/skills/*/SKILL.md; do
  while IFS= read -r p; do [ -e "$(dirname "$f")/$p" ] || bad "$f names missing path: $p"; done < <(grep -oE '(\.\./[a-z-]+/)?references/[A-Za-z0-9._-]+\.md' "$f" | sort -u)
done
for f in "$P/hooks/hooks.json" "$P/.mcp.json" "$P"/skills/*/SKILL.md; do
  while IFS= read -r p; do [ -e "$P/$p" ] || bad "$f names missing plugin path: \${CLAUDE_PLUGIN_ROOT}/$p"; done < <(grep -oE '\$\{CLAUDE_PLUGIN_ROOT\}/[A-Za-z0-9._/-]*[A-Za-z0-9_]' "$f" | sed 's#^\${CLAUDE_PLUGIN_ROOT}/##' | sort -u)
done

# 5
V="$(node -p 'require("./'$P'/.claude-plugin/plugin.json").version')"
MV="$(node -p 'require("./.claude-plugin/marketplace.json").plugins.find(p => p.name === "cf-browser").version')"
[ "$MV" = "$V" ] || bad "marketplace version $MV != plugin.json $V"
grep -q "readVersion()" "$P/server/src/index.ts" || bad "server/src/index.ts must read its version from the plugin manifest (scripts/release.py bumps manifests only)"

# 6
[ -f "$P/THIRD_PARTY_NOTICES.md" ] || bad "missing $P/THIRD_PARTY_NOTICES.md"
cmp -s THIRD_PARTY_NOTICES.md "$P/THIRD_PARTY_NOTICES.md" || bad "THIRD_PARTY_NOTICES.md differs between the repo root and $P"

# 7
grep -n -E '\$([0-9]|ARGUMENTS)' "$P"/skills/*/SKILL.md >/dev/null 2>&1 && bad "a SKILL.md contains \$N or \$ARGUMENTS: $(grep -n -E '\$([0-9]|ARGUMENTS)' "$P"/skills/*/SKILL.md | head -3 | cut -c1-120)"

# 8
node -e '
const t = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const bad = t.filter(x => x.inputSchema.properties.filename || !(x.inputSchema.required || []).includes("session_id"));
if (bad.length) { console.error("page-tools.json: " + bad.map(x => x.name).join(", ")); process.exit(1); }
const hidden = ["browser_close", "browser_run_code_unsafe", "browser_drop", "browser_storage_state", "browser_pdf_save"].filter(n => t.some(x => x.name === n));
if (hidden.length) { console.error("page-tools.json exposes hidden tools: " + hidden.join(", ")); process.exit(1); }
' "$P/server/dist/page-tools.json" || bad "page-tools.json check failed"

# 9 Codex: manifest, marketplace, MCP file and hooks file
node -e '
const fs = require("fs"), path = require("path"); const P = process.argv[1]; const errs = [];
const read = f => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { errs.push(`${f}: ${e.message}`); return {}; } };
const c = read(`${P}/.codex-plugin/plugin.json`), cl = read(`${P}/.claude-plugin/plugin.json`), m = read(".agents/plugins/marketplace.json");
for (const k of ["name", "version", "description", "interface", "skills", "mcpServers", "hooks"]) if (!c[k]) errs.push(`codex plugin.json lacks ${k}`);
if (c.version !== cl.version) errs.push(`codex version ${c.version} != claude version ${cl.version}`);
for (const k of ["skills", "mcpServers", "hooks"]) if (c[k] && (!String(c[k]).startsWith("./") || !fs.existsSync(path.join(P, c[k])))) errs.push(`codex ${k} path missing or not ./: ${c[k]}`);
const e = (m.plugins || []).find(x => x.name === "cf-browser");
if (!e) errs.push("codex marketplace has no cf-browser entry");
else { if (!e.category || !e.policy?.installation || !e.policy?.authentication) errs.push("codex marketplace entry lacks category/policy"); if (path.normalize(e.source?.path || "") !== path.normalize(P)) errs.push(`codex marketplace path ${e.source?.path} != ${P}`); }
const mcp = read(path.join(P, c.mcpServers || ".codex-mcp.json")).mcpServers || {};
if (!mcp.cf_browser) errs.push("codex MCP file has no cf_browser server");
const hooks = JSON.stringify(read(path.join(P, c.hooks || "hooks/codex-hooks.json")));
for (const h of hooks.match(/\/hooks\/[a-z-]+\.mjs/g) || []) if (!fs.existsSync(path.join(P, h))) errs.push(`codex hook script missing: ${h}`);
if (errs.length) { console.error(errs.join("\n")); process.exit(1); }
' "$P" || bad "Codex packaging check failed"

[ $fail = 0 ] && echo "validate: OK"
exit $fail
