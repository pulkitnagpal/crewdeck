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
(filled in by the passes)
