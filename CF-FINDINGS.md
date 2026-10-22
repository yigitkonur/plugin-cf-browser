# Cloudflare Browser Run: what we hit while building cf-browser

Checked live on 2026-10-22 against the REST API and CDP endpoint with a Workers Paid and a Workers Free account. Row ids point into [verified-facts.md](verified-facts.md).

## Documentation conflicts
| # | Topic | What the docs say | What we saw |
|---|---|---|---|
| D1 | API path | Newer pages use `/accounts/<id>/browser-run/…`, the API reference and older pages `/browser-rendering/…` | Both answer (CF1). Clients can use either; the docs should say both are supported |
| D2 | Token permission name | "Browser Run - Edit" on newer pages, "Browser Rendering - Edit"/"Write" on older ones | The token API calls it "Browser Run Write" (CF2) |
| D3 | `keep_alive` range | Session-management docs: 10000–1200000 ms; Wrangler docs: 60–600 s | The API enforces 10000–1200000 ms (CF8) |
| D4 | Concurrency cap | Limits page: 200 browsers; changelog: 120 | Not tested (would need a large account) |

## Undocumented behavior
| # | Topic | What we saw | Why it matters |
|---|---|---|---|
| U1 | REST create with `recording` / `lab` | Both apply on `POST /devtools/browser` (CF6); the docs only show them on the WebSocket acquire URL | Clients that create over REST and connect later can use both |
| U2 | Idle during a human handoff | An active `Cloudflare.handoff` does not count as activity: the session closed at `keep_alive` (CF10) | A human mid-login loses the browser unless the client pings. Suggest: count an active handoff as activity, or document it |
| U3 | Idle with an open Live View | A connected Live View viewer keeps the session alive (CF11) | Billing continues while a forgotten viewer tab is open; worth stating on the Live View page |
| U4 | `getHandoffState` | Requires `targetId` (CF14); the docs show it without parameters | Calls without it fail |
| U5 | `handoffComplete` | Listed as a *command* in `/json/protocol`, but it also arrives as an event with `{success, reason}` ("User clicked 'Done'") | Clients reading the protocol file would not expect the event |
| U6 | Session list | `GET /devtools/session` returns a bare array, closed sessions are not listed, and `GET /devtools/session/<id>` of a closed session returns `{"error":"Session not found"}` (CF4) | `closeReason` / `closeReasonText` can never be read after close through these endpoints |
| U7 | Account-owned tokens | `cfat_` tokens fail `/user/tokens/verify` but work (CF3) | Setup checks must not use the user endpoint |

## The hosted MCP server
`https://browser.mcp.cloudflare.com/mcp` offers page reads, crawl and session list/kill, but cannot create or drive a browser session, open Live View, hand off to a human or fetch recordings. An agent that needs a real interactive browser has to bring its own MCP server (this plugin) or `chrome-devtools-mcp`, which binds one session per process.
