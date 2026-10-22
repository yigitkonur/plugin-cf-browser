# decisions

## Owner decisions (2026-10-22)
| Topic | Decision |
|---|---|
| Repo / name | `yigitkonur/plugin-cf-browser`, marketplace `plugin-cf-browser`, plugin `cf-browser` |
| MCP shipping | Inside the plugin. No npm package. Users need Node with npm |
| Scope | Browser only, every Browser Run feature including beta and lab ones. Cloudflare Sandbox is a later phase |
| Logins | No password-manager integration (Browser Run has none). The human logs in through a Live View handoff; the agent never types passwords |
| Saved logins | A persistent everyday profile (`main`) loaded and saved by default; a clone path when two browsers want it; separate profiles for other accounts; the skills ask the user at the right moments |

## Why our own MCP server
| Option | Gap |
|---|---|
| Cloudflare's hosted `browser.mcp.cloudflare.com/mcp` (OAuth; page reads, crawl, list/kill sessions) | Cannot create a session, interact, open Live View, hand off, record, or keep profiles |
| `chrome-devtools-mcp --wsEndpoint=…?keep_alive=… --wsHeaders='{"Authorization":"Bearer …"}'` (the docs' recommendation) | One session fixed at startup and the token in plain process args. No close, budget, Live View, handoff or profiles |
| `@cloudflare/playwright-mcp` (deploy-your-own Worker) | Every user deploys a Worker; no lifecycle control |

## Architecture
- **One local stdio server per Claude Code window owns every browser it opens.** It is the only thing that creates browsers, so it can close idle ones, enforce an age cap, close everything on exit and sweep a crashed run's leftovers on the next start. Cloudflare's `keep_alive` (idle + 60 s) is the backstop if the process dies.
- **No SessionEnd hook.** It fires on `/clear` while the server keeps running, so it would close browsers the user still uses. The stop hook only informs the user (a blocking Stop hook shows as "Stop hook error occurred").
- **Page tools come from `@playwright/mcp`, embedded once per browser** (`createConnection(config, () => context)` over the MCP SDK's `InMemoryTransport`) and re-exposed with a required `session_id`. It gives a proven snapshot/ref engine without reimplementing it.
- **Hidden page tools:** `browser_close` (use `session_close`), `browser_run_code_unsafe` (Node code on the user's machine), storage/cookie/localStorage tools (profiles are ours), tracing/video/PDF-save, `browser_drop`, network routing and offline tools, test/verify/annotate tools. **Every `filename` argument is removed** at build time so a prompt-injected page cannot get the agent to write files.
- **Uploads** pass our guard first (project or temp folder, no dotfiles, not the profiles/data folders), then are copied into the browser's output folder, the only place the embedded server reads uploads from; `allowUnrestrictedFileAccess` stays off.
- **Profiles live outside `CLAUDE_PLUGIN_DATA`** (`~/.cf-browser`), because Claude Code deletes the plugin data folder on uninstall and logins must survive reinstalls.
- **The MCP SDK is bundled into `dist/server.mjs`; `playwright-core` and `@playwright/mcp` are installed at first start** (playwright-core is not esbuild-safe). The server answers `tools/list` immediately from a generated `page-tools.json`; only tools that need the driver say "installing". (The plan gated every tool except two; gating only the driver-dependent ones is strictly more useful.)
- **The install runs `npm ci --omit=dev --ignore-scripts`** into a temp folder renamed atomically; no lock files; the API token is stripped from its environment.
- **A local usage ledger** (UTC days) backs the daily budget, because Browser Run has no usage API. No dollar estimate: one machine cannot see the account.

## Changes made after live testing (see verified-facts.md)
- `webmcp_call` added: in `@playwright/mcp` 0.0.83 page WebMCP tools are dynamic MCP tools named `webmcp_<name>`; the tool maps the plain name the snapshot shows.
- Handoff heartbeat kept: an active handoff does not keep a session alive by itself (CF10).
- `replay.html` loads rrweb-player from unpkg, not jsDelivr: jsDelivr serves the UMD build as `application/node` with `nosniff` (CF19).
- A guardrails 403 on `browser_navigate` gets an explicit note, so the agent does not mistake its own allowlist for the site blocking it.
