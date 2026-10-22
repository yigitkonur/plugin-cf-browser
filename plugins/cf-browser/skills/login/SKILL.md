---
name: login
description: >-
  Save a website login into a cf-browser profile so later Cloudflare browsers start signed in, with the user typing the password, 2FA code or CAPTCHA themselves in a Live View handoff and nothing secret passing through chat. Use when the user asks to log in to a site in the cloud browser, when a cf-browser browser lands on a login page, or when a saved login has expired.
argument-hint: "<site>"
---

# /cf-browser:login

Goal: a profile that opens signed in to one site, verified on the page, with no password or code in the transcript.

The argument is the text after the skill name (or the line starting `ARGUMENTS:`): a site such as `github.com`. If missing, ask which site and stop. Lower-case it; it must look like a hostname.

Tools are the cf-browser MCP tools (`mcp__plugin_cf-browser_browser__<tool>`).

## Rules
- Never ask for, accept or type a password, one-time code or recovery code. The user types them into the handoff page. If the user pastes one into chat anyway, do not use it; say it is now in the transcript and suggest changing it if it is real.
- The handoff page opens on the user's screen. If the tool returns a URL instead, give it to the user once and never write it anywhere else.
- `record` stays off for logins.

## Step 1. Where should the login live (ask the user)
1. `profile_list`.
2. If no profile exists yet (first use), ask the user (AskUserQuestion in Claude Code): "Your Cloudflare browser can remember logins. Use one everyday profile `main` for everything (recommended), or separate profiles per account?" Options: Everyday profile (Recommended) / Separate profiles per account.
3. Always ask the user (AskUserQuestion in Claude Code): "Save your <site> login into your everyday profile `main`?" Options: Yes, everyday profile (Recommended) / Separate profile `<site>-<account>` / Don't save (this browser only).
   - Everyday: `profile` unset, mode write.
   - Separate: `profile_create` with a name like `github-work` (lowercase, `a-z0-9._-`), then use it in write mode.
   - Don't save: `profile_mode: "none"`.
4. A subagent cannot ask: it uses the everyday profile and says so in its report.

## Step 2. Open the login page
`session_create` with the chosen profile, `label: "login-<site>"`, `start_url` = the site's sign-in page, and `allowed_domains` = the site and its auth domains when you know them (leave unset if the login redirects to an identity provider you cannot predict). `PROFILE_IN_USE`: offer the three options from the error (a clone keeps parallel work safe).

If `browser_snapshot` already shows the user signed in, skip to Step 4.

## Step 3. Hand it to the user
1. `human_handoff` with `instructions: "Log in to <site> and click Done when you see your account."` (`timeout_minutes` 10; up to 30 if they need to find a device).
2. Tell the user in chat: a browser tab opened on their screen; log in there (password, 2FA, CAPTCHA), then click **Done** in the panel.
3. `human_wait` in a loop until the status is not `pending`. Do not ask the user whether they are finished.
4. `failed` or `timeout`: ask the user whether to try again; never retry silently.

## Step 4. Verify, then save
1. `browser_snapshot`: look for a signed-in element (account name, avatar menu, "Log out"). The URL must not be a login page. `done` from the handoff is not proof.
2. Signed in: `session_close` (saves the profile; `human_wait` already saved once).
3. Not signed in: `session_close` with `save_profile: false`, tell the user what you saw, and offer another try.
4. The site loops on bot checks or refuses the login: say so; `../browse/references/sites.md` explains why (Browser Run is always identified as a bot) and when another browser service fits better.

## Report
```
Site: <site>   Result: <signed in and saved | not saved: reason>
Profile: <name> (<everyday | separate | not saved>)
Proof: <the signed-in element you saw>
Next: later browsers on this profile start signed in; the login lasts as long as the site's cookies (profile_list shows the earliest expiry).
```
