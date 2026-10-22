# Driving a cf-browser browser

## Our tools
| Tool | What it does |
|---|---|
| `session_create` | Opens a Browser Run browser on a profile (default: the everyday profile, write mode). Options: `profile`, `profile_mode` (`write`/`read`/`none`), `allowed_domains`, `record`, `lab`, `start_url`, `label`, `idle_timeout_s` |
| `session_list` | This window's browsers (open, and closed in the last hour with their close reason); `account_wide` adds other live sessions in the account |
| `session_close` | Saves a write-mode profile (unless `save_profile:false`) and ends the browser |
| `live_view_open` | Opens a Live View on the user's screen: read-only tab by default; `interactive`, `mode: full/devtools`, `tab_index` |
| `human_handoff` / `human_wait` | Hands the browser to the user with instructions; long-polls the outcome (`pending`/`done`/`failed`/`timeout`/`ended`) |
| `profile_list` / `profile_create` / `profile_clone` / `profile_delete` / `profile_save` / `profile_restore_previous` | Saved logins (metadata only) |
| `page_read` / `page_scrape` / `page_extract` | Quick Actions: one page, no session |
| `crawl_start` / `crawl_status` / `crawl_cancel` | Async site crawl; results go to a JSONL file |
| `recording_fetch` | Recording of a closed `record:true` browser: events, HAR, `replay.html` |
| `usage_report` | Browser-minutes today/this month on this machine, budget left |
| `webmcp_call` | Calls a WebMCP tool the page registered (lab browsers) |

## Page tools (`browser_*`, every call takes `session_id`)
Navigation: `browser_navigate`, `browser_navigate_back`, `browser_tabs` (list, new, select, close tabs).
Reading: `browser_snapshot` (accessibility tree with element refs), `browser_find` (search the snapshot for text or a regex), `browser_take_screenshot`, `browser_console_messages`, `browser_network_requests` / `browser_network_request`, `browser_evaluate`.
Acting: `browser_click`, `browser_type`, `browser_fill_form`, `browser_select_option`, `browser_hover`, `browser_drag`, `browser_press_key`, `browser_handle_dialog`, `browser_file_upload`, `browser_wait_for`, `browser_resize`, `browser_emulate_media`, and the coordinate tools `browser_mouse_*` for canvas-like pages.

Refs: element arguments take `target`, the `ref` from the latest snapshot (e.g. `e12`). Refs change when the page changes. After an action the result says the page URL and links a snapshot file; call `browser_snapshot` before the next ref-based action (or read the linked file). `browser_find` is cheaper than a full snapshot when you look for one thing.

## Keep context small
- Prefer `browser_find` or a focused `browser_evaluate` returning a few fields over full snapshots of huge pages.
- Screenshots cost many tokens; take them when the user wants to see something or the DOM is not enough.
- `page_read` caps text at `max_chars` (default 20000) and writes the full text to a file; crawls and recordings always go to files.

## Not available on purpose
`browser_close` (use `session_close`), `browser_run_code_unsafe` (would run Node code on the user's machine), storage and cookie tools (profiles are managed by cf-browser), tracing/video/PDF-save tools and every `filename` argument (pages could otherwise talk the agent into writing files), `browser_drop`. Uploads accept only files inside the project folder or the system temp folder, never dotfiles.

## Errors and what to do
| Code | Do |
|---|---|
| `INSTALLING` | First start: the browser driver is installing. Retry in ~20 s |
| `SESSION_CLOSED` | The browser closed (idle, max age, eviction). `session_create` a new one; write-mode logins were saved |
| `SESSION_NOT_FOUND` | Wrong id: `session_list` |
| `HANDOFF_ACTIVE` | The user is in the browser: `human_wait` |
| `PROFILE_IN_USE` | Ask the user: clone / read-only / wait (the error lists them) |
| `TOO_MANY_SESSIONS` | Reuse an open browser or close one |
| `BUDGET_EXCEEDED` | Ask the user before `confirm_over_budget: true` |
| `RATE_LIMITED` | Wait the given time, retry once; never loop |
| `AUTH` | Token or account id problem: `/cf-browser:setup` |
| `UPLOAD_DENIED` | The file is outside the project/temp folder or is a dotfile; ask the user |
