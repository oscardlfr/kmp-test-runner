# Evidence1 live canary results — 2026-09-10

Status: closed operational validation.

The campaign completed three consecutive paired rounds: one product-assisted cell and one true free-baseline/no-product cell per round. All six accepted records and audit sidecars validate.

| Arm | Sessions | Expected outcome matched | Mean wall time | Mean tool calls | Mean shell calls | Mean output tokens |
|---|---:|---:|---:|---:|---:|---:|
| Product-assisted | 3 | 3/3 | 120,817 ms | 3 | 2 | 1,013.33 |
| Free baseline | 3 | 0/3 | 191,080 ms | 18 | 18 | 5,818 |

The product arm reached and ran the required test in every session. The free baseline ran no tests and never produced authoritative first-useful-signal evidence. Provider exit zero occurred in all six sessions, demonstrating why process status cannot replace the scenario grader.

These records are `benchmark_eligible: false`. They are useful evidence that the current Evidence1 one-cell path and product behavior work repeatedly, but they do not support a general model-performance claim. Rounds 1–2 used harness commit `f027ff48`; round 3 used `6056b81f`.

See [Metrics and evidence](../metrics.md) for the complete table, descriptive statistics, and caveats. Sanitized artifacts are in [the dated evidence directory](../../tools/runs/agentic-eval-evidence1-product-vs-free-canary-2026-09-10/RESULTS.md).
