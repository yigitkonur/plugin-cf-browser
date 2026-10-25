# Maintainer notes (plugin-cf-browser)

Claude Code and Codex plugin `cf-browser` (marketplace `plugin-cf-browser`, plugin folder `plugins/cf-browser`): Cloudflare Browser Run browsers through an MCP server, hooks and six skills. The Codex side is `.codex-plugin/plugin.json`, `.codex-mcp.json` and `hooks/codex-hooks.json`; the server, skills and hook scripts are shared.

- Read `DECISIONS.md` and `verified-facts.md` before changing behavior; every claim in the README was run live against a real account.
- The server reads its own version from the plugin manifest at runtime (`readVersion()` in `plugins/cf-browser/server/src/index.ts`); never put a version constant in code. `scripts/validate.sh` fails when that changes.
- `plugins/cf-browser/server/dist/` is built output and is committed; run `npm run build` in `plugins/cf-browser/server` and commit it with the source (CI fails on a stale `dist/`).
- Never put a Cloudflare account id or API token in this repo, a test, or a command line. `scripts/secret-scan.sh --staged` (this repo's lab-aware scan) and `scripts/kit/secret-scan.py` both run before pushing.
- Local checks: `scripts/validate.sh`, `scripts/hook-smoke.sh`.

<!-- kit:agents:start -->
## Releases, versions and installs (shared by every plugin repo)

- **Never bump a version by hand.** `.github/workflows/release.yml` runs after `ci` is green on `main`. `scripts/kit/release.py` reads the conventional-commit subjects since the last release tag (`feat` is a minor, `fix`/`perf`/unprefixed a patch, `type!:` or a BREAKING CHANGE line a major, a minor while the version is 0.x; docs, ci, chore, test, style, build and refactor release nothing) and counts only commits that touch shipped files. It writes every manifest, the marketplace entries and CHANGELOG.md, commits `chore(release): vX [skip ci]`, tags `vX` and `<plugin>--vX` (several plugins: `<plugin>--vX` only) and publishes the GitHub release. `python3 scripts/kit/release.py` with no flags prints what it would do; Actions > release > Run workflow forces a level or a dry run.
- **One version source: the manifests** (`.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, the marketplace entry). Never a constant in code; read the manifest at runtime.
- Installed copies update only when the version string changes, so a change users should get must reach `main` as a releasing commit type (`feat`, `fix`, `perf`, or `!`).
- **Install policy:** installed globally and off (`"defaultEnabled": false`), switched on per project with `plugin on <name>`. Never document a project-scope install as the way in.
- `scripts/kit/*`, `scripts/kit.sha256`, `.github/workflows/release.yml`, the `kit:manifests` job in `ci.yml` and the blocks between `kit:` markers in README.md and AGENTS.md are copies from [yigitkonur/plugin-kit](https://github.com/yigitkonur/plugin-kit). Change them there and run its `sync.sh`; `scripts/kit/check-manifests.py` fails CI on a local edit.
- Before pushing: `python3 scripts/kit/check-manifests.py --validate`, `python3 scripts/kit/secret-scan.py --tree`, `python3 scripts/kit/check-links.py`, then this repo's own checks.
<!-- kit:agents:end -->
