# P7: security and quality review: findings and fixes

Three independent read-only reviews ran on `git diff 2261134..HEAD` (2026-11-19):
- web surface;
- code execution, supply chain and injection;
- correctness and hard rules.

Each finding below has an ID, a decision, and the pass that fixes it:
- **Pass A:** the trust boundary (web, bridge, agent workspace).
- **Pass B:** the pipeline and sources.

Every fix ships with a test that fails before it.

## The trust boundary, plainly
A process running as the user (including a prompt-injected Claude session with Bash) can send any HTTP header, so
**headers alone can never prove "a human clicked this"**. Crewdeck's controls therefore have three layers:
1. **Browsers:** Origin, Sec-Fetch-Site and JSON checks stop other web pages.
2. **Local agents:** the jobs workspace runs Claude's Bash in Claude Code's **sandbox**, with no loopback or network
   access, so an injected session can't reach Crewdeck's page endpoints or other local services. The `crewdeck`
   CLI is the one command allowed out, and it can only do what the agent endpoints allow.
3. **Human-only actions:** risky switches need a confirmation the agent can't give, a native system dialog shown
   by the server (terminal fallback). Whatever remains is documented as residual risk in the README.

## Findings

| ID | Sev | Finding | Decision | Pass |
|---|---|---|---|---|
| W1 | **critical** | SilverBullet's internal port takes cross-site `POST /.shell` (RCE) and DNS-rebinding reads; no Host/Origin/auth upstream (pre-existing on main) | Run SilverBullet with `SB_SHELL_BACKEND=off`. Make the upstream unreachable except through the proxy: a Unix socket if supported, else a random per-launch auth token the proxy adds. Regression test against the real binary when installed | A |
| W2 | high | Backlog.md's internal port takes cross-site `POST /api/tasks` (text/plain) | Make the upstream reachable only through the proxy (socket/auth if Backlog supports it; otherwise a random per-launch internal port + documented residual risk + upstream issue draft in the doc). Investigate `backlog browser --help` and source | A |
| W3/C1 | high | Page-only actions (feature switches, approve, Ask into any lane) accept forged Origin from local processes; `features` TTY check bypassable with `script` | Generated workspace settings enable Claude Code's Bash sandbox (no network; `crewdeck` CLI excluded). Risky switch changes need a native confirmation dialog (macOS osascript; Linux zenity/kdialog if present; else refuse and point to the terminal with a one-time code). `fromOwnPage`/`ownRead` also require `Sec-Fetch-Site` from browsers. Document the residual risk | A |
| W4 | high | Bridge and CLI send the token before the server proves itself; token never rotates | Challenge first: send a nonce only, verify `proof`, then authenticate. Rotate the token on every `up`; the mod re-reads it on proof failure | A |
| W5 | medium | Agent endpoints don't check lane/owner (show/done/fail/progress on any request) | Require `laneFor(cwd) === request.lane` (CLI sends cwd); progress no longer touches presence | A |
| W6–W10 | low | `__proto__`/inherited names; null JSON body 500; `ownRead` missing on state/requests; SSE slot exhaustion; one cap shared by all kinds | `Object.hasOwn`; object-body check; ownRead everywhere; HEAD without stream + token-or-browser for SSE; per-kind caps (apply its own) | A |
| C4 | high | Picked requests stuck forever after a crash; presence stays "connected"; no cancel | Lease: picked with no progress for 15 min goes back (tries+1). Presence = a claim in the last 10 s. **Cancel** action on the panel. The mod puts back in-flight requests on start | A |
| C12 | low | Server caches feature switches | Re-read on each action/view | A |
| C11 | low | Easy Apply on with `daily_quick_apply` 0 shows "off" | Distinct message and a default of 5 when switched on | A |
| E3 | medium | Fixed `'EOF'` heredoc in skills/bridge prompt lets text break out | Skills and prompts: untrusted text only through the Write tool into files; no heredocs for it | A |
| C9 | medium | "Add it anyway" lost on pages read in the pane | `pick --role <id> --request <rid>` reads force from the payload; the skill follows | A (skill) + B (code) |
| E1 | high | Provider sandbox has network (TCP incl. loopback, Unix sockets) | Child gets **no network**. Providers' fetch is served by the parent over a private pipe with `guardedFetch`. Sourcing requires Node ≥ 25 (the permission model denies network there); older Node refuses with a clear message | B |
| E2 | medium | `process.getBuiltinModule`, `module.registerHooks`, `vm`, WebAssembly bypass the hooks | Wrap and freeze `getBuiltinModule` with the denylist before the first import; deny `vm`/`module`; remove WebAssembly compile/instantiate | B |
| E9 | low | Provider can forge stdout protocol lines | Protocol on a dedicated fd; stdout ignored | B |
| E6 | low | Quadratic regex on 2 MB pages | Cap input (400 KB) / indexOf scanning | B |
| E8 | low | netguard misses 64:ff9b:1::/48, ::ffff:0:0:0/96, 198.18/15, 192.0.0/24 | Add them | B |
| E5 | low | `-file` flags read any path | Realpath under `<jobs.home>` or the workspace; refuse the token/config | B |
| C2 | high | `--force` and raw `status picked` bypass caps/cooldown | Force only from request payloads; status transitions restricted (no →picked/prepared by hand) | B |
| C3 | high | Citation check passes invented numbers (1,5 → 15; 5 month ≈ 5M; number words; non-English first person) | Locale-aware decimals, units attached to digits only, number words checked, sentence check uses only the user's sources unless a claim is explicitly about the company | B |
| C5 | medium | Pay: first amount wins ($4/hr differential); unlabelled 10k+ read as yearly | Skip differential/premium/shift words; description-derived pay never hard-drops; no period → drop only if every reading (year and month) is below | B |
| C6 | medium | Travel: any % in a travel sentence | Percentage within ~25 chars of "travel" only | B |
| C7 | medium | Industry words match boilerplate/negations | Hard drop only on company/title; description hits go to the judge | B |
| C8 | medium | Trailing-dot hosts bypass LinkedIn/X checks | Strip trailing dots everywhere hosts are compared | B |
| C10 | low-med | jobs/memory.md concurrent writes | Lock file + mtime check; unique-id validation | B |
| E4 | low-med | Leak scan gaps (NANP phones, UTF-16, commit bodies, new branches) | Add `%B`, UTF-16 decode, NANP pattern, new-branch range vs default branch | B |
| E7 | low | CI leak key visible to all tests; actions unpinned | Leak scan as its own step with the secret; actions pinned by SHA | B |

## Done

### Pass A (2026-11-19)

Research first (no guesses):
- **SilverBullet 2.12.1** (the installed binary, run only with a temp space): `SB_UNIX_SOCKET` is supported in `--single`
  mode and then no TCP port is opened at all; `SB_SHELL_BACKEND=off` answers `POST /.shell` with "Shell commands are
  disabled". `SB_AUTH_TOKEN`/`SB_USER` exist but a socket is stronger (no port for pages or rebinding at all). Socket
  paths must stay under ~100 bytes (`SUN_LEN`).
- **Backlog.md 1.55.3** (`backlog browser --help` and the bundled source in the binary): `Bun.serve({ port, hostname:
  "127.0.0.1", routes })`, no Unix socket option, no auth, no Host/Origin check, `POST /api/tasks` parses the body
  whatever its type.
- **Claude Code sandbox** (code.claude.com/docs/en/sandboxing, settings, permissions, schemastore schema): `sandbox.enabled`,
  `allowUnsandboxedCommands: false` (ignores `dangerouslyDisableSandbox`), `failIfUnavailable`, `excludedCommands` match
  the call's text (`cmd *`; a `cd`, redirect or `$(…)` keeps the call sandboxed), `network.allowedDomains`/`deniedDomains`
  (deny wins in every mode), `allowLocalBinding` off (macOS loopback), `filesystem.denyRead`/`denyWrite` with plain
  absolute paths. `strictAllowlist` (hard block instead of a prompt for unlisted hosts) is ignored in project settings:
  the README tells users to set it in `~/.claude/settings.json`.

| ID | What was done | Tests |
|---|---|---|
| W1 | `src/services.ts`: SilverBullet runs `--single <vault>` with `SB_UNIX_SOCKET=~/.crewdeck/run/notes.sock` (0700 folder; a private temp folder when the path is too long; a stale socket removed before each start) and `SB_SHELL_BACKEND=off`; `src/proxy.ts` targets a socket for HTTP and WebSocket upgrades | `test/hardening.test.ts`: socket folder, proxy over a socket (pages, POST, WebSocket, Origin/Host checks), **the real binary** (page through the proxy, `/.shell` disabled and nothing runs, no TCP listener; skips with a message when SilverBullet isn't installed) |
| W2 | Each board's internal port is chosen by the system per launch (`freePort`), not `boardPort + 100`; `/api/state` shows only public proxy ports. Residual risk documented in the README; upstream issue draft below | `test/hardening.test.ts` (W2) |
| W3/C1 | Generated `.claude/settings.json`: `sandbox` (enabled, failIfUnavailable, no unsandboxed retry, excluded only `~/.crewdeck/bin/crewdeck jobs\|request\|progress *`, no domains, loopback names denied, no local binding or Unix sockets, denyRead token and feature code, denyWrite config/token/queue/wrapper/run/tracker/state/providers/guard rails), `ask` for `jobs init`, deny rules for nc/socat/ssh/script/expect/osascript/open/xdotool. A managed wrapper `~/.crewdeck/bin/crewdeck` makes the CLI one plain word. `fromOwnPage` requires `Sec-Fetch-Site: same-origin`; `ownRead` refuses a browser without same-origin/none. Risky switches: `src/jobs/confirm.ts` native dialog (osascript with the text as argv, zenity, kdialog; timeout 2 min; never under `node --test`), one dialog at a time; no dialog → a one-time code on the page for `crewdeck jobs features …` in a terminal (HMAC under the token, 10 min, single use, 3 tries); the CLI also needs the dialog or that code | `test/jobs/setup.test.ts` (settings checked against a subset of the schemastore schema, `test/fixtures/claude-code-settings.subset.schema.json`), `test/jobs/confirm.test.ts`, `test/jobs/api.test.ts` (yes/no/unavailable, one dialog at a time, off/lower never ask), `test/server.test.ts` (W3) |
| W4 | `POST /api/hello` answers a nonce with `sha256(crewdeck-proof:<token>:<nonce>:<port>)` before any token is sent; the bridge (`verified()`) and the CLI (`verifyServer`) check it first and re-read the token once on mismatch; `crewdeck up` rotates the token | `test/hardening.test.ts` (a squatter and a relay to the real server on another port never see the token; rotation), `test/server.test.ts` (W4), `test/jobs/skills.test.ts` (the bridge sends hello without the token, the token only after `verified`) |
| W5 | show/progress/done/fail need `cwd` and `laneFor(cwd) === request.lane` (links resolved: macOS `/var` vs `/private/var`); the CLI sends `process.cwd()`; progress no longer marks presence | `test/server.test.ts` (W5), `test/requests.test.ts` (C4 presence) |
| W6–W10 | `Object.hasOwn` for commands, static files, vendor map, features, preference fields, hints; `readJson` refuses non-objects (400); `ownRead` on `/api/state` and `/api/requests`; SSE only for a same-origin browser or the token, HEAD never streams; caps per lane **and kind** | `test/server.test.ts` (W6–W8), `test/jobs/api.test.ts` (W6, W9), `test/requests.test.ts` (W10) |
| C4 | Lease: picked with no claim/progress from its session for 15 min goes back (tries+1, failed after 3), checked on claims, adds and the Jobs timer; presence = a claim in the last 10 s, the busy bridge claims with `take: false` every 4 s; **Cancel** on the apply panel (waiting and filling, with a "no session" hint); the bridge puts back what a previous load held on `session.start` | `test/requests.test.ts` (C4 ×3), `test/jobs/api.test.ts` (Cancel), `test/jobs/skills.test.ts` (heartbeat, requeue on start) |
| C12 | The Jobs API re-reads `jobs.features` from `config.yaml` (by mtime and size) on every view, action and `request show` context | `test/jobs/api.test.ts` (C11/C12) |
| C11 | "Easy Apply filling is on, but its forms per day is 0"; switching Easy Apply (or drafts) on with its number at 0 sets 5 (10) in the same confirmed change | `test/jobs/api.test.ts`, `test/jobs/confirm.test.ts` |
| E3 | Skills, the managed CLAUDE.md, the vault CLAUDE.md and the bridge prompt: untrusted text goes into files with the Write tool, never a heredoc or `echo`; `<T>` literal paths; one plain `crewdeck` call per Bash call (what the sandbox lets out) | `test/jobs/skills.test.ts` (E3; the command lint still covers every line) |
| C9 (skill) | jobs-workspace's `needs` path runs `crewdeck jobs pick --role <role id> --request <id>`: the "Add it anyway" override comes from the request's payload. **Pass B** adds the code in `commands.ts` that reads `force` from that payload (today `pick` ignores `--request`, so nothing is forced) | `test/jobs/skills.test.ts` (C9) |

Residual risks (also in the README): any process running as the user outside the sandbox can forge page headers and
reach the board ports; a web page spraying every local port could still create a board task (Backlog.md has no
socket or auth); the sandbox prompts (rather than hard-blocks) for unlisted hosts unless the user sets
`strictAllowlist` in their own settings; the excluded `crewdeck` wrapper runs unsandboxed with any `jobs` arguments
(it can only do what the CLI and agent endpoints allow; `jobs init` asks); sessions outside the jobs workspace have no
sandbox from Crewdeck; Linux needs bubblewrap and socat or Bash refuses to run in the workspace.

Upstream issue draft (Backlog.md, not filed: the owner decides):
> **`backlog browser`: protect the local API from other sites.** The browser server binds 127.0.0.1 with no Host or
> Origin check and no auth, so any web page can `fetch('http://127.0.0.1:6420/api/tasks', { method: 'POST', mode:
> 'no-cors', body: '{"title":"…"}' })` and DNS-rebinding pages can read tasks. Please (1) refuse requests whose `Host`
> isn't `localhost`/`127.0.0.1`/`[::1]`, (2) refuse state-changing requests with a foreign `Origin` or
> `Sec-Fetch-Site: cross-site`, and ideally (3) support `--unix-socket <path>` (Bun.serve's `unix` option) or a
> per-launch token for embedders that proxy it.
