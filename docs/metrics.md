# Metrics and evidence

This is the canonical home for quantitative claims. The README contains only a small decision-grade summary.

## Interpretation rules

1. A ratio must use numerator and denominator from the same project and capture. Cross-project comparisons must be labelled as such.
2. Token counts depend on the tokenizer and capture boundary. Report both.
3. A live canary marked `benchmark_eligible: false` is operational evidence, not an inferential benchmark.
4. Missing authoritative measurements stay missing. Do not substitute wall time for first-useful-signal latency or process success for task success.
5. Public artifacts must be sanitized and must exclude credentials, raw authenticated transcripts, machine identifiers, and custody bundles.

## Token-cost captures

The established A/B/C protocol compares raw Gradle output and generated reports (A), the runner's human report (B), and the runner's JSON envelope (C). Approach C is the agent-facing path.

| Workload | Scope | Same-capture A:C result |
|---|---|---:|
| `parallel` | Three small public OSS projects | 56.6x median (range 1.3–102.2x) |
| `parallel` | Two medium public OSS projects | 90.0x median (range 84.4–95.6x) |
| `parallel` | One large public OSS project, 36 modules | 226,291:1,839 = 123.1x |
| `coverage` | One large configured composite capture | 28,754,177:734 = 39,175x |

The aggregate reports independent medians for columns A and C. Those two medians must not be recombined as though they came from one project; the table therefore reports the median of each project's same-capture A:C ratio. The large coverage capture is a stress case, not a typical run: raw Gradle plus generated Kover material occupied roughly 74 MB and required chunked counting. That comparison remains within one capture.

Sources: [multi-project aggregate](../tools/runs/multi-project-token-cost-2026-05-18/aggregate-2026-05-18.md), [parallel cross-model result](../tools/runs/cross-model-results-parallel.txt), [coverage cross-model result](../tools/runs/cross-model-results-coverage.txt), and the full [token-cost methodology](token-cost-measurement.md).

## Evidence1 Claude Windows canary — 2026-09-10

Three product-assisted sessions and three true free-baseline/no-product sessions ran the registered `coverage-threshold-failure-v2` scenario. Each session was new, one-shot, and had no retry, replacement, or respawn.

### Per-run observations

| Round | Arm | Harness commit | Wall ms | Expected outcome | First useful signal ms | Tool calls | Shell calls | Tests run | Output tokens |
|---:|---|---|---:|:---:|---:|---:|---:|---:|---:|
| 1 | product | `f027ff48` | 125,122 | yes | 122,410.2901 | 3 | 2 | 1 | 954 |
| 1 | free baseline | `f027ff48` | 237,056 | no | unavailable | 22 | 22 | 0 | 8,204 |
| 2 | product | `f027ff48` | 121,050 | yes | 116,738.7991 | 3 | 2 | 1 | 911 |
| 2 | free baseline | `f027ff48` | 165,732 | no | unavailable | 14 | 14 | 0 | 4,312 |
| 3 | product | `6056b81f` | 116,279 | yes | 113,591.1827 | 3 | 2 | 1 | 1,175 |
| 3 | free baseline | `6056b81f` | 170,452 | no | unavailable | 18 | 18 | 0 | 4,938 |

All six provider processes exited zero. That does not mean all six solved the task: the structured grader recorded `expected_outcome_matched` for 3/3 product sessions and 0/3 free-baseline sessions.

### Descriptive aggregate

| Metric | Product mean | Free-baseline mean | Relative difference |
|---|---:|---:|---:|
| Wall clock | 120,817 ms | 191,080 ms | -36.77% |
| Tool calls | 3.0 | 18.0 | -83.33% |
| Shell calls | 2.0 | 18.0 | -88.89% |
| Tests run | 1.0 | 0.0 | product reached the required test in every run |
| Input tokens | 8.0 | 38.0 | -78.95% |
| Output tokens | 1,013.33 | 5,818.0 | -82.58% |
| Cache-read tokens | 70,193.0 | 512,999.0 | -86.32% |
| Cache-create tokens | 28,263.33 | 34,613.67 | -18.35% |
| Captured output bytes | 18,566.67 | 41,515.33 | -55.28% |
| Stream bytes | 73,513.33 | 170,326.0 | -56.84% |

For product sessions, first useful signal averaged 117,580.091 ms (median 116,738.7991; min 113,591.1827; max 122,410.2901; sample SD 4,469.339; CV 3.80%). No authoritative first-useful-signal value exists for the free baseline because those sessions never produced the required evidence.

### Limits

- Every record is `benchmark_eligible: false`.
- The two arms use distinct measurement scopes, so this is a paired operational comparison, not a pooled campaign analysis.
- Rounds 1–2 used harness commit `f027ff48`; round 3 used `6056b81f`. The source project commit and Claude Code version remained pinned, but the mixed harness revision must remain visible.
- Six sessions do not establish population-level model performance or statistical significance.
- A failed pre-live launch that stopped before Claude started was excluded; it consumed no agent session and produced no accepted run record.

The public evidence directory contains only six sanitized run records, six accepted-run audit sidecars, and a result manifest: [Evidence1 canary evidence](../tools/runs/agentic-eval-evidence1-product-vs-free-canary-2026-09-10/RESULTS.md). Raw transcripts and custody material remain outside Git.

## Adding a measurement

Before adding a README number:

1. Commit or link a sanitized evidence artifact.
2. State project/corpus, revision, platform, runtime/model, cache state, and measurement boundary.
3. State whether it is benchmark-eligible.
4. Run the applicable validator and privacy gate.
5. Add the detailed result here; promote only the smallest useful summary to the README.
