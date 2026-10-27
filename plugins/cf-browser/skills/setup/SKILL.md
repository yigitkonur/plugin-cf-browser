---
name: setup
description: Diagnose and configure Cloudflare Browser Run credentials, runtime installation and shared-manager readiness for any supported local MCP host.
---

# Set up cf-browser

1. Call `doctor`, including when credentials are missing. Read the separate credentials-source, API-access, driver, profile and manager results. A local task list alone does not establish Cloudflare access.
2. If `CF_ACCOUNT_ID` and `CF_API_TOKEN` are already available, use them. Environment values take precedence over `~/.cf-browser/.env` (or the configured `CFB_HOME`). Claude Code's existing plugin configuration remains supported. Avoid asking the user to enter credentials again when doctor reports a working source.
3. If missing, have the user supply an account id and API token with Browser Run Write/Edit for that account through their host configuration or the credentials file. Values stay out of chat, source files, screenshots and shell command arguments. The file uses ordinary `KEY=VALUE` lines and mode `600`.
4. Reconnect the MCP server after changing its environment/configuration. If the driver is installing, wait and retry doctor. The launcher installs the pinned JavaScript driver; production browsing runs remotely and does not install or launch local Chromium.
5. With API and driver ready, call `task_start`, navigate to a public page, inspect its observation, and open interactive Live View if requested. Finish the test task and check closure. Completion: real page work succeeds, not merely tool listing.

Use the configured default profile and lifecycle defaults. Plan, budget, timeout and profile-model questionnaires are unnecessary for initial setup. Legacy budget/age/concurrency settings are ignored by the new manager. If an older manager or profile writer is still active, let its tasks and human control finish before reconnecting the updated plugin.
