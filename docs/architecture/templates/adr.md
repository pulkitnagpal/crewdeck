# ADR-NNNN: <Short decision title in imperative form>

| Field | Value |
| --- | --- |
| Status | Proposed / Accepted / Deprecated / Superseded by ADR-NNNN |
| Date | YYYY-MM-DD |
| Deciders | |
| Consulted | |
| Design doc | link |
| Reversibility | Two-way door (cheap to undo) / One-way door (expensive to undo) |

## Context

What forces are at play: the requirement or NFR, the constraint, the incident or number that triggered this. 3–6 sentences, facts only.

## Decision drivers

- e.g. p99 < 300 ms at 5x peak
- e.g. team of 4 with no Kafka experience
- e.g. budget cap $8k/month

## Options considered

### Option 1 — <name>
- Good, because ...
- Bad, because ...
- Cost: $/month at 1x and 3x
- Risk: ...

### Option 2 — <name>
...

### Option 3 — Do nothing / minimal change
...

## Decision

We will <decision>, because <the one or two drivers that decided it>.

## Consequences

- **Positive:** ...
- **Negative / accepted trade-offs:** ...
- **Follow-up work created:** ...

## Verification

How we will know this was right, and the automated check that keeps it true (fitness function, SLO, cost alert).

## Revisit when

The concrete trigger that should reopen this decision (e.g. > 20k RPS sustained, a second region, team grows past 15).

## Links

Related ADRs, benchmarks, vendor docs, prototypes.
