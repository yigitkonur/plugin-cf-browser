---
name: profiles
description: >-
  Manage the saved browser logins of the cf-browser plugin: list profiles, explain the everyday profile, clone it for parallel work, create separate profiles for other accounts, restore a profile after a bad save, or delete one. Use when the user asks about their cloud browser profiles, saved logins, "profile in use" errors, using two accounts on one site, or forgetting a login.
argument-hint: "[list | clone <from> <to> | separate <name> | restore <name> | delete <name>]"
---

# /cf-browser:profiles

Goal: the user understands where their logins live and gets the profile setup they want, with nothing deleted they did not confirm.

The argument is the text after the skill name (or the line starting `ARGUMENTS:`). No argument means `list`.

## How profiles work (explain this when the user asks, in a few lines)
- A profile is a saved browser state: cookies, localStorage and IndexedDB. It lives on this computer in `~/.cf-browser/profiles/<name>/` (or the folder set in the plugin's `profiles_dir` option), outside the plugin's own data folder, so uninstalling the plugin keeps it. Deleting that folder forgets every login.
- **Everyday profile** (`main` by default): every new browser loads it and saves logins back on close, after a handoff, and every 5 minutes of activity. One browser at a time writes it.
- **Clone** (parallel work): when `main` is already open in another browser (`PROFILE_IN_USE`), `profile_clone main → main-2` copies its last saved logins; the clone then keeps its own cookies. A site that allows one active session per login may sign one of them out: log in again inside the clone.
- **Separate profile** (another account, another person, or a site that logs out parallel sessions): `profile_create work`, then `/cf-browser:login <site>` choosing that profile. A fresh login gives an independent site session; a clone shares the original's.
- **Read-only** (`profile_mode: "read"`): loads the logins, never saves.
- **Backup**: the first save of each browser keeps the previous state as a backup; `profile_restore_previous` swaps it back when a save captured a signed-out state.
- Profile files are as sensitive as passwords. Tools return metadata only (sites, cookie count, expiry); the plugin's guard blocks the agent from reading the files. Never sync or share the folder; to share access, the other person logs in themselves.

## Actions
| Argument | Do |
|---|---|
| `list` | `profile_list`; show name, default, sites, cookie count, earliest expiry, last saved, backup, in use by |
| `clone <from> <to>` | `profile_clone`. If the source is open, say the copy is its last saved state (run `profile_save` on that browser first to include newer logins) |
| `separate <name>` | `profile_create <name>`, then offer `/cf-browser:login <site>` into it |
| `restore <name>` | `profile_restore_previous`. Refused while the profile is open: close that browser with `save_profile: false` first |
| `delete <name>` | Ask with AskUserQuestion first ("Delete profile <name> and its saved logins for <sites>? This cannot be undone."). Only on yes: `profile_delete` with `confirm: true` |
| `default <name>` | The default profile is a plugin option: tell the user to set `default_profile` in `/plugin` → cf-browser → configure |

Never read, copy or print files inside the profiles folder; use the tools.
