# changelog

## cf-browser 1.0.0 (2026-10-22)

First release.

- Local MCP server for Cloudflare Browser Run: `session_create/list/close`, 28 page tools from `@playwright/mcp` with a required `session_id`, `live_view_open`, `human_handoff` / `human_wait`, `profile_*`, `page_read` / `page_scrape` / `page_extract` (Quick Actions, Kitesurf first), `crawl_*`, `recording_fetch`, `usage_report`, `webmcp_call`.
- Lifecycle: idle close, max age (deferred during a handoff), close on exit, startup sweep of a crashed run's browsers, handoff heartbeat, `keep_alive` backstop.
- Profiles: everyday profile with autosave, one-writer lock with stale takeover, clone / read-only / separate profiles, one backup per browser and `profile_restore_previous`, cookies for Quick Actions.
- Limits: per-window browser cap, daily minute budget with a confirm path, one 429 retry at most.
- Hooks: primer, non-blocking stop notice, guard for the profiles folder and the API token.
- Skills: browse, login, profiles, sessions, replay, setup.
