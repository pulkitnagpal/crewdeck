# ADR-0004: Run Jobs work on demand in a Jobs chat opened in front of the person; a scheduled daily run later

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

## Decision

**Revised 2026-11-20 after the P0 spike and the owner's call.** A headless `claude -p` started by Crewdeck's server is not
signed in (Claude desktop passes its login only to the chats it runs; unattended runs would need `claude setup-token`),
so there is no server-started worker. Instead:

- **On demand (now):** Find, "check this post/page" (intake) and Apply each open a **Jobs chat in front of the person**
  (`claude://code/new`, folder `~/Crewdeck/jobs`, a prompt naming the task). It runs with the desktop app's login, under
  the jobs-folder sandbox, and is visible. Progress also shows in the `/crewdeck` panel and on the Jobs page.
- **Later, opt-in:** a Claude desktop **Scheduled task** in `~/Crewdeck/jobs` for the daily run (desktop login, visible
  under Scheduled, catches up on next launch), once the owner trusts results and token use.
- Hardening for any non-interactive run in that folder: only the exact `crewdeck` commands allowed
  (`autoAllowBashIfSandboxed: false`, `dontAsk`), no Read/Grep/Glob/WebFetch tools, no user MCP servers.

## Consequences

- Supersedes v1 D17
- P4 spike must confirm headless auth and limits on the plan
- Revisit if: P0 spike fails (auth, limits or terms), the worker's daily tokens exceed 0.5 M, or Claude Code changes headless flags.
