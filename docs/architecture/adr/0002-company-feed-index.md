# ADR-0002: Source most jobs from companies' own public job feeds, seeded from an open company directory

| Field | Value |
| --- | --- |
| Status | Proposed |
| Date | 2026-11-20 |
| Deciders | Crewdeck maintainer |
| Consulted | audits and research of 2026-11-20 |
| Design doc | [Jobs v2](../designs/jobs-v2.md) |
| Reversibility | Two-way door |

## Context

Jobright and similar products get volume from company career sites; Greenhouse, Lever, Ashby, Workable, Recruitee, Personio, Teamtailor and Breezy expose public job feeds with no key (probed 2026-11-20; Greenhouse and Lever return 304 on ETag), with structured location/remote fields. An open directory lists ~9.9k Greenhouse/Ashby/Lever boards under CC BY 4.0.

## Decision drivers

- Volume and freshness for any field where companies use an ATS
- Structured remote/country fields (fewer 'unclear')
- Politeness and terms

## Options considered

### Option 1 — Ship a company directory (CC BY seed + Common Crawl discovery, validated) and fetch the planner's company set
- Good, because high yield; structured; free
- Bad, because directory staleness; undocumented Workday endpoint for big employers

### Option 2 — Per-user watchlist only
- Good, because simple
- Bad, because users don't know which companies hire; cold start empty

### Option 3 — Scrape aggregators
- Good, because broad
- Bad, because terms violations, bot defences

## Decision

We will ship a company directory (name, domain, ATS, slug, industry, size, hiring countries) seeded from the CC BY LastRound ATS directory plus Common Crawl discovery, validated against each API, refreshed weekly; adapters for the public feeds listed; Workday weekly or watchlist-only; SmartRecruiters excluded (robots.txt disallows our agent); honest User-Agent, ≤1 req/s per host, conditional GETs.

## Consequences

- Attribution for the directory in the README and Sources tab
- Monthly contract tests per adapter
- Revisit if: > 20% of seeded boards return 404 in a month, or an ATS documents terms that forbid this use.
