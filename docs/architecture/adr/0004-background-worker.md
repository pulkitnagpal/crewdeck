# ADR-0004: Run intake, the daily run and Prepare as a headless Claude worker; supersede v1 D17

| Field | Value |
| --- | --- |
| Status | Proposed |
| Date | 2026-11-20 |
| Deciders | Crewdeck maintainer |
| Consulted | audits and research of 2026-11-20 |
| Design doc | [Jobs v2](../designs/jobs-v2.md) |
| Reversibility | One-way-ish door (runs scheduled work on the user's consumer plan; validate in P0) |

## Context

v1 routed all work to a dedicated Jobs chat polled every 2 s; the owner clicked Find from another chat and couldn't find where the work happened. The architecture review called this structural. v1 D17 had removed a headless drafter.

## Decision drivers

- G4: no chat to hunt for
- Same sandbox and least privilege as the jobs workspace
- Uses the user's own Claude plan

## Options considered

### Option 1 — Headless `claude -p` launched by the server in ~/Crewdeck/jobs with the jobs sandbox and an allowlist
- Good, because invisible work becomes visible status; no idle-session dependency
- Bad, because can't talk to it mid-run; plan usage

### Option 2 — Keep the Jobs chat, improve surfacing
- Good, because no new mechanism
- Bad, because still depends on an open, idle chat

### Option 3 — Direct API calls with a key
- Good, because full control
- Bad, because needs a paid API key; not the user's plan

## Decision

The server runs `claude -p` (non-interactive) for intake, the daily run and Prepare, in the jobs workspace (its .claude/settings.json sandbox), with `--tools <allowlist>` (hard restriction), `--strict-mcp-config` (no MCP servers), `--setting-sources project` (no user settings, plugins or hooks), no bypass mode, Read/Grep deny rules outside the jobs workspace; progress via `crewdeck progress`; results on the page and panel. The Jobs chat stays as a fallback and for the setup interview's back-and-forth.

## Consequences

- Supersedes v1 D17
- P4 spike must confirm headless auth and limits on the plan
- Revisit if: P0 spike fails (auth, limits or terms), the worker's daily tokens exceed 0.5 M, or Claude Code changes headless flags.
