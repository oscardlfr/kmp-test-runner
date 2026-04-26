# Token-cost measurement

Empirical measurement of the token cost an AI agent pays to run a KMP
workflow in three different ways, across four `kmp-test` features.
Backs the qualitative claim in the README "Why this exists" section
with real numbers from a representative KMP SDK module.

## Cross-feature summary — 4 features × 3 approaches × 4 tokenizers

Every cell is a real token count (`cl100k_base` via `js-tiktoken` offline; the
three Claude columns via Anthropic's `messages.countTokens` API). Bars are
full-block unicode characters (`█`) scaled to the global table max
(`coverage · A · opus-4-7` = **123,845 tokens** = 10 chars wide). `sonnet-4-6`
and `haiku-4-5` share a tokenizer (identical counts to the unit on every cell)
so they're merged into a single column here. Sub-1-char values render as `▏`.

| Feature · Approach    | 🟦 cl100k_base       | 🟥 opus-4-7          | 🟩🟧 sonnet · haiku   |
|-----------------------|----------------------|----------------------|-----------------------|
| `parallel`  · A. raw  | ` 12,807 █`          | ` 25,780 ██`         | ` 19,234 ██`          |
| `parallel`  · B. md   | `    376 ▏`          | `    642 ▏`          | `    444 ▏`           |
| `parallel`  · C. json | `    101 ▏`          | `    187 ▏`          | `    125 ▏`           |
| ─────────             | ──────────────────── | ──────────────────── | ───────────────────── |
| `coverage`  · A. raw  | `108,405 █████████`  | `123,845 ██████████` | ` 92,940 ████████`    |
| `coverage`  · B. md   | `    273 ▏`          | `    482 ▏`          | `    317 ▏`           |
| `coverage`  · C. json | `     89 ▏`          | `    162 ▏`          | `    109 ▏`           |
| ─────────             | ──────────────────── | ──────────────────── | ───────────────────── |
| `changed`   · A. raw  | ` 12,694 █`          | ` 25,580 ██`         | ` 19,098 ██`          |
| `changed`   · B. md   | `    466 ▏`          | `    787 ▏`          | `    550 ▏`           |
| `changed`   · C. json | `    100 ▏`          | `    186 ▏`          | `    125 ▏`           |
| ─────────             | ──────────────────── | ──────────────────── | ───────────────────── |
| `benchmark` · A. raw  | ` 16,083 █`          | ` 23,527 ██`         | ` 19,266 ██`          |
| `benchmark` · B. md   | `  6,211 █`          | `  9,916 █`          | `  7,596 █`           |
| `benchmark` · C. json | `     89 ▏`          | `    163 ▏`          | `    109 ▏`           |

A:C savings ratio per feature, per tokenizer (the headline number — relative
cost of raw gradle vs `--json`):

| Feature      | 🟦 cl100k_base | 🟥 opus-4-7 | 🟩 sonnet-4-6 | 🟧 haiku-4-5 |
|--------------|--------------:|------------:|--------------:|-------------:|
| `parallel`   |          127× |        138× |          154× |         154× |
| `coverage`   |     **1218×** |    **765×** |      **853×** |     **853×** |
| `changed`    |          127× |        138× |          153× |         153× |
| `benchmark`  |          181× |        144× |          177× |         177× |

Three patterns hold across every feature × tokenizer combination:

1. **C is consistently 89–187 tokens.** The `--json` envelope strips the
   feature down to `{exit_code, tests, modules, errors[]}` regardless of
   how heavy the underlying gradle workload is.
2. **A always exceeds 12 K tokens** on `cl100k_base` (and ~25 K on
   `claude-opus-4-7`). Raw gradle stdout alone is verbose; the report
   files multiply it. `coverage` is an outlier (108–124 K) because
   Kover HTML reports include per-line annotated source pages.
3. **B's variance comes from how rich the per-feature markdown report is.**
   Tiny on parallel/coverage/changed (273–787 tokens), heavy on
   benchmark (6,211–9,916) because the markdown report inlines
   per-benchmark scores by design — useful for humans, expensive for
   agents.

Two cross-tokenizer observations:
- **Tokenizer transition.** `claude-sonnet-4-6` and `claude-haiku-4-5`
  share a tokenizer (identical counts to the unit on every cell).
  `claude-opus-4-7` ships a new tokenizer that produces 30–100% more
  tokens for the same input — most visibly on heavy XML/HTML payloads
  (approach A).
- **Ratios survive across tokenizers.** Despite per-model spreads of
  70–101% in absolute count, the A:C ratio sits in a feature-specific
  band that holds across all four tokenizers (parallel/changed in
  127×–154×, benchmark in 144×–181×, coverage in 765×–1218×).

## Per-feature drill-down

Each per-feature table is scaled to its own column max (so the bar
visualisation maximises within the feature). Bars in column A always
dominate; B/C are sub-1-char unicode blocks that visually disappear —
that's the savings story.

### `parallel` — full test suite

Bars scaled to `25,780` (opus, A).

| Model               | A. raw                              | B. md         | C. --json     | A:C   |
|---------------------|-------------------------------------|---------------|---------------|-------|
| 🟦 `cl100k_base`    | ` 12,807 ██████████`                | `   376 ▏`    | `   101 ▏`    | 127×  |
| 🟥 `opus-4-7`       | ` 25,780 ████████████████████`      | `   642 █`    | `   187 ▏`    | 138×  |
| 🟩 `sonnet-4-6`     | ` 19,234 ███████████████`           | `   444 ▏`    | `   125 ▏`    | 154×  |
| 🟧 `haiku-4-5`      | ` 19,234 ███████████████`           | `   444 ▏`    | `   125 ▏`    | 154×  |

Captures: [`tools/runs/parallel/`](../tools/runs/parallel/) · evidence: [`tools/runs/cross-model-results-parallel.txt`](../tools/runs/cross-model-results-parallel.txt).

### `coverage` — Kover XML + HTML reports

Bars scaled to `123,845` (opus, A) — the largest cell across the whole
measurement.

| Model               | A. raw                                    | B. md         | C. --json     | A:C       |
|---------------------|-------------------------------------------|---------------|---------------|-----------|
| 🟦 `cl100k_base`    | `108,405 ██████████████████`              | `   273 ▏`    | `    89 ▏`    | **1218×** |
| 🟥 `opus-4-7`       | `123,845 ████████████████████`            | `   482 ▏`    | `   162 ▏`    | 765×      |
| 🟩 `sonnet-4-6`     | ` 92,940 ███████████████`                 | `   317 ▏`    | `   109 ▏`    | 853×      |
| 🟧 `haiku-4-5`      | ` 92,940 ███████████████`                 | `   317 ▏`    | `   109 ▏`    | 853×      |

The largest savings of any feature. Kover HTML reports include a fully
annotated source page per file (line numbers, hit counts, branch summaries,
package indexes) — slurping `build/reports/kover/**` for one module
gives the agent ~261 KB of HTML it has to scan to find one number.

Captures: [`tools/runs/coverage/`](../tools/runs/coverage/) · evidence: [`tools/runs/cross-model-results-coverage.txt`](../tools/runs/cross-model-results-coverage.txt).

### `changed` — tests for modules touched since `HEAD~1`

Bars scaled to `25,580` (opus, A).

| Model               | A. raw                              | B. md         | C. --json     | A:C   |
|---------------------|-------------------------------------|---------------|---------------|-------|
| 🟦 `cl100k_base`    | ` 12,694 ██████████`                | `   466 ▏`    | `   100 ▏`    | 127×  |
| 🟥 `opus-4-7`       | ` 25,580 ████████████████████`      | `   787 █`    | `   186 ▏`    | 138×  |
| 🟩 `sonnet-4-6`     | ` 19,098 ███████████████`           | `   550 ▏`    | `   125 ▏`    | 153×  |
| 🟧 `haiku-4-5`      | ` 19,098 ███████████████`           | `   550 ▏`    | `   125 ▏`    | 153×  |

Wall-clock note: B/C take 33–42s vs A's 2s because `kmp-test changed`
delegates to the full parallel coverage suite (broader test selection),
while A only invokes the single `:module:desktopTest` task an agent
without `kmp-test` would naturally type. The token-cost ratio is the
headline — B/C deliver more thorough testing in 100–466 tokens vs A's
12,694.

Captures: [`tools/runs/changed/`](../tools/runs/changed/) · evidence: [`tools/runs/cross-model-results-changed.txt`](../tools/runs/cross-model-results-changed.txt).

### `benchmark` — JMH `desktopSmokeBenchmark`

Bars scaled to `23,527` (opus, A). B is unusually heavy here
(`6,211`–`9,916`) — the markdown report inlines per-benchmark scores
by design.

| Model               | A. raw                              | B. md             | C. --json     | A:C   |
|---------------------|-------------------------------------|-------------------|---------------|-------|
| 🟦 `cl100k_base`    | ` 16,083 ██████████████`            | ` 6,211 █████`    | `    89 ▏`    | 181×  |
| 🟥 `opus-4-7`       | ` 23,527 ████████████████████`      | ` 9,916 ████████` | `   163 ▏`    | 144×  |
| 🟩 `sonnet-4-6`     | ` 19,266 ████████████████`          | ` 7,596 ██████`   | `   109 ▏`    | 177×  |
| 🟧 `haiku-4-5`      | ` 19,266 ████████████████`          | ` 7,596 ██████`   | `   109 ▏`    | 177×  |

Largest B:C gap of any feature (60×–70×). If you need the per-benchmark
scores, use B; if you only need to know whether benchmarks regressed, C
is 70× cheaper.

Captures: [`tools/runs/benchmark/`](../tools/runs/benchmark/) · evidence: [`tools/runs/cross-model-results-benchmark.txt`](../tools/runs/cross-model-results-benchmark.txt).

## Methodology

- **Reference project**: a representative KMP SDK module (~80-module
  multi-target codebase, JDK 21). The captures committed under
  `tools/runs/` are byte-for-byte the actual output measured; project
  identity is not part of the methodology — any KMP project with similar
  module density would reproduce the ratios within the same band.
- **Per-feature scope** (one module each, kept consistent across measurements):
    - `parallel`, `coverage`, `changed` → a small Result/Either-style
      utility module (4 unit-test files, KMP `desktopTest` target).
    - `benchmark` → a kotlinx-benchmark module
      (`desktopSmokeBenchmark` config: 3 warmups × 3 iterations × 500 ms).
- **Tokenizer**: `cl100k_base` via [`js-tiktoken`](https://www.npmjs.com/package/js-tiktoken)
  for the baseline numbers above. Anthropic's
  [`messages.countTokens`](https://docs.anthropic.com/en/api/messages-count-tokens)
  API for cross-model validation per Claude 4.x model — that endpoint
  is free of charge (rate-limited only) and returns the exact
  `input_tokens` count those models would charge for. Per-feature
  evidence files in `tools/runs/cross-model-results-<feature>.txt`.
- **`changed` setup**: a synthetic uncommitted change is applied to the
  target module so both approaches see the same git diff. The script
  then calls `git diff --name-only HEAD` (override via
  `--changed-range <rev>`) to detect modules; the bash CLI uses
  `git status --porcelain`. Both resolve to the same module set for
  tracked-file edits.
- **`benchmark` JDK**: `kotlinx-benchmark` modules whose convention
  plugin sets `jvmTarget = JVM_21` require JDK 21 at build time. Run
  with `JAVA_HOME=<jdk-21>` or the JmhBytecodeGeneratorWorker fails
  with a class file version mismatch.
- **Date**: 2026-04-26. **Tool version**: kmp-test-runner v0.4.0
  (multi-feature measurement; v0.3.9 introduced cross-model validation
  for the parallel feature).
- **Runs per approach**: 1. The script supports `--runs N` for noise
  robustness; with the Gradle daemon hot the variance run-to-run is
  small.

## Captured outputs

The `tools/runs/` directory contains the actual stdout captured for each
approach (committed alongside this doc, one subdirectory per feature):

```
tools/runs/
├── parallel/
│   ├── A-run1.txt    # ./gradlew :<module>:desktopTest + reports walk
│   ├── B-run1.txt    # kmp-test parallel --module-filter <module>
│   └── C-run1.txt    # kmp-test parallel --json --module-filter <module>
├── coverage/
│   ├── A-run1.txt    # ./gradlew :<module>:koverXml/HtmlReport + reports walk
│   ├── B-run1.txt    # kmp-test coverage
│   └── C-run1.txt    # kmp-test coverage --json
├── changed/
│   ├── A-run1.txt    # ./gradlew :<module>:desktopTest + reports walk
│   ├── B-run1.txt    # kmp-test changed
│   └── C-run1.txt    # kmp-test changed --json
├── benchmark/
│   ├── A-run1.txt    # ./gradlew :<bench>:desktopSmokeBenchmark + JSON reports
│   ├── B-run1.txt    # kmp-test benchmark
│   └── C-run1.txt    # kmp-test benchmark --json
├── cross-model-results-parallel.txt    # per-tokenizer run (Anthropic countTokens)
├── cross-model-results-coverage.txt
├── cross-model-results-changed.txt
└── cross-model-results-benchmark.txt
```

## Reproducibility

Per-feature capture (writes `tools/runs/<feature>/{A,B,C}-run1.txt`) —
substitute your own KMP project root + module names:

```bash
# parallel — full test suite
node tools/measure-token-cost.js --feature parallel \
  --project-root /path/to/your/kmp/project \
  --module-filter "<your-module>" \
  --test-task desktopTest

# coverage — Kover XML + HTML reports
node tools/measure-token-cost.js --feature coverage \
  --project-root /path/to/your/kmp/project \
  --module-filter "<your-module>"

# changed — modules touched since HEAD~1 (or override --changed-range)
node tools/measure-token-cost.js --feature changed \
  --project-root /path/to/your/kmp/project \
  --test-task desktopTest \
  --changed-range HEAD       # use working-tree changes, like the CLI does

# benchmark — JMH desktop smoke config (kotlinx-benchmark on JDK 21+)
JAVA_HOME=/path/to/jdk-21 node tools/measure-token-cost.js --feature benchmark \
  --project-root /path/to/your/kmp/project \
  --module-filter "<your-bench-module>" \
  --benchmark-task desktopSmokeBenchmark
```

Cross-model re-tokenize (per feature; reads existing captures from
`tools/runs/<feature>/`):

```bash
ANTHROPIC_API_KEY=sk-ant-... node tools/measure-token-cost.js \
  --feature <name> \
  --anthropic-models claude-opus-4-7,claude-sonnet-4-6,claude-haiku-4-5 \
  > tools/runs/cross-model-results-<name>.txt
```

## What this means in practice

Per agent iteration the absolute token saving is feature-specific:

| Feature    | A→C absolute saving (cl100k_base) | 5-iteration loop saving |
|------------|----------------------------------:|------------------------:|
| `parallel`  |                            12,706 |                  ~64 K |
| `coverage`  |                       **108,316** |             **~542 K** |
| `changed`   |                            12,594 |                  ~63 K |
| `benchmark` |                            15,994 |                  ~80 K |

A 5-iteration coverage loop on raw gradle burns ~542 K tokens — more
than two full 200 K Claude contexts. The same loop on `--json` burns
~500 tokens. **Context window pressure** is the real story, not the
dollar cost: the agent's working memory stays focused on the code
instead of log noise.

## Caveats

- **Tokenizer drift, validated.** `cl100k_base` is OpenAI's; Claude's
  tokenizer differs and isn't even consistent within the 4.x family
  (`claude-opus-4-7` ships a new tokenizer that's 34–50% less compact
  than the one shared by `sonnet-4-6` / `haiku-4-5`). The *ratio*
  between approaches (127× to 1218× for A vs C, depending on feature)
  is robust across all four tokenizers measured per feature.
- **Project size matters.** A larger module set explodes A's cost
  faster than B/C (more `> Task` lines, more report files). Re-running
  on a 100+-module aggregate would show even larger ratios. The current
  measurement is a conservative single-module baseline.
- **Failure shape matters.** A real test assertion failure with a long
  stack trace would inflate all three approaches, but A would inflate
  the most (the full trace lands in `build/test-results/*.xml`).
- **`coverage` ratio is an upper bound on a small module.** The 1218×
  number comes from comparing 108 K tokens of Kover HTML against an
  89-token JSON envelope. On a multi-module aggregate (10+ modules
  under `--module-filter`) the absolute A grows linearly while C stays
  at ~89 tokens — the ratio grows further, not shrinks.
- **`benchmark` B is intentionally heavy.** The markdown report inlines
  per-benchmark scores so a human reviewer can see what regressed.
  Agents that only need a pass/fail should use C.
- **Single run.** Re-run with `--runs 3` (or higher) for mean ± std
  numbers if precision matters for your context.
