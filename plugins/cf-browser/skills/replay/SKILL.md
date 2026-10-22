---
name: replay
description: >-
  Replay a recorded Cloudflare Browser Run session from the cf-browser plugin: download its recording (rrweb DOM events and network HAR), open the replay page in the user's browser, and summarize failed requests and why the browser closed. Use when the user asks to see, replay or debug what a recorded cloud browser did.
argument-hint: "<session-id>"
---

# /cf-browser:replay

Goal: the user watches what the browser did and gets a short account of what went wrong, without the raw events in chat.

The argument is the text after the skill name (or the line starting `ARGUMENTS:`): a session id. If missing, `session_list` and ask which recorded browser (only browsers created with `record: true` have recordings; Cloudflare keeps them 30 days).

## Steps
1. If the browser is still open, ask whether to close it: recordings exist only after the session closes. On yes, `session_close`.
2. `recording_fetch` with the session id. It retries for up to 60 s while Cloudflare finalizes the recording, and writes `events.json`, one `network-<tab>.har` per tab and `replay.html`.
3. Open `replay.html` for the user: on macOS `open <path>`, on Linux `xdg-open <path>`, on Windows `start "" "<path>"`. It loads the rrweb player from unpkg (pinned version, integrity-checked), so it needs internet.
4. Summarize from the HAR files with a short script (for example `jq`): count requests by status class, and list failed ones (status ≥ 400 or 0) as method + URL **without the query string**. Never print headers, cookies, bodies or full URLs: they can carry tokens.
5. Report: duration, tabs and event counts, the close reason, failed requests, and the replay path.

Notes: recordings are DOM replays, not video. Typed input is masked by Cloudflare; canvas and cross-origin iframes are not captured.
