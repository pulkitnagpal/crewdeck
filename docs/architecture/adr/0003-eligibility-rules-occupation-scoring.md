# ADR-0003: Hard-drop only on structured eligibility facts; score titles, skills and preferences

| Field | Value |
| --- | --- |
| Status | Proposed |
| Date | 2026-11-20 |
| Deciders | Crewdeck maintainer |
| Consulted | audits and research of 2026-11-20 |
| Design doc | [Jobs v2](../designs/jobs-v2.md) |
| Reversibility | Two-way door |

## Context

v1's title gate dropped 92% of the pool before any model read it, including clearly relevant titles (Full Stack Developer, SRE, DevOps, ML Engineer); soft preferences ('skip big tech') acted as hard 'no' in judging.

## Decision drivers

- Recall of relevant postings
- Precision of picks ≥70%
- Token budget

## Options considered

### Option 1 — Eligibility-only hard rules + occupation/skill scoring + light-model triage
- Good, because recall up; still cheap
- Bad, because triage tokens (~25 k/day)

### Option 2 — Title gate with synonyms
- Good, because cheap
- Bad, because still brittle across fields and languages

### Option 3 — No rules, judge everything
- Good, because max recall
- Bad, because tokens 10×

## Decision

Hard drops only on structured facts: where the person may work (country/remote eligibility), employment type, stated pay below the floor, explicit exclusions they gave as must-not. Titles, skills, seniority and soft preferences become scores; a light model triages summaries in batches; the full model judges the top ~30 with full postings; 'unclear' triggers one evidence fetch.

## Consequences

- Occupation model required (ADR-0007)
- Verdict cache by description hash
- Revisit if: precision < 60% for 2 weeks (rules too loose) or triage tokens exceed 0.1 M/day.
