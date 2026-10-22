# What Browser Run costs, and how cf-browser keeps it down

Prices from Cloudflare's Browser Run pricing and limits pages, 2026-10-22. Check the dashboard for your account.

## Billing
| | Workers Free | Workers Paid ($5/month) |
|---|---|---|
| Browser time | 10 minutes per day | 10 hours per month included, then **$0.09 per browser-hour** |
| Concurrent browsers | 3 | 10 included, then **$2 per browser** (monthly average of your daily peak) |
| New browsers | 1 every 20 s | higher; 429 with `Retry-After` when exceeded |
| Quick Actions (`page_read` etc.) | 1 every 10 s | billed as browser time (`X-Browser-Ms-Used` per call) |

- **Idle time is billed.** A browser that stays open costs browser time until it is closed or times out, even when nobody uses it.
- **An open Live View keeps a browser alive** (verified): the viewer counts as activity. Close the Live View tab when done.
- **Kitesurf** (the engine `page_read` uses for public text) is free during its beta.
- **`page_extract`** uses Workers AI on top of browser time.
- **Crawls** with `render: true` are browser time; `render: false` runs on Workers without a browser (much cheaper).
- **Recordings**: cost not stated by Cloudflare during the beta; kept 30 days.

Example: a 4-minute task in one browser = 4 browser-minutes. Twenty such tasks a day ≈ 80 min/day ≈ 40 h/month → (40 − 10) × $0.09 ≈ $2.70/month on Paid, plus nothing for concurrency while you stay at ≤ 10 browsers.

## What the plugin does about it
- Closes a browser after `idle_timeout_seconds` (default 300) of no tool calls, at `max_session_minutes` (default 30, not during a handoff), when the Claude Code or Codex session exits, and leftovers of a crashed run on the next start. Cloudflare's own `keep_alive` (idle + 60 s) is the backstop if everything else dies.
- Refuses new browsers past `max_concurrent_sessions` per window and past `daily_budget_minutes` (UTC day) unless the user confirms.
- `usage_report` shows this machine's minutes; the Cloudflare dashboard (Browser Run) is the account-wide truth — there is no usage API, so the plugin cannot see other machines.

## What you do about it
- `page_read` / `page_scrape` for anything a single request can answer.
- Reuse an open browser; close it when the task is done.
- One browser per task; parallel browsers only for different accounts.
