# Crewdeck

> 🚧 **Under construction.** The workspace and the bridge work; agent automation (start an agent on a ticket, memory
> skills) is still being built. Expect rough edges and breaking changes.

**Your one-person company, inside Claude desktop.** Notes, memory, tickets and your Claude agents in one
workspace that opens next to the chat. You click and decide; agents read and write the same files.

Crewdeck builds almost nothing itself. It wires together mature open-source tools:

| | Tool | Why |
|---|---|---|
| Notes · memory · backlinks · graph | [SilverBullet](https://silverbullet.md) (MIT) | Obsidian-style Markdown notes in the browser; plain files on disk |
| Tickets · kanban · milestones | [Backlog.md](https://github.com/MrLesk/Backlog.md) (MIT) | Tickets are Markdown files in each project's repo; agents use its CLI/MCP |
| Agents | [Claude Code](https://claude.com/claude-code) desktop app | Sessions do the work; Crewdeck shows it in Claude's browser pane |

Everything runs on your machine, bound to `127.0.0.1`. No accounts, no cloud, no telemetry.

<!-- Screenshots go here: add docs/img/*.png and reference them. -->

## How it works

```
Claude desktop
├── chat with Claude (sessions = your agents)
└── browser pane → Crewdeck  http://localhost:4848
     ├── Notes  → SilverBullet over your vault folder (Markdown, also opens in Obsidian)
     ├── Board  → Backlog.md for each project (tickets live in the project's repo)
     └── Apps   → any other local web app you add (a dashboard, a tracker, your own tool…)
```

### Two-way: the page talks to your Claude sessions

Crewdeck is a normal local web app. The **bridge** is a small Claude Code plugin (a *mod*) that runs inside each
Claude session:

```
Crewdeck page ── "Ask Claude about this…" ──► request queue (lane per project)
                                                   │  the bridge mod in the session whose folder
                                                   ▼  matches that project claims it while idle
                                      Claude session (project:myapp) does the work
                                                   │
Crewdeck page ◄── result shows up ─── `crewdeck request done <id> --result-file <file>`
```

A session inside a project's folder (or one of its worktrees) owns `project:<name>`; any other session owns
`cockpit`. Requests are only delivered while a session is idle, unfinished ones go back to the queue at the end of
a turn, and a request that keeps failing is marked failed after three tries. The bridge and Crewdeck share a secret
token (`~/.crewdeck/token`), so only your own Claude sessions can pick up or close requests, and the bridge checks
that it is really talking to Crewdeck before it delivers anything.

Your memory follows the [LLM-wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f):
you save sources to `raw/`, Claude maintains `wiki/` (summaries, links, `index.md`, `log.md`), and `me/` holds
what Claude knows about you, in your own words. The vault's `CLAUDE.md` tells agents the rules.

## Setup (macOS or Linux)

You need Node.js 22.18 or newer, git, `unzip`, and the [Claude desktop app](https://claude.ai/download).

```bash
git clone https://github.com/pulkitnagpal/crewdeck.git
cd crewdeck
npm install
```

```bash
node src/cli.ts init
```

This writes `~/.crewdeck/config.yaml` and the bridge token (both private to you), downloads SilverBullet (pinned
version) to `~/.crewdeck/bin/`, and creates your vault at `~/Crewdeck/vault` (change it with `--vault <path>`).

Add each project you work on (it must be a git repository):

```bash
node src/cli.ts add-project myapp ~/code/myapp
```

This creates the project's board (`backlog/` in the repo, columns To Do · In Progress · Needs you · Done) and a
notes folder for it in your vault.

Start it:

```bash
node src/cli.ts up
```

Open **http://localhost:4848** in Claude desktop's browser pane (or any browser). Notes, boards and your
apps share one look. By default it follows Claude desktop's own light/dark setting; set `appearance: light` or
`appearance: dark` in the config to force one everywhere, Notes included.

Check your setup any time with `node src/cli.ts doctor`. Logs are in `~/.crewdeck/logs/`.

Notes open on their own port (4849 by default), boards on theirs; the page links to them for you.

### Install the `crewdeck` plugin (the bridge and the skills)

In a terminal Claude Code session:

```
/plugin install crewdeck --marketplace pulkitnagpal/crewdeck
```

In the desktop app: + next to the prompt box → Plugins → Add marketplace `pulkitnagpal/crewdeck` → add
**crewdeck**. Start a new session in a project folder: its status line shows `Crewdeck · project:<name>`.
Type in **Ask Claude about this…** on that project's board and the request arrives in that session.

The plugin was called `crewdeck-bridge` before 0.3.0: if you installed that, uninstall it and install `crewdeck`.
Besides the bridge it carries the skills: `crewdeck-memory` (remember what you say, in any session) and the Jobs
playbooks below.

Optional: `npm link` in the Crewdeck folder puts `crewdeck` on your PATH. The skills write `crewdeck …`; without the
link they use `node <path-to>/crewdeck/src/cli.ts`, which the jobs workspace's `CLAUDE.md` names for you.

### Jobs (in progress)

```bash
node src/cli.ts jobs init                      # or: jobs init --preset remote-any-country | onsite-city | healthcare-us | non-engineering
```

This switches Jobs on, creates your job notes in the vault (it never overwrites a note you have), the tracker in
`~/.crewdeck/jobs/`, and the jobs workspace's `CLAUDE.md` and `.claude/settings.json` (hard rules and deny rules for the
Claude session that works Jobs; rewritten on every `init` and `up`). It checks for a Chromium-based browser and tells you
how to install one. Then open a Claude session in the workspace folder it prints, open Crewdeck → Jobs and click
**Set up with Claude**. `node src/cli.ts doctor` shows what is missing. Job-board sourcing is not built yet; pasted links,
Prepare and Apply work.

### Config

`~/.crewdeck/config.yaml` (created by `init`):

```yaml
port: 4848                 # the Crewdeck page
vault: ~/Crewdeck/vault    # your notes
appearance: auto           # auto (follow the system / Claude desktop) | light | dark, applied to every tool
projects:                  # added by `crewdeck add-project`
  - name: myapp
    path: ~/code/myapp
    label: Board           # what the nav shows (default: "Board" with one project, else the name)
apps:                      # optional: other local web apps to show, started for you if `command` is set
  - name: dashboard
    label: Dashboard
    url: http://localhost:4747/
    command: node
    args: [src/cli.ts, web]
    cwd: ~/code/my-dashboard
```

Apps that read an `?appearance=auto|light|dark` query parameter can follow Crewdeck's theme.

Notes follows the setting through `Library/Crewdeck/Appearance.md` in your vault, which Crewdeck rewrites on every
start (change the config, not that page). After switching from `light`/`dark` to `auto`, reload Notes once.

### Run it from the Claude desktop app

Add this to `.claude/launch.json` in any folder you open in Claude Code, then ask Claude to "start crewdeck":

```json
{
  "version": "0.0.1",
  "configurations": [
    { "name": "crewdeck", "runtimeExecutable": "node", "runtimeArgs": ["<path-to>/crewdeck/src/cli.ts", "up"], "port": 4848 }
  ]
}
```

## Working with agents

- **Tickets:** ask Claude in a project session to "take TASK-3". It updates the ticket with the Backlog.md CLI
  (`backlog task edit 3 -s "In Progress" -a @claude`) and the board updates live. Put work that needs your
  eyes in **Needs you**.
- **Memory:** "ingest raw/2026-11-17 brief.md", "what do we know about pricing?", "remember I prefer short answers".
  Claude follows the vault's `CLAUDE.md`.

## Security

- Everything binds to `127.0.0.1`. Every Crewdeck port (the page, Notes, each board) refuses requests whose `Host`
  isn't `localhost`, `127.0.0.1` or `[::1]`, which blocks DNS-rebinding pages.
- Notes and each board run behind their own proxy port, so each is its own origin: a note's scripts can't call the
  Crewdeck page's API. Through a proxy, only that tool's own pages (or a non-browser client) can change anything.
- The page's API only takes requests from the page itself (exact origin, same-origin fetch, JSON). The endpoints
  your Claude sessions use need the token in `~/.crewdeck/token` (0600). No endpoint sends CORS headers.
- `~/.crewdeck` is private (0700). Requests are capped (20 open per lane, 30 a minute).
- SilverBullet and Backlog.md listen on internal ports behind the proxies with no accounts, because only your
  machine can reach them. Other programs on your machine can; don't expose the ports.
- The repo is scanned for personal data on every test run and in CI (`scripts/leak-scan.mjs`).
- Agents edit your notes and tickets; review what they change like any other code (your vault and repos are git-friendly).

## Roadmap

- [x] Stage 1 — workspace shell, SilverBullet notes, Backlog.md boards, one theme, starter vault
- [x] Bridge — Claude Code mod: page requests reach the session that owns the lane, results come back to the page
- [ ] Stage 2 — "start an agent on this ticket" (moving a card starts a worktree session), memory skills
      (ingest / query / lint), agent status on cards
- [x] Apps — show any local web app in the same rail, with the same theme

Design notes: [docs/design.md](docs/design.md).

## License

MIT. SilverBullet and Backlog.md are MIT-licensed projects by their own authors; Crewdeck runs them unmodified.
