# Evidence1 product vs free-baseline canary — 2026-09-10

This directory is the public, sanitized evidence package for three paired one-cell rounds of `coverage-threshold-failure-v2` on Windows.

## Contents

- `scenario-current-skill-*.json`: three product-assisted schema-8 records.
- `scenario-no-skill-*.json`: three free-baseline/no-product schema-8 records.
- `audit/<same-name>.json`: matching accepted-run audit sidecars.

Raw transcripts, credentials, VM state, isolation secrets, and custody bundles are intentionally excluded.

## Acceptance

- Records: 6/6 validated.
- Audit sidecars: 6/6 matched.
- Product expected outcome: 3/3.
- Free-baseline expected outcome: 0/3.
- `benchmark_eligible`: false for every record.

Validate each record locally (replace `<record>` with one of the six filenames):

```sh
node tools/agentic-eval/cli.mjs validate --run tools/runs/agentic-eval-evidence1-product-vs-free-canary-2026-09-10/<record>.json
```

The publishable aggregator intentionally refuses all six records because they are benchmark-ineligible. The analyzer likewise reports `files_excluded_benchmark_ineligible: 6`; the descriptive table was calculated from the validated record fields without overriding those gates.

Interpretation and the full table live in [docs/metrics.md](../../../docs/metrics.md).
