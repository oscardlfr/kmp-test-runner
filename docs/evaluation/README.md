# Agentic evaluation

The evaluation harness measures whether an agent uses `kmp-test` correctly, reaches the scenario's structured outcome, and how much orchestration/output it consumes. It is separate from normal product use.

## Choose the right guide

- [Run an agentic evaluation](running-agentic-eval.md) for corpus validation, dry plans, committed records, validation, aggregation, and analysis.
- [Prepare Evidence1 on Windows](evidence1-windows-setup.md) for the Windows 11/Hyper-V environment and the current manual provisioning boundary.
- [Run an Evidence1 live canary](evidence1-live-canary.md) for the V1/V2/V3 and one-cell live workflow.
- [Read the 2026-09-10 results](evidence1-results-2026-09-10.md) for the three paired rounds.
- [Harness technical reference](../../tools/agentic-eval/README.md) for schemas, registries, graders, and implementation internals.

## Current contracts

- Scenario run record: latest schema 8; readers accept supported historical schemas 1–8.
- Accepted-run audit sidecar: latest schema 10; readers accept supported schemas 1–10.
- Analysis output: schema 9.
- `sandboxed-unrestricted-v1` is registered and implemented for the Claude Code runtime.
- `claude-product-canary-v1` and `claude-free-baseline-canary-v1` are registered one-session designs for `coverage-threshold-failure-v2`.
- The versioned Evidence1 launcher supports one-cell canaries when the complete canary parameter set is supplied.

Registration and implementation do not authorize paid/live sessions. Live authorization and one-use custody remain operator controls.

## Evidence policy

Commit only accepted, sanitized scenario records and their audit sidecars. Never commit raw authenticated transcripts, environment dumps, credentials, VM images, private scope files, or custody bundles. Preserve missing values and negative outcomes exactly; success is a graded property, not an inference from process exit zero.
