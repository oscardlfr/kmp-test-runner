# kmp-test-runner

Parallel test runner for Kotlin Multiplatform and Android Gradle projects. CLI and Gradle plugin that fan out unit, instrumented, coverage, and benchmark tasks across modules in parallel and emit a single-line JSON envelope optimized for AI coding agents.

## Why this exists — token cost per agent test-run iteration

For an AI coding agent re-running a workflow on every change, the cheapest path matters. **Token-cost reduction scales with project size** — small KMP libraries see ~1–100× reductions on `parallel`, medium projects ~90×, large projects ~123× (NowInAndroid sample), and **`coverage` on a ~70-module composite crosses 30,000× across every measured Claude tokenizer and overflows Anthropic's `count_tokens` payload limit on the raw `./gradlew` capture** (chunked counting recovers the number even there). Three observation strategies, every cell measured ([methodology](docs/token-cost-measurement.md)):

- 🔻 **A. Baseline.** Raw `./gradlew` + reading every generated report file — what an agent does **without** `kmp-test`. The cost we're competing against.
- 🟢 **B. Ours — `kmp-test <feature>`.** Markdown-summarised stdout. Drop-in replacement.
- 🟢 **C. Ours — `kmp-test <feature> --json`.** Single-line JSON envelope. **Recommended for agents.**

Sampled two ways: (a) a 6-project OSS matrix for the per-bucket comparison, and (b) a single anonymized private composite (`private-large-A`, ~70 KMP modules + Kover + kotlinx-benchmark) for the per-tokenizer drill-down where Kover and `@Benchmark` functions are actually configured. Buckets: **small** (1–5 modules), **medium** (6–20 modules), **large** (21+ modules). Every cell is a real `messages.countTokens` API count (Claude columns) or `cl100k_base` offline count via `js-tiktoken`; per-bucket aggregates: median + min/max range + spread.

> **Provenance.** OSS multi-project re-measurement landed 2026-05-12; re-run 2026-05-18 with a recursive module walker that picks up deeply-nested layouts (NowInAndroid grew from 5 → 36 captured modules, Confetti from 13 → 16). `private-large-A` per-feature drill-down re-measured 2026-05-19 (v0.10.1) — closes a cross-project mixing in the v0.10.0 headline ratio that combined `private-large-A`'s A baseline with NowInAndroid's C envelope. OSS sample: KaMPKit, kotlinconf-app, kmp-production-sample (small) · PeopleInSpace, Confetti (medium) · NowInAndroid (large). Drill-down reference: `private-large-A` (~70 KMP modules + Kover, anonymized). Per-project OSS captures are gitignored under [`tools/runs/multi-project-token-cost-<date>/per-project/<label>/<feature>/`](tools/runs/); the committed aggregate lives at [`tools/runs/multi-project-token-cost-<date>/aggregate-<date>.md`](tools/runs/). `private-large-A` captures are gitignored under [`tools/runs/<feature>/`](tools/runs/); committed cross-model evidence at [`tools/runs/cross-model-results-<feature>.txt`](tools/runs/). Reproducible floor in [`tests/fixtures/kmp-cross-platform-e2e/`](tests/fixtures/kmp-cross-platform-e2e/) — a single-module synthetic KMP fixture covering all 8 targets (jvm + js + wasmJs + 3 iOS archs + macosArm64 + androidLibrary).

### A→C reduction by project size — `parallel` median across the OSS sample

cl100k_base only (the bucket scaling is most visible against a single tokenizer). Per-project numbers in [`tools/runs/multi-project-token-cost-2026-05-18/aggregate-2026-05-18.md`](tools/runs/multi-project-token-cost-2026-05-18/aggregate-2026-05-18.md). Anthropic-side counts within ±20% of cl100k per the cross-model evidence ([`tools/runs/cross-model-results-parallel.txt`](tools/runs/cross-model-results-parallel.txt)).

| Bucket             | Sample (n) | Projects                                            | 🔻 A median | 🟢 C median | A→C median | A→C range       |
|--------------------|-----------:|-----------------------------------------------------|------------:|------------:|-----------:|-----------------|
| 🟦 **small** (1–5) |          3 | KaMPKit (2), kotlinconf-app (5), kmp-production-sample (2) |     24,454 |         338 |     **56.6×** |  1.3× – 102.2× |
| 🟨 **medium** (6–20) |        2 | PeopleInSpace (7), Confetti (16)                  |    427,586 |       4,499 |      **90.0×** | 84.4× – 95.6× |
| 🟥 **large** (21+) |          1 | NowInAndroid (36)                                   |    226,291 |       1,839 |     **123.1×** | (single sample) |

> **Note on NowInAndroid.** The 2026-05-12 measurement undercounted NIA's deeply-nested layout (`feature/<name>/<api|impl>/`, `core/<name>/`) — the walker was one-level-deep and captured only the 5 top-level modules. The recursive walker shipped in v0.10 #7 (`tools/measure-token-cost.js#filterModulesByGlob`) now honours nested grouping dirs, surfacing all 36 modules. The 123× ratio above reflects that fix. `private-large-A` (~70 KMP modules, the v0.10.1 per-feature drill-down reference) is anonymised and tracked separately in the [per-feature drill-down section](#per-feature-drill-down--private-large-a-reference-composite-cross-tokenizer-detail) below — it is **not** part of the OSS bucket sample above.

> **Reproducible floor.** [`tests/fixtures/kmp-cross-platform-e2e/`](tests/fixtures/kmp-cross-platform-e2e/) is a 1-module synthetic KMP project covering all 8 supported targets (jvm + js(IR) + wasmJs + 3 iOS archs + macosArm64 + androidLibrary). Re-run `node tools/measure-token-cost.js --project-root tests/fixtures/kmp-cross-platform-e2e --feature parallel` to see the floor case yourself — no SDKs required beyond JDK 21.

> **Large-project ceiling — `coverage` outlier.** On the `private-large-A` composite (~70 KMP modules + Kover, anonymised), `coverage` Approach A produces **74 MB of kover HTML/XML — 28.7 M cl100k / 36.6 M opus / 28.5 M sonnet & haiku tokens — and overflows Anthropic's `count_tokens` endpoint (`413 too_large`)** in a single HTTP request. Chunked counting at file-record boundaries (23 chunks @ ~3.1 MiB UTF-8 each; sum per-chunk `input_tokens`) recovers the Anthropic-side count. Approach C (`kmp-test coverage --json`) renders the same signal in 734 cl100k tokens — within-project A:C reduction is **39,175× cl100k / 30,075× opus / 30,350× sonnet & haiku**. The agent's working memory stays focused on the code instead of log noise.

Two observations carry across every bucket:
- **Tokenizer transition.** `claude-sonnet-4-6` and `claude-haiku-4-5` share a tokenizer (identical counts to the unit on every cell). `claude-opus-4-8` uses a different tokenizer that produces 30–100% more tokens for the same input — most visibly on heavy XML/HTML payloads (🔻 baseline A).
- **C stays small regardless of bucket** — under ~500 tokens for `parallel` on small projects, growing to ~9K on medium when test reports are dense, and back to compact on large projects when summarisation kicks in via `kmp-test`'s aggregation logic. The `--json` envelope strips the workload to `{exit_code, tests, modules, errors[]}` no matter how heavy the underlying gradle did.

### Per-feature drill-down — `private-large-A` reference composite (cross-tokenizer detail)

The bucketed table above shows per-bucket medians for `parallel` across the OSS sample. The four drill-down tables below show per-tokenizer detail (cl100k + 3 Claude families) on the **`private-large-A` reference composite** (~70 KMP modules + Kover + kotlinx-benchmark, anonymised). Every cell is a fresh measurement against today's `kmp-test --json` envelope shape — every ratio is honest within-project (A and C both come from `private-large-A`). The 🔻 A column is the baseline an agent runs **without** `kmp-test`; 🟢 columns are **our approaches** (B = `kmp-test` markdown, C = `kmp-test --json`). The gap between the heavy 🔻 A baseline and the tiny 🟢 C — read straight off the **A:C** column — is the savings story.

#### `parallel` — full test suite (private-large-A reference)

| Model            | 🔻 A. baseline (raw `./gradlew`) | 🟢 B. ours · `kmp-test` | 🟢 C. ours · `--json` |  A:C |
|------------------|---------------------------------:|------------------------:|----------------------:|-----:|
| 🟦 `cl100k_base` |                        1,456,399 |                  19,604 |             **4,039** | 361× |
| 🟥 `opus-4-8`    |                        2,384,531 |                  35,953 |             **7,099** | 336× |
| 🟩 `sonnet-4-6`  |                        1,941,373 |                  25,284 |             **4,980** | 390× |
| 🟧 `haiku-4-5`   |                        1,941,373 |                  25,284 |             **4,980** | 390× |

Captures: [`tools/runs/parallel/`](tools/runs/parallel/) · evidence: [`tools/runs/cross-model-results-parallel.txt`](tools/runs/cross-model-results-parallel.txt).

#### `coverage` — Kover XML + HTML reports (private-large-A reference)

The single largest data point in the whole measurement — and the cell that motivated PR #13's chunked-counting recovery. A `koverXmlReport` + `koverHtmlReport` invocation against `private-large-A` generates **74 MB of kover HTML/XML** under `build/reports/kover/**`. cl100k_base scores it at 28.7 M tokens; Anthropic's `count_tokens` returns `413 request_too_large` on every Claude family **in a single HTTP request**. PR #13's chunking path splits the capture at `\n=== <file> ===\n` file-record boundaries (23 chunks @ ~3.1 MiB UTF-8 each) and sums per-chunk `input_tokens` — see the [methodology section](#how-the-numbers-are-produced) for the activation rules. The same signal renders in 734 cl100k tokens through `kmp-test coverage --json`.

| Model            | 🔻 A. baseline (raw `./gradlew`) | 🟢 B. ours · `kmp-test` | 🟢 C. ours · `--json` |         A:C |
|------------------|---------------------------------:|------------------------:|----------------------:|------------:|
| 🟦 `cl100k_base` |                       28,754,177 |                     803 |               **734** | **39,175×** |
| 🟥 `opus-4-8`    |                       36,571,742 |                   1,394 |             **1,216** | **30,075×** |
| 🟩 `sonnet-4-6`  |                       28,468,274 |                   1,055 |               **938** | **30,350×** |
| 🟧 `haiku-4-5`   |                       28,468,274 |                   1,055 |               **938** | **30,350×** |

What this means in practice: an agent that follows the canonical "run gradle and read the reports" pattern produces a payload it cannot even fit into a single `count_tokens` API call to measure its own size, let alone fit into a 200 K context window. Coverage on `private-large-A` is ~144× a single context window per iteration in cl100k tokens (~183× in opus tokens). Captures: [`tools/runs/coverage/`](tools/runs/coverage/) · evidence: [`tools/runs/cross-model-results-coverage.txt`](tools/runs/cross-model-results-coverage.txt).

#### `changed` — tests for modules touched since `HEAD~1` (private-large-A reference)

| Model            | 🔻 A. baseline (raw `./gradlew`) | 🟢 B. ours · `kmp-test` | 🟢 C. ours · `--json` |  A:C |
|------------------|---------------------------------:|------------------------:|----------------------:|-----:|
| 🟦 `cl100k_base` |                           41,626 |                     125 |               **173** | 241× |
| 🟥 `opus-4-8`    |                           69,678 |                     236 |               **321** | 217× |
| 🟩 `sonnet-4-6`  |                           55,181 |                     159 |               **222** | 249× |
| 🟧 `haiku-4-5`   |                           55,181 |                     159 |               **222** | 249× |

Ratios scale with the size of the diff: this v0.10.1 measurement was taken against a `HEAD~1` that touched a single test file on a single KMP module, so A captures that one module's test report. A bigger diff (multi-module refactor, dependency bump) would scale A linearly while C stays compact — the v0.9 measurement of the same project against a wider commit reported A=1.1 M cl100k / C=144 → 7,766× cl100k (committed history: see [`tools/runs/cross-model-results-changed.txt`](tools/runs/cross-model-results-changed.txt) git log). B/C dispatch through the full parallel coverage suite (broader scope than A's per-module `:module:test`), so wall-clock time isn't apples-to-apples — token count is. Captures: [`tools/runs/changed/`](tools/runs/changed/).

#### `benchmark` — kotlinx-benchmark suites (private-large-A reference, single module)

v0.10.1 measurement: one benchmark module with three `@Benchmark` classes actively running (encryption / password-encryption / stream-encryption microbenchmarks). The v0.9 measurement on the same project covered a state with the plugin applied but no `@Benchmark` functions, so its A was almost entirely the gradle config banner; today's number reflects real benchmark JSON output written to `build/reports/benchmarks/`.

| Model            | 🔻 A. baseline (raw `./gradlew`) | 🟢 B. ours · `kmp-test` | 🟢 C. ours · `--json` |  A:C |
|------------------|---------------------------------:|------------------------:|----------------------:|-----:|
| 🟦 `cl100k_base` |                           52,638 |                     171 |               **273** | 193× |
| 🟥 `opus-4-8`    |                           72,459 |                     314 |               **494** | 147× |
| 🟩 `sonnet-4-6`  |                           61,856 |                     205 |               **322** | 192× |
| 🟧 `haiku-4-5`   |                           61,856 |                     205 |               **322** | 192× |

Single-module scope. The composite ships seven benchmark modules; running the full suite would scale A roughly linearly with benchmark count × iterations, while C stays compact (the JSON envelope keeps the exit-status / counts shape regardless of how many benchmarks ran). B grows because the markdown report inlines per-run scores by design. Captures: [`tools/runs/benchmark/`](tools/runs/benchmark/) · evidence: [`tools/runs/cross-model-results-benchmark.txt`](tools/runs/cross-model-results-benchmark.txt).

### How the numbers are produced

For each project × feature, the script captures one A/B/C triplet — for **A**, gradle stdout (`./gradlew :module:<task> --console=plain`) **plus** every generated report file matched by the feature's predicate (test HTML/XML for parallel/changed, kover HTML/XML for coverage, kotlinx-benchmark JSON for benchmark); for **B** and **C**, the corresponding `kmp-test <feature> [--json]` stdout. The same byte-for-byte text is then re-tokenized two ways: offline via [`js-tiktoken`](https://www.npmjs.com/package/js-tiktoken) using `cl100k_base` (the baseline column), and online via Anthropic's [`messages.countTokens`](https://docs.anthropic.com/en/api/messages-count-tokens) API per Claude 4.x model. When a payload exceeds Anthropic's `count_tokens` single-request limit (~4 MB UTF-8; observed `413 too_large` on 74 MB kover XML), the chunked path splits at `\n=== <file> ===\n` file-record boundaries (falling back to ~3.5 MiB byte windows) and sums per-chunk `input_tokens` — BPE tokenisers are approximately additive across chunks (<0.001% boundary error at measurement scale). Reproduce against your own KMP project sample with:

```bash
# Multi-project bucketed measurement (PR #13). Project list lives in
# tools/.measurement-projects.json (gitignored — paths only stay local) OR in
# the KMP_MEASUREMENT_PROJECTS env var (newline-separated `path|label|bucket`).
node tools/measure-token-cost.js                                 # all 6 features × all projects
node tools/measure-token-cost.js --features parallel,coverage    # subset of features
node tools/measure-token-cost.js --projects-config /custom/path.json --features changed

# Single-project mode (the v0.9 shape) still works:
node tools/measure-token-cost.js --feature parallel \
  --project-root /path/to/your/kmp/project --module-filter "<module-glob>" --runs 1

# Cross-model re-tokenize via Anthropic count_tokens (chunked path activates
# automatically for >~3.5 MiB payloads — set --anthropic-chunk-bytes <n> to
# override). Multi-account fallback supported via ANTHROPIC_API_KEY_FALLBACK.
ANTHROPIC_API_KEY=sk-ant-... node tools/measure-token-cost.js --feature <name> \
  --anthropic-models claude-opus-4-8,claude-sonnet-4-6,claude-haiku-4-5

# Multi-account workflows: set both keys, the tool auto-falls-back on 401:
export ANTHROPIC_API_KEY=sk-ant-account-A...
export ANTHROPIC_API_KEY_FALLBACK=sk-ant-account-B...
node tools/measure-token-cost.js --feature <name> \
  --anthropic-models claude-opus-4-8
```

> **Practical impact across buckets.** A 5-iteration agent loop reading raw gradle output burns roughly **150K tokens on small projects**, **2M tokens on medium projects**, and **7M+ tokens on the `private-large-A` composite** for `parallel` alone — and **~144M cl100k / ~183M opus tokens for `coverage` on the same composite** (the headline outlier — 144× a single 200K context window per iteration in cl100k, 183× in opus). The same loops on `--json` burn 1.5K–9K tokens regardless of bucket. Without PR #13's chunked counting, Anthropic's `count_tokens` endpoint cannot even tokenise a single raw `coverage` capture in one HTTP request on the large composite (28.7M cl100k / 36.6M opus tokens / 74MB of kover HTML/XML). The agent's working memory stays focused on the code instead of log noise.

Per-version detail and migration notes are in [`CHANGELOG.md`](CHANGELOG.md).

## Quick Start

**Linux / macOS**
```sh
curl -fsSL https://raw.githubusercontent.com/oscardlfr/kmp-test-runner/main/scripts/install.sh | bash
```

**Windows (PowerShell)**
```powershell
iwr -useb https://raw.githubusercontent.com/oscardlfr/kmp-test-runner/main/scripts/install.ps1 | iex
```

Or install via npm:
```sh
npm install -g kmp-test-runner
```

Then run:
```sh
kmp-test parallel --project-root /path/to/your/project
```

## Why kmp-test-runner

KMP projects mix JVM, Android, and native targets — each with its own Gradle task graph. Running them sequentially on CI blows past time budgets; running them naively in parallel hits file-lock contention on Windows and socket conflicts on emulators. kmp-test-runner wraps the right `maxParallelForks` and task-isolation defaults so your suite runs safely in parallel without custom scripting, whether you call it from npm, Gradle, or a shell one-liner.

It's also the testing piece that's missing from Google's [official `android` CLI for AI agents](https://developer.android.com/tools/agents/android-cli). That CLI (v0.7.x) covers project create/describe/deploy/emulator but ships no `test` subcommand — Google delegated test execution back to Gradle. `kmp-test --json` fills that gap with a single-line, parseable response that drops the agent-context cost from ~13 K tokens (raw Gradle + reports) to ~100 tokens. See "[Agentic usage](#agentic-usage--token-cost-rationale)" below for the measurement.

**Multi-agent safe (v0.3.8+).** When two `kmp-test` runs target the same project root — common with parallel agents or CI matrix shards — an advisory lockfile (`.kmp-test-runner.lock`) coordinates them and per-run-id-suffixed report files prevent clobber. The second arrival exits with a clear `lock_held` error (`--json` surfaces `errors[].code = "lock_held"`) instead of corrupting reports. Pass `--force` to override deliberately. See [`docs/concurrency.md`](docs/concurrency.md) for the full collision matrix.

## Installation

### Requirements

- Node.js 18+
- bash (Linux/macOS) or PowerShell 5.1+ (Windows)
- JDK 17+ and Gradle 8+ (Gradle plugin shape only)

> **Multi-JDK hosts.** Since v0.6.1 `kmp-test` auto-detects JDKs from `Adoptium / Zulu / Microsoft / Semeru / BellSoft` on Windows, `/Library/Java/JavaVirtualMachines/` on macOS, and `/usr/lib/jvm` + `/opt/{java,jdk}` on Linux. If your project requires a JDK version different from the host default, the matching install is selected automatically — no manual `JAVA_HOME` dance between projects. See the [JDK toolchain section](#jdk-toolchain-mismatch-auto-resolved-when-possible-since-v061) for the precedence chain and override flags.

### Option 1 — Shell installer (recommended)

**Linux / macOS**
```sh
curl -fsSL https://raw.githubusercontent.com/oscardlfr/kmp-test-runner/main/scripts/install.sh | bash
```

**Windows (PowerShell)**
```powershell
iwr -useb https://raw.githubusercontent.com/oscardlfr/kmp-test-runner/main/scripts/install.ps1 | iex
```

To uninstall:
```sh
# Linux/macOS
curl -fsSL https://raw.githubusercontent.com/oscardlfr/kmp-test-runner/main/scripts/uninstall.sh | bash

# Windows (PowerShell)
iwr -useb https://raw.githubusercontent.com/oscardlfr/kmp-test-runner/main/scripts/uninstall.ps1 | iex
```

### Option 2 — npm

```sh
npm install -g kmp-test-runner
```

Requires Node.js 18+. The npm package includes the CLI entry point and all platform scripts.

### Option 3 — Gradle plugin

Available on GitHub Packages. See the [Gradle Plugin](#gradle-plugin) section for setup.

## Usage

`--project-root` defaults to the current working directory, so the simplest invocation is:

```sh
cd /path/to/your/gradle/project
kmp-test parallel
```

Pass `--project-root <path>` explicitly when scripting from a different directory.

### Platforms supported

| Target | Default `--test-type` | Underlying gradle task | Where it runs |
|--------|---------------------|------------------------|---------------|
| **JVM / Desktop** | `common` / `desktop` (auto-detect) | `:module:desktopTest` | host (Linux / macOS / Windows) |
| **Android (unit)** | `androidUnit` (auto-detect) | `:module:testDebugUnitTest` — or `test${Flavor}DebugUnitTest` with `--flavor`; the umbrella `:module:test` for flavored projects without `--flavor` | host JVM |
| **Android (instrumented)** | `androidInstrumented` (or `kmp-test android`) | `:module:connectedDebugAndroidTest` | connected device or emulator |
| **iOS** | `ios` | `:module:iosSimulatorArm64Test` (Apple-silicon), `iosX64Test` (Intel/CI), `iosArm64Test` (device) — picked per-module from the project model | macOS host with Xcode + simulator (Gradle handles simulator boot since AGP/KMP 1.9+) |
| **macOS** | `macos` | `:module:macosArm64Test` / `macosX64Test` / `macosTest` — picked per-module | macOS host (host-native; no simulator) |
| **JS / Wasm** | _model-only_ (`webTestTask` field) | `:module:jsTest` / `:module:wasmJsTest` | host Node — wrapper-side `--test-type js`/`wasm` dispatch deferred (project model surfaces the task; pass it via `--gradle-args` when needed) |

`kmp-test` auto-detects the project type (`kmp-desktop` → `common`, otherwise `androidUnit`) when `--test-type` is omitted. iOS / macOS / `androidInstrumented` are opt-in — the wrapper does not switch to them implicitly because they require platform-specific runners (simulator / connected device). The auto-detected **unit** leg skips modules whose only tests are instrumented (see [Choosing a test type](#choosing-a-test-type)).

### Choosing a test type

Match the command to what you want to run:

| Your tests | Command | Runs on |
|---|---|---|
| Unit tests (JVM / desktop, Android host) | `kmp-test parallel` _(auto)_ — or `--test-type common` / `desktop` / `androidUnit` | host JVM |
| **Android instrumented / Compose UI tests** | `kmp-test android` — or `kmp-test parallel --test-type androidInstrumented` | connected device / emulator |
| iOS / macOS | `kmp-test parallel --test-type ios` / `--test-type macos` | macOS host |
| All of the above in one run | `kmp-test parallel --test-type all` | host + device (per leg) |

> **Compose UI tests are instrumented tests** — they live in `androidInstrumentedTest` / `androidTest`, not the unit source set. The default `kmp-test parallel` auto-detects the **unit** leg, which **skips instrumented-only modules**: a project whose only tests are Compose UI tests produces no reports under a bare `kmp-test parallel`. Run those with `kmp-test android` (or `--test-type androidInstrumented`). When the unit leg skips a module for this reason, `kmp-test` flags it — a `[SKIP] … instrumented-only …` line on stderr and a `warnings[].code: "instrumented_only_skipped"` entry under `--json` — so the right flag is one hop away.

### Subcommands

| Subcommand | Description |
|-----------|-------------|
| `parallel` | Run all test targets in parallel with coverage |
| `changed` | Run tests only for modules changed since last commit |
| `android` | Run Android **instrumented** tests — Compose UI included; requires a connected device/emulator. For host **unit** tests use `parallel` |
| `benchmark` | Run benchmark suites with `Dispatchers.Default` for real contention |
| `coverage` | Generate coverage report only (skips test execution) |
| `doctor` | Diagnose the local environment (Node, bash/pwsh, gradlew, JDK, ADB) |
| `info` | Print environment paths and versions — lighter `doctor` with a flat JSON-friendly envelope (no PASS/WARN/FAIL judgments) |
| `describe` | Print project metadata as JSON — modules, test tasks, coverage detection, dependency graph |
| `update` | Update kmp-test to the latest GitHub release (idempotent; passes through to install scripts) |

Each subcommand has its own `--help`:

```sh
kmp-test parallel --help    # parallel-specific flags + 1 example
kmp-test changed --help
kmp-test android --help
kmp-test benchmark --help
kmp-test coverage --help
kmp-test doctor --help
kmp-test info --help
kmp-test describe --help
kmp-test update --help
```

### Examples

```sh
# Run all tests in parallel with coverage (uses cwd as project root)
kmp-test parallel

# Same, against an explicit path
kmp-test parallel --project-root /path/to/project

# Run only changed modules (fast CI re-run)
kmp-test changed

# Run Android instrumented tests
kmp-test android --device emulator-5554

# Run benchmarks
kmp-test benchmark --config smoke

# Generate coverage report only (skip test run)
kmp-test coverage

# Skip api / build-logic modules explicitly (or just let auto-skip handle them — see below)
kmp-test parallel --exclude-modules "*:api,build-logic"

# Agentic mode: emit a single JSON object on stdout (see "Agentic usage" below)
kmp-test parallel --json

# Run iOS tests against KMP modules with iosX64() / iosSimulatorArm64() targets (v0.7.0)
kmp-test parallel --test-type ios --module-filter ":mySharedKmp"

# macOS host-native — no simulator (v0.7.0)
kmp-test parallel --test-type macos
```

### Multi-platform test dispatch

When `--test-type ios` is set (v0.7.0), `kmp-test` consults the project model **per module** to pick the right gradle task. The model's `iosTestTask` field is the candidate-ordered output of:

```
iosSimulatorArm64Test  →  iosX64Test  →  iosArm64Test  →  iosTest
       (Apple silicon)        (Intel / CI)    (device run)    (umbrella fallback)
```

The first entry that's actually present in the gradle task graph wins. macOS (`--test-type macos`) follows the same shape:

```
macosArm64Test  →  macosX64Test  →  macosTest
```

**Per-platform notes:**

- **iOS** dispatches `:module:iosSimulatorArm64Test` (or whatever the model picked). On macos-latest CI runners this typically boots a pre-installed simulator automatically — no `xcrun simctl` orchestration required at the wrapper level since KMP 1.9+ / AGP 9. On Intel hosts the model returns `iosX64Test` instead. Real-device runs (`iosArm64Test`) need a connected iPhone — out of scope for the wrapper, which doesn't manage devices.
- **macOS** dispatches host-natively (no simulator). On Apple-silicon you get `macosArm64Test`; on Intel, `macosX64Test`. macOS is **not** auto-detected — `--test-type macos` is opt-in.
- **Fallback when the model is absent**: the wrapper picks `iosSimulatorArm64Test` / `macosArm64Test` (most-portable defaults). Pre-build the model with any prior `kmp-test parallel` invocation against the project for content-keyed cache to populate.
- **Skip env vars**: `SKIP_IOS_MODULES="composeApp,iosApp"` excludes specific modules from iOS dispatch (mirrors the existing `SKIP_DESKTOP_MODULES` / `SKIP_ANDROID_MODULES` shape). Same for `SKIP_MACOS_MODULES`.

The `unitTestTask` field stays separate — KMP modules with both `jvmTest` and `iosSimulatorArm64Test` continue to pick `jvmTest` for `--test-type common` / auto-detect, while `--test-type ios` opts into the explicit iOS path.

### Coverage tools

`kmp-test` supports both [**Kover**](https://github.com/Kotlin/kotlinx-kover) (Kotlin's official, KMP-native) and [**JaCoCo**](https://www.jacoco.org/jacoco/) (the JVM standard). Pick one with `--coverage-tool` / `-CoverageTool`:

| Value | Behavior |
|-------|----------|
| `auto` _(default for parallel/coverage paths, via the gradle-tasks probe)_ | Per-module detection — picks `koverXmlReport` / `jacocoTestReport` from the module's actual Gradle task graph. Modules with no coverage task emit `[SKIP coverage]` and tests still run. |
| `kover` | Force Kover; assumes `org.jetbrains.kotlinx.kover` is applied per-module (or via convention plugin). Generates `koverXmlReportDesktop` / `koverXmlReportDebug`. |
| `jacoco` | Force JaCoCo; assumes the `jacoco` plugin is applied. Generates `jacocoTestReport`. |
| `none` | Skip coverage entirely — run tests only. Useful on heterogeneous projects where coverage isn't configured everywhere. |

Heterogeneous projects (some modules with kover, some with jacoco, some with neither) are first-class — the `auto` mode + per-module probe will pick the right task per module and skip cleanly when none is applied. The aggregated report still works across mixed tools.

`kmp-test parallel` runs the resolved coverage report task (`jacocoTestReport` / `koverXmlReport*`) automatically after the test legs — the XML is generated and aggregated in one command, with no separate `./gradlew jacocoTestReport` step. The standalone `coverage` subcommand only re-aggregates the reports a prior `parallel` run already wrote (it does not run gradle itself).

> **JaCoCo XML is enabled automatically.** Gradle's built-in `jacocoTestReport` leaves `xml.required = false` by default, so a module using the standard `jacoco` plugin emits an HTML report only — which `kmp-test` can't parse, leaving it in the `no_xml` bucket even though its tests ran. `kmp-test parallel` therefore injects a small Gradle init-script on the coverage-report leg that forces `reports { xml.required = true }` on every JaCoCo report task, so coverage works out of the box with no build change. It's a genuine no-op for Kover (already emits XML) and for projects that already enable it. Opt out with `--no-coverage-xml-autofix`; when opted out, a module that ran but produced HTML only surfaces a `coverage_xml_disabled` warning instead of a bare `no_xml`.

> **Coverage detection is task-graph-backed.** A module is classified `coveragePlugin: 'kover' | 'jacoco'` from the project's actual Gradle task graph (the `gradlew tasks` probe), so detection works regardless of *how* the plugin is applied — a per-module `plugins {}` block, a `build-logic/` convention plugin, or a root `subprojects {}` / `allprojects {}` block. Only modules that actually expose a `koverXmlReport*` / `jacocoTestReport` task are reported (e.g. nowinandroid reports the 13 modules that apply jacoco, not all 35). When the probe can't run (offline / `--skip-probe`), a static fallback scans each module's own build file and `build-logic/` convention plugins (heuristic on the convention class / filename, `/Jacoco|Kover/i`); a root `subprojects {}` / `allprojects {}` convention is only detected when the probe runs.

### Heterogeneous projects (modules without tests)

Many real-world KMP/Android projects have modules that by convention contain no tests — `:api` interface modules, `:build-logic` convention plugins, parent aggregator modules, etc. `kmp-test` handles these automatically:

- **Auto-skip (default)**: any module whose filesystem path has no `src/test`, `src/commonTest`, `src/jvmTest`, `src/desktopTest`, `src/androidUnitTest`, `src/androidInstrumentedTest`, `src/androidTest`, `src/iosTest`, or `src/nativeTest` directory is filtered out **before** gradle is invoked. Each skip prints `[SKIP] <module> (no test source set — pass --include-untested to override)` to stderr so the "Modules found" tally stays accurate.
- **Explicit exclusion**: `--exclude-modules "*:api,build-logic"` (sh) / `-ExcludeModules` (ps1) accepts comma-separated globs (same syntax as `--module-filter`). Self-documenting in CI commands.
- **Opt-out**: `--include-untested` / `-IncludeUntested` re-includes modules with no test source set (useful when a module exists but tests are still being added).

Both flags work on `parallel` and `changed`. Without them, untested modules historically caused `Task 'jacocoTestReport' not found in project ':api'` errors followed by misleading `[OK] Full coverage report generated!` with 0% coverage — a v0.5.0 fix.

### JDK toolchain mismatch (auto-resolved when possible since v0.6.1)

`kmp-test` reads the project's required JDK from `jvmToolchain(N)` / `JvmTarget.JVM_N` / `JavaVersion.VERSION_N` (taking the MAX of all signals). When that differs from `java -version`, the resolution follows this precedence chain:

1. **`--java-home <path>`** (explicit CLI override) — wins over everything; skips the catalogue and the gate.
2. **`gradle.properties` `org.gradle.java.home=<path>`** — gradle's explicit override; bypasses the gate.
3. **JDK catalogue auto-select (v0.6.1+)** — if a system-wide JDK matching the required version is installed in a known location (`Adoptium / Zulu / Microsoft / Semeru / BellSoft` on Windows, `/Library/Java/JavaVirtualMachines/` on macOS, `/usr/lib/jvm` + `/opt/{java,jdk}` on Linux), `kmp-test` injects `JAVA_HOME` and a prepended `PATH` into the gradle subprocess and proceeds. Disable with `--no-jdk-autoselect`.
4. **`--ignore-jdk-mismatch`** (or `-IgnoreJdkMismatch`) — downgrades the block to a `WARN` line; tests then run under the host default.
5. **Host default `java`** — if none of the above resolves a matching JDK, the gate fires and `kmp-test` exits 3 with a per-OS `JAVA_HOME` hint.

When the catalogue auto-selects, you'll see a `[NOTICE]` line on stderr:

```
[NOTICE] auto-selecting JDK 17 from C:\Program Files\Eclipse Adoptium\jdk-17.0.18.8-hotspot (Eclipse Adoptium; host default is JDK 21)
```

When the gate fires (step 5), the human-readable error looks like:

```
kmp-test: JDK mismatch — project requires JDK 17 but current is JDK 23
          Tests will fail with UnsupportedClassVersionError if we proceed.

          Fix: set JAVA_HOME to a JDK 17 install, or install one and let
          --no-jdk-autoselect off (default) pick it up. Example:
            JAVA_HOME=$(/usr/libexec/java_home -v 17) kmp-test parallel

          Bypass (not recommended): pass --ignore-jdk-mismatch
```

In `--json` mode, the envelope carries `errors[0].code = "jdk_mismatch"` plus `required_jdk` / `current_jdk` integer fields so agents can branch on the specific failure. `--dry-run` skips this gate entirely (since v0.6.0) — plan inspection works on misconfigured hosts.

### Exit codes

| Code | Meaning |
|------|---------|
| `0` | Success — all tests passed |
| `1` | Test failure — script ran, tests failed |
| `2` | Config error — bad CLI usage (unknown subcommand, missing arg) |
| `3` | Environment error — `gradlew` not found in `--project-root`, `bash`/`pwsh` missing on `PATH`, JDK absent, **JDK toolchain mismatch** (`errors[].code: jdk_mismatch` — bypass with `--ignore-jdk-mismatch`), or another `kmp-test` already running on the same project root (`errors[].code: lock_held` — bypass with `--force`; stale locks from crashed runs auto-reclaim when the PID is dead, predates the host boot, or exceeds a 4 h age threshold) |

### Flag reference

| Flag | Default | Description |
|------|---------|-------------|
| `--project-root` | `$PWD` | Path to the Gradle project root |
| `--max-workers` | `4` | Maximum parallel Gradle workers |
| `--test-type <type>` | _(auto-detect)_ | `common`/`desktop` (host JVM) \| `androidUnit` (host JVM) \| `androidInstrumented` (device — Compose UI) \| `ios` \| `macos` \| `all`. Omitted = auto-detect runs the **unit** leg (`androidUnit` or `common`), which skips instrumented-only modules with an `instrumented_only_skipped` warning. iOS / macOS pick the per-module task from the project model. See [Choosing a test type](#choosing-a-test-type) and [Multi-platform test dispatch](#multi-platform-test-dispatch) |
| `--coverage-tool` | `auto` (on `parallel`/`coverage`/`info`) · `jacoco` (on `changed`) | `auto` \| `kover` \| `jacoco` \| `none`. Defaults differ per subcommand — `auto` reads the project's Gradle task graph (catches per-module, convention, and root `subprojects {}` application); `changed` defaults to `jacoco` for historical compatibility |
| `--coverage-modules` | _(all)_ | Comma-separated module list for coverage aggregation |
| `--min-missed-lines` | `0` | Fail if missed lines exceed this threshold |
| `--exclude-modules` | _(none)_ | Comma-separated module globs to skip entirely (e.g. `"*:api,build-logic"`). See "Heterogeneous projects" above |
| `--include-untested` | _(off)_ | Re-include modules with no `src/*Test*` directory (auto-skipped by default) |
| `--ignore-jdk-mismatch` | _(off)_ | Bypass the project-vs-`JAVA_HOME` JDK toolchain check. Default behavior is `BLOCK` with exit 3 — see "JDK toolchain mismatch" above |
| `--java-home <path>` | _(none)_ | Explicit JDK install to use; wins over catalogue auto-select and `gradle.properties org.gradle.java.home`. See "JDK toolchain mismatch" |
| `--no-jdk-autoselect` | _(off)_ | Disable catalogue auto-select; fall through directly to the gate (pre-v0.6.1 behavior) |
| `--no-coverage` | _(off)_ | Alias for `--coverage-tool none`; runs tests only without generating coverage |
| `--json` / `--format json` | _(off)_ | Emit a single JSON object on stdout (see "Agentic usage" below). Suppresses human-readable output |
| `--include-shared` | _(off)_ | Include the shared KMP project (configured via `.kmp-test-runner.json` `sharedProject.name`) in the module set. Defaults to off — the runner stays scoped to the consumer project |
| `--exclude-coverage` | _(none)_ | Comma-separated module globs to skip from coverage aggregation (separate from `--exclude-modules`, which skips test execution too) |
| `--no-coverage-xml-autofix` | _(off)_ | Disable the auto-injected init-script that forces jacoco `xml.required=true`. By default `kmp-test` enables jacoco XML so standard-`jacoco` modules (HTML-only out of the box) still produce parseable coverage XML. No-op for Kover and for projects that already enable XML. See "Coverage tools" above |
| `--fresh-daemon` | _(off)_ | Stop existing Gradle daemons before launching — useful when memory pressure or stale config-cache entries from prior runs cause flakes. Adds ~5 s of cold-start overhead |
| `--skip-tests` | _(off)_ | Skip test execution; still runs coverage aggregation if the report files already exist. Equivalent to `kmp-test coverage` (the `coverage` subcommand sets this internally) |
| `--output-file <path>` | `coverage-full-report.md` | Filename for the aggregated coverage / parallel report. The per-run-id-suffixed copy uses this as the base name; the stable mirror (last writer wins) takes the literal value. See [`docs/concurrency.md`](docs/concurrency.md) |
| `--coverage-only` | _(off)_ | Generate only the coverage report — implies `--skip-tests` and skips test discovery. Faster than `coverage` subcommand when the gradle reports are already on disk |
| `--benchmark` | _(off)_ | Run benchmark suites instead of tests. The `benchmark` subcommand sets this internally; pass directly to `parallel` only if you're composing the orchestrator |
| `--benchmark-config <smoke\|main\|stress>` | `smoke` | Benchmark profile. `smoke` = ~5 min/module outer timeout (single warmup + 3 measurement iters). `main` = ~30 min/module (full warmup + 10 iters). `stress` = ~60 min/module (max warmup + 20 iters). Applies to the `benchmark` subcommand |
| `--no-configuration-cache` | _(off — implicit on `benchmark`)_ | Pass `--no-configuration-cache` to the gradle subprocess. `kmp-test benchmark` injects this by default (kotlinx-benchmark caches `%TEMP%` inside the config cache, producing silent FAIL on stale paths). Override via `--gradle-args "--configuration-cache"` (gradle's last-wins). Applies to all script-backed subs |
| `--ignore-gradle-timeout` | _(off)_ | (`benchmark` only) Disable the per-task gradle watchdog entirely. Risky on suites that hang — kmp-test will wait until gradle exits on its own |
| `--no-adb` | _(off)_ | Skip the ADB probe (equivalent to `KMP_TEST_SKIP_ADB=1`). On `kmp-test android`, implies `--list-only` and emits `warnings[].code: "no_adb_implies_list_only"`. Applies to `info` / `android` |
| `--variant` / `--android-variant <auto\|debug\|release\|all>` | `auto` | Android build-variant selector — global, accepted on `parallel` / `changed` / `android` / `benchmark` (and `coverage` reads it per-module). `auto` picks Debug if its task exists, falls back to Release (handles `testBuildType = "release"` projects). `all` dispatches both variants in the same gradle invocation |
| `--module-filter <regex>` | _(all)_ | Glob, comma-separated. Selects which modules to dispatch. Applies to `parallel` / `changed` / `android` / `benchmark` / `describe` |
| `--device <serial>` | _(none)_ | (`androidInstrumented` only) Pin the ADB device serial. Validated against `adb devices`; pins `ANDROID_SERIAL` for AGP. Mismatched serial → `errors[].code: instrumented_setup_failed` (exit 3). Applies to `parallel --test-type androidInstrumented` / `android` |
| `--device-task <name>` | _(none)_ | (`androidInstrumented` only) Force an explicit gradle task on the instrumented leg. Preempts every other resolution (project-model probe, `kmpAndroidLibrary` `androidConnectedCheck`, AGP `connected{Variant}AndroidTest`). Applies to `parallel --test-type androidInstrumented` / `android` |
| `--auto-retry` | _(off)_ | (`androidInstrumented` only) Re-dispatch instrumented tasks that ran but failed at runtime. One retry per task; mutually exclusive with cascade-isolation. Surfaces `parallel.legs[i].retries[]`. Applies to `parallel --test-type androidInstrumented` / `android` |
| `--clear-data` | _(off)_ | (`androidInstrumented` only) `adb shell pm clear <package>` between failed dispatch + retry. Implies `--auto-retry` to fire. Reads package from AndroidManifest.xml. Applies to `parallel --test-type androidInstrumented` / `android` |
| `--capture-on-fail` | _(off)_ | (`androidInstrumented` only) On instrumented-test failure, capture a device screenshot + UI-hierarchy dump via `adb` (best-effort, forensic-only — **never** changes the exit code). Paths surface on `errors[].screenshot_file` / `.ui_hierarchy_file`; `errors[].capture_error` is set when adb can't oblige. **Post-hoc**: shows the device state at task-end (high value for crashes / ANRs / hangs), not the exact assertion frame — see [Capture on failure](#capture-on-failure-android). Captures sit beside the per-module log/logcat/errors artifacts. Applies to `parallel --test-type androidInstrumented` / `android` |
| `--capture-dir <path>` | _(per-run log dir)_ | (`androidInstrumented` only) Override where `--capture-on-fail` artifacts are written (default: `.kmp-test-runner/logs/android/<runId>/`). Implies `--capture-on-fail`. Relative paths resolve against `--project-root`. Applies to `parallel --test-type androidInstrumented` / `android` |
| `--flavor <name>` | _(none)_ | Android `productFlavors` weave for the unit (`test${Cap}${Variant}UnitTest`), instrumented (`connected${Cap}${Variant}AndroidTest`), and coverage report tasks. Flavors applied by a build-logic convention plugin are recovered from the gradle task-graph probe (not just per-module `productFlavors {}`). Without `--flavor` on a flavored project, the unit / instrumented leg falls back to the flavor-agnostic umbrella (`test` / `connectedAndroidTest`, runs every flavor) and warns `flavor_defaulted_umbrella`. Applies to `parallel` (`androidUnit` / `androidInstrumented` / coverage) / `android` |
| `--gradle-args <string>` | _(none)_ | Escape hatch — append tokens to every gradlew invocation. Repeatable; whitespace-split. Tokens go LAST so they OVERRIDE CLI defaults via gradle's last-wins (`--gradle-args "--no-parallel"` wins over `--parallel`). Applies to `parallel` / `changed` / `android` / `benchmark` |
| `--strict-timeouts` | _(off)_ | (`benchmark` only) Restore pre-graded exit-code behavior: any gradle timeout exits 3 even when other modules passed. Default (off) grades partial timeouts as exit 0 + `warnings[].code: "partial_timeout"` when at least one module passed. Use this in CI matrix cells that require hard fail on any timeout |
| `--isolated` | _(off)_ | Run gradle with `--project-cache-dir <tmp>` so concurrent `kmp-test` invocations don't share configuration cache. Tier-3 isolation. Applies to `parallel` / `changed` / `android` / `benchmark`. See [`docs/concurrency.md`](docs/concurrency.md) |
| `--isolated-cache-dir <path>` | _(per-run tmpdir)_ | Override the temp project-cache-dir location. Implies `--isolated` |
| `--isolated-no-lock` | _(off)_ | Skip the OS-level cache-dir lockfile. Implies `--isolated`. Use only when lockfile contention itself is the bottleneck (rare) |
| `--color <mode>` | `auto` | `always` \| `never` \| `auto`. Controls defensive `--console=plain` injection into the gradle subprocess. `auto` injects when stdout isn't a TTY or `NO_COLOR` is set (POSIX). Skipped when the user already passes any `--console=*` via `--gradle-args` |

> **Instrumented-only flags.** `--device`, `--device-task`, `--auto-retry`, `--clear-data`, `--capture-on-fail`, and `--capture-dir` apply only to the instrumented leg (`kmp-test android` or `parallel --test-type androidInstrumented`); they are ignored on the unit / `androidUnit` legs.

**Env vars (skip-list):**

| Variable | Applies when | Effect |
|----------|--------------|--------|
| `SKIP_DESKTOP_MODULES` | `--test-type common` / `desktop` | Comma-separated short module names skipped from the desktop test pass |
| `SKIP_ANDROID_MODULES` | `--test-type androidUnit` (default) | Same shape, for Android-side dispatch |
| `SKIP_IOS_MODULES` | `--test-type ios` | Same shape, for iOS dispatch |
| `SKIP_MACOS_MODULES` | `--test-type macos` | Same shape, for macOS dispatch |
| `PARENT_ONLY_MODULES` | always | Comma-separated module names that are aggregator-only (skipped at discovery time) |
| `NO_COLOR` | always (POSIX) | Any non-empty value disables gradle ANSI output (equivalent to `--color=never`) |
| `KMP_TEST_SKIP_ADB` | `info` / `android` | Equivalent to `--no-adb`. On `android` it implies `--list-only` (instrumented tests require adb) |
| `KMP_GRADLE_MAXBUFFER_MB` | always | Max stdout/stderr captured per gradle/adb subprocess, in megabytes (default `64`). Raise on machines running very verbose builds; exceeding the cap surfaces as `errors[].code: "spawn_error"` instead of killing the run silently |
| `KMP_JUNIT_XML_MAX_MB` | `parallel` / `changed` | Size cap (megabytes) for a single `TEST-*.xml` report before it's skipped during the test-count walk (default `32`). A skipped report surfaces as `warnings[].code: "junit_xml_oversized"`; `tests.individual_total` then undercounts and that task's `test_failures[]` may be incomplete |
| `KMP_TEST_NO_SWEEP` | test subcommands | Set to `1` to disable the startup artifact-lifecycle sweep of `.kmp-test-runner/` (see the `cleanup` config key) |

### Project config — `.kmp-test-runner.json`

Drop a `.kmp-test-runner.json` at your project root to pin stable defaults instead of repeating CLI flags or relying on env vars. Resolution precedence: **CLI flag > env var > project-local > user-global > built-in default**. Schema:

```json
{
  "sharedProject": { "name": "shared-libs", "path": "../shared-libs" },
  "defaults":     { "testType": "common", "coverageTool": "kover", "excludeModules": "*:test-fakes" },
  "skip":         { "android": ["legacy-app"], "ios": ["bench-android"] },
  "cleanup":      { "auto": true, "logsTtlDays": 7 }
}
```

All fields are optional. Unknown fields are preserved silently for forward compat. Type-mismatched fields are dropped with a `[WARN]` line on stderr.

`cleanup` controls the **artifact lifecycle sweep**: every test run (after acquiring the project lock) removes stale entries under `.kmp-test-runner/` — orphaned `cache-isolated/` gradle caches, init-scripts and `*.tmp.*` leftovers older than 24 h, and per-run `logs/` directories older than `logsTtlDays` (default 7). The model/tasks cache, `reports/`, the lockfile, and this config file are never auto-swept. Disable with `"auto": false` or the `KMP_TEST_NO_SWEEP=1` env var. For an explicit purge use `kmp-test clean` (`--all` adds the model cache + reports, `--dry-run` lists targets with sizes first).

### User-global config — `~/.kmp-test/config.json`

Per-machine, per-project presets for things the project-local file can't carry — machine-specific JDK paths, personal overrides, configs against repos you don't own. File path: `~/.kmp-test/config.json` on Linux/macOS, `%USERPROFILE%\.kmp-test\config.json` on Windows. Keyed by **lookup key**: `git remote get-url origin` → `rootProject.name` in `settings.gradle(.kts)` → `basename(projectRoot)`, first hit wins.

```json
{
  "projects": {
    "https://github.com/me/my-kmp-app.git": {
      "defaults":  { "testType": "common", "coverageTool": "kover" },
      "skip":      { "android": ["legacy-app"] },
      "java_home": "C:/Program Files/Zulu/zulu-21"
    },
    "another-project-name": {
      "defaults": { "testType": "desktop" }
    }
  }
}
```

Per-project preset accepts all fields the project-local file does (`sharedProject`, `defaults`, `skip`) plus `java_home` (only valid here — see below). Project-local values override user-global values when both layers carry the same key.

**`java_home` security note.** The `java_home` field is permitted ONLY in the user-global file. A `java_home` entry in a checked-in `.kmp-test-runner.json` is dropped and warned, since a malicious PR could otherwise redirect a teammate's spawn env without their consent.

### Quick start: gitignore CLI artifacts

The CLI writes its outputs (cache, coverage reports, Android log dumps) under a single `.kmp-test-runner/` subdir at your project root. Add this one line to your project `.gitignore`:

```
# kmp-test-runner local artifacts (CLI output — never commit)
.kmp-test-runner/
```

## Continuous integration

`kmp-test-runner` is built for non-interactive use — the `--json` envelope and the exit-code contract target a CI step (or an agent) just as much as the console. Two ways to wire it into a GitHub Actions job:

### Via the npm CLI (least friction)

The package is public on npm, so no auth is needed; and because it's Node, the same step runs on `ubuntu-latest` / `windows-latest` / `macos-latest`:

```yaml
jobs:
  tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4          # the project still needs a JDK + ./gradlew
        with: { distribution: temurin, java-version: 17 }
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npx kmp-test-runner@latest parallel --json
```

Swap `parallel` for `coverage` / `changed` / `android` as the job needs. The step's **exit code is the gate** — `0` pass, `1` test failure (or coverage-gate breach), `2` config error, `3` environment error — so the job fails or passes with no extra scripting (full table in [Exit codes](#exit-codes)). `--json` keeps the output structured and low-token (pipe to `jq` in a script, or hand it to an agent); add `--isolated` for parallel-safe matrix / fan-out runs.

Fail the build when coverage regresses:

```yaml
      - run: npx kmp-test-runner@latest coverage --min-missed-lines 100 --json
```

> **Pin a version for reproducible CI.** `kmp-test-runner` is pre-v1 — flags can evolve between minor releases. Pin a published version (`npx kmp-test-runner@<x.y.z> …`, current version on [npm](https://www.npmjs.com/package/kmp-test-runner)) instead of `@latest` once your pipeline is set up. The envelope contract itself is stable from `schema_version: 2`.

### Via the Gradle plugin

Apply the [Gradle plugin](#option-3--gradle-plugin) and run its task (`parallelTests` / `coverageTask` / `androidTests`) in the job. The plugin is published to **GitHub Packages**, so the consuming project's `settings.gradle.kts` needs that repository plus `GITHUB_TOKEN` auth — for an external project the npm CLI above is usually less friction.

### Runner requirements

- **JDK + `gradlew`** must be present — any Gradle / KMP / Android project (see `actions/setup-java` above).
- **Instrumented tests** (`--test-type androidInstrumented`, or `kmp-test android`) need a device/emulator on the runner — e.g. [`reactivecircus/android-emulator-runner`](https://github.com/ReactiveCircus/android-emulator-runner). The `common` / `desktop` / `androidUnit` / `coverage` legs need no device.
- **iOS / macOS** legs require a `macos-*` runner (billed at ~10× Linux minutes).

## Use as an Agent Skill

`kmp-test-runner` ships an [Agent Skill](https://agentskills.io) at `.skills/kmp-test-runner/` conforming to the open `agentskills.io` standard. The skill makes the CLI auto-discoverable by Claude Code, Gemini CLI, Cursor, GitHub Copilot, OpenAI Codex, and 30+ other agentskills.io-compatible tools — agents activate the skill automatically when the user asks to run tests in a KMP or Android Gradle project.

**Installation paths** (pick one):

- **Project-local**: clone the `.skills/kmp-test-runner/` directory into your project's `.skills/`, `.agent/skills/`, or `.github/skills/`. The agent finds it on next session.
- **User-global (Claude Code)**: `cp -r .skills/kmp-test-runner ~/.claude/skills/`
- **User-global (Gemini CLI / Antigravity)**: `android skills add kmp-test-runner` (when listed in `github.com/android/skills`, currently pending).

The skill's `SKILL.md` documents the JSON envelope contract, exit codes, and per-workflow steps so the agent dispatches the right `kmp-test` subcommand (`parallel`, `coverage`, `android`, `benchmark`) and parses results correctly without trial-and-error.

### Install as a Claude Code Plugin

The same skill is also packaged as a [Claude Code Plugin](https://code.claude.com/docs/en/plugins) (`.claude-plugin/plugin.json` at repo root). Filesystem install:

```bash
git clone https://github.com/oscardlfr/kmp-test-runner.git
claude --plugin-dir ./kmp-test-runner    # session-only
```

The plugin re-uses the same `.skills/kmp-test-runner/` skill content — no duplication. Marketplace listing is planned for a follow-up.

## Agentic usage — token-cost rationale

`kmp-test` is built to be cheap to call from AI coding agents. The `--json` flag is the lever: it replaces verbose, multi-step Gradle orchestration with a single command and a single structured response.

### Three ways an agent can run a KMP test suite

| Approach | What the agent does | What it consumes |
|----------|---------------------|------------------|
| **A. Raw Gradle + report parsing** | (1) Discover modules from `settings.gradle.kts`. (2) Build per-module `:module:test` task list. (3) Invoke `./gradlew :a:test :b:test ... --parallel --continue`. (4) Re-invoke `./gradlew koverXmlReport` (or jacoco). (5) Read each generated XML / HTML report from `build/reports/`. (6) Parse missed lines, failure stack frames, etc. | Tens of thousands of tokens of Gradle progress logs + multi-KB report files in context. The agent must also understand Gradle DSL, Kover/JaCoCo task names, and report XML schemas. |
| **B. `kmp-test` default mode** | (1) Run one command: `kmp-test parallel`. (2) Read the human-readable summary from stdout. | A few thousand tokens — the script does the orchestration and writes a compact markdown report, but progress output and the coverage report are still in the agent's context. |
| **C. `kmp-test --json` (agentic mode)** | (1) Run one command: `kmp-test parallel --json`. (2) `JSON.parse(stdout)`. | A few hundred tokens — a single JSON object with `tests`, `modules`, `coverage`, `errors`. No ANSI, no markdown, no Gradle log noise. |

### Side-by-side example

**Default (human) output** — the same summary block users see in CI logs (~1.5 KB shown, scaled down from a typical ~10–20 KB run):

```
Configuration:
  Project: my-app
  Test Type: all
  Modules found: 12
[>] Running tests for 12 modules in parallel...
> Task :core-foo:test ... 8 tests completed, 0 failed, 0 skipped
> Task :core-bar:test ... 5 tests completed, 0 failed, 0 skipped
... (one block per module) ...
[OK] Full coverage report generated!
[>>] Report saved to: .kmp-test-runner/reports/coverage/latest.md

Tests: 42 total | 42 passed | 0 failed | 0 skipped

======================================================================
  MODULE COVERAGE SUMMARY
======================================================================
core-foo                                          85.0%       12
core-bar                                          92.5%        4
... (one row per module) ...
TOTAL                                             88.0%       16
SUMMARY: 88.0% total | 16 lines missed | 3 modules at 100% | 1m 23s
BUILD SUCCESSFUL
```

**Agentic (`--json`) output** — the entire response, on one line:

```json
{"tool":"kmp-test","subcommand":"parallel","version":"0.10.1","project_root":"/abs/path","exit_code":0,"duration_ms":83000,"tests":{"total":42,"passed":42,"failed":0,"skipped":0},"modules":["core-foo","core-bar"],"coverage":{"tool":"kover","missed_lines":16,"modules_with_kover_plugin":["core-foo","core-bar"],"modules_with_jacoco_plugin":[]},"isolated":{"enabled":false,"cache_dir":null,"kept":false,"locked":true},"skipped":[],"errors":[],"warnings":[]}
```

That's ~300 bytes — roughly **80–200 tokens** vs. tens of thousands for the 🔻 baseline (A). For an agent running tests on every iteration of a coding loop, the difference compounds quickly. The full per-tokenizer table is at the [top of this README](#why-this-exists--token-cost-per-agent-test-run-iteration); methodology and the captured run output are in [`docs/token-cost-measurement.md`](docs/token-cost-measurement.md).

### Why this gap matters

Google's [`android` CLI for agents](https://developer.android.com/tools/agents/android-cli) is the canonical agentic toolbelt for Android development — it has `create`, `describe`, `run`, `emulator`, `screen`, `layout`, `info`, `sdk`, and a pluggable `skills` system. It does **not** have a test command. An agent reaching for "the official tool" to run tests has to fall back to raw `./gradlew` invocations and parse multi-KB report files — exactly approach **A** above. `kmp-test --json` is the agent-friendly testing complement: same shape as `android describe` (single-line JSON, parseable, stable schema), focused on the test slice the official CLI doesn't cover.

### What the JSON guarantees

- **Always valid JSON**, even if parsing the script output partially fails. Parse gaps are surfaced in the `errors[]` array rather than crashing the CLI.
- **Stable schema**: `tool`, `subcommand`, `version`, `project_root`, `exit_code`, `duration_ms`, `tests {total/passed/failed/skipped}`, `modules[]`, `coverage {tool, missed_lines}`, `errors[]`, `warnings[]`.
- **`errors` vs `warnings`**: `errors[]` carries fatal signals an agent must act on (`code: "lock_held"`, `"jdk_mismatch"`, BUILD FAILED, parse gaps). `warnings[]` carries non-fatal signals an agent can branch on differently — e.g. `code: "gradle_deprecation"` (gradle exit 1 caused solely by Gradle 9+ deprecation warnings while every task passed) or `code: "instrumented_only_skipped"` (the unit leg skipped a module whose only tests are instrumented — run it with `--test-type androidInstrumented`). The corresponding `BUILD FAILED` line is not duplicated to `errors[]` when paired with a deprecation notice. The full warning-code catalogue lives in [`docs/envelope-contract.md`](docs/envelope-contract.md#warning-codes-warningscode).
- **Single line on stdout** — no surrounding noise, suitable for `JSON.parse()` directly.
- **Exit code matches `exit_code` field**, so an agent can branch on either.

## Agentic flags

`--json` is the headline flag, but four agentic levers ship together so you can introspect, scope, and validate without paying full test-execution cost.

### `--dry-run` — what would run, no spawn

```sh
kmp-test parallel --dry-run --project-root /abs/path
# kmp-test parallel — DRY RUN (no script invoked)
#   Project root: /abs/path
#   Subcommand:   parallel
#   Script:       /abs/path/to/run-parallel-coverage-suite.sh
#   Final argv:   --project-root /abs/path
#   Spawn:        bash /abs/path/to/run-parallel-coverage-suite.sh --project-root /abs/path
```

Pair with `--json` for a structured plan:

```json
{"tool":"kmp-test","subcommand":"parallel","version":"0.10.1","dry_run":true,"exit_code":0,"plan":{"spawn_cmd":"bash","spawn_args":["…/run-parallel-coverage-suite.sh","--project-root","/abs"],"script_path":"…/run-parallel-coverage-suite.sh","final_args":["--project-root","/abs"],"test_filter":null},…}
```

`--dry-run` still validates `gradlew` (so a missing wrapper still exits `3`). It just stops before spawning the script.

### `--test-filter <pattern>` — single-class or single-method scope

Cuts a multi-module suite down to one test class — or one method — without forcing the agent to bypass the CLI:

```sh
# JVM gradle tasks — gradle's --tests handles globs natively
kmp-test parallel --test-filter "*FooServiceTest"
kmp-test parallel --test-filter "com.example.FooServiceTest.shouldFooBar"

# Android instrumented — CLI resolves *Pattern* to FQN by source scan
# (the Android runner doesn't accept wildcards, so this resolution is required)
kmp-test android --test-filter "*WidgetTest*"

# Android method-level (v0.5.2): both forms accepted
kmp-test android --test-filter "com.example.WidgetTest#shouldRenderEmpty"
kmp-test android --test-filter "*WidgetTest*#shouldRenderEmpty"   # wildcard + method
kmp-test android --test-filter "com.example.WidgetTest.shouldRenderEmpty"   # `.method` heuristic

# Benchmark — same translation, per-platform
kmp-test benchmark --platform android --test-filter "*ScaleBenchmark*"
kmp-test benchmark --platform android --test-filter "*ScaleBenchmark*#fastPath"
```

When the pattern contains `*`, the CLI walks the project sources (skipping `build/`, `.gradle/`, `node_modules/`, `.git/`) for a `class <stripped>` declaration and substitutes the FQN. If no match is found, the original pattern is forwarded — gradle/Android then surfaces a clear error rather than the CLI guessing.

**Method-level filtering on Android.** When the pattern carries a method portion (`#method` separator or `.method` heuristic — last segment lowercase implies method, classes are conventionally UpperCamelCase), the CLI splits class+method, resolves the class, and emits the canonical AGP single-arg form `-Pandroid.testInstrumentationRunnerArguments.class=<FQN>#<method>`. This shape is what AndroidJUnitRunner + Microbenchmark both honor — earlier `class=` + `method=` separate-args form left Microbenchmark running every method on the class. Both input forms parse to the same wire form, so `kmp-test android --test-filter "com.example.WidgetTest#shouldRender"` and `... --test-filter "com.example.WidgetTest.shouldRender"` are equivalent. Use `#` if your class names happen to start with lowercase to avoid the heuristic.

#### Capture on failure (Android)

`--capture-on-fail` grabs forensic artifacts off the device when an instrumented test module fails — useful for Compose UI / Espresso failures an agent (or human) then has to triage:

```sh
kmp-test android --capture-on-fail --json
```

On each failed module it runs, best-effort, `adb exec-out screencap` (a PNG) and `adb exec-out uiautomator dump` (the view/semantics hierarchy as XML), writing them beside the existing log / logcat / errors artifacts under `.kmp-test-runner/logs/android/<runId>/` (already covered by the `.kmp-test-runner/` gitignore). The paths surface on the failed-module error entry:

```json
{ "code": "module_failed", "module": "feature-home",
  "log_file": "…/feature-home.log", "logcat_file": "…/feature-home_logcat.log",
  "errors_file": "…/feature-home_errors.json",
  "screenshot_file": "…/feature-home_screenshot.png",
  "ui_hierarchy_file": "…/feature-home_ui-hierarchy.xml" }
```

`--capture-dir <path>` redirects the artifacts elsewhere (and implies `--capture-on-fail`).

The same flags work on `kmp-test parallel --test-type androidInstrumented` (and the instrumented leg of `--test-type all`): each failed instrumented module captures into the same per-run `<runId>/` tree, namespaced by module (`<module>_screenshot.png` / `<module>_ui-hierarchy.xml`), with the paths on its `errors[]` entry. Capture fires once per module on the final failure — after any `--auto-retry` — against the resolved `--device` (or the first connected device / emulator).

The capture is **post-hoc** — adb runs after the gradle task ends, so the screenshot shows the device state at task-end, not the exact frame the assertion failed on (the same way the logcat buffer dump beside it is post-hoc). That makes it most valuable for **crashes, ANRs, and hangs** (the error dialog is still on screen); for a clean Compose assertion failure the screen may already be torn down, but the UI-hierarchy dump, logcat, and `errors.json` still carry the failure detail. It is forensic-only: a capture that can't run sets `errors[].capture_error` and **never** changes the exit code.

### `kmp-test clean` — purge run artifacts

Removes the per-run debris under `.kmp-test-runner/` (logs, orphaned isolated gradle caches, init-scripts, stale cache tmp files) regardless of age. `--all` also purges the model/tasks cache (next run re-probes gradle once) and `reports/`. `--dry-run` lists the targets and their sizes without deleting. The command respects the project lock — it refuses with `lock_held` while another `kmp-test` run is live. The lockfile itself and `.kmp-test-runner.json` are never touched. Day-to-day you rarely need it: the test subcommands already auto-sweep stale artifacts on startup (see the `cleanup` config key above).

```sh
kmp-test clean --dry-run     # list what would go, with sizes
kmp-test clean               # purge run artifacts
kmp-test clean --all --json  # full purge incl. caches, JSON envelope
```

### `kmp-test doctor` — environment diagnosis

Six quick checks that catch the usual "why isn't this running" suspects — plus a conditional seventh (`gradle java.home`) that only appears when your `gradle.properties` sets `org.gradle.java.home`:

```sh
kmp-test doctor
# CHECK            STATUS  VALUE        MESSAGE
# Node             OK      v22.5.0      >=18 required
# bash             OK      available    shell present
# gradlew          OK      present      /path/to/project
# JDK              OK      21.0.10      >=17 recommended
# JDK catalogue    OK      3 installs   JDK 11 (Adoptium), JDK 17 (Adoptium), JDK 21 (Azul Zulu)
# gradle java.home WARN    ~/jdks/21    Gradle does not expand ~ here — use an absolute path
# ADB              WARN    not found    install Android SDK platform-tools to run android subcommand
```

Exit `0` if every check is OK or WARN; exit `3` if any FAIL (Node <18, missing shell, missing JDK). The "JDK catalogue" row (v0.6.1+) lists every JDK detected in the system locations consulted by the [auto-select chain](#jdk-toolchain-mismatch-auto-resolved-when-possible-since-v061) — empty catalogue → WARN ("auto-select disabled, gate will fire on JDK mismatch"). The "gradle java.home" row appears only when `org.gradle.java.home` is set in `gradle.properties`: WARN when the value starts with `~` (Gradle does not expand it and will fail to launch) or points at a missing path, OK with the resolved path otherwise. `--json` emits the same data as a structured array for agents, plus a top-level `gradle_config{}` diagnostic (v0.8.1):

```json
{"tool":"kmp-test","subcommand":"doctor","exit_code":0,"checks":[{"name":"Node","status":"OK","value":"v22.5.0","message":">=18 required"},…,{"name":"JDK catalogue","status":"OK","value":"3 installs","message":"JDK 11 (Eclipse Adoptium), JDK 17 (Eclipse Adoptium), JDK 21 (Azul Systems, Inc.)"}],"gradle_config":{"parallel":true,"workers_max":4,"caching":true,"daemon":true,"jvmargs":"-Xmx4g","configureondemand":false,"sources":{"project":true,"user":false}}}
```

The `gradle_config{}` block (v0.8.1+) is informational, not a check — it surfaces the resolved values from `<project>/gradle.properties` merged on top of `~/.gradle/gradle.properties`. Agents read these to decide whether to layer their own parallel scheduler on top of gradle's. As of v0.10, `kmp-test parallel` also *respects* `org.gradle.parallel=false` from the resolved config: when the project has a `gradle.properties` and the resolved value is `false`, the CLI drops the unconditional `--parallel` flag from the gradle dispatch (escape hatch: `--gradle-args "--parallel"` re-enables via gradle's last-wins). On drop, the `parallel` envelope carries a top-level `gradle_config_applied: { parallel_dropped: true }`. The human banner renders the `gradle_config{}` block below the CHECK table:

```
Gradle config (project + user resolved):
  parallel=true  workers.max=4  caching=true  daemon=true  configureondemand=false
  jvmargs=-Xmx4g
```

### Composing them

```sh
# Show the plan an agent would execute, in JSON, with the test-filter resolved:
kmp-test benchmark --platform android --test-filter "*ScaleBenchmark*" --dry-run --json

# Confirm the box can run kmp-test before queueing a real run:
kmp-test doctor --json | jq '.checks[] | select(.status == "FAIL")'
```

## Agent-query subcommands

Three lightweight subcommands that introspect the environment + project state without dispatching gradle. Designed for AI agents that need to plan a run, validate the host, or self-update — and for humans who want a fast read on either dimension.

### `kmp-test info` — environment paths + versions

Lighter sibling of `doctor` — same probes (Node / shell / gradlew / JDK + JDK catalogue / Android SDK / ADB / project config / `gradle_config{}`) but emits a flat key-value `info:{}` envelope without PASS/WARN/FAIL judgments. Always exits `0`; missing tools surface as `null` values rather than failures, so an agent can branch on field presence without try/catch loops:

```sh
kmp-test info --json
# {"tool":"kmp-test","subcommand":"info","exit_code":0,"info":{"node":"v22.5.0","os":"Windows_NT","platform":"win32",
#  "shell":{"name":"pwsh","present":true},"gradlew":{"present":true,"project_root":"/abs/path"},
#  "jdk":{"version":"21.0.10","java_home":"…","note":"host default"},
#  "jdk_catalogue":[{"major":11,"vendor":"Eclipse Adoptium"},{"major":17,"vendor":"Eclipse Adoptium"},
#                   {"major":21,"vendor":"Azul Systems"}],
#  "android_sdk":{"path":"/abs/Android/sdk","source":"local.properties"},"adb":{"version":"34.0.5"},
#  "config":{"present":false},
#  "gradle_config":{"parallel":true,"workers_max":4,"caching":true,"daemon":true,"jvmargs":"-Xmx4g","configureondemand":false}}}
```

Pass `--no-adb` (or set `KMP_TEST_SKIP_ADB=1`) to skip the ADB probe when it's slow or hangs. On `kmp-test android`, `--no-adb` implies `--list-only` (instrumented tests fundamentally require adb, so the orchestrator emits the module set without dispatching gradle and surfaces `warnings[].code: "no_adb_implies_list_only"` for the implication).

### `kmp-test describe` — project metadata as JSON

Emits the project model — modules, test tasks per platform, coverage detection, dependency graph — without running anything. Reuses the same `lib/project-model.js#buildProjectModel` source-of-truth that `parallel` / `android` / `benchmark` / `coverage` consult for module discovery + task resolution:

```sh
kmp-test describe --json --module-filter "core-*"
# {"tool":"kmp-test","subcommand":"describe","exit_code":0,"describe":{
#   "modules":[{"name":":sample-result","path":"…","type":"kmp",
#     "platforms":["jvm","android","ios","js"],
#     "test_tasks":{"unit":"jvmTest","device":"connectedDebugAndroidTest","web":"jsTest","ios":"iosSimulatorArm64Test","macos":null},
#     "coverage_plugin":"kover","test_build_type":null,"has_flavor":false,
#     "android_dsl":"androidLibrary","android_dsl_variant":null}],
#   "coverage_tool":"kover",
#   "dependency_graph":{"composite_builds":["../shared-libs"],"included_modules":[":sample-result",":core-network"]},
#   "jdk_requirement":{"min":17,"agp":17}}}
```

Flags: `--module-filter <regex>` (filters the modules array), `--skip-probe` (forwards to `buildProjectModel({ skipProbe: true })` for cold-cache projects where the gradle-tasks probe blocks for ~30 s+), `--no-cache` (bypasses `.kmp-test-runner/cache/model-*.json`). Exits `2` if neither `settings.gradle.kts` nor `build.gradle.kts` is present in `--project-root`.

### `kmp-test update` — pull the latest GitHub release

Re-runs `scripts/install.sh` (Linux/macOS) or `scripts/install.ps1` (Windows) targeting the latest GitHub release. Idempotent: when current = latest and `--force` is not set, emits `action: "no-op"` + exit `0` without spawning anything.

```sh
kmp-test update                  # install latest if newer
kmp-test update --check --json   # probe only — never spawns the install script
kmp-test update --force          # re-install even when up-to-date
```

Flags: `--check` (probe only), `--force` (re-install regardless), `--prefix <dir>` (forwarded to the install script), `--prerelease` (allow pre-release tags; default strips `-alpha` / `-beta` / `-rc`). Failure modes surface as structured error codes: `release_resolve_failed` (both probe tiers fail), `current_version_unresolvable` (CLI's `package.json` missing), `install_failed` (install script exited non-zero).

## Gradle Plugin

`io.github.oscardlfr.kmp-test-runner` is the Gradle consumer shape. It registers 5 Gradle tasks that mirror the npm subcommands and dispatch to the same platform scripts.

### Setup (consumer side)

In `settings.gradle.kts`:
```kotlin
pluginManagement {
    repositories {
        gradlePluginPortal()
        maven {
            url = uri("https://maven.pkg.github.com/oscardlfr/kmp-test-runner")
            credentials {
                username = providers.gradleProperty("gpr.user").orNull
                    ?: System.getenv("GITHUB_ACTOR")
                password = providers.gradleProperty("gpr.key").orNull
                    ?: System.getenv("GITHUB_TOKEN")
            }
        }
    }
}
```

In `build.gradle.kts`:
```kotlin
plugins {
    id("io.github.oscardlfr.kmp-test-runner") version "0.14.0"
}

kmpTestRunner {
    projectRoot = rootDir.absolutePath
    maxWorkers = 4
    coverageTool = "kover"           // "kover" | "jacoco" | "none"
    coverageModules = ":core,:app"
    minMissedLines = 0
    sharedProjectName = "my-shared-lib"
    // Opt into a specific test type. Empty = wrapper auto-detects (the unit leg).
    // For a Compose-UI-only / instrumented-only module, set "androidInstrumented"
    // — otherwise the unit leg skips it and you get no reports.
    // Accepts: "common" | "desktop" | "androidUnit" | "androidInstrumented" | "ios" | "macos" | "all".
    testType = ""
}
```

### Tasks

| Task | Subcommand | Underlying script |
|------|-----------|-------------------|
| `parallelTests` | `kmp-test parallel` | `run-parallel-coverage-suite.sh` |
| `changedTests` | `kmp-test changed` | `run-changed-modules-tests.sh` |
| `androidTests` | `kmp-test android` | `run-android-tests.sh` |
| `benchmarkTests` | `kmp-test benchmark` | `run-benchmarks.sh` |
| `coverageTask` | `kmp-test coverage` | `run-parallel-coverage-suite.sh --skip-tests` |

### Authentication (consumer side)

Add to `~/.gradle/gradle.properties` (NOT to a checked-in file):
```properties
gpr.user=<your-github-username>
gpr.key=<github-personal-access-token-with-read:packages-scope>
```

A token with `read:packages` scope is sufficient for consumers. Maven Central publication is planned for a future release (no auth needed when it ships) — track [BACKLOG.md](BACKLOG.md) for status.

## Configuration

### npm CLI flags

| Flag | Default | Description |
|------|---------|-------------|
| `--project-root` | `$PWD` | Path to the Gradle project root |
| `--max-workers` | `4` | Maximum parallel Gradle workers (`0` = gradle auto-detect) |
| `--coverage-tool` | `auto` (most subs) · `jacoco` (`changed`) | `auto` \| `kover` \| `jacoco` \| `none` — `auto` probes the project's plugins; explicit value overrides |
| `--coverage-modules` | _(all)_ | Comma-separated module names for coverage |
| `--min-missed-lines` | `0` | Fail threshold for missed lines |

> The shared-project name is now configured via `.kmp-test-runner.json` (`sharedProject.name`). The legacy `SHARED_PROJECT_NAME` env var still works as a fallback. There is no `--shared-project-name` CLI flag.

### Gradle DSL properties

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `projectRoot` | `String` | `rootDir.absolutePath` | Gradle project root path |
| `maxWorkers` | `Int` | `4` | Parallel Gradle workers |
| `coverageTool` | `String` | `"kover"` | `"kover"` \| `"jacoco"` \| `"none"` |
| `coverageModules` | `String` | _(all)_ | Colon-prefixed module list (e.g. `":core,:app"`) |
| `minMissedLines` | `Int` | `0` | Fail threshold for missed lines |
| `sharedProjectName` | `String` | _(none)_ | Shared KMP module name |
| `testType` | `String` | `""` (wrapper auto-detect) | `"common"` \| `"desktop"` \| `"androidUnit"` \| `"androidInstrumented"` \| `"ios"` \| `"macos"` \| `"all"`. Propagated as `--test-type <value>` to `parallelTests` / `changedTests` / `coverageTask` |

## Architecture

kmp-test-runner uses a three-shape model — an npm CLI, a Gradle plugin, and shell installers — all backed by the same set of Node orchestrators in `lib/` (`parallel-orchestrator.js`, `coverage-orchestrator.js`, `changed-orchestrator.js`, `android-orchestrator.js`, `benchmark-orchestrator.js`). The shell scripts in `scripts/sh/` and `scripts/ps1/` are thin wrappers that `exec` the corresponding Node module — what used to be thousands of lines of duplicated bash + PowerShell now lives as Node orchestration logic with platform-specific glue at the edges. The npm CLI and Gradle plugin both invoke the same orchestrators with identical argument shapes, ensuring cross-shape parity; `CrossShapeParityTest` (in `gradle-plugin/src/test/`) enforces this structurally in CI by asserting that every npm subcommand flag has a matching Gradle task name without spawning a subprocess. This design lets the runner be consumed as a global tool (installer), a project devDependency (npm), or a Gradle task (plugin) with no behavioral difference.

## Contributing

Open issues and pull requests are welcome. See **[CONTRIBUTING.md](CONTRIBUTING.md)** for the full contributor guide — branch model, conventional commits, the SH/PS1 parity rule, the test matrix per change area, and the release flow.

Quick check before a PR:

```bash
npm test                                       # vitest (~1,600 tests)
npx bats tests/bats/ tests/installer/ tests/skill-scripts/   # bats (~200 tests, Linux/macOS)
cd gradle-plugin && ./gradlew test && cd ..    # Gradle TestKit (~12 tests)
npm run shellcheck                             # POSIX script lint (0 warnings required)
npm run size-check                             # bundle size budget (tarball ~210 KB)
```

Pester runs in CI on `windows-latest`. PR titles must conform to [Conventional Commits v1.0.0](https://www.conventionalcommits.org/) (the workflow-validated PR title becomes the squash commit message).

### Community

- **Code of conduct**: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) — Contributor Covenant 2.1.
- **Security**: report vulnerabilities privately per [SECURITY.md](SECURITY.md) (do NOT open a public issue for security issues).

## License

MIT — see [LICENSE](LICENSE) for details.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for version history.
