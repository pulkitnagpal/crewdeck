# Crewdeck — design

Status: approved direction (2026-11-17), stage 1 in build. Changelog at the end.

## Intent

One workspace, inside Claude desktop, where a solo builder and their Claude agents work on the same things:
tickets, notes and memory, and (optionally) job applications. It opens in Claude desktop's browser pane next
to the chat. Humans click and edit; agents read and write the same files; requests from the page reach the
right Claude session.

**Reuse first.** Mature open-source tools do the heavy UI; Crewdeck is the glue:

| Need | Tool (license) | How Crewdeck uses it |
|---|---|---|
| Notes, memory, backlinks, graph | [SilverBullet](https://silverbullet.md) 2.12 (MIT) | Run as-is over the vault folder, served same-origin at `/notes`, themed with a Space Style page |
| Tickets, kanban, milestones | [Backlog.md](https://github.com/MrLesk/Backlog.md) 1.55 (MIT) | One `backlog browser` per project, themed through a small CSS-injecting proxy; agents use its CLI/MCP |
| Agents | Claude Code (desktop app) | Sessions do the work; a Claude Code plugin bridges page requests to sessions |

## Non-goals and anti-goals

- No new note editor or kanban: if SilverBullet or Backlog.md does it, use theirs.
- No cloud service, accounts or telemetry: everything binds to 127.0.0.1.
- Agents never submit, send, post or pay on the user's behalf (job forms, email, X): they prepare, the human clicks.
- No personal data in the repo: the vault, projects and job data live outside it.

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
- **Shell** on `PORT` (default 4848): the page, `/api/*`, and a reverse proxy `/notes/*` → SilverBullet.
- **SilverBullet** `--single` on the vault with `SB_URL_PREFIX=/notes` (internal port).
- Per project: **`backlog browser`** (internal port) behind a **theme proxy** (public port) that injects
  `themes/backlog.css` into its HTML and passes everything else through, WebSockets included.

The supervisor restarts a child that exits, and stops all children on exit.

## Agents and requests (stage 2)

- The plugin's mod gives each Claude session a lane from its working folder: a project folder → `project:<name>`;
  else `cockpit`. It claims requests for its lane only while idle, and puts back unfinished ones at turn end
  (lessons from the Job Agent bridge).
- Requests come from the shell (Ask Claude, Start agent on ticket) and from Backlog.md's `onStatusChange` hook
  (ticket moved to In Progress → `start` request on the project lane).
- Skills: `memory` (ingest / query / lint the vault), `board` (work a ticket in a worktree, keep its status and
  notes current), `jobs` (stage 3).

## Stages

1. Shell + supervisor + proxies + theme + vault template + README/setup. **Done when** `crewdeck up` shows
   Notes and a project Board, themed, in Claude's browser pane, and edits from disk appear live.
2. Plugin: lane bridge, request queue, ticket → agent, memory skills.
3. Jobs module (extracted from the author's job agent, with example config only).

## Left to the builder

Exact ports, theme values, process restart backoff, and log format.

## Changelog

- 2026-11-17: first version. Name Crewdeck chosen; reuse SilverBullet + Backlog.md; repo private until the demo.
