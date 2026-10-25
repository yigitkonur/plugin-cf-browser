# plugin-cf-browser

a claude code and codex plugin that gives your agents a real browser on [cloudflare browser run](https://developers.cloudflare.com/browser-run/) (the thing that used to be called browser rendering). the browser runs in cloudflare's cloud, your laptop just runs claude code or codex.

what you get:

- **saved logins.** an everyday profile (`main`) that every browser loads and saves back, so you log in once and later tasks start signed in.
- **you log in, not the agent.** logins, 2fa and captchas go through a live view handoff: a tab opens on your screen, you do the step, click done. the agent never sees or types a password.
- **you can watch.** the agent opens a read-only live view before it submits, buys or sends anything.
- **nothing keeps billing.** browsers close when idle, at a max age, when claude code exits, and leftovers of a crash get closed on the next start. a daily minute budget and a per-window browser limit on top.
- **everything browser run has.** quick actions (markdown, screenshots, pdfs, scraping, ai extraction), kitesurf (free during its beta), crawls, session recordings with a replay page, domain guardrails, and webmcp in lab browsers.

every behavior in here was run live against a real cloudflare account (receipts: [verified-facts.md](verified-facts.md)).

<!-- kit:install:start -->
## install

Every plugin of ours is installed **once, globally, and off**, then **turned on per project**. Nothing runs and no tokens are spent in chats that don't switch it on. It works the same in Claude Code and Codex.

### 1. install it globally

**Claude Code**

```sh
claude plugin marketplace add yigitkonur/plugin-cf-browser
claude plugin install cf-browser@plugin-cf-browser -s user          # stays off: defaultEnabled is false in the manifest
```

**Codex** (0.163+)

```sh
codex plugin marketplace add yigitkonur/plugin-cf-browser
codex plugin add cf-browser@plugin-cf-browser
codex-plugin-project.sh global-off cf-browser@plugin-cf-browser     # Codex has no enable/disable command; this keeps it off everywhere
```

All our plugins, both hosts, plus the `plugin` command and the 6-hourly update job, in one line:

```sh
curl -fsSL https://raw.githubusercontent.com/yigitkonur/plugin-kit/main/install.sh | sh -s -- --all
```

### 2. turn it on in a project

```sh
cd your-project
plugin on cf-browser    # Claude Code and Codex, this folder only
plugin off cf-browser   # undo
plugin                  # or pick from a list (TUI)
```

By hand, without the `plugin` command:

```sh
claude plugin enable cf-browser@plugin-cf-browser --scope project      # undo: claude plugin disable cf-browser@plugin-cf-browser --scope project
codex-plugin-project.sh on cf-browser@plugin-cf-browser . --trust      # undo: codex-plugin-project.sh off cf-browser@plugin-cf-browser
```

Restart `claude` / `codex` in that folder afterwards.
Codex reads a folder's `.codex/config.toml` only when the folder is trusted; `--trust` adds that, and it also enables the folder's hooks and rules, so use it for your own projects only. `plugin` and `codex-plugin-project.sh` come from [plugin-kit](https://github.com/yigitkonur/plugin-kit) (the one-line installer above).

### 3. updates

A plugin updates only when its `version` changes, and this repo's `release` workflow bumps it on every shipped change. Machines pick it up with `plugin update`, or by themselves with the 6-hourly job (`plugin autoupdate install`). By hand:

```sh
claude plugin marketplace update plugin-cf-browser && claude plugin update cf-browser@plugin-cf-browser
codex plugin marketplace upgrade plugin-cf-browser        # then start a new session
```

No GitHub SSH key on the machine? `export CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1` (`plugin install` sets it in Claude's settings for you).

### 4. uninstall

```sh
claude plugin uninstall cf-browser@plugin-cf-browser -s user
claude plugin marketplace remove plugin-cf-browser
codex plugin remove cf-browser@plugin-cf-browser
codex plugin marketplace remove plugin-cf-browser
```
<!-- kit:install:end -->

### set up the credentials

the plugin needs your cloudflare account id and an api token (see "what you need" below). claude code asks for them on install, or run `/plugin` → cf-browser → configure. from a terminal, without the token ever touching chat:

```sh
printf '{"account_id":"%s","api_token":"%s"}' "$CF_ACCOUNT_ID" "$CF_API_TOKEN" \
  | claude plugin configure cf-browser@plugin-cf-browser --values-stdin
```

or skip that and put `CF_ACCOUNT_ID` and `CF_API_TOKEN` in the `.env` file described under "use it in codex" below; `/plugin` values win when both are set.

plugins load when a chat starts, so a chat opened before the install won't have the tools (see "without the plugin (curl)" below for those). after you switch the plugin on in a project, run `/cf-browser:setup` once: it checks everything and asks how you want logins kept.

### use it in codex

codex 0.163+ runs the same plugin from the same repo (install block above). codex has no plugin settings, so the credentials go in a `.env` file the server reads (the claude code install reads it too when `/plugin` leaves them unset):

```sh
mkdir -p ~/.cf-browser && umask 077 && printf 'CF_ACCOUNT_ID=%s\nCF_API_TOKEN=%s\n' "$CF_ACCOUNT_ID" "$CF_API_TOKEN" > ~/.cf-browser/.env
```

optional settings go in the same file with the same names as the claude options: `CFB_PLAN`, `CFB_IDLE_TIMEOUT_S`, `CFB_MAX_SESSION_MIN`, `CFB_MAX_CONCURRENT`, `CFB_DAILY_BUDGET_MIN`, `CFB_OPEN_LIVE_VIEW`, `CFB_DEFAULT_PROFILE`.

start a new codex session. codex asks you to review the plugin's 4 hooks once (primer, guard, stop notice): pick "trust all". to stop codex asking before every browser tool, add this to `~/.codex/config.toml`:

```toml
[plugins."cf-browser@plugin-cf-browser".mcp_servers.cf_browser]
default_tools_approval_mode = "approve"
```

in codex the tools are `cf_browser.*` and the skills are the same six. two differences: codex doesn't tell plugins your project folder, so uploads only take files from the temp folder; and codex kills plugin servers at exit, so a small watchdog process closes your browsers right after (a profile save that was due at that moment is skipped; autosave runs every 5 minutes).

### what you need

- claude code 2.1.300 or newer, **node 20.19+ with npm** (the plugin ships its own mcp server). macos and linux are tested; windows should work but is untested.
- a cloudflare account. workers paid ($5/month) is the comfortable option; the free plan works but allows 10 browser-minutes a day.
- an api token: dashboard → my profile → api tokens → create token → custom → **account → browser run → edit** for your account (older docs call it browser rendering edit). account-owned tokens work too.
- network on first start: the server installs its browser driver (`playwright-core` + `@playwright/mcp`, pinned) into the plugin's data folder. takes 10–30 s; tools answer "installing" meanwhile.

## how you use it

just ask claude to do something on the web; the primer tells it to load `cf-browser:browse`. or call the skills:

| skill | does |
|---|---|
| `/cf-browser:browse <task>` | the main one: reuses or opens a browser, drives it, hands logins to you, closes it |
| `/cf-browser:login <site>` | saves a site login into a profile through a handoff, verified on the page |
| `/cf-browser:profiles` | list, clone, separate, restore, delete saved logins |
| `/cf-browser:sessions` | what's open (this window and the whole account), minutes used today, cleanup |
| `/cf-browser:replay <id>` | download a recorded session and open the replay |
| `/cf-browser:setup` | check node, token, settings; ask how logins should be kept |

### settings

| option | default | what it does |
|---|---|---|
| `account_id`, `api_token` | — | needed from one of two places: here (the token goes to your os keychain) or `CF_ACCOUNT_ID` / `CF_API_TOKEN` in the `.env` file from the install section. these values win when both are set |
| `plan` | `paid` | `free` caps idle at 300 s, 3 browsers, 9 min/day |
| `default_profile` | `main` | the everyday profile |
| `profiles_dir` | `~/.cf-browser` | where logins live (outside the plugin data folder on purpose) |
| `idle_timeout_seconds` | 300 | close a browser after this much idle time (60–1140) |
| `max_session_minutes` | 30 | close at this age (not during a handoff) |
| `max_concurrent_sessions` | 2 | open browsers per claude code window |
| `daily_budget_minutes` | 120 | refuse new browsers past this many minutes today (utc), unless you confirm |
| `open_live_view_locally` | true | open live view / handoff in your default browser instead of printing the url |

`CF_BROWSER_HOOKS=off` in your environment silences the plugin's hooks.

### without the plugin (curl)

an agent that doesn't have the tools loaded (a chat started before the install, a harness without plugins) can do the same work with the rest calls the mcp server makes. the credentials are the `.env` file from the install section (`CF_ACCOUNT_ID`, `CF_API_TOKEN`; `CFB_HOME` moves the folder). load them in the shell and never print the token or put it in a file or command line others can read:

```sh
set -a; . "${CFB_HOME:-$HOME/.cf-browser}/.env"; set +a
B="https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/browser-run"   # older accounts: /browser-rendering
H="Authorization: Bearer $CF_API_TOKEN"; J='content-type: application/json'

# read a public page as markdown (kitesurf, free in beta); also /content (html), /links
curl -sS -m 60 -X POST "$B/markdown?browser=kitesurf" -H "$H" -H "$J" -d '{"url":"https://example.com"}'     # {"success":true,"result":"..."}

# screenshot / pdf (chromium, billed by browser time; the x-browser-ms-used header says how much)
curl -sS -m 90 -o shot.png -X POST "$B/screenshot" -H "$H" -H "$J" -d '{"url":"https://example.com"}'

# crawl: start, then poll with the id in "result" until "status" is "completed"
curl -sS -X POST "$B/crawl" -H "$H" -H "$J" -d '{"url":"https://example.com","limit":10,"render":false,"formats":["markdown"]}'
curl -sS "$B/crawl/<job-id>?limit=10" -H "$H"        # records[] hold the pages

# a real browser: create, drive it over the websocket in webSocketDebuggerUrl with playwright/cdp, then ALWAYS delete it
curl -sS -X POST "$B/devtools/browser?keep_alive=120000" -H "$H"    # {"sessionId":"...","webSocketDebuggerUrl":"wss://..."}
curl -sS "$B/devtools/session?limit=20" -H "$H"                     # what is open on the account
curl -sS -X DELETE "$B/devtools/browser/<sessionId>" -H "$H"        # {"status":"closed"}
```

an open browser bills until it's deleted or `keep_alive` (milliseconds) runs out, so delete it when done. logins still go through you: don't type passwords into pages for the agent. api quirks: [CF-FINDINGS.md](CF-FINDINGS.md).

## the questions everyone asks

**what does it cost?** browser time while a browser is open, idle included: workers paid includes 10 browser-hours a month, then $0.09/hour; concurrency above 10 browsers (monthly average of your daily peak) is $2 each. free: 10 minutes a day. kitesurf reads are free during its beta. `/cf-browser:sessions` shows minutes used on this machine; the cloudflare dashboard (browser run) is the account-wide number, there's no usage api. details: [cost.md](plugins/cf-browser/skills/browse/references/cost.md).

**why does idle cost money, and how do browsers get closed?** browser run bills a browser until it's closed or times out. so the plugin's own mcp server owns every browser it opens and closes it: after `idle_timeout_seconds` without a tool call, at `max_session_minutes`, when claude code exits (sigterm or stdin closing), and on the next start for anything a crash left behind. cloudflare's `keep_alive` is set 60 s past the idle timeout as the last backstop. `/clear` doesn't touch open browsers.

**what's live view?** a page cloudflare hosts that shows the browser's tab. read-only by default (you can watch, not touch); the agent opens it on your screen before consequential steps or when you ask to watch. an open live view tab keeps the browser alive (verified), so close it when you're done.

**how do logins work?** the agent calls `human_handoff`: a tab opens on your screen with the agent's instructions and done/failed buttons. you log in (password, 2fa, captcha), click done, the agent checks the page shows you signed in, and the login is saved into the profile. browser run has no password-manager integration; this plugin doesn't add one either.

**everyday profile vs clone vs separate?** by default every browser loads `main` and saves back (one browser writes it at a time). when a second browser wants `main`, you get three options: clone it (`main-2`, same logins, own cookies from then on; best for parallel work), open it read-only, or wait. for a second account on the same site, or a site that signs out parallel sessions, make a separate profile and log in there.

**where are my logins stored?** `~/.cf-browser/profiles/<name>/state.json` (playwright storage state: cookies, localstorage, indexeddb), mode 600, outside the plugin's data folder so uninstalling keeps them. delete the folder to forget everything. browser run itself has no profiles; every browser starts empty and the plugin loads the profile into it.

**which sites will fight it?** browser run is always identified as bot traffic (non-removable headers, cloudflare egress ips, no captcha solving). sites with heavy bot defenses may challenge or refuse; the handoff gets you through captchas, but a site that blocks automated browsers outright stays blocked. for those, a browser service with stealth and residential proxies (like the sibling [kernel-browser](https://github.com/yigitkonur/plugin-kernel-sh) plugin) fits better.

**what's kitesurf?** cloudflare's lightweight engine, free during its beta. `page_read` uses it for public text/markdown/links and falls back to chromium on errors.

**recordings?** `record: true` on a browser keeps a dom replay (inputs masked) and network log at cloudflare for 30 days; `recording_fetch` writes `replay.html` you open locally. off by default, and the skill keeps it off for logged-in work unless you ask.

**webmcp?** sites can register tools for agents (`document.modelContext`). in a lab browser (`lab: true`) the snapshot lists them and `webmcp_call` runs them; their output is treated as untrusted page data.

**can i use it from several claude code windows?** yes. each window runs its own server and owns its own browsers; the profile lock stops two windows from writing one profile at once.

## privacy and security limits

- the api token reaches only the mcp server (env from your keychain). it's stripped from every child process the plugin starts, and the guard hook denies bash/read/write calls containing it.
- tools never return cdp/websocket urls, cookies or the token. a live view url is returned only when it can't be opened on your screen, with a "give only to the user, once" note.
- profile files are as sensitive as passwords. tools return metadata only, and the guard hook blocks the agent's read/grep/glob/bash/edit/write calls that mention the profiles folder. that's a speed bump, not a vault: an indirect shell command or a page script reading `document.cookie` can get around it. don't sync or share the folder.
- page tools that write local files are hidden, every `filename` argument is removed, and `browser_run_code_unsafe` (node code on your machine) is not exposed. uploads only take files from the project folder or the temp folder, never dotfiles.
- `allowed_domains` on a browser makes cloudflare block requests to any other host, which limits where a prompt-injected page can send data.

## how it's built

one local stdio mcp server per claude code window (`plugins/cf-browser/server`): cloudflare's rest api for sessions, live view, recordings, quick actions and crawls; `playwright-core` over cdp for the browser; one embedded [`@playwright/mcp`](https://github.com/microsoft/playwright-mcp) per browser for the page tools (snapshot, click, type…), re-exposed with a `session_id`. why not cloudflare's hosted mcp or chrome-devtools-mcp: [DECISIONS.md](DECISIONS.md). what we found in browser run along the way: [CF-FINDINGS.md](CF-FINDINGS.md).

```sh
cd plugins/cf-browser/server && npm ci && npm run build   # dist/ is committed; ci checks it's fresh
scripts/validate.sh && scripts/hook-smoke.sh && scripts/secret-scan.sh --tree
```

## license

mit. third-party notices (the mcp sdk bundled in `dist/`, `@playwright/mcp` installed at runtime): [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
