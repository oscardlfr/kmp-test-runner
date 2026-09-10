# Agentic usage measurement

This document is retained as a compatibility entry point. The previous version mixed historical plans, obsolete schema limits, proposed runtime profiles, and dated results in one long narrative.

Use the separated current sources instead:

- [Metrics and evidence](metrics.md) — quantitative claims and interpretation rules.
- [Agentic evaluation](evaluation/README.md) — operator entry point.
- [Run an agentic evaluation](evaluation/running-agentic-eval.md) — reproducible harness workflow.
- [Harness technical reference](../tools/agentic-eval/README.md) — schemas, profiles, acceptance, and analysis.
- [Evidence1 results](evaluation/evidence1-results-2026-09-10.md) — latest live canary report.
- [Token-cost methodology](token-cost-measurement.md) — A/B/C output measurement.

Current schema summary: scenario records latest 8 (supported 1–8), accepted-run audit sidecars latest 10 (supported 1–10), and analysis output schema 9. `sandboxed-unrestricted-v1` and the registered one-cell Claude canary designs are implemented. Historical audit documents remain point-in-time records and must not override these current contracts.
