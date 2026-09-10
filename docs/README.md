# Documentation

This index separates current user/operator documentation from historical evidence. Current docs are maintained against `origin/develop`; dated audits and run captures remain immutable context unless a correction note says otherwise.

## Use the product

- [Installation](installation.md) — CLI installers, npm, updates, and Gradle package access.
- [Usage and recipes](usage.md) — common workflows and platform selection.
- [CLI reference](cli-reference.md) — canonical public flags and defaults.
- [Gradle plugin](gradle-plugin.md) — plugin repository, DSL, and tasks.
- [JSON envelope contract](envelope-contract.md) — machine-readable output.
- [Concurrency](concurrency.md) — locks, isolation, and report ownership.
- [Windows troubleshooting](troubleshooting-windows.md) — TLS, PATH, JDK, and PowerShell.

## Measurements and evaluation

- [Metrics and evidence](metrics.md) — canonical result tables, provenance, and interpretation rules.
- [Token-cost methodology](token-cost-measurement.md) — token-count capture protocol.
- [Agentic evaluation](evaluation/README.md) — current harness entry point.
- [Run an agentic evaluation](evaluation/running-agentic-eval.md) — dry and committed-run workflow.
- [Prepare Evidence1 on Windows](evaluation/evidence1-windows-setup.md) — official ISO/Hyper-V prerequisites and the current manual boundary.
- [Evidence1 live canary runbook](evaluation/evidence1-live-canary.md) — V1/V2/V3, authentication, execution, custody, and validation.
- [Evidence1 results, 2026-09-10](evaluation/evidence1-results-2026-09-10.md) — three paired product/free-baseline rounds.

## Maintain the repository

- [Contributor guide](../CONTRIBUTING.md)
- [Local CI](testing/local-ci.md)
- [Tooling index](../tools/README.md)
- [Documentation audit, 2026-09-10](documentation-audit-2026-09-10.md)
- [Product principles](../PRODUCT.md)
- [Changelog](../CHANGELOG.md)
- [Active backlog](../BACKLOG.md)

## Historical material

Most prose under `docs/audits/`, most dated files under `tools/runs/`, and the detailed history in `CHANGELOG.md` are point-in-time records. They can describe an older schema, workflow, or limitation accurately for their date. The versioned `evidence1-*.ps1` and `evidence1-validation-ops.psm1` files under `docs/audits/` are the exception: the current Evidence1 runbook invokes them as executable operator assets. Follow the links above instead of treating adjacent audit prose as current behavior.
