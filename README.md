# Crewdeck

**Your one-person company, inside Claude desktop.** Notes, memory, tickets and your Claude agents in one
workspace that opens next to the chat. You click and decide; agents read and write the same files.

Crewdeck builds almost nothing itself. It wires together mature open-source tools:

| | Tool | Why |
|---|---|---|
| Notes · memory · backlinks · graph | [SilverBullet](https://silverbullet.md) (MIT) | Obsidian-style Markdown notes in the browser; plain files on disk |
| Tickets · kanban · milestones | [Backlog.md](https://github.com/MrLesk/Backlog.md) (MIT) | Tickets are Markdown files in each project's repo; agents use its CLI/MCP |
| Agents | [Claude Code](https://claude.com/claude-code) desktop app | Sessions do the work; Crewdeck shows it in Claude's browser pane |

Everything runs on your machine, bound to `127.0.0.1`. No accounts, no cloud, no telemetry.

## How it works

```
Claude desktop
├── chat with Claude (sessions = your agents)
└── browser pane → Crewdeck  http://localhost:4848
     ├── Notes  → SilverBullet over your vault folder (Markdown, also opens in Obsidian)
     └── Board  → Backlog.md for each project (tickets live in the project's repo)
```

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

This writes `~/.crewdeck/config.yaml`, downloads SilverBullet (pinned version) to `~/.crewdeck/bin/`, and
creates your vault at `~/Crewdeck/vault` (change it with `--vault <path>`).

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

Open **http://localhost:4848** in Claude desktop's browser pane (or any browser). In Notes, run
**Theme: Select → Crewdeck** once to apply the theme.

Check your setup any time with `node src/cli.ts doctor`. Logs are in `~/.crewdeck/logs/`.

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
- **Memory:** "ingest raw/2026-11-17 brief.md", "what do we know about pricing?", "remember I prefer remote roles".
  Claude follows the vault's `CLAUDE.md`.

## Roadmap

- [x] Stage 1 — workspace shell, SilverBullet notes, Backlog.md boards, theme, starter vault
- [ ] Stage 2 — Claude Code plugin: page clicks reach the right session (one lane per project), "start an agent
      on this ticket", memory skills (ingest / query / lint)
- [ ] Stage 3 — optional Jobs module: find roles, draft answers from your own words, fill forms in Claude's
      browser pane; you press Submit

Design notes: [docs/design.md](docs/design.md).

## License

MIT. SilverBullet and Backlog.md are MIT-licensed projects by their own authors; Crewdeck runs them unmodified.
