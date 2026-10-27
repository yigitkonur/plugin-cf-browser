# Migration and rollback

The plugin keeps its name, marketplace ids, entry paths, default profile name and storage-state files. There is no automatic version bump in source; the existing plugin-kit release workflow handles shipped changes after main CI passes.

1. Let active old-version tasks and interactive viewers finish. The new manager will not steal a live legacy profile lock, even if its heartbeat is old.
2. Update the plugin through its existing installer and reconnect the host. A different manager build waits for its current tasks/human control and pending cleanup before replacing it.
3. Run doctor. Existing environment/Claude configuration/credentials-file values remain usable. Removed budget, maximum-age, plan-specific and per-window concurrency settings no longer gate work.
4. Start a task in the existing default profile and verify the expected account on a page. Other agents start tasks in separate tabs of that same live context.

Legacy names remain callable for one transition release but are hidden from the ordinary tool list. `session_create` returns a task-scoped `session_id`; `session_close` finishes only that task. Legacy selection is per task. A live remote session owned by an old process is not silently imported or closed. Explicit old read/no-save profile modes and session-local domain guardrails return migration guidance because they cannot be imposed on other users of a shared browser. Screenshot/coordinate flows require a current image, including in the adapter.

Saved profile files are not encrypted by the plugin; they retain private filesystem permissions. The full Chrome disk profile, passkeys, sessionStorage and unsaved form state were never part of storage-state persistence.

For rollback, finish new-manager tasks and human control first, wait for confirmed cleanup, then stop the idle manager/update the installed plugin to the previous release. The profile state format remains compatible. Returning to the old version also returns to its per-window ownership model and limits. Never run two versions as concurrent writers to one profile.

The new manager deliberately outlives individual host windows. Uninstalling or killing a client is not a request to interrupt another agent or a human viewer. Use the control panel to finish shared work before uninstalling.
