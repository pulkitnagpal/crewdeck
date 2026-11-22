# FMEA: Crewdeck Jobs v2

Part of [the Jobs v2 design](jobs-v2.md). S = severity, L = likelihood (1–5).

| Component / dependency | Failure | Effect | S | L | Detection | Mitigation |
| --- | --- | --- | --- | --- | --- | --- |
| Company feed (Greenhouse/Lever/Ashby…) | down / 5xx / timeout | that board missing today | 2 | 3 | adapter error count | timeout 15 s, 2 retries with jitter, skip; run continues |
| Company feed | response shape changed | postings missing or wrong fields | 3 | 2 | contract test; zero-yield alert per adapter | adapter versioned; monthly recorded-fixture refresh; breaker after 3 failures |
| Workday cxs (undocumented) | blocked or changed | hospital/enterprise coverage drops | 4 | 3 | per-source health | weekly cadence; fall back to careers page JSON-LD; honest UA |
| Any source | 429 / bot wall | source empty | 2 | 3 | status code | backoff doubles across runs (≤ 7 days); keep partial results |
| robots.txt change | now disallows our UA | must stop | 3 | 2 | weekly robots check | adapter disabled automatically, shown on Sources |
| Company directory | stale slugs | wasted requests, missed boards | 2 | 4 | 404 rate | weekly validation; drop after 2 × 404; discovery refresh |
| Official API key | missing/expired/quota | that source off | 2 | 3 | 401/403/429 | source marked "needs key"; never blocks a run |
| Background worker | crash / killed | run incomplete | 3 | 2 | run state not `ready` | step checkpoints; resume on next start; fallback "Run in a chat" |
| Claude plan limit | hit mid-run | judging/prepare stops | 3 | 3 | worker exit message | partial results kept; resume after reset; prepare-on-open lever |
| Notes | invalid after an edit | rules can't load | 4 | 2 | `jobs check` | last-valid fallback (v1); panel banner with the field |
| Pool | duplicate flood (same job on 5 boards) | picks repeated | 2 | 4 | dedupe key collisions | dedupe by ATS id, then company+title+location |
| Pool | scam posting | harm to the person | 5 | 2 | scam flags (payment/ID asks, mismatched domains) | flagged never picked; shown as warning |
| Machine asleep at 07:00 | daily run skipped | no picks | 2 | 4 | last-run age | run on wake if missed (launchd) |
| Intake | misreads the person | wrong sources/targets | 3 | 3 | summary card the person sees | changes shown; one-click undo from the Changes log |
| Apply subagent | prompt injection in a form page | wrong field values or actions | 4 | 2 | citation check, sensitive-field rules | browser + crewdeck only; stops before Submit; person reviews |
