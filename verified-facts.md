# verified facts

Every behavior this plugin depends on, checked against the live Cloudflare Browser Run API or a live Claude Code run. "CF" rows are Phase 0 spikes (small Node scripts with the pinned packages); "L" rows are the plugin's own ledger. Dates are UTC. Account ids, tokens, session ids and URLs are left out on purpose.

Environment: Node 26.5, Claude Code 2.1.307, `@playwright/mcp` 0.0.83 with `playwright-core` 1.64.0-alpha-1790635538000, `@modelcontextprotocol/sdk` 1.32.1, a Workers Paid account and a Workers Free account.

## Cloudflare Browser Run (2026-10-22)

| # | Claim | How it was checked | Result |
|---|---|---|---|
| CF1 | Both API prefixes answer | `GET …/browser-run/devtools/session` and `…/browser-rendering/devtools/session` | both 200 `[]` |
| CF2 | The token permission is called "Browser Run Write" in the token API | `GET /user/tokens/permission_groups` | groups "Browser Run Read" and "Browser Run Write" |
| CF3 | Account-owned tokens (`cfat_…`) work for Browser Run but fail `/user/tokens/verify` | verify both endpoints, then list sessions | `/user/tokens/verify` → "Invalid API Token"; `/accounts/<id>/tokens/verify` → active; Browser Run calls 200 |
| CF4 | `GET /devtools/session` returns a bare array; closed sessions are not listed | list before/after `DELETE` | `[]`; `GET /devtools/session/<id>` after close → `{"error":"Session not found"}` |
| CF5 | `POST /devtools/browser` returns `{sessionId, webSocketDebuggerUrl}` without the `{success,result}` envelope | REST create | as stated |
| CF6 | `recording=true` and `lab=true` work on the REST create | create with both, close, fetch recording; compare `/json/protocol` with a non-lab session | recording 200; `WebMCP` CDP domain present only on the lab session |
| CF7 | Guardrails in the REST create body apply | `{"guardrails":{"allowedDomains":["example.com"]}}`, then navigate elsewhere | 403, `cf-mitigated: guardrails` |
| CF8 | `keep_alive` accepts 10000–1200000 ms | create with 1200000, 1200001, 600000, 5000 | 200, 400 "<=1200000", 200, 400 ">=10000" |
| CF9 | Idle close happens at about `keep_alive` with no commands | four sessions at `keep_alive=60000`, polled every 10 s | no client: gone at ~63 s; connected but silent: ~73 s |
| CF10 | An active human handoff does **not** keep a session alive | `Cloudflare.handoff` then no commands | gone at ~63 s, like an idle session |
| CF11 | An open Live View viewer **does** keep a session alive | tab-mode Live View opened in a real browser, no commands | alive until ~167 s |
| CF12 | Live View, handoff and recording work on a page from `browser.newContext()` | REST `live_view` with our `targetId` (tab, readonly); `Cloudflare.getLiveView`; `Cloudflare.handoff`; recording keyed by our `targetId` | all 200; viewer showed our page |
| CF13 | Closing the default `about:blank` page keeps the session | close it, then `/json/list` | 1 target left (ours); still connected |
| CF14 | `Cloudflare` CDP domain shape | `/json/protocol` | commands `getSessionId`, `getLiveView(targetId?,mode?,expiresInMs?,guardrails?)`, `handoff(targetId,instructions?,timeout?)`, `handoffComplete`, `getHandoffState(targetId)`; no events declared |
| CF15 | Recording is ready right after `DELETE` | `GET /recording/<id>` immediately | 200 `{success,result:{sessionId,duration,events:{<targetId>:[rrweb…]}}}`; `/network?target=<targetId>&format=har` 200 |
| CF16 | Quick Actions return `{success,result}` plus `X-Browser-Ms-Used`, also on Kitesurf | `/markdown`, `/links`, `/content` with `?browser=kitesurf`; `/scrape`, `/accessibilityTree`, `/screenshot` | as stated; `/screenshot` is a 1920×1080 PNG |
| CF17 | Quick Action `cookies[]` accepts Playwright-style fields with `sameSite:"Lax"` | `/markdown` with one cookie | 200 |
| CF18 | `@playwright/mcp` 0.0.83 embeds over the MCP SDK `InMemoryTransport` and drives a Browser Run page | `createConnection(config, () => context)` | 35 tools; navigate, snapshot, screenshot work; `browser_click` takes `target`; action tools save the snapshot to a file and link it, `browser_snapshot` returns it inline |
| CF19 | jsDelivr serves the rrweb-player UMD build as `application/node` with `nosniff`; unpkg serves `text/javascript` | `curl -I` both | so `replay.html` loads from unpkg with SRI |

## Plugin behavior (live ledger, 2026-10-22)

Server driven over stdio with `mcpc` 0.7.0 against the Workers Paid account; the human side (Live View, handoff, logging in) done by a tester in a real browser. Test site: `the-internet.herokuapp.com` with its public demo login, typed by the tester, never by the agent. L4 and L16 run inside Claude Code after installing from GitHub.

| # | Behavior | Expect | Saw |
|---|---|---|---|
| L1 | Fresh start | `tools/list` at once; a page tool says installing; then `session_list` → `[]` | 49 tools at 0 s; `INSTALLING: cf-browser is installing its browser driver…`; after the install `session_list` → `[]` |
| L2 | Read a page and close | Hacker News top 5 titles + screenshot; nothing left at Cloudflare | 5 titles, PNG screenshot; `session_close` → closed; `GET /devtools/session` → `[]` |
| L3 | Idle and crash | reaper closes at the idle timeout; after `kill -9` the next start sweeps | `closed: idle for 60s`; after `kill -9`, the next start logged `swept 1 browser(s) left by a crashed run` and Cloudflare listed `[]` |
| L4 | Exit and `/clear` | exit closes browsers; `/clear` does not | see below |
| L5 | Limits | third browser refused; budget refused with the confirm path | `TOO_MANY_SESSIONS` listing the two open; `BUDGET_EXCEEDED` with numbers; `confirm_over_budget: true` opened one |
| L6 | Live View | read-only ignores typing; interactive takes it | read-only: field stayed empty; interactive: field read `12345`; `opened_locally: true` |
| L7 | Login handoff | handoff opens; page tools refused meanwhile; Done → saved; agent sees Logout | `HANDOFF_ACTIVE` on a page tool; `human_wait` pending, then `done: User clicked 'Done'`, profile `main` saved (4 cookies); snapshot on `/secure` shows "Logout" |
| L8 | Everyday profile and clone | new browser loads `main`; second write open refused; clone works in parallel | `/secure` without logging in; `PROFILE_IN_USE` with the three choices; `main` and `main-2` both on `/secure` |
| L9 | Read-only and restore | read-only logout keeps `main`; restore after a bad save | `main` still signed in after the read-only logout; after a signed-out save, `profile_restore_previous` → signed in again |
| L10 | Quick Actions | Kitesurf for public markdown; profile cookies work; ledger entries | `engine: kitesurf`; `page_read` of `/secure` with `profile: main` shows "Secure Area"; `quick` entries with `browser_ms` |
| L11 | Recording | fetch after close; replay plays | `STILL_OPEN` before close; after close `events.json`, `network-<tab>.har`, `replay.html`; replay renders the recorded page |
| L12 | Guardrails | off-list navigation reported as blocked | `start_url` off-list → blocked by guardrails; `browser_navigate` off-list → 403 plus the guardrails note |
| L13 | Crawl | limit 5 completes, results written | `completed`, 5 records in `out/crawls/<job>.jsonl`; one `crawl` ledger entry |
| L14 | WebMCP | lab browser lists and runs page tools | demo page registered 3 tools; `webmcp_call search_location {"location":"Paris"}` navigated to the Paris results |
| L15 | Guards | profiles folder and token denied; `~/.ssh` upload denied; primer present | `scripts/hook-smoke.sh` 9/9 ok; `browser_file_upload` of `~/.ssh/id_ed25519` → `UPLOAD_DENIED`; a project file uploaded |
| L16 | Install from GitHub | `plugin details` shows 6 skills, 3 hooks, 1 MCP server; L1/L2/L7/L8 on the installed copy | see below |
