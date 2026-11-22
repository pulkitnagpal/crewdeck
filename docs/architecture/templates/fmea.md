# Failure Mode and Effects Analysis (FMEA): <System name>

One row per component × failure mode. Risk priority = Likelihood × Severity × (6 − Detectability), each scored 1–5. Sort by risk priority; every row scoring 40+ needs a mitigation and a test.

| Component | Failure mode | Cause | Effect on users (blast radius) | Detection (alert / signal) | L (1–5) | S (1–5) | D (1–5, 5 = detected instantly) | Risk priority | Mitigation | Recovery and RTO | Verified by (chaos test / drill) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| e.g. Payments API → PSP | Dependency slow (p99 > 5 s) | PSP degradation | Checkout stalls for all users | p99 latency SLO burn alert | 3 | 4 | 4 | 24 | 2 s timeout, circuit breaker, queue and retry async | Auto, < 1 min | Latency injection game day |

## Failure categories to cover

- Dependency down · dependency slow (the more dangerous one) · partial failure / bad responses
- Bad deploy or config change · poison message / poison request
- Instance, AZ and region loss · network partition
- Quota, rate limit or connection-pool exhaustion · disk full · certificate expiry
- Data corruption or accidental deletion · replication lag · clock skew
- Thundering herd / cache stampede · retry storm · noisy tenant
- AI components: model API outage, rate limiting, quality regression after a model change, runaway agent loop
