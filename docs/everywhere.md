# Crewdeck everywhere: one address, always on, in every Claude session

Status: v0.5 design, 2026-11-20. Part of [the architecture](design.md). Builds on the bridge (design.md, "The bridge")
and the `crewdeck` plugin (`plugin/`).

## 1. The problem

Crewdeck lives at `http://localhost:4848` and runs only while `crewdeck up` runs in some terminal. A new person who
only uses Claude desktop has to learn three things nobody tells them:

1. **Where it is.** `localhost:4848` means nothing, and there is no name to type.
2. **That it must be running.** Close the terminal or restart the Mac and the page stops loading.
3. **How to reach it from Claude.** Outside the jobs folder's session, nothing in Claude says Crewdeck exists: no
   command, no panel, no glance at today's to-dos, jobs or tickets.

The target (the owner's words): "a unified one app like interface where claude and human work on jobs, tickets and
take notes", reachable "anytime from anywhere".

## 2. Decisions

| # | Decision | Why |
|---|---|---|
| E1 | **Claude desktop is the app.** Crewdeck plugs into it: the page in the browser pane, a panel beside the chat, a command in every session. No Crewdeck window, no own chat. | Claude desktop already has chat, sessions, approvals, logins and the user's plan; rebuilding them is years of work and splits the user's attention. |
| E2 | **The address is `http://crewdeck.localhost:4848`.** The server accepts the Host `crewdeck.localhost` (and `localhost`, `127.0.0.1`, `[::1]` as before), on every Crewdeck port (shell, Notes, boards). | `*.localhost` is reserved (RFC 6761): macOS's resolver and every Chromium (Chrome, Brave, Edge, Claude's browser pane) send it to 127.0.0.1 with no hosts file and no admin. Checked on macOS 26.5: `dscacheutil -q host -a name crewdeck.localhost` → 127.0.0.1 / ::1. A name can't be rebound to another IP, so the Host check still blocks DNS rebinding. |
| E3 | **No port in the address is optional and needs the user's admin password once**: `crewdeck address --short` writes a packet-filter redirect (127.0.0.1:80 → the shell's port), a LaunchDaemon that loads it at boot, and (only if asked, `--name crew.deck`) a hosts line, into `~/.crewdeck/system/`, then prints the `sudo` commands for the user to run, and the undo. Crewdeck itself never runs `sudo`. | Port 80 can't be bound without root on 127.0.0.1 (checked: `EACCES`); binding `0.0.0.0:80` works unprivileged but exposes Crewdeck to the network, which the threat model forbids. A redirect on the loopback interface touches nothing else. `crew.deck` isn't a real TLD, so it needs the hosts line, and a browser may treat a bare `crew.deck` as a search until it is typed once as `crew.deck/`. |
| E4 | **Always on: a per-user background service.** `crewdeck service install|uninstall|status|restart`: a LaunchAgent (`~/Library/LaunchAgents/io.crewdeck.server.plist`) on macOS, a `systemd --user` unit on Linux. It runs `crewdeck up` with the Node that installed it, starts at login, restarts after a crash, and logs to `~/.crewdeck/logs/service.log`. No admin. `crewdeck setup` offers it (`--service` / `--no-service`). | A Mac app with a menu bar icon is the later, nicer form (§6); the service gives the "always there" now, with no signing or packaging. |
| E5 | **`crewdeck up` and `crewdeck open` know about each other.** `up` while another Crewdeck (this home) answers on the port says so and exits 0 instead of `EADDRINUSE`. `crewdeck open [jobs|notes]` starts Crewdeck if needed (the service, or a detached `up`), waits until it answers, and opens the address in the default browser. | One command a person (or Claude) can always run. |
| E6 | **`/crewdeck` in every Claude session** (the plugin's mod, installed at user scope, so it loads in every session including the desktop's Code tab): opens the Today panel; starts Crewdeck first if it isn't running. A skill, `crewdeck-open`, covers "open Crewdeck" said in words (Claude opens the address in the browser pane). | "Start Crewdeck anytime from anywhere". |
| E7 | **The Today panel** (a mod `Pane`, drawn by the desktop app beside the chat, or as a widget when minimised): Crewdeck's state, today's to-dos (tick, add), Jobs (what waits on you, ready to apply, whether the jobs session is connected), tickets in progress, and buttons: **Open Crewdeck**, **Open Jobs**, **Open today's notes**. Read and written through two new agent endpoints with the token (`POST /api/today`, `POST /api/today/todo`). | A glance and the daily actions without leaving the chat. The panel draws text, buttons, inputs and Markdown only (no web page inside it), so it is a summary that opens the full page. |
| E8 | **To-dos are lines in today's journal page** (`journal/YYYY-MM-DD.md`, `- [ ]` / `- [x]` under `## To do`), the same file Notes and Obsidian show. The panel adds and ticks lines; it never rewrites other lines. | One source of truth, in the user's own notes, readable by every tool. |
| E9 | **Tickets are read from each project's Backlog.md folder** (`backlog/tasks/*.md` frontmatter `status`), read-only in the panel; "In Progress" first. | Backlog.md stays the ticket tool (design.md non-goal: no new kanban). |
| E11 | **Opening the jobs session is one click.** Claude desktop's documented link `claude://code/new?folder=<path>&q=<prompt>` ([support article](https://support.claude.com/en/articles/14729294-open-claude-desktop-with-a-link)) opens a Code session in the jobs folder with a hello in the message box (never sent by itself; the folder is always confirmed). The Jobs page's **Open in Claude** asks the server to open it (`openSession` page action: the link is built from the config, and the page's frame can't open a `claude://` link itself under the shell's CSP); the panel's **Start the Jobs session** and `crewdeck open session` open it with `open`/`xdg-open`. | New users missed "start a session in this folder"; this was the step most likely to stop them. |
| E12 | **Notes uses SilverBullet's own helpers** (the owner: "if SilverBullet provides something natively, we can use it, otherwise park it"): a managed page `Library/Crewdeck/Notes.md` (Space Lua, priority -1) opens the built-in file tree (`std.spaceTree`) on the left unless the person set it otherwise, points `Journal: Today` at `journal/` with a "To do" template (`Library/Crewdeck/Journal Template.md`), and adds top-bar buttons: Files, Today, New page, Bold, Checkbox, Heading, Link to a page. | A newcomer saw a blank page with no list of files and no buttons. A richer editor is parked. |
| E13 | **Two-step onboarding, all inside Claude** (owner: "user installs it, opens Claude desktop and types /crewdeck… simple 2 step onboarding"): (1) add the plugin from the marketplace `pulkitnagpal/crewdeck`; (2) `/crewdeck` → **Set up Crewdeck**. The plugin runs `plugin/hooks/install-script.ts` (`sh -s`, macOS's own curl/tar/shasum): Node 25.9.0 from nodejs.org and `crewdeck-<v>.tar.gz` from the GitHub release, each checked against a SHA-256 pinned in the plugin, into `~/.crewdeck/runtime` and `~/.crewdeck/app/<v>`; `npm ci`; `crewdeck setup --from-plugin --service`; start. The panel shows the STEP lines; Try again resumes. Then **Set up my job search** opens the jobs chat with the setup prompt. No separate Mac app: it would need an Apple Developer ID to avoid Gatekeeper's warning and adds nothing the plugin can't do. | Node, git, a terminal and a pasted prompt were four things a non-technical person can't be asked to do. Residual: Claude itself needs git to add a GitHub marketplace (macOS offers the developer tools once); listing Crewdeck in Anthropic's community plugin directory would remove that. |
| E14 | **Seamless Jobs** (owner: "there is no way to find in which session things are happening… make it seamless"): work stays isolated per lane (the Jobs chat in `~/Crewdeck/jobs` is the only one that reads postings), and the person never hunts for it: Find holds its request until a fresh fetch ends when sources are stale (`Request.hold`); a queued Jobs request with no Jobs chat connected opens one (`claude://code/new`, at most every 10 min, the real server only); `/api/today` reports the lane's activity and the panel shows it in any chat, with a toast when it ends. Claude desktop gives plugins no link into an existing chat, so the panel names the chat instead of opening it. | Clicking Find from a zivon-v2 chat sent the work to a chat the owner couldn't find. |
| E10 | **The panel never queues Jobs work.** Find, Prepare and Apply stay the Jobs page's own buttons (design §14: Jobs requests only from the page). The panel links to them. | The agent token must not become a way to start applications. |

## 3. Security

- E2 widens the Host allow-list by exactly one name, `crewdeck.localhost`, and the page origins by
  `http://crewdeck.localhost:<port>`. Page endpoints still need the exact origin and `Sec-Fetch-Site: same-origin`.
  `crew.deck` is accepted only when `address.names` in the config lists it (E3), never by default.
- `/api/today` and `/api/today/todo` are agent endpoints: the token, no browser Origin, like `/api/claim`. The mod
  calls them only after the server proved itself (`/api/hello`, as the bridge does). A to-do's text is one line,
  ≤ 300 characters, with no newline, written as `- [ ] <text>`; ticking names a line by its number and text (both
  must match), so a stale panel can't tick the wrong line.
- The service runs as the user, with the checkout and home it was installed from; its plist/unit is written 0644 under
  the user's own folders. `uninstall` removes exactly what `install` wrote.
- `address --short` writes files and prints commands; the person runs `sudo` themselves. The pf anchor redirects only
  `127.0.0.1:80` on `lo0` to the shell's port.

## 4. Phases

| Phase | What | Tests |
|---|---|---|
| E-a | Address (E2): Host/origin checks, CSP frame-src, every printed URL from one `pageUrl(c)`. `address.names` config. | http.test (hosts, origins), server/proxy tests with the new Host; setup/doctor lines |
| E-b | Service (E4) and `up`/`open` (E5). | plist/unit text, install/uninstall into a temp `HOME`, `up` on a busy port, `open` with a fake opener |
| E-c | Today API (E7–E9): journal to-dos, Jobs glance, tickets. | parse/add/tick to-dos (stale tick refused), tickets from fixture repos, endpoints need the token |
| E-d | Plugin 0.6.0: `/crewdeck`, the Today panel, the `crewdeck-open` skill. | `claude plugin validate`, `claude plugin test` on terminal and desktop surfaces, skills test |
| E-e | Short address (E3), onboarding: setup's last lines, README "Let Claude install it", first-run. | file text for pf/daemon/hosts, undo; docs |

## 5. Onboarding after this

1. Install Node and git (unchanged).
2. Paste the README prompt into a Claude Code session. Claude clones, runs `crewdeck setup` (which installs the plugin
   and, with the person's yes, the background service), and opens `http://crewdeck.localhost:4848`.
3. From then on: type `crewdeck.localhost:4848` in any browser, or `/crewdeck` in any Claude session.

## 6. Not in this version

- A signed Mac app (menu bar icon, Node packaged inside, "Open Crewdeck" at login). The service and `/crewdeck` cover
  the same needs for now.
- Starting the jobs-folder Claude session from the panel: no API starts a desktop session; the panel says what to do
  and copies the folder path.
- Windows.

## 7. Done (2026-11-20)

**Built:** E-a to E-e. `npm test`: Node 25 648 tests, 646 pass, 2 skipped; Node 22.18 648, 634 pass, 14 skipped.
`plugin/`: `claude plugin validate` passes, `claude plugin test` 3 pass (terminal and desktop surfaces), and it
type-checks with TypeScript 5.6 under the hooks-module tsconfig.

**Tests:** `test/everywhere.test.ts` (hosts and origins with and without the short address, the LaunchAgent and systemd
unit text, install/uninstall with a fake `launchctl`, the pf rule's scope and the printed steps, to-dos add/tick/refuse,
tickets, the Today endpoints' token rule); `plugin/tests/today.test.tsx` (the panel against a fake Crewdeck: the token
only after the hello's proof, ticking and adding, opening Notes and Jobs, starting Crewdeck when it isn't running, the
not-set-up state); `skills.test.ts` (the fifth skill, its commands exist, plugin 0.6.0).

**Rehearsal** (a throwaway home on ports 5471/5472, never the owner's): `crewdeck setup --no-plugin --no-service` prints
the new address; `crewdeck open jobs --print` started Crewdeck detached and printed `http://crewdeck.localhost:5471/#jobs`;
a second `crewdeck up` said "already running"; `crewdeck.localhost` answered 200 on the page and Notes ports and a
foreign Host 403; two to-dos added through `/api/today/todo` landed under `## To do` in the journal page; in Chromium
`http://crewdeck.localhost:5471/#notes/journal/2026-11-20` opened Notes on that page with both checkboxes, and `#jobs`
opened Jobs.

Fixed during the rehearsal:
1. `crewdeck open --print` took `--print` for the view.
2. `setup --no-plugin` still pointed at `/crewdeck`.
3. Every home shared one service name, so a second Crewdeck home's `service install` would have replaced the first's:
   the default home keeps `io.crewdeck.server`, any other gets `io.crewdeck.server.<hash>` (`serviceNames`).

**Not checked on a real machine yet:** `launchctl bootstrap` of the LaunchAgent and the pf redirect (both need the
owner's go-ahead: a LaunchAgent in their Library, and sudo), and the panel inside the Claude desktop app (needs plugin
0.6.0 installed in the owner's Claude config).

**Deviations:** E3's undo also flushes the anchor (`pfctl -a com.apple/crewdeck -F all`); the to-do endpoint names a
line by number and text (E7) and refuses a page edited since the panel drew.

**Security review** (an independent read of the diff; 3 medium, 6 low, all fixed, each with a test unless noted):
1. Two `crewdeck up` starting together could each rotate the token while only one listened, leaving the server with a
   token nobody had. Now one start per home: an exclusive lock file `run/up.lock` (a dead holder's lock is taken over).
2. `crewdeck.localhost` also resolves to `::1`, which the IPv4 redirect doesn't cover, so a program on `[::]:80` could
   answer at the trusted address. `address --short --done` refuses, and `doctor` warns, when anything answers on
   `[::1]:80`. (Residual, as before: whatever squats a port while Crewdeck is down.)
3. The files root loads were copied from a folder the user's processes can write. The printed steps now check the
   root-owned copies against the hashes Crewdeck computed before `launchctl bootstrap` loads them.
4. The bridge's curl put the token in its arguments (visible to `ps`). Headers, body and address now go on stdin
   (`curl --config -`); the plugin test asserts the arguments, and a real curl was checked with quotes and backslashes.
5. A FIFO or symlink in a board's `backlog/tasks` could block or leak through `ticketsOf`: regular files ≤ 256 KB only.
6. systemd escaping (`%%`, `$$`, quotes, backslashes).
7. A port change left the short address pointing at the old port: `address.port` records it, and the short address
   applies only while it matches (`effectiveAddress`); `up` and `doctor` say so.
8. A malformed `#…` link blanked the shell: decoding errors are ignored (not unit-tested; one line).
9. The background service exited for good when a manual `up` was running: under the service (`CREWDECK_SERVICE=1`) `up`
   waits and takes over when that one stops.

Checked and fine (the reviewer's words, summarised): the Host list is exact, the token endpoints refuse browsers, dates
can't traverse, to-dos can't add lines, the plist is escaped, the mod opens only `http://` addresses from a server that
proved itself.

**After the first release candidate** (2026-11-20, owner: "complete work… as if released to the public now"):
- Installed on the owner's Mac: the LaunchAgent runs Crewdeck at `http://crewdeck.localhost:4848` with their notes; a
  `kill -9` of the server was restarted by launchd within a second (Notes with it); `claude -p "/crewdeck"` through the
  installed plugin 0.6.0 answered "Crewdeck is open beside the chat." (the hello's proof and `/api/today` against the
  real server); the jobs session reconnected to the new server.
- E11 found in the browser pane: a plain `claude://` link inside the Jobs frame was blocked by the shell's CSP
  (`frame-src`), so the button asks the server instead (`openSession`), which ran `open` and returned 200.
- E12 found in a real SilverBullet: the vault's own `Library/Crewdeck/Setup.md` also sets `view.defaults` and won the
  race, so the managed page loads after it (`-- priority: -1`) and merges instead of replacing. On a brand-new vault
  SilverBullet applies the page from its second load (it indexes it on the first).
- A second review of this delta (no high findings): the panel now opens only a session link with Crewdeck's exact hello
  and an absolute folder (a forged answer could otherwise prefill other words); managed vault pages are written to a
  temp file and renamed, never through a planted symlink. Tests for both.
- Screenshots retaken: `jobs-setup-light.png` (Open in Claude), `notes-light.png` (file list, buttons, made-up to-dos).

**0.7.1** (2026-11-20): boards without a terminal (**Add this folder as a board** in the panel, a Boards help item in the
rail; the owner's FlightStack board, missing from a fresh config, added back), the panel's pages open in Claude
desktop's browser pane (`$.mcp.call('Claude_Browser', 'preview_start')`, else the default browser), `jobs/sources.md`
lists the sources in its body, **Update Crewdeck** in the panel when the running Crewdeck is older than the plugin
(`/api/today` reports `version`), and every screen fits small and short windows.
