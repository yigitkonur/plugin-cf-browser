#!/usr/bin/env bash
# sync-version.sh <X.Y.Z> -- set the cf-browser version in both plugin manifests (Claude Code, Codex), the marketplace entry and metadata, and the server.
set -eu
cd "$(git rev-parse --show-toplevel)"
[ $# -eq 1 ] || { echo "usage: $0 <X.Y.Z>" >&2; exit 2; }
V="$1"; P=plugins/cf-browser
node -e '
const fs = require("fs"); const v = process.argv[1];
const pj = "plugins/cf-browser/.claude-plugin/plugin.json", mj = ".claude-plugin/marketplace.json";
const p = JSON.parse(fs.readFileSync(pj)); p.version = v; fs.writeFileSync(pj, JSON.stringify(p, null, 2) + "\n");
const cj = "plugins/cf-browser/.codex-plugin/plugin.json";
const c = JSON.parse(fs.readFileSync(cj)); c.version = v; fs.writeFileSync(cj, JSON.stringify(c, null, 2) + "\n");
const m = JSON.parse(fs.readFileSync(mj)); m.metadata.version = v; m.plugins.find(x => x.name === "cf-browser").version = v; fs.writeFileSync(mj, JSON.stringify(m, null, 2) + "\n");
' "$V"
sed -i.bak "s/export const VERSION = '[^']*'/export const VERSION = '$V'/" "$P/server/src/index.ts" && rm -f "$P/server/src/index.ts.bak"
(cd "$P/server" && npm run build --silent)
echo "cf-browser set to $V (rebuilt dist/)"
