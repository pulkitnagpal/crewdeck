# Architecture Review Checklist and Scorecard

Use for every design doc before approval. Each lens is reviewed independently (ideally by a separate reviewer or subagent that did not write the design). Score each lens 0–3 and log findings with a severity.

**Scores:** 0 = missing · 1 = present but weak, blocking gaps · 2 = adequate, minor gaps · 3 = strong, evidence-backed.

**Severity of a finding:**
- **Blocker** — the design will fail an NFR, lose data, breach security, or cost far over budget. Must fix before approval.
- **Major** — likely incident or significant rework within 6 months. Fix or accept explicitly in an ADR.
- **Minor** — improvement; track it.

**Every finding must cite** the section of the doc it refers to and a concrete failure scenario ("when X happens, Y breaks because Z").

## 1. Requirements fit — score: _
- [ ] Goals are measurable; non-goals are explicit.
- [ ] Every NFR has a target, a measurement method and today's baseline.
- [ ] Capacity math is shown with formulas at 1x, 3x and 10x.
- [ ] Assumptions have owners.

## 2. Simplicity and evolvability — score: _
- [ ] At least two real options were compared, plus "do nothing".
- [ ] The chosen option is the simplest one that meets the NFRs.
- [ ] Service boundaries follow ownership and change rate, not technical layers.
- [ ] One-way-door decisions are identified and have ADRs.
- [ ] Each new technology has a justification and an owner who can run it.

## 3. Scalability and performance — score: _
- [ ] Each component's scaling dimension and limit is named.
- [ ] Hot keys / hot partitions are identified with a mitigation.
- [ ] Latency budget adds up across the call chain for key journeys.
- [ ] A load-test plan exists with pass criteria.

## 4. Reliability and resilience — score: _
- [ ] SLOs per user journey, with error budgets.
- [ ] FMEA covers dependency down, slow dependency, bad deploy, poison message, AZ/region loss, quota exhaustion, data corruption.
- [ ] Every remote call has a timeout; retries are bounded with backoff + jitter and only on idempotent operations.
- [ ] Blast radius is bounded (bulkheads, cells, per-tenant limits).
- [ ] Load shedding / backpressure / graceful degradation are defined.
- [ ] Backups exist **and** a restore has been tested; RPO/RTO are realistic.
- [ ] Long-running workflows survive process crashes (durable execution or equivalent).

## 5. Data and consistency — score: _
- [ ] Access patterns map to keys and indexes.
- [ ] Consistency model is stated per entity and matches the business need.
- [ ] Cross-service writes use outbox / saga; no hidden distributed transactions.
- [ ] Message delivery semantics are explicit; consumers are idempotent; DLQ + replay exist.
- [ ] Schema evolution and data migration are planned and verifiable.
- [ ] Retention, deletion (right-to-erasure) and residency are covered.

## 6. Security and privacy — score: _
- [ ] A threat model exists covering each trust boundary (STRIDE).
- [ ] AuthN/AuthZ is defined per API; least privilege for services and agents.
- [ ] Data is classified; encryption in transit and at rest; secrets in a manager.
- [ ] Tenant isolation is enforced, not assumed.
- [ ] Audit logs for sensitive actions.
- [ ] AI components: prompt injection, excessive agency, sensitive data in prompts/logs, tool permission scope.

## 7. Operability and observability — score: _
- [ ] RED/USE metrics, structured logs, traces end to end.
- [ ] Alerts on SLO burn rate, each with a runbook.
- [ ] Deployment is progressive (canary / cell waves) with automated rollback.
- [ ] Feature flags for risky paths; config changes are as safe as code changes.
- [ ] Owner team and on-call are named.

## 8. Cost — score: _
- [ ] Monthly cost at 1x / 3x / 10x with the formula per component.
- [ ] Unit cost (per request / MAU / tenant) and its target.
- [ ] Top 3 cost drivers and a lever for each.
- [ ] Data transfer, logging/observability, and AI token costs are included (the usual surprises).
- [ ] Cost guardrails in CI (Infracost) and budgets/alerts in the cloud account.

## 9. Delivery and migration — score: _
- [ ] Phased rollout with exit criteria per phase.
- [ ] Rollback is possible at every phase, and the procedure is written.
- [ ] Data migration has verification (counts, checksums, shadow reads).
- [ ] Old system decommission is planned.

## 10. Keeping it true — score: _
- [ ] Key decisions are encoded as fitness functions in CI.
- [ ] Diagrams are generated from a model checked into the repo.
- [ ] ADR index is current.

## Verdict

| Lens | Score | Blockers | Majors |
| --- | --- | --- | --- |
| Requirements fit | | | |
| Simplicity / evolvability | | | |
| Scalability / performance | | | |
| Reliability / resilience | | | |
| Data / consistency | | | |
| Security / privacy | | | |
| Operability | | | |
| Cost | | | |
| Delivery / migration | | | |
| Keeping it true | | | |

**Decision:** Approve · Approve with conditions (list) · Rework (list blockers)

**Rule:** any Blocker → Rework. Any lens scored 0 or 1 → at most "Approve with conditions".
