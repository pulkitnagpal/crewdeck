# ADR-0005: LinkedIn only through pages the person opens; guest search off by default

| Field | Value |
| --- | --- |
| Status | Proposed |
| Date | 2026-11-20 |
| Deciders | Crewdeck maintainer |
| Consulted | audits and research of 2026-11-20 |
| Design doc | [Jobs v2](../designs/jobs-v2.md) |
| Reversibility | Two-way door |

## Context

Guest search stored nothing in 5 of 5 runs and discards cards on stop; LinkedIn's User Agreement forbids automation; competitors that automate signed-in LinkedIn report bans.

## Decision drivers

- Reach the jobs people see on LinkedIn
- No account risk

## Options considered

### Option 1 — Import from this page: the person opens a LinkedIn post or search in the pane and clicks Import; Claude reads that visible page once
- Good, because no automation; uses what they see
- Bad, because one page at a time

### Option 2 — Keep guest search
- Good, because no clicks
- Bad, because fails, terms risk

### Option 3 — Automate signed-in LinkedIn
- Good, because volume
- Bad, because bans; terms

## Decision

LinkedIn enters through Import from this page and pasted post/job links; guest search stays available but off by default and keeps its cards when stopped.

## Consequences

- Panel button + skill; netguard validates extracted links
- Revisit if: LinkedIn offers an official jobs API, or a user reports an account warning.
