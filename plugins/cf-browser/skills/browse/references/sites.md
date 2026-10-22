# Sites that push back

## Browser Run is always a bot
Cloudflare's docs: "Browser Run requests are always identified as bot traffic." Every request carries non-removable `cf-brapi-*` / Web Bot Auth headers, egress comes from Cloudflare's network (you cannot pick an IP or country), and Browser Run does not solve CAPTCHAs. Setting a user agent does not change this.

So:
- Sites behind bot management may show a challenge, a CAPTCHA, or a 403 on the first request.
- Some consumer logins (large email, social and banking sites) may refuse sign-in or ask for extra verification. Not tested by this plugin: Google and Microsoft accounts.
- Sites that allow one active session per login may sign out the user's own browser or a cloned profile.

## What to do
1. A CAPTCHA or "verify you are human" page: `human_handoff` — the user solves it in the Live View. Do not click CAPTCHAs yourself.
2. A login that needs 2FA or SSO: `human_handoff` (the login skill).
3. A hard block (403 on every page, endless challenge loop after the user solved one): stop, tell the user the site blocks automated browsers, and do not retry in a loop. A browser service with residential proxies and stealth (for example the sibling plugin `kernel-browser`) fits those sites better.
4. A 403 with the note "Blocked by this browser's guardrails" is your own `allowed_domains`, not the site: ask the user before opening a browser with a wider allowlist.

## Kitesurf limits
`page_read` uses Kitesurf (a lightweight engine) for public text when `engine: auto`. It has no JavaScript-heavy rendering guarantees, no video/WebGL, and cannot pass TLS-fingerprint bot checks; the tool falls back to Chromium on errors. Force `engine: "chromium"` when a page renders incompletely.
