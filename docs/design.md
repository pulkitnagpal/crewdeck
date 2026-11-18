# Crewdeck — design

Status: approved direction (2026-11-17), stage 1 in build. Changelog at the end.

## Intent

One workspace, inside Claude desktop, where a solo builder and their Claude agents work on the same things:
tickets, notes and memory, plus any other local web app you plug in. It opens in Claude desktop's browser pane next
to the chat. Humans click and edit; agents read and write the same files; requests from the page reach the
right Claude session.

**Reuse first.** Mature open-source tools do the heavy UI; Crewdeck is the glue:

| Need | Tool (license) | How Crewdeck uses it |
|---|---|---|
| Notes, memory, backlinks, graph | [SilverBullet](https://silverbullet.md) 2.12 (MIT) | Run as-is over the vault folder behind its own proxy port (its own origin), themed with a Space Style page |
| Tickets, kanban, milestones | [Backlog.md](https://github.com/MrLesk/Backlog.md) 1.55 (MIT) | One `backlog browser` per project, themed through a small CSS-injecting proxy; agents use its CLI/MCP |
| Agents | Claude Code (desktop app) | Sessions do the work; a Claude Code plugin bridges page requests to sessions |

## Non-goals and anti-goals

- No new note editor or kanban: if SilverBullet or Backlog.md does it, use theirs.
- No cloud service, accounts or telemetry: everything binds to 127.0.0.1.
- Agents never submit, send, post or pay on the user's behalf (forms, email, social posts): they prepare, the human clicks.
- No personal data in the repo: the vault and your projects live outside it.

## Layout on disk

```
crewdeck/                  this repo (open source)
  src/                     CLI + server (Node ≥ 22, TypeScript run directly)
  web/                     the shell page (thin: nav rail, frames, agent strip)
  themes/                  backlog.css (injected), the SilverBullet theme page
  vault-template/          a starter vault in the LLM-wiki layout
  plugin/                  Claude Code plugin: bridge mod + skills (stage 2)
~/.crewdeck/               per-user, never in git
  config.yaml              vault path, projects, ports
  bin/silverbullet         downloaded binary (pinned version)
  data/                    SilverBullet data folder, logs
<vault>/                   the user's notes (plain Markdown; also opens in Obsidian)
  CLAUDE.md                the schema: how agents maintain the vault
  raw/                     things the human clips (never edited by agents)
  wiki/                    pages Claude writes and links; index.md, log.md
  me/                      profile, preferences ("what Claude knows about you")
  journal/                 one note per day
  projects/<name>/         notes per project
<project repo>/backlog/    each project's tickets (Backlog.md files, committed with the code)
```

Memory follows Karpathy's LLM-wiki pattern: `raw/` is the source of truth, `wiki/` is maintained by Claude
(ingest → summary + linked pages + `index.md` + `log.md`; query from the index; weekly lint), the human reads
and steers in SilverBullet (or Obsidian, same files).

## Runtime

`crewdeck up` starts, on 127.0.0.1:
- **Shell** on `PORT` (default 4848): the page and `/api/*` (page endpoints: same-origin only; agent endpoints: the
  token in `~/.crewdeck/token`).
- **Notes**: a proxy on `silverbullet.port` (default 4849) → SilverBullet `--single` on the vault (internal port
  `silverbullet.port + 100`).
- Per project: **`backlog browser`** (internal port) behind a **theme proxy** (public port) that injects
  `themes/backlog.css` into its HTML and passes everything else through, WebSockets included.

The supervisor restarts a child that exits, and stops all children on exit.

## Agents and requests (stage 2)

- The plugin's mod gives each Claude session a lane from its working folder: a project folder → `project:<name>`;
  else `cockpit`. It claims requests for its lane only while idle, and puts back unfinished ones at turn end
  (idle-only delivery, put-back, bounded retries).
- Requests come from the shell (Ask Claude, Start agent on ticket) and from Backlog.md's `onStatusChange` hook
  (ticket moved to In Progress → `start` request on the project lane).
- Skills: `memory` (ingest / query / lint the vault), `board` (work a ticket in a worktree, keep its status and
  notes current).

## Stages

1. Shell + supervisor + proxies + theme + vault template + README/setup. **Done when** `crewdeck up` shows
   Notes and a project Board, themed, in Claude's browser pane, and edits from disk appear live.
2. Plugin: lane bridge, request queue, ticket → agent, memory skills.

## Left to the builder

Exact ports, theme values, process restart backoff, and log format.

## Changelog

- 2026-11-18: security baseline (Jobs P0, see `docs/jobs/`): Notes on its own origin; page vs agent endpoints with a
  token and a bridge identity proof; Host allowlist incl. `[::1]` and Origin checks on every proxy; crash-proof handler;
  queue caps; private `~/.crewdeck`; leak scan in tests and CI; system fonts (no Google Fonts).
- 2026-11-18: one look everywhere: the palette lives in `src/appearance.ts`; `appearance: auto` (new default) follows
  the system, i.e. Claude desktop's light/dark; `light`/`dark` force it in the shell, boards and Notes. Notes gets
  the palette from its proxy at first paint and its own dark-mode switch through a managed `Library/Crewdeck/Appearance.md`;
  the Crewdeck Dark theme page now actually applies (it lost to SilverBullet's own dark rule before).

- 2026-11-18: bridge shipped (basic): request queue on the shell (`/api/requests`, `/api/claim`, `/api/requeue`, `requests.json`), lane from the session's folder, `crewdeck-bridge` mod in `plugin/` with idle-only delivery and put-back; Ask Claude box in the shell.
- 2026-11-17: apps in the rail (any local web app, optional `command`), `appearance` applied to all tools, project `label`; theme selected automatically via `Library/Crewdeck/Setup`.
- 2026-11-17: first version. Name Crewdeck chosen; reuse SilverBullet + Backlog.md; repo private until the demo.
