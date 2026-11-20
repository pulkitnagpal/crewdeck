# ADR-0007: Model targets as standard occupations (O*NET database, ESCO) with alternate titles and skills

| Field | Value |
| --- | --- |
| Status | Proposed |
| Date | 2026-11-20 |
| Deciders | Crewdeck maintainer |
| Consulted | audits and research of 2026-11-20 |
| Design doc | [Jobs v2](../designs/jobs-v2.md) |
| Reversibility | One-way door (notes schema) |

## Context

Titles alone can't express 'nurse moving to the US' or 'PM career change', and synonyms differ by language.

## Decision drivers

- Any field, any language
- Licensing and skills per occupation

## Options considered

### Option 1 — Bundle the O*NET database (CC BY 4.0) + ESCO alternative labels (multilingual), ISCO as the bridge
- Good, because rich titles/skills/licences; free
- Bad, because bundle size (~30 MB compressed)

### Option 2 — Hand-written synonyms
- Good, because small
- Bad, because doesn't scale across fields

## Decision

Targets in jobs/search.md gain occupation codes (ISCO; O*NET-SOC or ESCO URI) next to the person's words; alternate titles, skills and licence hints come from the bundled data; v1 `roles.titles` migrate automatically with a Changes line.

## Consequences

- Notes schema v3 (additive); attribution for O*NET and ESCO
- Revisit if: O*NET/ESCO licences change, or a persona's field is poorly covered by both taxonomies.
