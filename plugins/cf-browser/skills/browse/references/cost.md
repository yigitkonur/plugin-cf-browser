# Resource lifecycle and usage

Finish the task explicitly. The manager checkpoints the profile and closes the remote browser when its last task and human control end. Idle forgotten agent tasks are reaped after the configured inactivity interval (five minutes by default). Running operations and human control are excluded; client heartbeats and status polling are not task activity.

The plugin enforces no daily browser-minute budget, maximum browser age or per-window browser quota. Cloudflare's actual account limits and billing remain authoritative. An account limit error is reported as such; it does not imply the user should clone a profile or repeatedly retry creation.

Cloudflare `keep_alive` is a fallback if the manager disappears. Confirmed close is an explicit API operation. Failed closes stay in the manager's journal and are retried; the response says `close_unconfirmed` until resolved.

`advanced topic=diagnostics` exposes the optional local usage ledger. It is not an account-wide invoice. Public Quick Actions, crawl, AI extraction and recording can have separate service costs; consult the current Cloudflare dashboard/documentation when the user asks about pricing. No cost warning is added to every browser step.
