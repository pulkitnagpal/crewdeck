# Threat Model: <System name>

| Field | Value |
| --- | --- |
| Design doc | link |
| Version / date | |
| Method | STRIDE per element (+ OWASP LLM Top 10 for AI components) |
| Participants | |

## 1. System description
One paragraph plus the data-flow diagram (DFD) with trust boundaries drawn.

## 2. Assets
| Asset | Classification (public / internal / confidential / restricted) | Owner | Why an attacker wants it |
| --- | --- | --- | --- |

## 3. Trust boundaries and entry points
| Boundary | Entry points crossing it | AuthN | AuthZ |
| --- | --- | --- | --- |

## 4. STRIDE analysis
One row per element × applicable threat.

| Element | Threat (S/T/R/I/D/E) | Scenario | Likelihood (L/M/H) | Impact (L/M/H) | Mitigation | Status |
| --- | --- | --- | --- | --- | --- | --- |

- **S**poofing · **T**ampering · **R**epudiation · **I**nformation disclosure · **D**enial of service · **E**levation of privilege

## 5. AI / agent-specific threats (if applicable)
| Threat | Where it enters | Mitigation | Status |
| --- | --- | --- | --- |
| Prompt injection (direct and indirect via retrieved content/tools) | | | |
| Excessive agency (tools with broader permissions than the task needs) | | | |
| Sensitive data in prompts, context, logs or traces | | | |
| Insecure output handling (model output executed or rendered) | | | |
| Model/tool supply chain (MCP servers, plugins, skills) | | | |
| Denial of wallet (token or GPU cost abuse) | | | |
| Toxic flows (untrusted input + private data + exfiltration path in one agent) | | | |

## 6. Residual risks accepted
| Risk | Why accepted | Accepted by | Revisit |
| --- | --- | --- | --- |

## 7. Security tests to add
SAST/DAST, authz tests per role, fuzzing, red-team prompts, dependency and IaC scanning.
