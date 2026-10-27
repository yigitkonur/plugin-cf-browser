# plugin-cf-browser

A shared remote browser for agents and the person working with them. Cloudflare Browser Run does the browser work; the local plugin coordinates tasks, tabs, saved logins and interactive control.

- **One everyday profile.** Codex and Claude Code on the same machine share its live login state while working in separate owned tabs.
- **Observed small steps.** Actions return fresh semantic observations. Screenshots are native MCP images for visual work, not a discouraged fallback.
- **Direct human control.** A small local panel lists tabs and owners. Use a tab, sign in through Live View, then give it back. Independent tabs keep working.
- **Lifecycle instead of artificial budgets.** The last task/user closes the remote browser after checkpointing. Failed closes remain queued for reconciliation. No plugin daily-minute or maximum-age cutoff.
- **A compact normal workflow.** Crawl, Quick Actions, replay, scripts, WebMCP and profile administration remain available through advanced discovery.

This revision's evidence and limits are tracked in [acceptance.md](docs/acceptance.md). Earlier live results in [verified-facts.md](verified-facts.md) describe the old architecture and are not blanket certification of this revision.

<!-- kit:install:start -->
## install

Every plugin of ours is installed **once, globally, and off**, then **turned on per project**. Nothing runs and no tokens are spent in chats that don't switch it on. It works the same in Claude Code and Codex.

### 1. install it globally

**Claude Code**

```sh
claude plugin marketplace add yigitkonur/plugin-cf-browser
claude plugin install cf-browser@plugin-cf-browser -s user          # stays off: defaultEnabled is false in the manifest
```

**Codex** (0.163+)

```sh
codex plugin marketplace add yigitkonur/plugin-cf-browser
codex plugin add cf-browser@plugin-cf-browser
codex-plugin-project.sh global-off cf-browser@plugin-cf-browser     # Codex has no enable/disable command; this keeps it off everywhere
```

All our plugins, both hosts, plus the `plugin` command and the 6-hourly update job, in one line:

```sh
curl -fsSL https://raw.githubusercontent.com/yigitkonur/plugin-kit/main/install.sh | sh -s -- --all
```

### 2. turn it on in a project

```sh
cd your-project
plugin on cf-browser    # Claude Code and Codex, this folder only
plugin off cf-browser   # undo
plugin                  # or pick from a list (TUI)
```

By hand, without the `plugin` command:

```sh
claude plugin enable cf-browser@plugin-cf-browser --scope project      # undo: claude plugin disable cf-browser@plugin-cf-browser --scope project
codex-plugin-project.sh on cf-browser@plugin-cf-browser . --trust      # undo: codex-plugin-project.sh off cf-browser@plugin-cf-browser
```

Restart `claude` / `codex` in that folder afterwards.
Codex reads a folder's `.codex/config.toml` only when the folder is trusted; `--trust` adds that, and it also enables the folder's hooks and rules, so use it for your own projects only. `plugin` and `codex-plugin-project.sh` come from [plugin-kit](https://github.com/yigitkonur/plugin-kit) (the one-line installer above).

### 3. updates

A plugin updates only when its `version` changes, and this repo's `release` workflow bumps it on every shipped change. Machines pick it up with `plugin update`, or by themselves with the 6-hourly job (`plugin autoupdate install`). By hand:

```sh
claude plugin marketplace update plugin-cf-browser && claude plugin update cf-browser@plugin-cf-browser
codex plugin marketplace upgrade plugin-cf-browser        # then start a new session
```

No GitHub SSH key on the machine? `export CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1` (`plugin install` sets it in Claude's settings for you).

### 4. uninstall

```sh
claude plugin uninstall cf-browser@plugin-cf-browser -s user
claude plugin marketplace remove plugin-cf-browser
codex plugin remove cf-browser@plugin-cf-browser
codex plugin marketplace remove plugin-cf-browser
```
<!-- kit:install:end -->

## Start using it

Use existing `CF_ACCOUNT_ID` and `CF_API_TOKEN` environment variables. The token needs Browser Run Write/Edit for the account. The existing Claude Code plugin settings and `~/.cf-browser/.env` fallback still work; environment values take precedence. Keep credential values outside chat and source control. `CFB_HOME` can select a different private profile/runtime directory.

Run the setup skill or call `doctor`. It distinguishes missing credentials, API access, driver installation, manager readiness and profile metadata. There is no initial budget/profile questionnaire. Node 20.19+ and npm are required. The launcher installs the pinned JavaScript driver; production never launches a local Chromium.

An ordinary task looks like this:

```text
task_start → your task_id, tab_id and initial observation
act(navigate) → fresh observation
act(click/fill/…) → fresh observation and visible result
human(handoff) → user completes login → observe and verify
...finish the requested work...
task_finish → profile checkpoint and browser closure state
```

The six skills remain `browse`, `login`, `setup`, `profiles`, `sessions` and `replay`. The browse skill is the common workflow; the others reach it or its relevant reference. The ordinary MCP surface has twelve tools. Tool count is a design consequence, not a success metric.

## Work together

The first caller automatically starts one local manager for its OS user, account and `CFB_HOME`. Each host keeps its existing stdio plugin entry. The manager owns the browser profile and uses stable task/tab ids; there is no shared implicit “current tab.” A new tab opened in native Live View uses the same default Chrome context as agent tabs.

Open independent sources ahead of reading; let same-record mutations follow their dependencies. The plugin has no hard tab quota. A tab mutation is grounded in an observation; running operations have ids and do not block other tabs.

The local control panel is returned by `task_start` and `doctor`:

- **Use this tab / Open viewer** transfers that tab and opens Cloudflare's interactive viewer.
- **Login / switch account** pauses the shared identity while the human works.
- **Give back** invalidates old observations before the agent continues.
- **Close tab** handles human tabs whose original agent has ended.
- **Finish all tasks & close** explicitly finishes the whole browser.

A named viewer window is the reliable default; Show inline is available where the hosted viewer can be embedded. The panel does not infer human inactivity from cross-origin mouse events. Closing a viewer window is separate from giving back control. Human-owned tabs stay open across agent exits until released/closed.

## Persistence and recovery

The existing profile name (`main` by default), directory and state format are retained. Cookies, localStorage and IndexedDB are checkpointed atomically, with a previous valid version. This is not a full Chrome disk profile, password/passkey store, service-worker cache, sessionStorage or unsaved form guarantee. Websites can expire sessions themselves.

If IndexedDB capture fails, the good checkpoint is retained and the error is visible. Explicit task completion waits for a successful save; crash/idle cleanup preserves the last valid checkpoint and reports recovery state. Connection recovery first reattaches the known remote browser; no previous action is automatically repeated.

Long operations return an id instead of leaving the host silent. Cancellation closes only the affected target so delayed script continuations stop too; site effects already sent may remain. The next step is observation, not blind retry. A failed remote DELETE returns `close_unconfirmed`, remains journaled, and is retried. If a browser-create response is lost, the manager avoids duplicate creation during the unconnected session's keep_alive recovery window.

## Advanced services

Use `advanced action=discover` with `script`, `profiles`, `reads`, `crawl`, `replay`, `webmcp` or `diagnostics`. Discovery returns exact schemas. Browser scripts run JavaScript inside the existing remote page; ordinary actions supply Playwright's actionability checks. Instructions teach incremental script development without code/length policing hooks.

Recording and lab/WebMCP options are chosen before the shared browser starts. A task cannot change these options under another active task. Quick Actions and crawl are independent Cloudflare jobs; their saved-cookie support is not equivalent to the live shared browser context.

## Configuration and boundaries

| Setting | Default / meaning |
|---|---|
| `CF_ACCOUNT_ID`, `CF_API_TOKEN` | Environment, with existing host/file fallback |
| `CFB_DEFAULT_PROFILE` | `main`; ordinary tasks do not ask again |
| `CFB_HOME` | `~/.cf-browser`; profiles survive plugin reinstall |
| `CFB_IDLE_TIMEOUT_S` | 300; reaps genuinely idle agent tasks, excluding work in flight and human control |
| `CFB_OPEN_LIVE_VIEW` | true; opens the local control panel |

The old budget, concurrency and age settings are ignored. Cloudflare account/service quotas still apply. Local usage is optional through diagnostics. See [migration](docs/migration.md) before updating an active installation.

No per-submit approval ritual or profile-path shell guard is added. The user's request and host's authorization policy govern actions. Page content is untrusted data. Tokens are masked in diagnostics; profile/runtime files use private permissions; the control API requires a local bearer token and rejects cross-origin requests. A control-panel or Live View link grants access and should be shared only with the intended user.

The manager is local to one machine/account. Remote ChatGPT MCP, multi-user SaaS and alternative browser backends are outside this revision. The code is host-neutral stdio MCP; packaging is provided for Codex and Claude Code. macOS/Linux CI is required; Windows remains unverified.

## Development

```sh
cd plugins/cf-browser/server
npm ci --ignore-scripts
npm run typecheck
npm test
npm run build
```

Behavior tests use a disposable local test browser, never a personal profile. CI installs the pinned Chromium for these tests. Production only uses `connectOverCDP`. `CFB_TEST_BROWSER` can point to a test Chrome executable; `CFB_SKIP_BROWSER_TESTS=1` skips real-driver tests for restricted environments and must be disclosed in evidence.

`node scripts/live.mjs` is an explicit live acceptance run. It consumes normal Cloudflare credentials privately, creates only isolated synthetic test profiles, and closes its own remote browsers. It never reads the everyday profile. See [architecture](docs/architecture.md), [agent evaluation](docs/agent-evaluation.md) and [acceptance](docs/acceptance.md).

Run the repository checks documented in [AGENTS.md](AGENTS.md) before pushing. Committed `dist/` must match source. The plugin-kit release workflow owns versions; never bump them manually.

## License

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
