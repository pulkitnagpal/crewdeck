# Design Doc: <System / Change name>

| Field | Value |
| --- | --- |
| Status | Draft / In review / Approved / Superseded |
| Author(s) | |
| Reviewers | Reliability · Security · Cost · Data · Operability · Devil's advocate |
| Approver | |
| Last updated | YYYY-MM-DD |
| Related ADRs | ADR-NNNN, ... |
| Links | Epic, spec, dashboards, prior designs |

> Fill every section. If a section truly does not apply, write `N/A — <one-line reason>`.
> Never leave `TODO`, `TBD` or `<placeholders>`: the design-doc gate hook blocks completion while they remain.

## 1. Summary

One paragraph: the problem, the chosen approach, what it costs per month, the biggest risk, and what we need from reviewers.

## 2. Context and problem

- **Current state (as-is):** C4 Level 1 of today's system. Link or embed the diagram.
- **Pain points, with numbers:** e.g. p99 latency 2.4 s at peak, 3 Sev-1 incidents in Q3 from X, $Y/month spend on Z.
- **Why now:** the trigger (growth, incident, new product, cost, compliance).

## 3. Goals and non-goals

| Goals (measurable) | Non-goals (explicitly out of scope) |
| --- | --- |
| e.g. p99 < 300 ms at 5x today's peak | e.g. multi-region active-active this phase |

## 4. Requirements

### 4.1 Functional
Numbered list of user-visible capabilities and key journeys.

### 4.2 Non-functional (NFRs)

| Attribute | Target | How measured | Today |
| --- | --- | --- | --- |
| Availability (SLO) | e.g. 99.95% monthly | Successful requests / total, per region | |
| Latency | p50 / p99 per key API | Server-side, at load balancer | |
| Throughput | avg / peak RPS, events/s | | |
| Durability | e.g. 11 nines for user data | | |
| RPO / RTO | e.g. RPO 5 min, RTO 30 min | DR drill | |
| Consistency | strong / read-your-writes / eventual (per entity) | | |
| Data retention / residency | | | |
| Compliance | e.g. SOC 2, GDPR, DPDP Act | | |
| Budget | $/month cap, unit-cost target | | |

### 4.3 Constraints and assumptions
Team size and skills, mandated platforms, deadlines, contracts. Each assumption gets an owner who will confirm it.

## 5. Capacity estimates (back of the envelope)

Show the formula, not just the answer.

| Quantity | Formula | Value (1x) | 3x | 10x |
| --- | --- | --- | --- | --- |
| DAU / MAU | | | | |
| Avg RPS | DAU × requests per user per day / 86,400 | | | |
| Peak RPS | avg × peak factor | | | |
| Read:write ratio | | | | |
| Storage growth / year | objects/day × avg size × 365 × replication | | | |
| Egress bandwidth | | | | |
| Hot working set (cache) | | | | |

## 6. Options considered

At least two real options plus "do nothing / minimal change".

### Option A — <name>
Description · diagram · pros · cons · cost/month · main risk · reversibility (one-way or two-way door).

### Option B — <name>
...

### Decision matrix

| Criterion (weight) | Option A | Option B | Option C |
| --- | --- | --- | --- |
| Meets NFRs (30%) | 1–5 | | |
| Operational complexity (20%) | | | |
| Cost at 3x (20%) | | | |
| Time to deliver (15%) | | | |
| Reversibility / evolvability (15%) | | | |
| **Weighted total** | | | |

**Decision:** Option _ — recorded in ADR-NNNN.

## 7. High-level design (HLD)

- **C4 Level 2 (containers):** Structurizr DSL or Mermaid source checked into `docs/architecture/diagrams/`.
- **Component responsibilities:**

| Component | Responsibility | Owner team | Tech | Scales on | Stateful? |
| --- | --- | --- | --- | --- | --- |

- **Key flows:** 2–4 critical journeys as sequence diagrams (happy path + one failure path each).
- **Technology choices:** each non-obvious choice links to an ADR.
- **Boundaries:** sync vs async edges, trust boundaries, tenancy / cell boundaries.

## 8. Low-level design (LLD)

Repeat per significant component.

### 8.1 APIs
Endpoint/RPC · request/response schema · idempotency key · versioning · pagination · rate limits · error model · timeouts the caller must set.

### 8.2 Data model
Entities and schema · primary/partition key and why · indexes mapped to access patterns · hot-key risks · migrations · retention/TTL.

| Access pattern | Frequency | Key / index used | Consistency needed |
| --- | --- | --- | --- |

### 8.3 Caching
What is cached · where (client/CDN/edge/service/DB) · TTL · invalidation · stampede protection · behaviour when the cache is cold or down.

### 8.4 Messaging and events
Topics/queues · producers/consumers · ordering key · delivery semantics (at-least-once + idempotent consumer?) · retries + backoff · DLQ and replay · schema evolution.

### 8.5 Consistency and transactions
Per entity: model chosen · cross-service transactions (saga, outbox, 2PC avoided?) · conflict resolution · clocks and ordering.

### 8.6 State machines and workflows
Long-running flows: states, transitions, timeouts, compensation. Durable execution engine (Temporal / Restate / DBOS / Step Functions) if any.

### 8.7 AI / agent components (if any)
Model(s) and fallback · prompt/context sources · tool permissions (least privilege) · guardrails · eval suite and quality bar · durable state for agent loops · token cost per request · latency budget · LLM tracing.

## 9. Scalability and performance

Scaling dimension per component (CPU, connections, partitions, throughput units) · known hot spots · partitioning/sharding strategy · autoscaling signals · load-test plan with pass criteria.

## 10. Reliability and resilience

- **SLOs and error budgets** per user journey.
- **Failure modes:** link the FMEA table (template `fmea.md`). Cover dependency down, slow dependency, bad deploy, poison message, region/AZ loss, quota exhaustion, data corruption.
- **Patterns used:** timeouts · retries with backoff + jitter · circuit breakers · bulkheads / cells · load shedding · backpressure · graceful degradation · idempotency.
- **Redundancy:** AZ / region strategy and why.
- **Disaster recovery:** backup method, restore tested on (date), RPO/RTO achieved in drill.
- **Chaos / game days:** experiments planned before launch.

## 11. Security and privacy

Link the threat model (`threat-model.md`). Summarise: authN/authZ model · data classification · encryption in transit/at rest · key and secret management · network segmentation · tenant isolation · audit logging · compliance obligations · AI-specific risks (prompt injection, excessive agency, data leakage).

## 12. Observability and operations

- **Telemetry:** RED metrics per service, USE per resource, structured logs, distributed traces (OpenTelemetry), LLM traces if applicable.
- **Alerts:** tied to SLO burn rate, each with a runbook link.
- **Deployment:** strategy (canary / blue-green / cell waves), automated rollback triggers.
- **Runbooks and on-call:** owner team, escalation.

## 13. Cost

Link the cost model (`cost-model.md`). Summarise: monthly cost at 1x/3x/10x · unit cost (per 1k requests / per MAU / per tenant) · top 3 cost drivers · levers if we must cut 30%.

## 14. Migration and rollout

Phases · strangler-fig / dual-write / backfill plan · data migration verification · feature flags · cutover · rollback criteria and procedure · decommission of old system.

## 15. Testing strategy

Unit · contract · integration · load · chaos · security (SAST/DAST) · DR drill · AI evals.

## 16. Fitness functions (keeping the design true)

| Rule | Tool | Where it runs | Fails when |
| --- | --- | --- | --- |
| e.g. domain must not import adapters | archfit / ArchUnit | CI | an import crosses the boundary |
| e.g. infra cost delta per PR | Infracost | CI | > $500/month added without approval |

## 17. Risks, dependencies, open questions

| Item | Type (risk / dependency / question) | Impact | Owner | Due |
| --- | --- | --- | --- | --- |

## 18. Review log

| Date | Reviewer / lens | Verdict | Key findings | Resolved in |
| --- | --- | --- | --- | --- |

## Appendix
Glossary · references · raw calculations.
