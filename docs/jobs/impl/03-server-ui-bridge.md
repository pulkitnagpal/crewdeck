# P3: the server, the Jobs page, the apply panel, the request lane and the bridge

Part of [the Jobs design](../design.md): read §2 (all journeys, especially 2.2, 2.3, 2.3a, 2.5–2.9), §5 D2/D4/D10/D11/D13/D16,
§9, §11, §12, §14 and §22 row P3 first. Rules for every implementer: [README.md](README.md). P2a/P2b left the interfaces this
phase uses: the view models in `src/jobs/views.ts`, `link`/`readForm`/`renderResume`/`searchLinkedin` taking plain objects,
`openDb(…, { server: true })`.

## 1. Scope
- **Queue** (`src/requests.ts`): typed requests (`kind`, `ref`, `payload`, `progress`), dedupe of open requests on
  `(lane, kind, ref, payload)`, payloads cleared on close, lane `jobs`, presence (each lane's last claim), reconcile
  (open requests of applied/skipped roles close), `needs you` closing for apply.
- **Server** (`src/jobs/api.ts`, mounted from `src/server.ts` only when `jobs.enabled`, loaded lazily): views, page actions,
  agent endpoints for request payloads and progress, SSE, resume download and "Show in Finder".
- **Request-scoped CLI**: `crewdeck jobs link|answer|fill-plan --request <id>`, `crewdeck jobs request show <id>`,
  `crewdeck progress <id> --text-file f`.
- **UI** (`web/jobs/`): Preact + htm from `node_modules` through an explicit file map; Today (queue, role detail, apply
  panel), Applications, What Claude knows, Preferences, Settings, setup card, top bar (Find, Add link, agent strip),
  banners.
- **Shell**: Jobs in the rail when enabled, `/jobs/` same-origin; "Open in Notes" switches the shell to Notes.
- **Bridge**: per-lane hint, typed requests printed as kind, ref and payload keys only.

Not in P3: skills (`jobs-workspace`, `jobs-setup`, …) and `jobs init` (P4), sourcing/Find's real work and Refresh sources
(P5). Find and Setup only queue requests here.

## 2. Modules and API

| File | What |
|---|---|
| `src/requests.ts` | `Request` gains `kind?`, `ref?`, `payload?`, `progress?`; `add(lane, text, typed?)`; `progress(id, text)`; `get(id)`; `presence(lane)` / `markSeen(lane)`; `reconcile(statusOf)`; `latest(lane, kind, ref)`; `onChange(fn)`; `JOB_KINDS`; `laneFor` returns `jobs` for `jobs.workspace` (checked before projects) |
| `src/server.ts` | `/jobs/*` static (explicit file map + importmap CSP hash), `/api/jobs/*` delegated to the Jobs API, agent endpoints `/api/requests/<id>/show` and `/api/requests/<id>/progress`, claim returns `hint` and typed requests as `{ id, kind, ref, keys }` |
| `src/jobs/api.ts` | `createJobsApi(config, requests, opts)` → `{ handle(req, res, url), contextFor(request), close() }` |
| `src/jobs/panel.ts` | `applyPanel(role, request, presence)`: the apply panel's state from the role and its latest apply request (pure) |
| `src/jobs/features.ts` | `RISK` texts and feature metadata (shared by the CLI and Settings) |
| `src/jobs/requests-cli.ts` | `request show`, and the `--request` variants of `link`, `answer`, `fill-plan` |
| `src/agent-client.ts` | `agentCall(path, body)`: the token-bearing call the CLI makes to the running server |
| `src/jobs/edit.ts` | `setFields(file, note, changes[], opts)`: several fields, one validation, one atomic write (`setField` uses it) |
| `web/jobs/` | `index.html`, `jobs.css`, `app.js`, `api.js`, `lib.js`, `screens/{today,apply,applications,knowledge,preferences,settings,setup,topbar}.js` |
| `web/shell.js` | Jobs in the rail (own icon), the "open in Notes" message from the Jobs frame |
| `plugin/hooks/register.tsx` | hint + typed requests |

### Request kinds and payloads (P4 skills read these with `crewdeck jobs request show <id>`)
| kind | ref | payload | Created by | Claude closes it with |
|---|---|---|---|---|
| `setup` | — | `{}` | Set up with Claude | `done` (summary) or `fail` |
| `find` | — | `{ count: 1..20 }` | Find N jobs | `done` ("N picked") |
| `link` | — | `{ url, force? }` | Add link | runs `crewdeck jobs link --request <id>`, then `done`/`fail` |
| `apply` | role id | `{ role }` | Apply (enabled when every required question is answered) | `done` with `needs you: <question>`, `submitted: <what Claude saw>` (confirmation page), or anything else (stopped at Review/Submit: "your turn"); `fail` with the reason (sign-in, CAPTCHA, restricted, limit) |
| `improve` | role id | `{ role, field_id, question: "Q3", instruction }` | Ask Claude on an answer | `crewdeck jobs answer --request <id> --text-file f --claims-file f`, then `done` |

`request show` prints `{ id, lane, kind, ref, status, payload, context }`; `context` adds the role (company, title, url,
apply_url, how Apply works) for `apply`/`improve`, and the field (label, current text, options) for `improve`.

### Page endpoints (exact own Origin, `Sec-Fetch-Site: same-origin` when sent, JSON body)
`POST /api/jobs/action/<name>`: `find`, `addLink`, `approve`, `retryApply`, `improve`, `editAnswer`, `answer`
(first-time: `{ role, field_id, text | option }`, or `{ role, request, text }` for a `needs you` question no field holds),
`notInterested`, `markApplied`, `select`, `prefs` (`{ changes: { path: value } }`), `feature` (`{ name, value }`),
`setup`, `reveal` (macOS only).

`GET /api/jobs/{state,today?role=,applications,knowledge?tab=,preferences,settings}`, `GET /api/jobs/events` (SSE),
`GET /api/jobs/resume/<role>[?download=1]`. GETs refuse a `Sec-Fetch-Site` other than `same-origin`/`none`.

### Agent endpoints (token, no Origin)
`POST /api/requests/<id>/show`, `POST /api/requests/<id>/progress` (`{ text }`), plus P0's claim/requeue/done/fail.

## 3. Decisions
1. **The generic Ask box can't reach `jobs`**: `Requests.add('jobs', text)` without a kind throws; only the Jobs API's
   actions create jobs requests, each validated per kind. The Ask box on the Jobs view stays `cockpit`.
2. **Typed request text** is a fixed label ("Apply to a role"), never posting text; the shell's `/api/requests` list
   shows payload keys only. The claim response carries `keys`, not the payload, so a payload value can't reach the
   bridge prompt even by mistake.
3. **Dedupe** is on open requests only: same lane, kind, ref and canonical JSON payload returns the existing request.
   Closing clears `payload`; `progress` (Claude's own lines, at most 50 × 300 chars) and `result` stay.
4. **Presence** is in memory: a lane is "connected" when its last claim (or a progress line on one of its requests) is
   under 10 s old, or one of its requests is being worked on (a busy session doesn't claim). The SSE stream announces
   when it flips.
5. **Reconcile** runs when the Jobs API starts, on every DB change (`PRAGMA data_version`) and after the server's own
   Mark applied / Not interested: open jobs requests whose ref is an applied or skipped role close as done with
   "Nothing to do: this role is already applied|skipped".
6. **Needs you → apply again**: when the user answers on the page (`answer`, `editAnswer`, `firstTimeChoice`) and the
   role's latest apply request closed with `needs you:` and every required question now has an answer, the server
   queues `apply` again (design §2.3a step 4). A `needs you` question that Claude did not record with `learn` is
   answered through `learnField` with the question from the result.
7. **Apply panel states** (`panel.ts`): `ready`, `copy`, `waiting` (+ `connected`), `filling` (progress lines),
   `needs_you`, `your_turn`, `confirmation`, `stopped` (reason), `applied`. The page can't focus another tab of
   Claude's pane: **Open the form** opens the application URL in a new tab and the panel says Claude's tab is next to
   this one (deviation from "brings that tab to the front").
8. **Copy mode** (copy-only sites, LinkedIn with Easy Apply off): Apply shows the answers to copy and the posting; no
   request is queued.
9. **Preferences** save all changed fields with one `setFields` call (one validation, one atomic write, one Changes line
   per field quoting `"(set on the Jobs page)"`); only the fields on the form are accepted. Validation errors come back
   per field path and nothing is written.
10. **Feature switches** change only through `POST /api/jobs/action/feature` (a page click; agents can't send an own
    Origin) or the TTY CLI; the in-memory config is updated so gates apply at once. Switching one on shows its risk text
    and needs a second click.
11. **Resume**: `/api/jobs/resume/<role>` with a strict `^[a-f0-9]{12}$` id, the file realpath'd inside
    `<jobs.home>/out/`, `application/pdf`, `inline` (or `attachment` with `?download=1`), `nosniff`. "Show in Finder" runs
    `open -R <that path>` through `execFile` on macOS only; elsewhere the button is hidden.
12. **SSE** `/api/jobs/events`: one `refresh` event (topics `db`, `notes`, `queue`, `presence`), coalesced over 150 ms;
    sources: `PRAGMA data_version` every 500 ms, `fs.watch` on `me/` and `jobs/` (re-armed when the folders appear), the
    server's own writes and queue changes. At most 20 clients; a comment line every 25 s keeps it open.
13. **Busy database**: a `SQLITE_BUSY` from the 250 ms server timeout answers 503 `{ error: "busy, retry" }`; the page
    retries once after 500 ms.
14. **Lazy**: `src/server.ts` imports `src/jobs/api.ts` only when `jobs.enabled`; `node:sqlite` loads only when that
    module opens the tracker.
15. **UI delivery**: `/jobs/vendor/{preact,hooks,htm}.mjs` map to exact files in `node_modules` (no directory serving);
    `web/jobs/` files are served from a list of allowed extensions inside that folder; `index.html`'s importmap is
    hashed into the page's CSP at serve time. Screens are pure (props in, callbacks out) so they render in Node for tests.
16. **Open in Notes**: links point at the Notes port and page; inside the shell the Jobs frame asks the shell (a
    same-origin `postMessage`) to switch to Notes on that page instead of navigating the frame.
17. **Bridge hint** comes from the server's claim answer (`hint`, e.g. "Use the jobs-workspace skill."), so the mod has
    no Jobs knowledge.

## 4. Test plan
- Queue: typed add, dedupe (same payload in another key order), caps and rate limit, payload cleared on close, progress cap,
  presence, reconcile, the jobs lane refused without a kind, `laneFor` jobs before projects.
- API: every new POST refuses a missing/foreign Origin, cross-site `Sec-Fetch-Site`, a non-JSON body and an agent token;
  agent endpoints refuse the page; per-kind validation (bad URL, X, LinkedIn off, unknown role, applied role, unanswered
  required questions); features only via the page POST; `prefs` writes the note and a Changes line, refuses invalid
  values without writing; reconcile on Mark applied; needs-you answer re-queues apply; busy → 503.
- SSE: an event after another connection writes the DB and after a note changes on disk.
- Resume route: traversal and bad ids refused, a PDF served inline with nosniff.
- UI: preact-render-to-string for every screen and every apply-panel state with fictional data; a grep test for
  `innerHTML`/`dangerouslySetInnerHTML`/`insertAdjacentHTML`/`document.write` in `web/jobs`.
- CLI: `--request` refuses a request of the wrong kind or a closed one; `progress` and `request show` through a live
  server in a temp home.
- Bridge: `claude plugin validate plugin`.

## Done
Built as planned in §2, with the decisions in §3.

- **Code:** `src/requests.ts` (typed requests, dedupe, progress, presence, reconcile, `RequestError`, jobs lane),
  `src/server.ts` (lazy Jobs, `/jobs/` static, `show`/`progress` agent endpoints, claim `hint` + payload keys only),
  `src/http.ts` (shared send/readJson/page/agent checks, `ownRead`, the Jobs CSP), `src/agent-client.ts`,
  `src/jobs/{api,panel,static,features}.ts`, `src/jobs/edit.ts` `setFields`, `src/jobs/commands.ts` (`request show`,
  `link|answer|fill-plan --request`), `src/cli.ts` (`progress`, `request show`), `src/appearance.ts` (warn/ok/bad background
  tokens shared by the shell and Jobs), `web/jobs/**` (index, CSS, app, api, lib, screens: topbar, banners, setup, today,
  apply, applications, knowledge, preferences, settings), `web/shell.js` (Jobs in the rail, open-in-Notes message),
  `plugin/hooks/register.tsx` (hint, typed requests as kind/ref/keys, `jobs request show`). `claude plugin validate plugin`
  passes (only the directory's "no icon" note, as before).
- **Deps:** `preact` 10.29.8, `htm` 3.1.1 (exact); dev `preact-render-to-string` 6.8.2. `npm audit` clean.
- **Tests:** `test/requests.test.ts` (+3), `test/server.test.ts` (+2: node:sqlite never loaded with Jobs off, claim hint),
  `test/jobs/api.test.ts` (16: page vs agent on every action, reads, static files and CSP hash, lane/dedupe/claim/show/
  progress/done, LinkedIn gate, features, apply and copy mode, needs-you re-apply, first-time/edit/improve, reconcile incl.
  a CLI write, preferences, busy 503, resume route and reveal, SSE on DB/note/queue, banners and setup),
  `test/jobs/cli-request.test.ts` (4, a live server and child CLIs), `test/jobs/ui.test.ts` (7: every screen and every
  apply-panel state rendered from the real view models, escaping, the no-innerHTML/no-inline-style grep). Whole suite: 295
  tests, green with the leak scan.
- **Checked by eye** (a throwaway Crewdeck on ports 6848/6850 with a temp home, the example person and fictional roles in
  every state): the rail, Today, every apply-panel state, answering a needs-you question (Apply queued again, memory
  written), Applications, What Claude knows, Preferences (an invalid currency refused per field, a valid change written with
  its Changes line), Settings (confirm, then on), the setup card and the no-session banner; light and dark; the browser-pane
  width (~720 px) and wide. Fixed from it: the top bar wraps into two rows below 1280 px, link buttons, switch contrast in
  dark, one SSE stream for the page's life. Screenshots: `docs/img/jobs-*.png`.

**Deviations and notes**
- "Open the form" opens the application address in a new tab: a page can't bring another tab of Claude's pane to the
  front. The panel says Claude's tab is next to this one.
- The Ask box on the Jobs view stays `cockpit` (no jobs "ask" kind).
- Preferences edits lists one entry per line (places like "Cambridge, MA" keep their commas).
- "Add it anyway" (a link Claude could not pick because of a warning) re-sends the address the page itself remembers for
  that request, with `force: true`; the server never keeps a closed request's payload.
- `request show` is a token POST (`/api/requests/<id>/show`) like the other agent endpoints.
- `test/jobs/web-guard.test.ts` now ignores `import type … from 'node:http'` (the Jobs API's types make no requests).
- A broken note that was never valid counts as missing for the setup card; one with a last valid version shows a banner.
- Deferred: Refresh sources and Find's real work (P5; Find only queues a `find` request now), the skills that work these
  requests (P4).
