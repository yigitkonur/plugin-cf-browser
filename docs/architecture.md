# Shared local browser architecture

```text
Codex / Claude Code / another local MCP host
  └─ existing stdio entry (launch.mjs → index.ts)
      └─ authenticated loopback client, unique request ids
          └─ one account-scoped manager (broker.ts)
              ├─ task → owned stable tabs → per-tab operations
              ├─ profile → default Chrome context → Cloudflare CDP
              ├─ recovery journal + private checkpoint files
              └─ local control panel → native Cloudflare Live View
```

## Ownership and execution

A client id is tied to a local process. Task ids belong to clients; tab ids belong to tasks or the human. Mutations validate the task/tab, current observation, navigation generation and shared identity epoch. A tab can have one in-flight operation; separate tabs advance independently. There is no shared selected-tab regex. The transitional adapter keeps selection per legacy task only.

A human takeover reserves control before waiting for current operations. New agent input stops; the viewer is opened after quiescence. Tab scope preserves independent work. Identity/browser scope pauses the profile. Return invalidates observations and checkpoints storage. Explicit release ends a pending native handoff without asserting that login succeeded. Identity-paused tasks are excluded from idle cleanup; returning or closing the human target starts a fresh idle interval for affected tasks. Full and DevTools modes always take browser scope, regardless of a supplied narrower scope.

Agent-driven account changes declare `affects_identity`; other operations settle first and all dependent observations expire. Applications can switch account state in undocumented ways, so this coordination depends on agent/user intent and observed state, not a claim of universal automatic detection.

## Browser and profile lifecycle

```text
no browser → opening → open
                   ↘ uncertain create → provider idle recovery window
open → disconnected → reconnect known target ids
                    → confirmed absent → reopen on task resume
open → checkpoint → closing → closed
                            ↘ close_unconfirmed → retry/verify → closed
```

Creation is serialized per profile. The profile lock has a PID and nonce; an old live writer is never displaced because a timestamp is stale. A remote id is journaled before context setup. A create response lost after POST cannot be replayed safely; the manager records that uncertainty and uses the provider's unconnected-session keep_alive backstop.

`task_finish` checkpoints before closing its agent tabs so origin storage is still available. An explicit save failure keeps the task open. Dead-client cleanup preserves the previous good checkpoint and releases only that client's work; human tabs lose the dead task association but remain accessible. The last owner triggers explicit remote DELETE and a subsequent existence check. Failed cleanup stays on disk and is retried after restart.

Profile capture includes IndexedDB. The capture can time out without writing a late/partial result. Valid state is atomically replaced, with the previous valid file retained. Corrupt current or backup files are errors, not empty profiles. Shared profile files are outside the host's plugin cache/data lifecycle.

## Operations and observations

Native Playwright actions use short timeouts. Tool replies return a completed result or a tracked operation id. Polling an id never restarts execution. A hard execution deadline requests target closure; cancellation is reported only when target stop succeeds. Closing that target also terminates delayed JS continuations. Earlier server-side effects cannot be undone and are reported as potentially applied.

A semantic observation uses the pinned AI snapshot plus `aria-ref` locator contract. Read-only snapshots may be retried if a frame navigates while observing; mutations are not retried. A screenshot activates its explicit page for the Cloudflare compositor, then uses Playwright capture with viewport/scroll geometry and image dimensions. Only captures share a short compositor queue; semantic actions still run independently on their own page objects. Background capture could otherwise stall even after font loading completed. Full-page images cannot authorize viewport-coordinate actions. Dynamic layout between image and action remains a reason to verify results.

Popup pages inherit their opener's ownership. Unknown pages created through native browser UI become human-owned. Dialogs and downloads are explicit events. Files use authorized absolute input paths and manager-selected output paths. Large snapshots and results have continuation offsets rather than broken JSON truncation.

## Local boundary and recovery

The endpoint binds `127.0.0.1`, validates Host and Origin, and requires its private bearer token. No CORS permission is granted. Dashboard content renders page titles/URLs as text; its CSP allows only its own script and the native viewer frame. Cloudflare tokens are never sent to the dashboard. Endpoint/control links are local bearer capabilities and stay out of logs.

Clients discover the manager through the same `CFB_HOME` and account identity. Startup races use an atomic lock with guarded dead-PID reclamation. Protocol/build mismatches wait for existing work to finish before upgrade. A disconnected caller queries its original request id instead of replaying the call; after a manager crash the request outcome may be unknown.

The manager journal holds ownership and target ids, not cookie/token values. Restart reconnects the existing browser/context first and invalidates every observation. If the remote browser is confirmed gone, task resume creates a fresh browser from the checkpoint and a fresh tab. Old inputs are never replayed.

## Modules

- `manager.ts`: ownership, lifecycle, checkpoints, recovery and per-tab scheduling.
- `backend.ts`: Cloudflare create/connect/close, native Live View and handoff.
- `page.ts`: pinned snapshot/ref adapter, observations, images, actions and uploads.
- `operations.ts`: asynchronous results, cancellation and uncertainty.
- `broker.ts`, `client.ts`, `runtime.ts`: local transport, identity, startup and request deduplication.
- `tools.ts`, `dispatch.ts`, `advanced.ts`: small ordinary surface and progressive discovery.
- `compatibility.ts`, `services.ts`: legacy calls and independent Cloudflare services.
- `dashboard.ts`: ownership controls around Cloudflare's viewer.
- `profiles.ts`: private atomic storage and migration-compatible locks/checkpoints.
