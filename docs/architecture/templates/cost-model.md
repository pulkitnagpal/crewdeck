# Cost Model: <System name>

| Field | Value |
| --- | --- |
| Design doc | link |
| Cloud / region | e.g. AWS ap-south-1 |
| Pricing source and date | e.g. AWS Pricing MCP / Pricing Calculator, YYYY-MM-DD |
| Currency | USD (convert to INR at the rate noted, if needed) |

## 1. Load assumptions (from the design doc's capacity section)
| Driver | 1x (today / launch) | 3x | 10x |
| --- | --- | --- | --- |
| Requests / month | | | |
| Peak RPS | | | |
| Stored data (GB) | | | |
| Egress (GB / month) | | | |
| Events / month | | | |
| LLM input / output tokens per month | | | |

## 2. Cost per component
Show the formula so anyone can recompute it when prices or load change.

| Component | Service / SKU | Pricing unit | Formula | 1x $/mo | 3x $/mo | 10x $/mo |
| --- | --- | --- | --- | --- | --- | --- |
| Compute | | | | | | |
| Database | | | | | | |
| Cache | | | | | | |
| Messaging | | | | | | |
| Object storage | | | | | | |
| Data transfer (inter-AZ, egress, NAT) | | | | | | |
| Observability (logs, metrics, traces) | | | | | | |
| LLM / AI inference | | | | | | |
| Third-party SaaS | | | | | | |
| **Total** | | | | | | |

## 3. Unit economics
| Unit | 1x | 3x | 10x | Target |
| --- | --- | --- | --- | --- |
| $ per 1k requests | | | | |
| $ per MAU | | | | |
| $ per tenant | | | | |

## 4. Sensitivity
Which single assumption, if wrong by 2x, moves the total most? List the top 3.

## 5. Levers if we must cut 30%
| Lever | Saving $/mo | Trade-off |
| --- | --- | --- |
| e.g. Savings Plans / reserved capacity | | commitment |
| e.g. Graviton / ARM instances | | rebuild images |
| e.g. reduce log retention / sampling | | less forensics |
| e.g. smaller model for simple LLM calls | | quality risk, needs evals |

## 6. Guardrails
Budgets and anomaly alerts in the account · Infracost threshold in CI · tagging policy for cost allocation.
