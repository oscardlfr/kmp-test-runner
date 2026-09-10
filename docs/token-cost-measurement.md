# Token-cost measurement

This document explains the evidence behind the README's token-cost claims. It
is intentionally more detailed than the README: definitions, sample selection,
tokenizers, chunking, provenance, reproduction commands, and caveats all live
here so the README can stay short and timeless.

## Measurement status

The current README numbers reuse committed evidence rather than a fresh full
measurement matrix. A 2026-07-16 validation pass confirmed that the published
headline rows still trace to committed evidence, then added fresh public-project
`parallel` smoke measurements with the current CLI/tooling:
[`token-cost-validation-2026-07-16.md`](../tools/runs/token-cost-validation-2026-07-16.md).

- OSS size-bucket evidence: [`tools/runs/multi-project-token-cost-2026-05-18/aggregate-2026-05-18.md`](../tools/runs/multi-project-token-cost-2026-05-18/aggregate-2026-05-18.md)
- Cross-model feature evidence: [`tools/runs/cross-model-results-parallel.txt`](../tools/runs/cross-model-results-parallel.txt), [`tools/runs/cross-model-results-coverage.txt`](../tools/runs/cross-model-results-coverage.txt), [`tools/runs/cross-model-results-changed.txt`](../tools/runs/cross-model-results-changed.txt), [`tools/runs/cross-model-results-benchmark.txt`](../tools/runs/cross-model-results-benchmark.txt)

Recent audit-train work on `develop` changed edge-case diagnostics, warnings,
cache invalidation, and dry-run/error behavior. Those changes do not materially
change the successful `parallel` and `coverage` command-output shapes used by
the published ratios. The validation wave therefore did not re-run the full
six-project Gradle matrix. It ran a current NowInAndroid large-project
`parallel` smoke plus a KaMPKit app-module small smoke using offline
`cl100k_base`, then ran Anthropic `messages.countTokens` on the public
NowInAndroid captures with `claude-opus-4-8`, `claude-sonnet-4-6`, and
`claude-haiku-4-5`. OpenAI token-count API was not run because this repo has no
supported OpenAI token-count API path.

## Approaches

Every measurement compares the same workflow through three observation
strategies:

| Approach | What is measured | Why it matters |
|----------|------------------|----------------|
| A. raw Gradle | `./gradlew` stdout plus generated report files such as JUnit XML, test HTML, Kover HTML/XML, or benchmark JSON | The baseline cost an agent pays without `kmp-test` |
| B. markdown | `kmp-test <feature>` stdout | Human-friendly summary with less noise |
| C. JSON | `kmp-test <feature> --json` stdout | Agent-friendly single-line envelope |

A:C is the main ratio. Unless explicitly labelled as cross-project, the ratio
must use A and C from the same project/capture or the median of per-project
A:C ratios from the same bucket.

## Evidence sets

### OSS bucket sample

The OSS sample measures how `parallel` scales with project size. Buckets are
based on Gradle module count discovered by the recursive module walker in
`tools/measure-token-cost.js`.

| Bucket | Sample | Projects |
|--------|-------:|----------|
| small (1-5 modules) | 3 | KaMPKit (2), kotlinconf-app (5), kmp-production-sample (2) |
| medium (6-20 modules) | 2 | PeopleInSpace (7), Confetti (16) |
| large (21+ modules) | 1 | NowInAndroid (36) |

The committed aggregate reports medians, ranges, and per-project raw numbers:
[`aggregate-2026-05-18.md`](../tools/runs/multi-project-token-cost-2026-05-18/aggregate-2026-05-18.md).
That run fixed an earlier one-level module-walker undercount by recursing into
grouping directories. As a result, NowInAndroid was measured as 36 modules
instead of 5, and Confetti as 16 instead of 13.

Use the aggregate's `parallel` section for the README's OSS bucket rows. Its
older manually augmented `coverage` note is historical context only; the
published coverage headline below uses the same-project `private-large-A`
values from `cross-model-results-coverage.txt`.

The 2026-07-16 current-CLI smoke did not change the headline rows. The
NowInAndroid warmed rerun measured 234,046 raw `cl100k_base` tokens versus 2,013
JSON tokens, or 116.3x, close to the committed headline row of 226,291 versus
1,839, or 123.1x. Anthropic counts on the same public captures produced A:C
ratios of 123.3x for `claude-opus-4-8` and 133.0x for both
`claude-sonnet-4-6` and `claude-haiku-4-5`; no chunking was needed. The KaMPKit
smoke covered only the `app` module because the current shared KMP module does
not expose the generic `:shared:test` task shape; it is therefore a tooling
smoke, not a replacement small-bucket sample.

### Anonymized configured reference

Some features need a configured project to produce meaningful raw reports.
The anonymized `private-large-A` reference is a large KMP composite with roughly
70 modules plus Kover and kotlinx-benchmark configuration. It is used for:

- cross-tokenizer per-feature drill-downs;
- the large `coverage` ceiling, where raw Kover HTML/XML is the dominant cost;
- benchmark evidence where real benchmark functions produce report JSON.

Only anonymized labels and aggregate counts are committed. Raw private captures,
private paths, and private module names are not committed.

## Headline numbers

### `parallel` by project size

These are `cl100k_base` counts from the OSS bucket aggregate. A:C is the median
of per-project ratios inside each bucket.

| Bucket | A median | C median | A:C median | A:C range |
|--------|---------:|---------:|-----------:|-----------|
| small | 24,454 | 338 | 56.6x | 1.3x-102.2x |
| medium | 427,586 | 4,499 | 90.0x | 84.4x-95.6x |
| large | 226,291 | 1,839 | 123.1x | single sample |

### `private-large-A` per-feature drill-down

These are within-project ratios from the anonymized configured reference.

| Feature | Tokenizer | A raw | B markdown | C JSON | A:C |
|---------|-----------|------:|-----------:|-------:|----:|
| `parallel` | `cl100k_base` | 1,456,399 | 19,604 | 4,039 | 361x |
| `parallel` | `claude-opus-4-8` | 2,384,531 | 35,953 | 7,099 | 336x |
| `parallel` | `claude-sonnet-4-6` / `claude-haiku-4-5` | 1,941,373 | 25,284 | 4,980 | 390x |
| `coverage` | `cl100k_base` | 28,754,177 | 803 | 734 | 39,175x |
| `coverage` | `claude-opus-4-8` | 36,571,742 | 1,394 | 1,216 | 30,075x |
| `coverage` | `claude-sonnet-4-6` / `claude-haiku-4-5` | 28,468,274 | 1,055 | 938 | 30,350x |
| `changed` | `cl100k_base` | 41,626 | 125 | 173 | 241x |
| `changed` | `claude-opus-4-8` | 69,678 | 236 | 321 | 217x |
| `changed` | `claude-sonnet-4-6` / `claude-haiku-4-5` | 55,181 | 159 | 222 | 249x |
| `benchmark` | `cl100k_base` | 52,638 | 171 | 273 | 193x |
| `benchmark` | `claude-opus-4-8` | 72,459 | 314 | 494 | 147x |
| `benchmark` | `claude-sonnet-4-6` / `claude-haiku-4-5` | 61,856 | 205 | 322 | 192x |

Evidence files:

- [`cross-model-results-parallel.txt`](../tools/runs/cross-model-results-parallel.txt)
- [`cross-model-results-coverage.txt`](../tools/runs/cross-model-results-coverage.txt)
- [`cross-model-results-changed.txt`](../tools/runs/cross-model-results-changed.txt)
- [`cross-model-results-benchmark.txt`](../tools/runs/cross-model-results-benchmark.txt)

## Coverage outlier

Coverage is the largest measured token-cost gap. On `private-large-A`, raw
Gradle plus Kover report reading produced roughly 74 MB of HTML/XML. Anthropic's
token-count endpoint rejected that full payload as too large in a single
request. The measurement tool recovered the Anthropic counts by splitting at
file-record boundaries and summing per-chunk token counts.

The same coverage run through `kmp-test coverage --json` produced a compact
JSON envelope: 734 `cl100k_base` tokens. The published coverage ratio is
therefore a within-project comparison: 28,754,177 raw `cl100k_base` tokens
versus 734 JSON tokens, or 39,175x.

## Tokenizers

`tools/measure-token-cost.js` supports two counting modes:

- Offline `cl100k_base` via `js-tiktoken`.
- Anthropic `messages.countTokens` for Claude model families when API keys are
  explicitly supplied.

The committed cross-model files show that absolute token counts vary by
tokenizer, especially for XML/HTML-heavy payloads. The ratios remain large
across tokenizers. `claude-sonnet-4-6` and `claude-haiku-4-5` produced identical
counts in the committed evidence; `claude-opus-4-8` produced a different count
profile.

Do not call Anthropic or OpenAI token APIs during routine docs cleanup unless
the maintainer explicitly approves it. Offline `cl100k_base` checks are cheap
and safe when local captures already exist.

## Chunking behavior

Large captures can exceed either tokenizer runtime limits or remote API request
limits. The measurement tool handles that in two places:

- `countTokensCl100k` chunks very large strings before passing them to
  `js-tiktoken`.
- `countTokensAnthropic` chunks large payloads before calling
  `messages.countTokens`.

The preferred split point is the file-record delimiter emitted by report
collection: `\n=== <file> ===\n`. If that cannot keep chunks below the target
byte size, the fallback is byte-window chunking. BPE token counts are close to
additive across these boundaries; the remaining boundary error is negligible at
the scale of the large coverage capture.

## Reproduction

### Multi-project bucketed measurement

The multi-project runner reads either an explicit JSON config, the
`KMP_MEASUREMENT_PROJECTS` environment variable, or the gitignored conventional
config at `tools/.measurement-projects.json`.

```bash
node tools/measure-token-cost.js --projects-config /path/to/projects.json --features parallel,coverage
```

Project entries must use anonymized labels for private projects before any
aggregate is committed.

### Single-project capture

```bash
node tools/measure-token-cost.js --feature parallel \
  --project-root /path/to/kmp/project \
  --module-filter "<module-glob>" \
  --test-task test
```

Feature-specific knobs:

- `--feature coverage` reads Kover report output after running coverage tasks.
- `--feature changed` accepts `--changed-range <rev>` for the diff used to pick
  modules.
- `--feature benchmark` accepts `--benchmark-task <task>`.
- `--runs N` repeats each approach and reports summary statistics.

### Cross-model re-tokenization

This mode reads existing captures from `tools/runs/<feature>/` and writes a
summary table. It requires explicit API-key approval before use.

```bash
ANTHROPIC_API_KEY=sk-ant-... node tools/measure-token-cost.js \
  --feature parallel \
  --anthropic-models claude-opus-4-8,claude-sonnet-4-6,claude-haiku-4-5 \
  > tools/runs/cross-model-results-parallel.txt
```

For multi-account workflows, the tool can fall back from `ANTHROPIC_API_KEY` to
`ANTHROPIC_API_KEY_FALLBACK` on authentication failure. That is an operational
escape hatch, not a reason to run API-backed measurement casually.

## Measurement registry

Every token-count measurement referenced on this page is also recorded as an
append-only row in
[`tools/runs/measurement-registry.jsonl`](../tools/runs/measurement-registry.jsonl).
Each row is one (approach, tokenizer) observation tagged with its measurement
kind (`full-matrix`, `smoke`, `trace-validation`, `private-reference`), cache
state, platform, and privacy status. This page stays the narrative and
methodology reference; the registry is the queryable ledger its numbers trace
back to.

```bash
node tools/measurement-registry.mjs validate     # schema + privacy + A:C sanity checks
node tools/measurement-registry.mjs export-csv   # regenerates the derived, gitignored .csv
node tools/measurement-registry.mjs summarize    # totals, or --feature <name> for a pivoted table
```

A Windows validation wave backfilled the registry with every evidence source
already referenced on this page, then added fresh Windows measurements for
public `NowInAndroid`/`KaMPKit` smokes:
[`token-cost-validation-windows-2026-07-16.md`](../tools/runs/token-cost-validation-windows-2026-07-16.md).
The private-reference re-measurement was a deliberate NO-GO that wave — see
that document for the reasoning.

A follow-up Windows session backfilled the registry's remaining feature gap
(`info`/`describe`/`changed`/`benchmark`, all from evidence already committed
above — zero new API calls) and corrected one mischaracterized row (a
2026-07-16 KaMPKit capture that had actually recorded a Gradle Android-SDK
failure, not a real measurement):
[`token-cost-validation-windows-2026-07-17.md`](../tools/runs/token-cost-validation-windows-2026-07-17.md).
The registry now covers all 6 features. `private-large-A` remains
un-re-measured; its `claude-sonnet-5` cross-model refresh is tracked in
BACKLOG.md as a separate, explicitly-approved future task.

## Captured outputs

Committed summary evidence lives under `tools/runs/`:

```text
tools/runs/
  multi-project-token-cost-2026-05-18/
    aggregate-2026-05-18.md
  cross-model-results-parallel.txt
  cross-model-results-coverage.txt
  cross-model-results-changed.txt
  cross-model-results-benchmark.txt
  cross-model-results-info.txt
  cross-model-results-describe.txt
  measurement-registry.jsonl
  token-cost-validation-2026-07-16.md
  token-cost-validation-windows-2026-07-16.md
  token-cost-validation-windows-2026-07-17.md
```

Per-project raw captures are intentionally not committed for the multi-project
matrix. The gitignored shape is:

```text
tools/runs/multi-project-token-cost-<date>/per-project/<label>/<feature>/{A,B,C}-run-N.txt
```

The configured-reference raw captures under `tools/runs/<feature>/` are also
treated as measurement-machine artifacts. Commit the redacted summary files, not
private paths or raw private logs.

## Caveats

- The OSS bucket sample is intentionally small. It is useful for trend shape,
  not a statistical model of all KMP repositories.
- The large OSS bucket has one public sample. The configured private reference
  is tracked separately and should not be mixed into OSS A:C ratios.
- `coverage` depends on coverage tooling being configured. Public projects
  without Kover/Jacoco produce only "task not found" style raw output, which is
  not a meaningful coverage baseline.
- `changed` depends on the size and shape of the diff. A single-module change
  and a sweeping refactor are not comparable.
- `benchmark` markdown can be intentionally larger than JSON because the human
  report includes per-benchmark scores.
- Failure output can inflate every approach. Raw Gradle usually inflates most
  because stack traces and generated XML both enter the capture.
- Tokenizer implementations can drift. Reuse committed evidence for docs-only
  edits unless a product change materially alters the envelope shape.
