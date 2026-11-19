# Crewdeck — design

Status: stage 1 (workspace), the bridge and the Jobs module built; "start an agent on a ticket" not yet. The Jobs module
has its own design: [jobs/design.md](jobs/design.md). Changelog at the end.

## Intent

One workspace, inside Claude desktop, where a solo builder and their Claude agents work on the same things:
tickets, notes and memory, a job search, plus any other local web app you plug in. It opens in Claude desktop's browser
pane next to the chat. Humans click and edit; agents read and write the same files; requests from the page reach the
right Claude session.

**Reuse first.** Mature open-source tools do the heavy UI; Crewdeck is the glue:

| Need | Tool (license) | How Crewdeck uses it |
|---|---|---|
| Notes, memory, backlinks | [SilverBullet](https://silverbullet.md) 2.12 (MIT) | Run as-is over the vault folder on a private Unix socket, behind its own proxy port (its own origin), themed with a Space Style page |
| Tickets, kanban | [Backlog.md](https://github.com/MrLesk/Backlog.md) 1.55 (MIT) | One `backlog browser` per project behind a CSS-injecting proxy; agents use its CLI |
| Agents | Claude Code (desktop app) | Sessions do the work; the `crewdeck` plugin bridges page requests to sessions and carries the skills |
| Job boards | [career-ops](https://github.com/career-ops-hq/career-ops) providers (MIT) | Downloaded at a pinned commit, hash-checked, run in a sandboxed child |

## Non-goals and anti-goals

- No new note editor or kanban: if SilverBullet or Backlog.md does it, use theirs.
- No cloud service, accounts or telemetry: everything binds to 127.0.0.1.
- Agents never submit, send, post or pay on the user's behalf (forms, email, social posts): they prepare, the human clicks.
- No personal data in the repo: the vault, `~/.crewdeck` and your projects live outside it, and a leak scan guards it.

## Architecture

```
Claude desktop
├── chat: Claude Code sessions, each with the crewdeck plugin (bridge mod + skills)
│     ├── a session in a project folder      → lane project:<name>
│     ├── a session in the jobs workspace    → lane jobs     (Claude Code's sandbox; one CLI let out)
│     └── any other session                  → lane cockpit
│           the bridge claims its lane's requests only while the session is idle, with the token
└── browser pane → http://localhost:4848  (one Node process: `crewdeck up`)
      ├── shell server  /  /api/*  /jobs/  /api/jobs/*        page endpoints (same-origin) · agent endpoints (token)
      ├── Notes proxy   :4849 → SilverBullet --single on a Unix socket in ~/.crewdeck/run (no TCP port, shell off)
      ├── board proxies :4858… → backlog browser per project on a random internal port (theme CSS injected)
      └── supervisor: restarts children that exit, stops them on exit; logs in ~/.crewdeck/logs
```

- **Shell server** (`src/server.ts`): the page (`web/`), the request queue's HTTP face, `/api/state`, and the Jobs API and
  UI when Jobs is enabled (`src/jobs/api.ts`, `web/jobs/`, loaded lazily with `node:sqlite`). Every response has a
  strict CSP (`script-src 'self'` plus the import map's hash), `nosniff` and `Cross-Origin-Resource-Policy: same-origin`;
  a top-level try/catch turns any bad request into a 400.
- **Notes** (`src/services.ts`, `src/proxy.ts`): SilverBullet listens on `SB_UNIX_SOCKET` (paths kept under the
  `sun_path` limit) with `SB_SHELL_BACKEND=off`. Its proxy is the only door; it injects the theme at first paint.
- **Boards**: each `backlog browser` gets a fresh internal port per start (`freePort`), never shown to pages; its proxy
  on `port + 10 + i` checks Host and Origin and injects `themes/backlog.css`.
- **Jobs**: in-process API over a SQLite tracker (WAL, busy timeout 250 ms, "busy, retry" on contention), live updates
  over SSE from `PRAGMA data_version`, `fs.watch` on the job notes and the queue. Heavy work (sourcing, form reading,
  PDFs) runs in `crewdeck jobs …` CLI processes. A timer fetches sources every `jobs.fetch_every`.
- **The plugin** (`plugin/`): the bridge mod (`hooks/register.tsx`) and the skills `jobs-workspace`, `jobs-setup`,
  `jobs-daily-run`, `crewdeck-memory`. Marketplace manifest: `.claude-plugin/marketplace.json` (the repo is its own
  marketplace).
- **One look**: the palette lives in `src/appearance.ts`; `appearance: auto|light|dark` applies to the shell, Jobs, the
  boards (injected CSS) and Notes (a managed `Library/Crewdeck/Appearance.md`).

### The bridge: token, proof, idle-only delivery

1. `crewdeck up` writes a new 64-hex token to `~/.crewdeck/token` (0600) on every start.
2. Before sending it, the bridge (and the CLI) posts a nonce alone to `POST /api/hello`; the server answers
   `sha256("crewdeck-proof:<token>:<nonce>:<port>")`. Only a matching proof lets the token leave; on a mismatch the
   bridge re-reads the token once (Crewdeck restarted). A port squatter never sees it.
3. The bridge claims with its session's cwd every 2 s while the session is idle, and every 4 s while it is busy with
   `take: false` (a heartbeat: presence, nothing delivered). Requests are delivered only to an idle session, as one prompt that names
   ids, kinds and payload keys, never payload values: Claude reads those with `crewdeck jobs request show <id>`.
4. Whatever the session held and didn't close at turn end goes back to the queue (`/api/requeue`); a new load puts back
   what a previous load held.

## Data layout

```
crewdeck/ (this repo)      src/ (CLI + server, TypeScript run directly)  web/ (shell, Jobs UI)  plugin/  themes/
                           vault-template/  presets/jobs/  examples/jobs/ (fictional)  docs/  test/  scripts/
~/.crewdeck/ (0700)        config.yaml (0600)   token (0600)   requests.json (the queue)   logs/   run/ (Notes socket)
                           bin/silverbullet (pinned)   bin/crewdeck (managed wrapper: this checkout + this home)
~/.crewdeck/jobs/ (0700)   jobs.db (tracker)   out/<role>/ (PDFs, scratch)   out/tmp/ (Claude's files)
                           providers/<commit>/ (read-only, hash-checked)   state/ (last-valid notes, sources run)
                           CLAUDE.md + .claude/settings.json (the jobs workspace: managed, rewritten on init and up)
<vault>/                   CLAUDE.md (rules for agents)   raw/   wiki/   journal/   projects/<name>/
                           me/profile.md  me/career.md  me/preferences.md
                           jobs/search.md  jobs/memory.md  jobs/sources.md   Library/Crewdeck/ (theme, appearance)
<project repo>/backlog/    each project's tickets (Backlog.md files, committed with the code)
```

User knowledge is notes in the vault (plain Markdown with YAML frontmatter, written with comments and key order kept,
replaced atomically, validated with a last-valid fallback). Machine state is in `~/.crewdeck`. Crewdeck writes its own
files with explicit modes (folders 0700, files 0600) and refuses a group- or world-writable home.

## Requests: lanes and lifecycle

A request: `{ id, lane, status: new|picked|done|failed, kind?, ref?, payload?, progress?, result?, tries }`
(`src/requests.ts`), stored in `~/.crewdeck/requests.json`, written only by the server.

- **Lanes.** `jobs` for a cwd inside `jobs.workspace` (checked first), `project:<name>` for a project folder or its
  worktrees, else `cockpit`. The Ask box makes plain-text requests for `cockpit` and project lanes only; `jobs` takes
  only typed requests that the Jobs page's own actions create after validating the payload (`setup`, `find`, `link`,
  `apply`, `improve`). The same open `(lane, kind, ref, payload)` returns the existing request.
- **Caps.** 20 open and 30 adds a minute per lane **and kind** (plain text is its own kind), so a pile of links never
  blocks an Apply. Open requests are never trimmed; closed ones are kept 30 days; payloads are cleared on close.
- **Claim → picked.** Only by the token, for the caller's lane.
- **Progress.** `crewdeck progress <id> --text-file f`: the last 50 lines per request, shown live on the page.
- **Close.** `crewdeck request done|fail <id> --result-file f`. An apply that needs the user closes `done` with
  `needs you: …`; Claude's "your turn" and `submitted: …` results drive the apply panel. Request-scoped agent calls
  (show, progress, done, fail) carry the caller's cwd and must come from the request's lane.
- **Put back and retries.** Unclosed at turn end → back to `new` (tries + 1); failed after 3 tries.
- **Lease.** A picked request with no claim or progress from its session for 15 minutes goes back to the queue (a
  crashed session); checked on claims, adds and the Jobs timer.
- **Presence.** "Claude connected" = a claim from the lane in the last 10 s. A picked request or a progress line is not
  presence.
- **Cancel.** The page can cancel a waiting or stuck request (closed as failed, "Cancelled on the page").
- **Reconcile.** Open requests for a role that is applied or skipped are closed on start and on every tracker change.

## Threat model and controls

Assets: notes with personal data, answers, the user's signed-in browser sessions, their machine and Claude usage.
Attackers: (a) another web page or local web app, (b) a malicious posting or page read by Claude, (c) compromised
upstream code, (d) a repo reader, (e) a local process squatting the port. The full table is
[Jobs design §14](jobs/design.md#14-threat-model-and-controls); the findings and fixes are in the
[security review](jobs/impl/07-security-review.md).

| Threat | Control |
|---|---|
| DNS rebinding (a) | Host allowlist `localhost`, `127.0.0.1`, `[::1]` on every port, proxy forward and WebSocket upgrade |
| Cross-site requests and prompt minting (a) | Page endpoints: exact Origin, `Sec-Fetch-Site: same-origin`, JSON body; reads refuse a browser without same-origin Fetch Metadata; agent endpoints need the token; no CORS; Notes and boards on their own origins; Jobs requests only from the Jobs page's own actions |
| Notes as a way in (a) | SilverBullet on a private Unix socket, no TCP port, shell backend off |
| Boards as a way in (a) | Random internal port per start, never shown. Residual: Backlog.md has no socket or auth |
| Port squatting (e) | Challenge first: the server proves the token (port-bound hash) before anyone sends it; the token rotates on every `up` |
| A prompt-injected Claude (b) | Postings are data: request ids and `--*-file` flags only, never text in a shell command; files only inside Jobs' home or workspace, never the token or config; the jobs workspace runs Bash in Claude Code's sandbox (no network, loopback denied, no unsandboxed retry, Crewdeck's files unreadable/unwritable, only the `crewdeck` wrapper let out) plus deny rules; risky switches need the user's click in a native dialog or a page-issued code; caps, cooldowns and status moves enforced in code, no `--force` |
| Never submit, never send | `fill-plan` never emits submit or review actions and skips password/CAPTCHA fields (code); the skills stop at the review page (prompt). Email is drafts only (no send path) |
| Invented experience | Fact ids validated; a citation check compares numbers by value and checks each sentence against the user's own sources; anything unsupported becomes a first-time question |
| SSRF from pasted links and headless reading | `netguard`: http(s) only, every resolved address checked and the connection pinned, private and special ranges blocked, 5 re-checked redirects, 15 s, 2 MB; Chromium goes through an in-process guard proxy |
| Compromised providers (c) | Pinned commit, full import closure hash-checked at download and load, allow-list, a child with Node's permission model and no network (Node 25+), its fetches made by the parent through netguard, frozen built-ins, no WebAssembly, a nonce'd private channel |
| XSS | Preact escaping, no `innerHTML` with data (grep test), http(s) hrefs only, CSP |
| Leaks (d) | Fictional people only in tests, fixtures, examples and screenshots; `scripts/leak-scan.mjs` on every test run and in CI (generic PII patterns, an HMAC denylist keyed by a CI secret, history of pushed commits) |

Residual risks (also in the README): a process running as the user outside the sandbox can forge any header and reach
the board ports; a page spraying local ports could create a board task; in the browser pane "never submit" and "open only
the role's pages" are prompt-level rules; the sandbox prompts for unknown hosts unless `strictAllowlist` is set in the
user's own settings; sessions outside the jobs workspace have no sandbox from Crewdeck; providers can still make public
requests through Crewdeck and return misleading postings; the citation check reads numbers and named terms, not meaning.

## Stages

1. Shell + supervisor + proxies + theme + vault template. **Done.**
2. Bridge: request queue, lanes, idle-only delivery. **Done.**
3. Jobs module (P0–P8, [jobs/design.md §22](jobs/design.md#22-work-breakdown)). **Done**, pending the owner's
   acceptance run.
4. Next: "start an agent on this ticket", memory skills for the wiki ([roadmap](roadmap.md)).

## Left to the builder

Exact ports, theme values, process restart backoff, and log format.

## Changelog

- 2026-11-19: P8 docs: this document rewritten as the architecture overview (the shell, Notes on a socket, boards, Jobs,
  the bridge's token and proof, data layout, request lifecycle, threat model); README, first-run guide, CHANGELOG and
  roadmap for new users; the repo validated as a plugin marketplace from a local checkout.
- 2026-11-19: Jobs module built (P0–P7, see [jobs/design.md](jobs/design.md#changelog)): SilverBullet on a Unix socket
  with its shell off, random internal board ports, challenge-first handshake with a rotating token, leases, presence,
  Cancel, per-kind caps, the jobs workspace sandbox, native confirmation for risky switches.
- 2026-11-18: security baseline (Jobs P0, see `docs/jobs/`): Notes on its own origin; page vs agent endpoints with a
  token and a bridge identity proof; Host allowlist incl. `[::1]` and Origin checks on every proxy; crash-proof handler;
  queue caps; private `~/.crewdeck`; leak scan in tests and CI; system fonts (no Google Fonts).
- 2026-11-19: the plugin is renamed `crewdeck` (0.3.0): the bridge mod plus skills (`crewdeck-memory` and the Jobs
  playbooks `jobs-workspace`, `jobs-setup`, `jobs-daily-run`). Token and proof unchanged.
- 2026-11-18: one look everywhere: the palette lives in `src/appearance.ts`; `appearance: auto` (new default) follows
  the system, i.e. Claude desktop's light/dark; `light`/`dark` force it in the shell, boards and Notes. Notes gets
  the palette from its proxy at first paint and its own dark-mode switch through a managed `Library/Crewdeck/Appearance.md`;
  the Crewdeck Dark theme page now actually applies (it lost to SilverBullet's own dark rule before).
- 2026-11-18: bridge shipped (basic): request queue on the shell (`/api/requests`, `/api/claim`, `/api/requeue`, `requests.json`), lane from the session's folder, `crewdeck-bridge` mod in `plugin/` with idle-only delivery and put-back; Ask Claude box in the shell.
- 2026-11-17: apps in the rail (any local web app, optional `command`), `appearance` applied to all tools, project `label`; theme selected automatically via `Library/Crewdeck/Setup`.
- 2026-11-17: first version. Name Crewdeck chosen; reuse SilverBullet + Backlog.md; repo private until the demo.
