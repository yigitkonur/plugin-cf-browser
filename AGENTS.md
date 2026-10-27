# Maintainer notes (plugin-cf-browser)

Local stdio MCP entries for Codex and Claude Code share one account-scoped manager. `server/src/manager.ts` owns tasks/tabs/profiles; `backend.ts` is the Cloudflare/CDP seam; `dispatch.ts` separates ordinary and advanced tools. See [architecture](docs/architecture.md) for state transitions and failure handling before changing lifecycle behavior.

- Read `DECISIONS.md` and [acceptance](docs/acceptance.md). `verified-facts.md` is historical evidence for the old architecture, not current acceptance.
- Keep the browse skill the authoritative agent workflow. Other skills and the primer point to it; branch-specific instructions live in its references. Use [agent evaluation](docs/agent-evaluation.md) to test steering changes, including false-completion and wrong-tab cases.
- Test ownership, persistence, cancellation and cleanup at their real interfaces. Unit/contract tests alone are not evidence of an actual host-agent run; record verification levels separately.
- Version comes from `readVersion()` in `server/src/index.ts`; preserve plugin identities and the release process below.
- `server/dist/` is committed. Run typecheck, tests and build in `plugins/cf-browser/server`; CI rejects stale output.
- Never put account ids or tokens in source, fixtures, command arguments or logs. Live tests use an isolated profile, synthetic state and exact-session cleanup. The user's saved profile is not a fixture.
- Before pushing run `scripts/validate.sh`, `scripts/hook-smoke.sh`, `scripts/secret-scan.sh --staged` and the kit checks below.

<!-- kit:agents:start -->
## Releases, versions and installs (shared by every plugin repo)

- **Never bump a version by hand.** `.github/workflows/release.yml` runs after `ci` is green on `main`. `scripts/kit/release.py` reads the conventional-commit subjects since the last release tag (`feat` is a minor, `fix`/`perf`/unprefixed a patch, `type!:` or a BREAKING CHANGE line a major, a minor while the version is 0.x; docs, ci, chore, test, style, build and refactor release nothing) and counts only commits that touch shipped files. It writes every manifest, the marketplace entries and CHANGELOG.md, commits `chore(release): vX [skip ci]`, tags `vX` and `<plugin>--vX` (several plugins: `<plugin>--vX` only) and publishes the GitHub release. `python3 scripts/kit/release.py` with no flags prints what it would do; Actions > release > Run workflow forces a level or a dry run.
- **One version source: the manifests** (`.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, the marketplace entry). Never a constant in code; read the manifest at runtime.
- Installed copies update only when the version string changes, so a change users should get must reach `main` as a releasing commit type (`feat`, `fix`, `perf`, or `!`).
- **Install policy:** installed globally and off (`"defaultEnabled": false`), switched on per project with `plugin on <name>`. Never document a project-scope install as the way in.
- `scripts/kit/*`, `scripts/kit.sha256`, `.github/workflows/release.yml`, the `kit:manifests` job in `ci.yml` and the blocks between `kit:` markers in README.md and AGENTS.md are copies from [yigitkonur/plugin-kit](https://github.com/yigitkonur/plugin-kit). Change them there and run its `sync.sh`; `scripts/kit/check-manifests.py` fails CI on a local edit.
- Before pushing: `python3 scripts/kit/check-manifests.py --validate`, `python3 scripts/kit/secret-scan.py --tree`, `python3 scripts/kit/check-links.py`, then this repo's own checks.
<!-- kit:agents:end -->
