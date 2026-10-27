# Decisions

## Shared-browser revision (owner-approved 2026-10-27)

- Keep the existing plugin identity and Codex/Claude Code stdio entry points. First target is personal use across agents on the same machine; remote ChatGPT hosting, SaaS and other browser backends remain separate work.
- One manager owns the profile, remote browser and default Chrome context. Agents own tasks/tabs, not browsers. Default context matters because native Live View creates its tabs there too.
- Keep the existing everyday profile name and storage-state format. Parallelism is not an account/profile boundary. Separate profiles are explicit account environments.
- Human takeover is interactive and tab-scoped; login/account changes pause shared identity. Full/DevTools viewers require browser-wide control. Human ownership survives an agent exiting.
- Use the pinned Playwright engine's AI snapshot/aria-ref behavior behind our adapter. No custom selector engine, browser fork or local runtime Chromium. The private snapshot contract is pinned and tested.
- Ordinary action responses include the next observation. Screenshots are native MCP images with CSS viewport coordinates. Long outputs are paged valid JSON.
- Use instructions for incremental scripting; no script content/length hook or blanket permission ritual. Runtime ownership, uncertainty and actual cancellation are execution semantics.
- Native action timeouts bound waits. Long work returns an operation id. A cancelled script closes only its target, because terminating current JavaScript alone does not cancel future promises/timers. Effects already delivered to a site remain uncertain.
- Remove plugin budget, per-window concurrency and maximum-age cutoffs. Finish tasks explicitly; idle forgotten work is reaped. Keep human/inflight work alive. Failed remote closes remain in a durable journal.
- Checkpoint cookies, localStorage and IndexedDB atomically. No silent narrower fallback. Missing/corrupt profiles differ. A failed explicit finish keeps the task available for save recovery.
- Small local control panel; native Cloudflare viewer reused. Separate named window works without third-party iframe assumptions. Inline mode is optional; mouse activity inside the viewer is not inferred.
- Credentials come from existing environment/host configuration/file. Doctor works without credentials and separates local readiness from API access. No setup questionnaire for budgets or profile models.
- Advanced Cloudflare services remain on-demand. Legacy names remain callable for one transition release, mapping session ownership to tasks so old close calls cannot kill another user's browser.

## Implementation tradeoffs

The manager uses a private authenticated loopback endpoint plus an atomic process lock and a secret-free recovery journal. Its endpoint descriptor is mode 600 and contains a local access token. A live process lock is never stolen on heartbeat age alone. An upgrade waits for active work to finish.

Requests are deduplicated within a manager lifetime. A transport failure queries the original request; it never automatically repeats a mutation. After manager restart, unavailable results are explicitly unknown. A lost create response enters a provider-keep_alive recovery window rather than creating a duplicate browser whose id cannot be reconciled safely.

The full browser and human interaction APIs do not provide a general trustworthy viewer-activity signal. Ownership is explicit. Defaulting to interactive does not mean the agent continues input simultaneously in a human-owned tab.

The former per-window embedded Playwright MCP server, profile clone-on-conflict workflow, age/budget enforcement and file-path permission hook are superseded. Historical provider observations are retained in `verified-facts.md` for provenance.
