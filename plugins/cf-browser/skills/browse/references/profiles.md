# Saved logins (profiles)

## Model
- A profile = a Playwright storage state (cookies, localStorage, IndexedDB) saved on this computer at `~/.cf-browser/profiles/<name>/state.json` (or the `profiles_dir` option), with one backup (`state.prev.json`) and metadata. It is outside the plugin's data folder: uninstalling keeps it; deleting the folder forgets every login.
- Browser Run has no profiles of its own; every browser starts empty and cf-browser loads the profile into it.

## Modes (`session_create profile_mode`)
| Mode | Loads logins | Saves back | Use for |
|---|---|---|---|
| `write` (default) | yes | on close, after a handoff, every 5 min of activity, `profile_save` | normal work on the everyday profile |
| `read` | yes | never | a second browser on a profile that is open elsewhere; subagents when the profile is locked |
| `none` | no | never | public pages, throwaway work |

## One writer per profile
A write-mode browser holds the profile's lock. A second write open fails with `PROFILE_IN_USE` and three choices for the user:
1. **Clone** — `profile_clone main → main-2`: same logins, own cookies from then on. Best for parallel work.
2. **Read-only** — same logins, nothing saved.
3. **Wait or close** the other browser.
Locks of crashed runs go stale after 2 minutes and are taken over automatically.

## Separate profiles
For a second account on the same site, another person, or a site that signs out parallel sessions: `profile_create <name>` and log in inside it (the cf-browser login skill, choosing that profile). A fresh login is an independent session; a clone shares the original's session cookies.

## Bad saves
If the site showed you signed out or broken, close with `save_profile: false`. If a bad state was saved already: `profile_restore_previous <name>` swaps in the backup (the first save of every browser keeps the previous state as backup).

## Quick Actions with a profile
`page_read` / `page_scrape` / `page_extract` with `profile` send that profile's cookies for the URL's host and its parent domains. Logins stored in localStorage cannot be carried this way; use a browser session.

## Security limits
Profile files are as sensitive as passwords. Tools return metadata only. The guard hook blocks Read/Grep/Glob/Bash/Edit/Write calls that mention the profiles folder — a speed bump, not a vault (a page script reading `document.cookie` or an indirect shell command can get around it). Never sync or share the folder; to share access, the other person logs in themselves.
