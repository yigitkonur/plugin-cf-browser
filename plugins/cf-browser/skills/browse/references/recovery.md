# Recovery by observed state

| Signal | Next useful step |
|---|---|
| `running`, `TAB_BUSY` | Poll the given operation id; work in an independent tab while it runs |
| `STALE_OBSERVATION`, `PAGE_CHANGED`, `STALE_SCREENSHOT` | Observe again in the required modality, then select an action from that state |
| `HUMAN_CONTROL` | Check human status; continue independent tabs or wait for explicit return |
| `IDENTITY_PAUSED`, `IDENTITY_BUSY` | Let the login/account transition finish; take fresh observations afterwards |
| `outcome_unknown`, transport loss, action timeout | Inspect the visible record/confirmation before repeating a mutation |
| `BROWSER_RESTART_REQUIRED` | Resume `task_start` with the same task id; use the returned fresh tab and observation |
| `RECONNECT_PENDING` | Retry status after a short wait; reconnecting does not replay actions |
| `CHECKPOINT_FAILED` | Keep the task open and retry profile save/finish when the connection works; the previous checkpoint is intact |
| `PROFILE_CORRUPT` | Inspect profile metadata; restore the previous checkpoint after its active tasks end |
| `close_unconfirmed` | Report pending remote cleanup; the manager retains its journal and retries |
| `CREATE_UNCONFIRMED` | A create response was lost. Let the unconnected remote browser's keep_alive window expire; avoid opening duplicate browsers |
| `LEGACY_WRITER_ACTIVE`, `MANAGER_UPGRADE_PENDING` | Let old tasks/user control finish. The update waits rather than taking a live profile lock |
| `AUTH`, `NOT_CONFIGURED`, `INSTALL_FAILED` | Run `doctor`; follow the setup skill for the specific failing layer |
| Cloudflare `RATE_LIMITED` | Honor the provider's retry interval; a new tab/profile is not a quota workaround |

## Cancellation

`operation action=cancel` stops the affected target by closing that tab. This also stops delayed JavaScript continuations that a simple timeout or `Runtime.terminateExecution` alone might leave alive. Other tabs and the saved profile remain available. Earlier network requests may already have changed the website: inspect the result in a fresh tab before attempting it again.

If cancellation cannot confirm target closure, the operation stays pending with `CANCEL_FAILED`. Treat it as potentially active. A running script is not cancelled merely because a tool returned an operation id.

## User ownership

A tab handoff waits for in-flight input to settle before the viewer opens. The user can take one tab while unrelated work continues. `full` and DevTools viewers take browser-wide control. A viewer can outlive its opening link's expiry; closing the viewer is separate from releasing ownership. Use the panel's Give back or the structured handoff's Done signal.

A user tab remains open when its agent exits. If that task no longer exists, the panel keeps the tab user-owned; Close tab or Finish all tasks & close completes its lifecycle. The panel cannot reliably infer mouse activity inside a third-party viewer, so it does not guess that a human is idle.

## Results versus intent

A page saying "saved" before you acted, a disabled button, a spinner ending, or an input event being dispatched are not individually enough to claim the requested mutation succeeded. Choose evidence tied to the intended result: the new item's identifier, a changed persisted value, a sent entry or a confirmed completion state. If evidence remains ambiguous, state that uncertainty instead of repeating the action blindly.
