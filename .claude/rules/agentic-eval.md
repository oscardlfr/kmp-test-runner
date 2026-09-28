---
paths:
  - "tools/agentic-eval/**/*"
  - "tests/vitest/agentic-eval-*.test.js"
  - "tests/fixtures/fake-claude*/**/*"
  - "docs/agentic-usage-measurement.md"
  - "docs/audits/**/*"
---

# Agentic evaluation rules

- Treat run records, sidecars, manifests, and registries as evidence contracts.
  Fail closed when provenance, isolation, privacy, or completeness cannot be
  established.
- Never commit raw transcripts, credentials, private paths, or unsanitized
  project identifiers. Keep raw evidence in the ignored locations documented
  by the harness.
- Preserve control/treatment comparability and pinned snapshot identity. Do not
  edit accepted evidence to make a gate pass.
- Add discriminating tests for schema, journal, recovery, and cross-record
  invariants whenever those contracts change.
- Historical `tools/runs/` captures are product evidence, not agent memory; do
  not move them into startup instruction files.
