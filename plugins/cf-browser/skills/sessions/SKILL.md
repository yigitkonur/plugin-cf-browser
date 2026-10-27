---
name: sessions
description: Inspect browser tasks, human ownership and pending cleanup, or finish work in the shared Cloudflare browser.
---

# Inspect and finish browser work

Call `doctor` for manager/browser state and the control-panel address. Use `tabs action=list` with your task id for your own pages. A shared browser can be used by several tasks and the human at once.

Finish your work with `task_finish`; it releases your agent tabs and checkpoints their profile. Human-owned tabs remain open. The remote browser closes only after all tasks and human control end. Check the returned state; `close_unconfirmed` means cleanup is still being retried.

For a running operation, inspect or cancel it through `operation`. Cancellation closes its affected tab and leaves earlier site effects uncertain. For a user request to take control or finish everything, use the local panel: choose a tab, Give back, Close tab, or Finish all tasks & close.

See [recovery](../browse/references/recovery.md) for disconnections, old-version migration and failed saves. Usage is optional through `advanced topic=diagnostics`.
