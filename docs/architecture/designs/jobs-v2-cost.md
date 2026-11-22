# Cost model: Crewdeck Jobs v2

Part of [the Jobs v2 design](jobs-v2.md). Money: **$0** for Crewdeck itself (local; public feeds; optional free API keys
registered by the person). The cost is the person's Claude plan usage, in tokens. Token counts are estimates from v1
measurements (a v1 Find of 25 judged ≈ 0.15 M tokens) and typical posting sizes; no prices are asserted here.

| Line item | Formula | 1x (300 boards) | 3x (900) | 10x (3,000) |
| --- | --- | --- | --- | --- |
| Triage (light model) | min(eligible, cap 150) × ~250 tokens + batch overhead | ~25 k | ~70 k | ~40 k (cap) |
| Judge (default model) | 30 × ~3 k | ~90 k | ~90 k | ~90 k |
| Resolve unclear | ~5 × ~4 k | ~20 k | ~20 k | ~20 k |
| Prepare | 10 × ~12 k | ~120 k | ~120 k | ~120 k |
| Intake | ~2 statements × ~8 k | ~16 k | ~16 k | ~16 k |
| **Total tokens/day** | | **~0.27 M** | **~0.32 M** | **~0.29 M** |
| Network | §5 | ~5 MB | ~15 MB | ~50 MB |
| Disk | §5 | ~350 MB | ~1 GB | ~1 GB (30-day prune) |

Levers (−30%): prepare on open instead of ahead (−0.12 M); judge top 20 not 30 (−30 k); verdict cache reuse across days
(typically −20–40% of triage/judge).
