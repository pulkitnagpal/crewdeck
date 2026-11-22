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

### Pass B (2026-11-19)

Research first: Node 25.9's permission model without `--allow-net` refuses `net.connect` (TCP and Unix sockets),
`dns.lookup` and `node:http` with `ERR_ACCESS_DENIED`, but wrapping an inherited fd (`new net.Socket({ fd: 3 })`) works,
so a private channel needs no network grant; on 22/24 there is no `--allow-net` and the network is outside the model.
career-ops' `_http.mjs` at the pinned commit calls the global `fetch` (default parameter `fetchImpl = fetch`, read at
call time) with `redirect: 'error'` by default and recognises a refused redirect by `cause.message === 'unexpected
redirect'`; replacing the global `fetch` before the first import is enough. The old runner, run against the new
fixture providers, opened TCP, DNS, `node:http` and a loopback fetch, ran `vm`, `module.registerHooks` and WebAssembly,
and stored a job forged on stdout; the old memory writer lost 31 of 40 items to eight concurrent writers.

| ID | What was done | Tests |
|---|---|---|
| E1 | `runnerArgs` never passes `--allow-net`. `sandboxSupport()` (`providers.ts`): Node ≥ 25 with `--allow-net` in `allowedNodeEnvironmentFlags`, else a reason ("need Node 25 or newer … pasted links, Prepare and Apply work"); `spawnRunner` rejects, `runProviders`/`runSources` report `providers: { ran: false, why }`, `doctor` warns. The runner replaces the global `fetch` with one that sends `{ url, method, headers, body (base64), redirect }` on fd 3, reads the answer on fd 4 and builds a `Response` from the answer (`url`, `redirected`, null-body statuses, undici's error shapes). The parent's `answerFetch` uses `guardedFetch` (now with `method`/`body`, browser-like 303/301/302 handling, `statusText`): 10 MB per body (career-ops' own cap), 15 s, 5 redirects, GET/HEAD/POST, POST ≤ 1 MB, hop-by-hop and `host` headers dropped, `redirect: 'error'` → "unexpected redirect", ≤ 8 in flight, 2000 requests and 256 MB per run. CI adds Node 25 | `test/jobs/sources.test.ts` (E1 ×4: Node gate for 24/22/25-without-flag/25; refusal on the running Node < 25, skipped on 25; `evil-net` gets `ERR_ACCESS_DENIED` for TCP, DNS, Unix socket and `node:http`, `blocked` for a loopback fetch, and its POST to a fixture host arrives through the parent; the bridge itself on any Node: POST body, headers, redirect modes, loopback redirect, scheme, method, budget). Sandbox tests skip with the reason on Node < 25 |
| E2 | `lockDownRuntime()` right before the first provider import: `process.getBuiltinModule` replaced by a non-writable, non-configurable wrapper with `DENIED_BUILTINS` (`vm`, `module`, `worker_threads`, `child_process`, `inspector`, `wasi`, …); the fetch classes loaded, then `WebAssembly.compile/compileStreaming/instantiate/instantiateStreaming/Module/Instance/validate` deleted and the namespace frozen | `evil-escape`: `getBuiltinModule('vm')`, `('node:module').registerHooks`, `child_process`, `worker_threads`, redefining or assigning `getBuiltinModule`, `WebAssembly.compile`, `new WebAssembly.Module`, `WebAssembly.instantiate`, `import('node:vm')` all refused; `fs` still works. Fitness: the lock-down sits right before the first import |
| E9 | The protocol moved to fd 3 (a socket pair, `stdio[3]`; fetch answers come back on fd 4), lines `<nonce> <json>` with a 24-byte nonce per run sent on stdin (read before any provider loads, kept in a closure, never on a global), written with a `writeSync` captured before any provider loads (fd 3 stays blocking; EAGAIN waits), so no patched prototype sees the nonce; the parent drops lines without it (counted as `bad`) and keeps stdout+stderr only as a 4000-character log tail | `evil-forge` writes jobs to stdout, the console, `fs.writeSync(3)` and a second `Socket({ fd: 3 })` (and a fake `done`): only its honest job is stored |
| E6 | `text.ts`: `plainText` caps input at `HTML_MAX` (400 000 characters) and strips script/style blocks and tags with indexOf/one-regex-from-lastIndex scans; `elements()`/`after()` helpers. `link.ts` (page capped at 400 KB; meta tags, JSON-LD scripts and `<title>` found linearly; attribute strings ≤ 4000) and `linkedin.ts` (`parseSearch`, `parseDetail`) use them | `test/jobs/link.test.ts` (E6): twelve 2 MB adversarial pages through `readPostingPage`, `plainText`, `parseDetail`, `parseSearch`, each under 1 s (the old code took 28 s on one), plus ordinary pages unchanged |
| E8 | netguard also blocks `192.0.0.0/24`, `198.18.0.0/15`, the documentation nets `192.0.2/24`, `198.51.100/24`, `203.0.113/24`, `::ffff:0:0:0/96` (IPv4-translated), `64:ff9b:1::/48` (local-use NAT64) and `2001:db8::/32` | `test/jobs/netguard.test.ts` (E8), with neighbours that stay open |
| E5 | `src/files.ts`: `checkedPath`/`readChecked` take the real path (links resolved) and require it under `<jobs.home>` or the jobs workspace; Crewdeck's token and `config.yaml` are refused even inside them; regular files only; files to write need an existing folder there; `extraRoots` is the explicit option for tests. Used by every `crewdeck jobs` file flag (`textFrom`, `--value-file`, `draft --brief`/`--answers`). `crewdeck request done --result-file` / `progress --text-file`: the same rule when run in the jobs workspace, elsewhere never Crewdeck's own files. Skills, the vault `CLAUDE.md` and the tests write to `<jobs home>/out/tmp` | `test/jobs/cli.test.ts` (E5 ×2: outside files, the vault, a link pointing out, the token/config/a link to the token with `jobs.home` set to Crewdeck's home, `--brief` outside, `progress`/`request done` in and out of the workspace; the checker's roots, extra root, write mode, non-files) |
| C2 | No `--force` on the command line: `pick` and `link` refuse it with a pointer to the page's "Add it anyway". `setRoleStatus` follows `MANUAL_MOVES`: new/bench → bench, new, skipped, expired, judged_out; picked → prepared, bench, skipped, expired, judged_out; prepared → skipped, expired, judged_out; skipped/expired/judged_out → new; applied and prefiltered_out → nothing (`applied` only via `jobs applied`, `picked` only via `pick`, prefiltered roles via `refilter`). The workspace `CLAUDE.md` says so | `test/jobs/pipeline.test.ts` (C2), `test/jobs/cli-request.test.ts` (C9/C2) |
| C9 | `pick --role <id> --request <rid>` reads the link request (`kind: link`, open), checks that the role's URL is the request's posting (`checkRoleUrl`), and passes the payload's `force === true` to `pickPasted`; the `needs` text in `link.ts` names it | `test/jobs/cli-request.test.ts` (C9/C2: warnings without the override, `--force` refused with and without a request, a forced request can't pick another role, it picks the right one "despite: …") |
| C3 | `kb/cite.ts`: numbers compared by value. Separators: one comma or dot + 1–2 digits is a decimal ("1,5" = 1.5), groups of three are thousands, two kinds → the last is the decimal, "1.2.3" stays as written; an ambiguous "1,500"/"1.500" takes the text's own unambiguous style, else both readings. k/m/mm/mn/mio/b/bn only when attached and not followed by a letter, and "5 million"/"3 thousand" multiply. Number words: English one–ninety, dozen, hundred…billion (compounds like "three hundred and twenty", "forty-five"); German, French, Spanish and Portuguese counts that are not also everyday words or articles (no "ein", "un", "once", "sept", "cent", "dos", "mil", "neuf"); plurals ("hundreds") need a count in range; "no one", "one of", "one-on-one" are not counts. Every sentence is checked against the user's own sources (facts, memory, profile from any claim); a sentence may also use the posting only when it is or contains a company claim citing the posting and is not in the English first person (an extra check, not the gate) | `test/jobs/cite.test.ts` (C3 ×4: "1,5" vs 15 both ways, 1.5 = 1,5, German thousands; "5M" vs "5 month", 5M = 5 million, 50K = 50,000; number words in five languages, "no one", "hundreds"; third-person and German sentences get no posting numbers) |
| C5 | `findPayText` skips amounts next to differential(s)/diff/premium(s)/uplift; `PayResult.from` says where the text came from and `payDrops` never drops on description-derived pay (still shown and ranked); with no period, ≥ 10 000 is read as a year **and** a month and drops only when every reading is below (`unclear` when they disagree), smaller amounts stay `unclear` | `test/jobs/pay.test.ts` (C5 and the updated floor cases) |
| C6 | `travelLevel` takes a percentage only within 25 characters of a "travel…" word | `test/jobs/rules.test.ts` (C6) |
| C7 | The industry rule matches the company name and title only; description hits go to the judge (its brief already lists the excluded industries); `describeRules` says so | `test/jobs/rules.test.ts` (C7, and the drop cases moved to company/title) |
| C8 | `cleanHost` (lowercase, no brackets, no trailing dots) behind `hostOf`, `isXHost`, `isLinkedinHost`, `isLinkedinJobUrl`, `applyUrl`, `linkedinJobId`, `link`, `checkLink`, the guard proxy and the apply panel; `checkRoleUrl` stores the host without the dot | `test/jobs/hosts.test.ts` (C8) |
| C10 | `memory.ts`: every read-modify-write (`remember`, `retire`, `undoRemember`) holds `.memory.md.lock` next to the note (`O_EXCL`, taken over after 30 s, waits up to 10 s), re-reads and starts over (3 tries) when the note's mtime or size changed before the rename (an editor's save is kept); new ids skip any id already in the note; duplicate ids were already refused by validation | `test/jobs/memory.test.ts` (C10 ×3: 8 processes × 5 items all land with unique ids; an edit between read and write is kept; a stale lock is taken over; duplicate ids refused) |
| E4 | `scripts/leak-scan.mjs`: `%B` in the commit format; `textOf` decodes UTF-16 with a BOM (LE/BE) or without (zero-byte parity) and reads UTF-16LE runs in binaries; a NANP pattern (area code and exchange 2-9, one separator style, nothing glued on; the fictional 555-01xx and 1234567 numbers allowed); every blob the range adds is read (`rev-list --objects` + `cat-file`); a range from the all-zero sha becomes `<default>..<after>` (`LEAK_SCAN_DEFAULT_BRANCH`, `origin/HEAD`, `origin/main`, `origin/master`, `main`, `master`) or the whole branch | `test/leak-scan.test.ts` (E4 ×4: a body, four UTF-16 shapes, five NANP shapes found and thirteen look-alikes not, a new branch whose UTF-16 file was added and removed) |
| E7 | CI: the leak scan is its own step and the only one with `LEAK_SCAN_KEY` (range from the event, default branch for new branches); tests run with `node --test` without it; `actions/checkout@11d5960a326750d5838078e36cf38b85af677262` and `actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020` (both v4.4.0, from `git ls-remote`), `persist-credentials: false`; matrix 22, 24, 25 | `test/leak-scan.test.ts` (E7) |

Residual risks (pass B): a provider can still make requests to public hosts through the parent (within the caps) and
return misleading postings (each is validated); it could read another provider's fetch answers in the same child; the
sandbox is Node's permission model (not an OS sandbox) and depends on Node ≥ 25. The citation check reads numbers and
named terms, not meaning: a claim with no number or term in it is only as true as its cited sources. A process that
doesn't take the memory lock and writes within the same mtime tick as Crewdeck's rename can still be overwritten (the
editor case is covered by the mtime check). Outside the jobs workspace, `request done`/`progress` files are refused
only when they are Crewdeck's own (those sessions have no sandbox from Crewdeck anyway). The leak scan's NANP pattern
skips bare 10-digit numbers by design.
