# changelog

## 1.2.1 - 2026-10-27

- fix: preserve filtered observation continuation (0ab16f1)

## 1.2.0 - 2026-10-27

- feat: share persistent browser tasks across local agents (325637a)

## 1.1.2 - 2026-10-25

- fix: install off by default; shared plugin-kit CI, release and install docs (a91b01b)

## 1.1.1 - 2026-10-25

- fix: read the server version from the plugin manifest (#3) (ba59ec1)

## cf-browser 1.1.0 (2026-10-22)

- Codex plugin from the same repo: `.agents/plugins/marketplace.json`, `.codex-plugin/plugin.json`, MCP server `cf_browser` (`.codex-mcp.json`) and Codex hooks (`hooks/codex-hooks.json`).
- Credentials and settings from `~/.cf-browser/.env` (or `$CFB_HOME/.env`) when the host does not set them; the guard hook protects that file too.
- A detached watchdog closes a server's browsers within seconds when the host kills the server without letting it shut down (Codex does at exit).
- The upload guard never treats the plugin folder as the project; without a project folder from the host, uploads take files from the temp folder.
- Texts and skills name both hosts.

## cf-browser 1.0.0 (2026-10-22)

First release.

- Local MCP server for Cloudflare Browser Run: `session_create/list/close`, 28 page tools from `@playwright/mcp` with a required `session_id`, `live_view_open`, `human_handoff` / `human_wait`, `profile_*`, `page_read` / `page_scrape` / `page_extract` (Quick Actions, Kitesurf first), `crawl_*`, `recording_fetch`, `usage_report`, `webmcp_call`.
- Lifecycle: idle close, max age (deferred during a handoff), close on exit, startup sweep of a crashed run's browsers, handoff heartbeat, `keep_alive` backstop.
- Profiles: everyday profile with autosave, one-writer lock with stale takeover, clone / read-only / separate profiles, one backup per browser and `profile_restore_previous`, cookies for Quick Actions.
- Limits: per-window browser cap, daily minute budget with a confirm path, one 429 retry at most.
- Hooks: primer, non-blocking stop notice, guard for the profiles folder and the API token.
- Skills: browse, login, profiles, sessions, replay, setup.
- Review fixes before release: the profile lock stays fresh during long handoffs, handoffs go to the tab the agent is on, parallel creates respect the browser cap, page tools queued behind a handoff are refused, the budget counts other windows' open browsers, stale-lock takeover is serialized, a running tool call is never idle-closed.
