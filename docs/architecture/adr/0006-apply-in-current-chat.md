# ADR-0006: Apply in a fresh Jobs chat opened in front of the person, never in an unrelated chat

| Field | Value |
| --- | --- |
| Status | Proposed |
| Date | 2026-11-20 |
| Deciders | Crewdeck maintainer |
| Consulted | audits and research of 2026-11-20 |
| Design doc | [Jobs v2](../designs/jobs-v2.md) |
| Reversibility | Two-way door |

## Context

In v1 the Jobs chat filled the form in its own browser pane, which the person was often not looking at.

## Decision drivers

- The form appears where the person is
- Least privilege for the agent that reads untrusted form pages

## Options considered

### Option 1 — A `jobs-apply` subagent in the current chat with browser tools + crewdeck CLI only
- Good, because visible; isolated context
- Bad, because needs the plugin in that chat

### Option 2 — Keep Apply in the Jobs chat
- Good, because existing
- Bad, because invisible

## Decision

Apply (and LinkedIn page import) open a **new Jobs chat** via `claude://code/new` with the jobs folder and a prompt naming the role; Claude desktop brings it to the front and the form fills in that chat's pane under the jobs sandbox and v1 rules. A security review found that a subagent's tool allowlist does not isolate the parent chat (a work chat with Bash, MCP and credentials would act on text returned from an injected page), so Apply never runs in a chat outside `~/Crewdeck/jobs`.

## Consequences

- The subagent definition ships in the plugin; sensitive-field rules unchanged
- Revisit if: Claude desktop lets a plugin open its browser pane or focus an existing chat.
