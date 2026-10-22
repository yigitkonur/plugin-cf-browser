---
name: setup
description: >-
  Set up and check the cf-browser plugin: Node version, Cloudflare account ID and API token with the Browser Run permission, plan and budget settings, the first-start driver install, and how saved logins should work. Use when the user installs cf-browser, sees "cf-browser is not configured", gets an auth error from Cloudflare, or asks how to configure the cloud browser.
---

# /cf-browser:setup

Goal: cf-browser answers `session_list` without errors, the user knows where logins are kept, and no token appears in the transcript.

## Rules
- Never ask the user to paste the API token into chat, and never echo it. In Claude Code they enter it in `/plugin` (stored in the OS keychain) or run the configure command in their own shell; in Codex they write it into `~/.cf-browser/.env` themselves. Never read or print that file.

## Steps
1. **Node.** Run `node -v`. cf-browser needs Node 20.19 or newer with npm. Older: tell the user to upgrade and stop.
2. **Configured?** Call `session_list`.
   - Works → go to step 4.
   - "not configured" → step 3.
   - `AUTH` error → the token lacks the permission or the account ID is wrong → step 3.
   - `INSTALLING` → the first start is installing the browser driver (10–30 s, needs network); wait and retry once.
3. **Account ID and token.** Tell the user:
   - Account ID: Cloudflare dashboard → Account home → the ID next to the account name (32 hex characters).
   - Token: dashboard → My Profile → API Tokens → Create Token → Custom token → permission **Account → Browser Run → Edit** (older pages call it Browser Rendering Edit or Write) for that account. An account-owned token works too.
   - **Claude Code:** enter both in `/plugin` → cf-browser → configure, or run in their own terminal (the `!` prefix runs it here):
     `printf '{"account_id":"%s","api_token":"%s"}' "$CF_ACCOUNT_ID" "$CF_API_TOKEN" | claude plugin configure cf-browser@plugin-cf-browser --values-stdin`
     Then restart Claude Code (or `/mcp` → reconnect cf-browser).
   - **Codex** (no plugin settings): the user creates `~/.cf-browser/.env` (mode 600) with two lines, `CF_ACCOUNT_ID=<id>` and `CF_API_TOKEN=<token>`, then starts a new Codex session. Optional settings use the same file: `CFB_PLAN`, `CFB_IDLE_TIMEOUT_S`, `CFB_MAX_SESSION_MIN`, `CFB_MAX_CONCURRENT`, `CFB_DAILY_BUDGET_MIN`, `CFB_OPEN_LIVE_VIEW`, `CFB_DEFAULT_PROFILE`. To stop Codex asking before every browser tool, they can add to `~/.codex/config.toml`: `[plugins."cf-browser@plugin-cf-browser".mcp_servers.cf_browser]` then `default_tools_approval_mode = "approve"`.
   - Call `session_list` again.
4. **Plan and limits.** Show the settings that matter (Claude Code: `/plugin` → cf-browser → configure; Codex: the `CFB_*` lines in `~/.cf-browser/.env`): plan (`paid` or `free`; Free allows 10 browser-minutes a day), idle timeout, max browser age, max open browsers, daily budget. `usage_report` shows today's use. They change them in the same place.
5. **Logins.** Ask the user (AskUserQuestion in Claude Code): "Your Cloudflare browser can remember logins. Use one everyday profile `main` for everything (recommended), or separate profiles per account?" Explain the answer in two lines (the profiles skill has the details). Logins live in `~/.cf-browser/profiles` and survive uninstalling; deleting that folder forgets them.
6. **Default browser for web tasks (optional).** Offer to add one line to the project's or user's `CLAUDE.md` (Claude Code) or `AGENTS.md` (Codex): `For web tasks use the cf-browser:browse skill (Cloudflare cloud browser).` Add it only on yes.
7. **Smoke test.** `page_read` of `https://example.com` (should report `engine: kitesurf`), then `session_create` with `profile_mode: "none"` and `start_url: "https://example.com"`, `browser_snapshot`, `session_close`. Report what you saw.

## Report
```
Node: <version>   Configured: <yes | no: what is missing>
Plan: <paid|free>   Idle close: <s>   Max open: <n>   Daily budget: <min> (used today: <min>)
Logins: <everyday profile main | separate profiles>   Folder: <profiles path>
Smoke test: <page_read engine, browser opened and closed>
```
