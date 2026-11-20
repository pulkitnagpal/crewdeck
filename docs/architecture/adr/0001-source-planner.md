# ADR-0001: Choose each person's top ~10 sources with a planner over a source registry

| Field | Value |
| --- | --- |
| Status | Proposed |
| Date | 2026-11-20 |
| Deciders | Crewdeck maintainer |
| Consulted | audits and research of 2026-11-20 |
| Design doc | [Jobs v2](../designs/jobs-v2.md) |
| Reversibility | Two-way door |

## Context

v1 suggested sources once, at setup, from a fixed catalog of ~140 scraped boards; changing field or country did not change where Crewdeck looked, and the maintainer's real run fetched 2,161 postings of which 39 were relevant to his country. The owner's principle: there are thousands of portals, so be smart and pick the top ~10 for each person from their preferences and proven data.

## Decision drivers

- G1/G5 in the design: ≥10 relevant picks/day for any field × country; re-plan on intent change
- Network and token budgets per user (§5)
- Legitimate sources only

## Options considered

### Option 1 — Planner over a registry (field × country × work mode × proven yield + exploration)
- Good, because adapts per person and over time; explainable
- Bad, because needs yield data to learn (cold start uses curated priors)

### Option 2 — Fetch everything we can
- Good, because maximal recall
- Bad, because waste: 99% of a global pool is irrelevant; slow; terms risk

### Option 3 — Keep the setup-time suggestion (do nothing)
- Good, because no work
- Bad, because doesn't adapt; the cause of today's failure

## Decision

We will plan sources per person: score = fit(occupation group, countries, work modes, languages) × prior yield (curated per field × country, then learned from the person's own yields) + a small exploration bonus; pick the top ~10 (one 'company feeds' source counts as one, carrying a company set chosen by industry × region × size); re-plan on any intent change and weekly; explain each choice on the Sources tab; the person can pin or remove.

## Consequences

- The registry needs per-source metadata (fields, countries, modes, terms) and a lint
- Cold-start priors must be curated for the 8 acceptance personas' fields first
- Revisit if: the static table misses a persona's main source twice in a month, or measured yields contradict the table for 4 weeks.
