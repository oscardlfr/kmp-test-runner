# Metrics and measurement

`kmp-test-runner` has two different measurement programs:

1. **Output reduction:** compares raw Gradle/report material with the product's
   Markdown and JSON output.
2. **Agentic evaluation:** compares how an agent behaves with and without a
   pinned skill/product surface under controlled conditions.

They answer different questions. A large A:C output ratio does not prove that
an agent succeeds more often, and an agentic success contrast does not prove a
particular token reduction.

## Output-reduction methodology

Every capture measures one workflow through three observation strategies:

| Approach | Captured surface | Intended consumer |
| --- | --- | --- |
| A — raw Gradle | Gradle stdout/stderr plus relevant generated reports such as JUnit XML, test HTML, Kover HTML/XML, or benchmark JSON | Baseline an agent would otherwise inspect |
| B — Markdown | `kmp-test <feature>` stdout | Human-readable summary |
| C — JSON | `kmp-test <feature> --json` stdout | Agent-readable envelope |

The main reduction ratio is:

```text
A:C = tokens(A from one project/capture) / tokens(C from that same project/capture)
```

Never combine A from one project with C from another. For a size bucket, first
compute each project's same-capture A:C ratio, then report the median of those
ratios. The displayed median A and median C are descriptive columns; dividing
those two medians is not guaranteed to reproduce the median A:C ratio.

The canonical methodology, tokenizer behavior, registry schema, and reproduction
options remain in [Token-cost measurement](token-cost-measurement.md).

## Current evidence status

The following figures are real and traceable, but they do not all deserve the
same prominence.

| Scenario | `cl100k_base` evidence | Status for current documentation |
| --- | ---: | --- |
| `parallel`, small public projects | 56.6x median; range 1.3x-102.2x; `n=3` | Historical, highly dispersed. Keep in the detailed record; do not use as an unqualified current headline without a fresh full matrix. |
| `parallel`, medium public projects | 90.0x median; range 84.4x-95.6x; `n=2` | Historical and internally consistent, but small sample. Date and qualify it or refresh it. |
| `parallel`, large public project | 123.1x historical; fresh warm smokes 116.3x and 116.7x; `n=1` project | Directionally replicated. “Approximately 116-123x on the measured public large project” is defensible when project, date, and cache state are shown. |
| `coverage`, large configured composite | 39,175x; one anonymized private same-capture reference | Valid stress-case ceiling, not a typical-run estimate or current public benchmark. |

### Provenance

- Public size buckets: [2026-05-18 aggregate](../tools/runs/multi-project-token-cost-2026-05-18/aggregate-2026-05-18.md).
- Public large-project refresh: [cross-platform validation](../tools/runs/token-cost-validation-2026-07-16.md)
  and [Windows validation](../tools/runs/token-cost-validation-windows-2026-07-16.md).
- Corrected small-project Windows smoke: [2026-07-17 correction](../tools/runs/token-cost-validation-windows-2026-07-17.md).
- Configured composite feature captures:
  [`parallel`](../tools/runs/cross-model-results-parallel.txt),
  [`coverage`](../tools/runs/cross-model-results-coverage.txt),
  [`changed`](../tools/runs/cross-model-results-changed.txt), and
  [`benchmark`](../tools/runs/cross-model-results-benchmark.txt).
- Queryable ledger: [`measurement-registry.jsonl`](../tools/runs/measurement-registry.jsonl).

### Why 39,175x needs a warning

The coverage stress case compares approximately 74 MB of raw Kover HTML/XML
with a 734-token JSON envelope in the same anonymized configured project:
28,754,177 divided by 734 rounds to 39,175x. The arithmetic and same-capture
provenance are valid. The magnitude is dominated by report volume in one large
private composite, so it must not be presented as a normal expected reduction.

The private capture was not regenerated during the July validation because
doing so would recreate a large private artifact and potentially send chunked
content to an external token-count API without new product signal. Re-run it
only when the coverage envelope materially changes and the maintainer explicitly
approves the privacy and API cost.

## Repeating the public matrix

“Repeat the public matrix” means measuring the same public project set with the
current CLI, fixed project commits, recorded cache policy, and isolated output
directories. It does not invoke an agent runtime and does not require Anthropic
or OpenAI APIs when `cl100k_base` is used offline.

The historical set is:

| Bucket | Projects | Historical sample |
| --- | --- | ---: |
| Small, 1-5 modules | KaMPKit, kotlinconf-app, kmp-production-sample | 3 |
| Medium, 6-20 modules | PeopleInSpace, Confetti | 2 |
| Large, 21+ modules | NowInAndroid | 1 |

Check out every clone at its chosen commit, verify it is clean, and record those
commits in the measurement report. Then create a gitignored projects
configuration containing only the supported `path`, public `label`, and
`bucket` fields. Run the whole matrix once with three repetitions per approach:

```bash
node tools/measure-token-cost.js \
  --projects-config <gitignored-public-projects-config> \
  --features parallel \
  --runs 3
```

The tool writes to a date-based directory under `tools/runs/` and does not yet
accept a configurable output root. Before starting, confirm that the day's
destination contains no evidence that this invocation could overwrite. Use a
fresh measurement checkout or preserve the existing directory without deleting
it. Do not launch a second same-day matrix as a substitute for `--runs 3`, and
do not use a bare single-project invocation when it would write into shared
capture paths; the 2026-07-17 incident report documents how that can overwrite
unrelated gitignored local captures.

A professional refresh records, per project and approach:

- project URL, exact commit, module count and platform;
- product/harness commit and CLI version;
- exact command shape and task/filter choices;
- run/repetition index, order, cache state, JDK and Gradle versions;
- bytes, tokenizer ID/version, token count and any chunking;
- exit code, whether real tests ran, and any setup failure;
- A:C for the same capture;
- `n`, minimum, maximum, median, mean, and dispersion in the aggregate.

Reject configuration failures and placeholder/no-test projects from a claim
about successful-test output, or label them as a separate failure/no-test
stratum. Never silently discard them after seeing the ratio.

## Tokenizers and cost

- `cl100k_base` through `js-tiktoken` is the cheap, reproducible offline count
  used for the main historical table.
- Anthropic `messages.countTokens` measurements are vendor/model-specific and
  require explicit approval, an exact dated model identifier, and disclosure of
  chunking.
- The repository has no supported OpenAI token-count API workflow. An offline
  `cl100k_base` estimate is not an OpenAI billable-token statement.
- Absolute counts from different tokenizers are not directly comparable.
- A monetary cost needs a dated pricing snapshot. Do not calculate current cost
  during a historical aggregation.

## Agentic-evaluation metrics

Agentic records keep correctness, evidence quality, behavior, resource use, and
protocol integrity separate.

| Dimension | Examples | Interpretation rule |
| --- | --- | --- |
| Outcome | `success`, expected outcome match, per-field mismatch | Report factual correctness separately from how it was evidenced. |
| Evidence | product-canonical, direct-build-tool, claim-only | A correct claim without authoritative evidence is not product-equivalent evidence. |
| Activation | skill available, attempted, confirmed | A `Skill` tool call is only confirmed when its correlated result succeeds. |
| Work | tool calls, shell commands, test invocations, retries, operation roles | Counts require the same capture surface and taxonomy. |
| Time | total wall time, first useful signal, product-reported duration, tool round trip | Do not label residual non-tool time as “reasoning time.” |
| Volume | tool-output bytes, runtime-native usage dimensions, offline estimate | Keep bytes, estimates, and native usage separate. |
| Integrity | schema, policy/accounting, provenance, privacy, sidecar, custody | `benchmark_eligible` reports this layer, not task success. |

Within-condition summaries should include the exact `n`, run order, every
individual outcome, median, minimum, maximum, mean, and sample standard deviation
when meaningful. With only a few repetitions, present the difference as an
**observed descriptive contrast**, not an effect estimate or confidence claim.

### Cross-runtime reporting

Never pool Claude and Codex into one treatment ratio. Runtime, CLI version,
model, event protocol, tool surface, hidden scaffolding, tokenizer, cache
semantics, and usage accounting are different partitions. A cross-runtime table
may show descriptive values side by side only when it states those differences
and identifies each captured surface.

Codex runtime validation is currently separate work. Until its adapter, tests,
registry entry, and sanitized records are merged, this documentation publishes
no Codex support claim or metric.

### Evidence1 results

The 2026-09-10 Windows operational canary contains three independently launched
Product sessions and three independently launched FreeBaseline sessions. Each
was authorized as a one-shot run: no retry, replacement, or respawn. All six
used Claude Code 2.1.238, `claude-sonnet-5`, the public NowInAndroid commit
`7d45eae4`, a cold cache, and the `coverage-threshold-failure-v2` scenario under
the externally attested `sandboxed-unrestricted-v1` profile.

| Arm / sanitized run | Harness commit | Expected outcome | Wall time | First useful signal | Tool / shell / test invocations | Runtime usage: input / cached / cache write / output |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| Product [`94267216`](../tools/runs/agentic-eval-evidence1-product-vs-free-canary-2026-09-10/scenario-current-skill-94267216.json) | `6056b81f` | matched | 116.3 s | 113.6 s | 3 / 2 / 1 | 8 / 67,400 / 31,186 / 1,175 |
| Product [`a1501778`](../tools/runs/agentic-eval-evidence1-product-vs-free-canary-2026-09-10/scenario-current-skill-a1501778.json) | `f027ff48` | matched | 121.1 s | 116.7 s | 3 / 2 / 1 | 8 / 75,764 / 22,592 / 911 |
| Product [`b08fd625`](../tools/runs/agentic-eval-evidence1-product-vs-free-canary-2026-09-10/scenario-current-skill-b08fd625.json) | `f027ff48` | matched | 125.1 s | 122.4 s | 3 / 2 / 1 | 8 / 67,415 / 31,012 / 954 |
| FreeBaseline [`124307ad`](../tools/runs/agentic-eval-evidence1-product-vs-free-canary-2026-09-10/scenario-no-skill-124307ad.json) | `f027ff48` | not matched | 165.7 s | unavailable | 14 / 14 / 0 | 30 / 349,894 / 32,216 / 4,312 |
| FreeBaseline [`3f971561`](../tools/runs/agentic-eval-evidence1-product-vs-free-canary-2026-09-10/scenario-no-skill-3f971561.json) | `6056b81f` | not matched | 170.5 s | unavailable | 18 / 18 / 0 | 38 / 504,243 / 34,499 / 4,938 |
| FreeBaseline [`3c548521`](../tools/runs/agentic-eval-evidence1-product-vs-free-canary-2026-09-10/scenario-no-skill-3c548521.json) | `f027ff48` | not matched | 237.1 s | unavailable | 22 / 22 / 0 | 46 / 684,860 / 37,126 / 8,204 |

Descriptive summaries, with no cross-arm pooling:

| Metric | Product (`n=3`) | FreeBaseline (`n=3`) |
| --- | ---: | ---: |
| Expected outcome matched | 3/3 | 0/3 |
| Wall time, median (range) | 121.1 s (116.3-125.1) | 170.5 s (165.7-237.1) |
| Wall time, mean | 120.8 s | 191.1 s |
| First useful signal, median (range) | 116.7 s (113.6-122.4) | unavailable in 3/3 |
| Tool calls, median (range) | 3 (3-3) | 18 (14-22) |
| Shell commands, median (range) | 2 (2-2) | 18 (14-22) |
| Test invocations, median (range) | 1 (1-1) | 0 (0-0) |
| Captured output bytes, median (range) | 18,565 (18,565-18,570) | 40,450 (40,299-43,797) |
| Runtime output usage, median (range) | 954 (911-1,175) | 4,938 (4,312-8,204) |

The Product first-useful-signal mean was 117.6 s, with sample standard
deviation 4.5 s and coefficient of variation 3.8%. FreeBaseline has no
correlated authoritative outcome event, so its missing signal is reported as
unavailable rather than zero. Provider process exit was zero for all sessions;
that did not make the three baseline answers factually correct.

This is an **operational canary, not a benchmark or causal estimate**. Every
record deliberately carries `benchmark_eligible:false`, the sample is only
three sessions per arm, run ordering was not a preregistered balanced design,
and two harness commits appear in both arms. The analyzer excludes all six from
benchmark aggregates by design. The observed 3/3 versus 0/3 contrast and the
resource distributions are useful for validating the workflow and choosing the
next experiment, not for claiming a treatment effect.

The committed privacy-safe source of truth is the
[Evidence1 result index](../tools/runs/agentic-eval-evidence1-product-vs-free-canary-2026-09-10/RESULTS.md).
Each record has a validated accepted-run sidecar containing the attestation,
evidence correlation, structured tool-call data, and integrity details; the
analyzer derives operation-role distributions from those calls. Raw transcripts,
authentication state, and custody artifacts remain local.

## Publication checklist

- Every ratio is same-project and same-capture, or explicitly labelled otherwise.
- Dates, sample size, project/alias, platform, cache state, and tokenizer appear
  beside the number or in the immediately linked evidence.
- Median ratios are not reverse-engineered from independently computed median
  numerator and denominator columns.
- Smokes, stress cases, historical figures, and full matrices are labelled
  distinctly.
- Setup failures are not reported as successful product measurements.
- Runtime-native usage is not presented as billable cost or compared across
  vendors as if semantics matched.
- Missing values remain `null`/`not recorded`, never zero.
- Raw/private material remains local and no external API receives it without
  explicit approval.
- The README contains only a concise, defensible subset and links here for full
  provenance and caveats.
