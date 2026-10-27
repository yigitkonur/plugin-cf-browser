# Profiles and identity

The configured everyday profile defaults to `main`. Every agent on the same machine/account uses its own tabs in the same live browser context. Login changes are therefore shared immediately. Parallel tasks need no profile selection, clone or read-only fallback.

Persistence covers cookies, localStorage and IndexedDB. It does not promise a complete Chrome disk profile, password/passkey store, service-worker cache, sessionStorage, unsaved form or open-tab RAM. A site may also expire or revoke its own session.

The manager checkpoints after human return, before task completion and periodically during use. Writes are atomic and preserve the previous valid checkpoint. An IndexedDB capture failure is reported; it does not silently overwrite the profile with a cookie-only snapshot. Corrupt state is distinct from a first-use empty profile.

Use `advanced topic=profiles` only for an actual account-management need:

- Separate account environment requested: create a named profile, then start a task with that name and hand off login.
- Save recent login state explicitly: `profile_save` with the task id.
- Inspect state: `profile_list` returns metadata, not credentials.
- Undo an unwanted/corrupt checkpoint: finish active tasks, then `profile_restore_previous`.
- Remove an account environment: `profile_delete` for the user-requested inactive profile.

A clone is a copy of the last saved checkpoint; it is not live synchronization. Existing saved profiles retain their names and location across this update.

For login/logout/account switching, coordinate the shared identity. Human login uses `scope:identity`; an agent's authorized logout/switch action uses `affects_identity:true`. Other active operations settle first; dependent tasks then take fresh observations. The plugin cannot infer every application's private account-switch mechanism from page content.
