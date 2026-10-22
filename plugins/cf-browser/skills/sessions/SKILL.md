---
name: sessions
description: >-
  Show and clean up Cloudflare Browser Run browsers and usage: which cf-browser browsers are open in this window, which other sessions are live in the Cloudflare account, how many browser-minutes were used today and this month against the daily budget, and close the ones the user no longer needs. Use when the user asks what browsers are running, what the cloud browser costs, or to close or clean up browsers.
---

# /cf-browser:sessions

Goal: the user sees what is open and what it costs, and only browsers they agree to are closed.

## Steps
1. `session_list` with `account_wide: true`, and `usage_report`.
2. Show:
   - This window's browsers: label, profile and mode, age, idle, "closes itself in", recording, handoff.
   - Other live sessions in the account (marked "not created by this window"): id and start time. They may belong to another Claude Code window, another person or another app on the same Cloudflare account.
   - Usage today (UTC) and this month from this machine's ledger: session minutes, Quick Action minutes, crawl minutes, Kitesurf minutes (free during its beta), and the daily budget left. Say that the Cloudflare dashboard (Browser Run) is the account-wide number.
3. Offer to close this window's idle browsers (AskUserQuestion when there are several). `session_close` saves write-mode profiles; use `save_profile: false` for a browser that ended up signed out.
4. Other sessions: close one only when the user typed its id and asked to close it: `session_close` with `foreign: true`. Never close them in bulk or on your own judgment.

## Cost in one paragraph (when the user asks)
Browser Run bills browser time while a browser is open, idle time included, plus concurrency above 10 browsers (monthly average of daily peaks) on the Paid plan; the Free plan allows 10 browser-minutes a day. The plugin closes idle browsers after `idle_timeout_seconds`, at `max_session_minutes`, and when Claude Code exits, and a crashed run's leftovers on the next start. Details and the pricing formula: `../browse/references/cost.md`.
