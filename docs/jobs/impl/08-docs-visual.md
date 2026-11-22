# P8: docs, visual check, fresh-clone proof

From design §22's P8 row: README (setup, safety, terms of service), `docs/design.md`, CHANGELOG, roadmap, screenshots.
Exit check: owner sign-off; a PR description ready, nothing pushed and no PR opened (the owner decides).

## 1. Plan

Inventory first: the README, `docs/design.md`, `examples/jobs/`, `presets/jobs/`, `plugin/`, `crewdeck --help` and
`crewdeck jobs --help` (run with a temp `CREWDECK_HOME`), the Done sections of P0–P7 and the residual risks in
[07-security-review.md](07-security-review.md). Every command, flag, path and default in the docs is checked against the
code (`src/cli.ts`, `src/config.ts`, `src/jobs/cli.ts`, `src/jobs/setup.ts`, `src/jobs/features.ts`).

| # | Deliverable | Where |
|---|---|---|
| 1 | README for a brand-new user: features (Notes, Boards, Jobs, the plugin), requirements (Node ≥ 22.18; Node ≥ 25 for job-board sourcing and why), quick start from zero, where knowledge lives, presets, daily use, changing preferences, adding a source, a custom rule, LinkedIn and other risky switches, appearance, safety and terms of service, security model and residual risks, troubleshooting | `README.md` |
| 2 | Top-level architecture: shell server, SilverBullet on a Unix socket, Backlog boards, Jobs API/UI, the plugin bridge (token + proof, idle-only delivery), data layout, request lanes and lifecycle, threat model and controls (short, linking to the Jobs design §14 and the P7 review) | `docs/design.md` |
| 3 | Keep a Changelog entry for users: 0.3.0 (Unreleased) with the breaking changes | `CHANGELOG.md` |
| 4 | Roadmap: what is deferred and what is never planned | `docs/roadmap.md`, linked from the README |
| 5 | A complete fictional example, linked from the README | `examples/jobs/` (Sam Example) + its README pointing at the two journey people |
| 6 | Visual check in the real shell: temp home, temp vault with a fictional person, `crewdeck up` on ports outside 4747-4949, the in-app browser pane; rail, Notes over the socket proxy, a Board, Jobs screens, light and dark, no CSP errors; screenshots refreshed | `docs/img/`, §2 below |
| 7 | Fresh-clone proof: clone this repo into a scratch folder, `npm ci && npm test` on Node 25 and Node 22.18 | §2 below |
| 8 | PR description (not opened) | `08-pr-description.md` |
| 9 | Design changelog line, §22 P8 marked done, leak scan green, one commit (never pushed) | `docs/jobs/design.md` |

Decisions:
- The README stays one file and keeps its voice (plain, short sentences, no marketing). Jobs detail that a user doesn't
  need on day one links to the Jobs design.
- `examples/jobs/` stays Sam Example (the tests use it as the `example` person); the Berlin analyst and the US nurse
  stay in `test/fixtures/jobs/people/` and the example README points at them rather than copying them (one copy to keep
  valid).
- The plugin is `crewdeck` **0.4.0** today (0.3.0 renamed it in P4; P7 bumped it for the challenge-first handshake). The
  CHANGELOG says both.
- Screenshots come only from a temp home seeded with fictional people; the browser pane's URL is `localhost`, and pages
  that show paths (the no-session banner, Settings) are checked for real home paths before saving.

## 2. Done

### Built (2026-11-19)

| # | What | Where |
|---|---|---|
| 1 | README for a brand-new user, in the existing voice: what's in it, requirements (Node 25 for sourcing and why), quick start, plugin install (local checkout and GitHub, removing `crewdeck-bridge`), where knowledge lives, presets, daily use, changing preferences, adding a source, a custom rule (`judge_notes`, `avoid`, `exclude_title_words`, `rules:` overrides), risky switches with their limits, appearance, safety and terms of service, security model and residual risks, troubleshooting, config, screenshots | `README.md` |
| 2 | First run in Claude desktop, step by step (do / see / if not), with "starting fresh" (move `~/.crewdeck` and the vault aside, never delete; remove the old plugin and marketplace) | `docs/jobs/first-run.md` |
| 3 | Architecture overview: shell, Notes on a socket, boards, Jobs, the plugin, the bridge's token + proof + idle-only delivery, data layout, request lanes and lifecycle (caps, leases, presence, Cancel, reconcile), threat model and controls, residual risks | `docs/design.md` |
| 4 | Keep a Changelog: Unreleased 0.3.0 with the breaking changes; earlier `main` history by date. `package.json` version 0.3.0 | `CHANGELOG.md` |
| 5 | Roadmap: built, next, deferred (old-data import, Windows, multi-user, Backlog.md bind/auth upstream, a coded filler, Jobs in its own process, pane URL allow-listing, sourcing on 22/24, interview prep) with triggers; never planned | `docs/roadmap.md` |
| 6 | The example's README: what each note shows, a "try it" with a throwaway home (run), the two journey people | `examples/jobs/README.md` |
| 7 | Plugin install without pushing: `.claude-plugin/marketplace.json` already lists `crewdeck` at `./plugin`; `claude plugin validate .` and `./plugin` pass (one advisory warning: no icon). Installed into a **throwaway** `CLAUDE_CONFIG_DIR` (never the owner's config): `claude plugin marketplace add <checkout>` → `claude plugin install crewdeck@crewdeck` → `crewdeck@crewdeck` 0.4.0 enabled, read from the checkout. The migration too: GitHub marketplace + `crewdeck-bridge@crewdeck` 0.1.0, then `uninstall crewdeck-bridge@crewdeck`, `marketplace remove crewdeck`, `marketplace add <checkout>`, `install crewdeck@crewdeck --config port=4848` | §1 deliverable list; README |
| 8 | Visual check (below), two fixes with tests, screenshots refreshed | `web/jobs/jobs.css`, `src/jobs/panel.ts`, `test/jobs/ui-layout.test.ts`, `test/jobs/ui.test.ts`, `docs/img/` |
| 9 | Fresh-clone proof (below) and the PR description (not opened) | `08-pr-description.md` |

### Visual check

Two temp homes in the scratchpad, never `~/.crewdeck` or the owner's vault, on ports outside 4747-4949: a new user
(`crewdeck init` → `jobs init` with the real provider download, 137 providers / 166 files verified) on 5878, and Sam
Example (`examples/jobs`, seeded roles: two prepared, two applied, three new; a demo project with four tasks) on 5858.
`crewdeck up` from the checkout; opened in Claude desktop's in-app browser pane (light and dark emulation, 1440, 900 and
640 wide). A stand-in for the bridge's heartbeat (a token claim with `take: false` every 4 s) gave "Claude connected";
the apply request was claimed with the token and its progress posted with `~/.crewdeck/bin/crewdeck progress` from the
jobs workspace, as Claude would.

Checked and fine: the rail shows Notes, Jobs and the Board in one theme, light and dark; Notes (SilverBullet over its
socket and proxy) loads and matches; the board loads, themed; Today, the apply panel in waiting / filling (live progress)
/ your turn, Applications, What Claude knows, Preferences, Settings and the first-run setup card render; paste-a-link
queues a `link` request ("Link sent to Claude", status "1 waiting", the fee37b9 fix); a LinkedIn link is refused while the
switch is off; **Find 3 jobs** queues a `find`; `crewdeck doctor` reads the running server; no CSP errors from
Crewdeck's own pages (headless pass collecting console errors).

Found and fixed:
- **The top bar wrapped "Find N jobs" onto a row of its own** at desktop widths (1281–1500 px) whenever Claude's status
  ("Claude is working (2 waiting): …") or the sources line was long: the strips sized to their text before the row
  could wrap. They now shrink to an ellipsis first (`flex: 1 1 160px` / `140px`, right-aligned; the narrow-pane layout
  unchanged), and "Refresh sources" never breaks. `test/jobs/ui-layout.test.ts` lays the page out in a real headless
  Chromium at 1368 and 900 px (fails before the fix; skipped without a browser).
- **The "your turn" panel repeated itself**: the skill closes an apply with "Your turn: review the form tab and click
  Submit, then I submitted it", which the panel printed under its own identical title. `applyPanel` now drops that stock
  sentence and shows only what follows it (the resume upload, a skipped field); `test/jobs/ui.test.ts`.

Seen and left alone:
- The browser pane refuses every service worker (a plain page on another port fails the same way), so Notes logs
  "Failed to register a ServiceWorker" and a follow-on `flashNotification` error there. Notes works without it; the README
  and first-run guide say it is harmless.
- `/favicon.ico` is a 404 on the shell (a console line in headless Chromium only).
- At 640 px the tabs take a row and Find its own; that is the narrow layout's design.
- One screenshot's PNG bytes contained a phone-shaped printable run; the leak scan caught it and the file was re-encoded
  (the scan was not changed).

Screenshots (1440×900 at 2×, headless Chromium against the running instances, temp paths shown as the defaults):
`jobs-today-light`, `jobs-filling-dark`, `jobs-narrow-light`, `jobs-preferences-dark`, `jobs-applications-light`,
`jobs-settings-light`, `jobs-setup-light`, `notes-light`, `board-dark` (`docs/img/README.md`). Every process started was
stopped and the browser pane tab closed.

### Fresh-clone proof

`git clone` of the local repo into a scratch folder, `git checkout feat/jobs-module` (`810a5db`), `npm ci && npm test`
(leak scan first), then the clone deleted:

| Node | Tests | Pass | Skip | Fail |
|---|---|---|---|---|
| 25.9.0 | 434 | 432 | 2 | 0 |
| 22.18.0 | 434 | 425 | 9 | 0 |

Skipped on both: the manifest rebuild (needs `CAREER_OPS_CHECKOUT`); on 25 the "refuses below 25" check; on 22.18 the
eight provider-sandbox tests, each with its reason. `npm ci`: 0 vulnerabilities.

### Not done, and why

- Owner sign-off and the acceptance run as a new user: the owner's (the docs are written for it).
- No PR opened and nothing pushed (the rules). The PR description is ready.
- The plugin wasn't installed into the owner's real Claude config: validated and installed into a throwaway config only.
- The GitHub install path (`pulkitnagpal/crewdeck`) serves `main`, which still has `crewdeck-bridge`; `crewdeck@crewdeck`
  installs from GitHub only after the merge. The local-checkout path works today.
- Risky-switch toggles were not clicked in the pane (that would show a native dialog on the owner's desktop); covered by
  `test/jobs/api.test.ts` and `confirm.test.ts`.
