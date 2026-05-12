# kmp-test-runner

Standalone parallel test runner for Kotlin Multiplatform and Android Gradle projects.

## Why this exists — token cost per agent test-run iteration

For an AI coding agent re-running a workflow on every change, the cheapest path matters. **Token-cost reduction scales with project size** — small KMP libraries see ~60–120× reductions on `parallel`, medium projects ~90×, and **large projects with coverage cross 10,000× and routinely overflow Anthropic's `count_tokens` payload limit on the raw `./gradlew` capture** (PR #13 added chunked counting to recover the number even there). Three observation strategies, every cell measured ([methodology](docs/token-cost-measurement.md)):

- 🔻 **A. Baseline.** Raw `./gradlew` + reading every generated report file — what an agent does **without** `kmp-test`. The cost we're competing against.
- 🟢 **B. Ours — `kmp-test <feature>`.** Markdown-summarised stdout. Drop-in replacement.
- 🟢 **C. Ours — `kmp-test <feature> --json`.** Single-line JSON envelope. **Recommended for agents.**

Sampled across a 6-project bucketed matrix (named OSS) plus one reused anonymized private composite for the large bucket. Buckets: **small** (1–5 modules), **medium** (6–20 modules), **large** (21+ modules). Every cell is a real `messages.countTokens` API count (Claude columns) or `cl100k_base` offline count via `js-tiktoken`; per-bucket aggregates: median + min/max range + spread.

> **Provenance.** Multi-project re-measurement landed 2026-05-12 (PR #13). Sample: KaMPKit, kotlinconf-app, kmp-production-sample (small) · PeopleInSpace, Confetti (medium) · NowInAndroid + `private-large-A` (large, the v0.9 reference composite, ~70 modules, anonymized). Per-project per-feature captures are gitignored under [`tools/runs/multi-project-token-cost-<date>/per-project/<label>/<feature>/`](tools/runs/); the committed aggregate lives at [`tools/runs/multi-project-token-cost-<date>/aggregate-<date>.md`](tools/runs/). Reproducible floor in [`tests/fixtures/kmp-cross-platform-e2e/`](tests/fixtures/kmp-cross-platform-e2e/) — a single-module synthetic KMP fixture covering all 8 targets (jvm + js + wasmJs + 3 iOS archs + macosArm64 + androidLibrary).

### A→C reduction by project size — `parallel` median across the OSS sample

cl100k_base only (the bucket scaling is most visible against a single tokenizer). Per-project numbers in [`tools/runs/multi-project-token-cost-2026-05-12/aggregate-2026-05-12.md`](tools/runs/). Anthropic-side counts within ±20% of cl100k per the v0.9 cross-model evidence ([`tools/runs/cross-model-results-parallel.txt`](tools/runs/cross-model-results-parallel.txt)).

| Bucket             | Sample (n) | Projects                                            | 🔻 A median | 🟢 C median | A→C median | A→C range  |
|--------------------|-----------:|-----------------------------------------------------|------------:|------------:|-----------:|------------|
| 🟦 **small** (1–5) |          3 | KaMPKit (2), kotlinconf-app (5), kmp-production-sample (2) |      29,426 |         314 |        60× |  13× – 119× |
| 🟨 **medium** (6–20) |        2 | PeopleInSpace (7), Confetti (13)                  |     426,338 |       4,475 |     **93×** | 89× – 96× |
| 🟥 **large** (21+) |          2 | NowInAndroid (35) + `private-large-A` (~70, reused) |     690,660 |       1,300 |     **804×** | 29× – 1,579× |

> **Methodology caveat for NowInAndroid.** The multi-project orchestrator's default module walker discovers top-level Gradle modules (those with `build.gradle.kts` at depth 1). NIA's deeply-nested structure (`feature/<name>/<api|impl>/`, `core/<name>/`) puts most modules below depth 1, so the orchestrator captured `:test` reports for the 5 top-level modules only (`:app`, `:app-nia-catalog`, `:benchmarks`, `:lint`, `:ui-test-hilt-manifest`). NIA's A=50,284 reflects that subset — not the full 35-module project. `private-large-A`'s A=1,331,036 used an explicit module-filter to sample representative modules, so the 1,579× ratio there is apples-to-oranges relative to NIA. PR #13 ships the orchestrator with this default heuristic; per-project filter customization is queued for a follow-up.

> **Reproducible floor.** [`tests/fixtures/kmp-cross-platform-e2e/`](tests/fixtures/kmp-cross-platform-e2e/) is a 1-module synthetic KMP project covering all 8 supported targets (jvm + js(IR) + wasmJs + 3 iOS archs + macosArm64 + androidLibrary). Re-run `node tools/measure-token-cost.js --project-root tests/fixtures/kmp-cross-platform-e2e --feature parallel` to see the floor case yourself — no SDKs required beyond JDK 21.

> **Large-project ceiling — `coverage` outlier.** On the `private-large-A` composite (~70 KMP modules + Kover, v0.9 reference, anonymized), `coverage` Approach A produces **74 MB of kover HTML/XML — 28.7 M cl100k tokens — and overflows Anthropic's `count_tokens` endpoint (`413 too_large`)** in a single HTTP request. PR #13 added chunked counting (~3.5 MiB UTF-8 windows, sum per-chunk `input_tokens`) so the Anthropic-side number can be recovered by splitting the payload at file-record boundaries. The cl100k-baseline ratio is **77,114×**. The same signal renders in 372 cl100k tokens through `kmp-test coverage --json` — the agent's working memory stays focused on the code instead of log noise.

Two observations carry across every bucket:
- **Tokenizer transition.** `claude-sonnet-4-6` and `claude-haiku-4-5` share a tokenizer (identical counts to the unit on every cell). `claude-opus-4-7` ships a new tokenizer that produces 30–100% more tokens for the same input — most visibly on heavy XML/HTML payloads (🔻 baseline A).
- **C stays small regardless of bucket** — under ~500 tokens for `parallel` on small projects, growing to ~9K on medium when test reports are dense, and back to compact on large projects when summarisation kicks in via `kmp-test`'s aggregation logic. The `--json` envelope strips the workload to `{exit_code, tests, modules, errors[]}` no matter how heavy the underlying gradle did.

### Per-feature drill-down — `private-large-A` reference composite (cross-tokenizer detail)

The bucketed table above shows per-bucket medians for `parallel`. The four drill-down tables below show per-tokenizer detail (cl100k + 3 Claude families) on the **`private-large-A` reference composite** (~70 KMP modules + Kover, the v0.9 measurement project, anonymized). They are kept for the cross-tokenizer comparison and as the source of the 77,114× coverage outlier headline. Each table is scaled to its own max for the 🔻 A column (the baseline an agent runs **without** `kmp-test`). 🟢 columns are **our approaches** (B = `kmp-test` markdown, C = `kmp-test --json`); shown as numbers only because the bars would be sub-1-char anyway — **that visual asymmetry between the heavy 🔻 baseline and the tiny 🟢 ours IS the savings story**. Multi-project bucketed re-measurement for `coverage` / `changed` / `benchmark` is queued for v0.10 step 7.

#### `parallel` — full test suite (private-large-A reference)

A bars scaled to `2,183,843` (opus).

| Model            | 🔻 A. baseline (raw `./gradlew`)    | 🟢 B. ours · `kmp-test` | 🟢 C. ours · `--json` |    A:C |
|------------------|-------------------------------------|------------------------:|----------------------:|-------:|
| 🟦 `cl100k_base` | `1,331,036 ████████████`            |                  16,556 |               **843** | 1,579× |
| 🟥 `opus-4-7`    | `2,183,843 ████████████████████`    |                  30,134 |             **1,396** | 1,564× |
| 🟩 `sonnet-4-6`  | `1,777,893 ████████████████`        |                  21,372 |             **1,063** | 1,673× |
| 🟧 `haiku-4-5`   | `1,777,893 ████████████████`        |                  21,372 |             **1,063** | 1,673× |

Captures: [`tools/runs/parallel/`](tools/runs/parallel/) · evidence: [`tools/runs/cross-model-results-parallel.txt`](tools/runs/cross-model-results-parallel.txt).

#### `coverage` — Kover XML + HTML reports (private-large-A reference)

The single largest data point in the whole measurement — and the cell that motivated PR #13's chunked-counting recovery. A `koverXmlReport` + `koverHtmlReport` invocation against `private-large-A` generates **74 MB of kover HTML/XML** under `build/reports/kover/**`. cl100k_base scores it at 28.7 M tokens; Anthropic's `count_tokens` returns `413 request_too_large` on every Claude family **in a single HTTP request**. PR #13's chunking path splits the capture into ~3.5 MiB UTF-8 windows and sums per-chunk `input_tokens` — see the [methodology section](#how-the-numbers-are-produced) for the activation rules. The same signal renders in 372 cl100k tokens through `kmp-test coverage --json`.

| Model            | 🔻 A. baseline (raw `./gradlew`)                    | 🟢 B. ours · `kmp-test` | 🟢 C. ours · `--json` |         A:C |
|------------------|-----------------------------------------------------|------------------------:|----------------------:|------------:|
| 🟦 `cl100k_base` | `28,686,309 ████████████████████`                   |                     682 |               **372** | **77,114×** |
| 🟥 `opus-4-7`    | _413 in single-request; chunked recovery via PR #13_ |                  1,176 |               **623** |  _chunked_  |
| 🟩 `sonnet-4-6`  | _413 in single-request; chunked recovery via PR #13_ |                    895 |               **470** |  _chunked_  |
| 🟧 `haiku-4-5`   | _413 in single-request; chunked recovery via PR #13_ |                    895 |               **470** |  _chunked_  |

What this means in practice: an agent that follows the canonical "run gradle and read the reports" pattern produces a payload it cannot even fit into a single `count_tokens` API call to measure its own size, let alone fit into a 200 K context window. Coverage on `private-large-A` is ~144× a single context window per iteration. Captures: [`tools/runs/coverage/`](tools/runs/coverage/) · evidence: [`tools/runs/cross-model-results-coverage.txt`](tools/runs/cross-model-results-coverage.txt).

#### `changed` — tests for modules touched since `HEAD~1` (private-large-A reference)

A bars scaled to `1,835,175` (opus).

| Model            | 🔻 A. baseline (raw `./gradlew`)    | 🟢 B. ours · `kmp-test` | 🟢 C. ours · `--json` |    A:C |
|------------------|-------------------------------------|------------------------:|----------------------:|-------:|
| 🟦 `cl100k_base` | `1,118,241 ████████████`            |                      91 |               **144** | 7,766× |
| 🟥 `opus-4-7`    | `1,835,175 ████████████████████`    |                     171 |               **274** | 6,698× |
| 🟩 `sonnet-4-6`  | `1,494,157 ████████████████`        |                     115 |               **182** | 8,210× |
| 🟧 `haiku-4-5`   | `1,494,157 ████████████████`        |                     115 |               **182** | 8,210× |

B/C dispatch through the full parallel coverage suite (broader scope than A's single `:module:desktopTest`), so wall-clock time isn't apples-to-apples — token count is. Captures: [`tools/runs/changed/`](tools/runs/changed/) · evidence: [`tools/runs/cross-model-results-changed.txt`](tools/runs/cross-model-results-changed.txt).

#### `benchmark` — kotlinx-benchmark suites (private-large-A reference)

A bars scaled to `323,638` (opus).

| Model            | 🔻 A. baseline (raw `./gradlew`)    | 🟢 B. ours · `kmp-test` | 🟢 C. ours · `--json` |  A:C |
|------------------|-------------------------------------|------------------------:|----------------------:|-----:|
| 🟦 `cl100k_base` | `245,140 ███████████████`           |                     305 |               **309** | 793× |
| 🟥 `opus-4-7`    | `323,638 ████████████████████`      |                     572 |               **573** | 565× |
| 🟩 `sonnet-4-6`  | `283,750 ██████████████████`        |                     374 |               **363** | 782× |
| 🟧 `haiku-4-5`   | `283,750 ██████████████████`        |                     374 |               **363** | 782× |

A is the only heavy column on this slice — the reference project's benchmark modules carry the kotlinx-benchmark plugin but no `@Benchmark` functions, so B and C both reduce to compact summary envelopes. On a project with active benchmarks B grows because the markdown report inlines per-run scores by design; C stays small (the JSON envelope keeps the exit-status / counts shape regardless of how many benchmarks ran). Captures: [`tools/runs/benchmark/`](tools/runs/benchmark/) · evidence: [`tools/runs/cross-model-results-benchmark.txt`](tools/runs/cross-model-results-benchmark.txt).

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
  --anthropic-models claude-opus-4-7,claude-sonnet-4-6,claude-haiku-4-5

# Multi-account workflows: set both keys, the tool auto-falls-back on 401:
export ANTHROPIC_API_KEY=sk-ant-account-A...
export ANTHROPIC_API_KEY_FALLBACK=sk-ant-account-B...
node tools/measure-token-cost.js --feature <name> \
  --anthropic-models claude-opus-4-7
```

> **Practical impact across buckets.** A 5-iteration agent loop reading raw gradle output burns roughly **150K tokens on small projects**, **2M tokens on medium projects**, and **6M+ tokens on large composites** for `parallel` alone — and **~143M tokens for `coverage` on a large composite** (the headline outlier — 144× a single 200K context window per iteration on `private-large-A`). The same loops on `--json` burn 1.5K–9K tokens regardless of bucket. Without PR #13's chunked counting, Anthropic's `count_tokens` endpoint cannot even tokenise a single raw `coverage` capture in one HTTP request on the large composite (28.7M cl100k tokens / 74MB of kover HTML/XML). The agent's working memory stays focused on the code instead of log noise.

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
| **Android (unit)** | `androidUnit` (auto-detect) | `:module:testDebugUnitTest` | host JVM |
| **Android (instrumented)** | `androidInstrumented` (or `kmp-test android`) | `:module:connectedDebugAndroidTest` | connected device or emulator |
| **iOS** | `ios` | `:module:iosSimulatorArm64Test` (Apple-silicon), `iosX64Test` (Intel/CI), `iosArm64Test` (device) — picked per-module from the project model | macOS host with Xcode + simulator (Gradle handles simulator boot since AGP/KMP 1.9+) |
| **macOS** | `macos` | `:module:macosArm64Test` / `macosX64Test` / `macosTest` — picked per-module | macOS host (host-native; no simulator) |
| **JS / Wasm** | _model-only_ (`webTestTask` field) | `:module:jsTest` / `:module:wasmJsTest` | host Node — wrapper-side dispatch deferred to v0.7.x |

`kmp-test` auto-detects the project type (`kmp-desktop` → `common`, otherwise `androidUnit`) when `--test-type` is omitted. iOS / macOS / `androidInstrumented` are opt-in — the wrapper does not switch to them implicitly because they require platform-specific runners (simulator / connected device).

### Subcommands

| Subcommand | Description |
|-----------|-------------|
| `parallel` | Run all test targets in parallel with coverage |
| `changed` | Run tests only for modules changed since last commit |
| `android` | Run Android instrumented tests (requires connected device or emulator) |
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
| `auto` _(default since v0.5.1 for parallel/coverage paths via the gradle-tasks probe)_ | Per-module detection — picks `koverXmlReport` / `jacocoTestReport` based on which plugin the module actually applies. Modules with no plugin emit `[SKIP coverage]` and tests still run. |
| `kover` | Force Kover; assumes `org.jetbrains.kotlinx.kover` is applied per-module (or via convention plugin). Generates `koverXmlReportDesktop` / `koverXmlReportDebug`. |
| `jacoco` | Force JaCoCo; assumes the `jacoco` plugin is applied. Generates `jacocoTestReport`. |
| `none` | Skip coverage entirely — run tests only. Useful on heterogeneous projects where coverage isn't configured everywhere. |

Heterogeneous projects (some modules with kover, some with jacoco, some with neither) are first-class — the `auto` mode + per-module probe will pick the right task per module and skip cleanly when none is applied. The aggregated report still works across mixed tools.

> **Convention-plugin coverage detection (v0.6.1+).** Projects that distribute coverage via a convention plugin (`build-logic/<X>/` registers `Plugin<Project>` classes or precompiled-script plugins) get per-module inheritance: only modules that explicitly apply a coverage-adding convention plugin id are reported as having `coveragePlugin: 'kover' | 'jacoco'`. Detection is heuristic-first via the convention class / filename (`/Jacoco|Kover/i`); pre-v0.6.1 broad inheritance is preserved as a fallback for `Plugin<Project>` setups without a `gradlePlugin{}` block (kover composites without a `gradlePlugin{}` registration block continue to work unchanged). Concretely: nowinandroid drops from "all 35 modules report jacoco" to the 13 that actually apply it.

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
| `3` | Environment error — `gradlew` not found in `--project-root`, `bash`/`pwsh` missing on `PATH`, JDK absent, **JDK toolchain mismatch** (`errors[].code: jdk_mismatch` — bypass with `--ignore-jdk-mismatch`), or another `kmp-test` already running on the same project root (`errors[].code: lock_held` — bypass with `--force`) |

### Flag reference

| Flag | Default | Description |
|------|---------|-------------|
| `--project-root` | `$PWD` | Path to the Gradle project root |
| `--max-workers` | `4` | Maximum parallel Gradle workers |
| `--test-type <type>` | _(auto-detect)_ | `common` \| `desktop` \| `androidUnit` \| `androidInstrumented` \| `ios` \| `macos` \| `all`. iOS / macOS pick the per-module task from the project model. See [Multi-platform test dispatch](#multi-platform-test-dispatch) |
| `--coverage-tool` | `kover` | Coverage tool: `kover`, `jacoco`, `auto`, or `none` |
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
| `--fresh-daemon` | _(off)_ | Stop existing Gradle daemons before launching — useful when memory pressure or stale config-cache entries from prior runs cause flakes. Adds ~5 s of cold-start overhead |
| `--skip-tests` | _(off)_ | Skip test execution; still runs coverage aggregation if the report files already exist. Equivalent to `kmp-test coverage` (the `coverage` subcommand sets this internally) |
| `--output-file <path>` | `coverage-full-report.md` | Filename for the aggregated coverage / parallel report. The per-run-id-suffixed copy uses this as the base name; the stable mirror (last writer wins) takes the literal value. See [`docs/concurrency.md`](docs/concurrency.md) |
| `--coverage-only` | _(off)_ | Generate only the coverage report — implies `--skip-tests` and skips test discovery. Faster than `coverage` subcommand when the gradle reports are already on disk |
| `--benchmark` | _(off)_ | Run benchmark suites instead of tests. The `benchmark` subcommand sets this internally; pass directly to `parallel` only if you're composing the orchestrator |
| `--benchmark-config <smoke\|full>` | `smoke` | Benchmark profile. `smoke` = single warmup + 3 measurement iters (~30 s/module). `full` = 5 warmup + 10 iters (~5 min/module). Applies to the `benchmark` subcommand |
| `--variant` / `--android-variant <auto\|debug\|release\|all>` | `auto` | Android build-variant selector — global, accepted on `parallel` / `changed` / `android` / `benchmark` (and `coverage` reads it per-module). `auto` picks Debug if its task exists, falls back to Release (handles `testBuildType = "release"` projects). `all` dispatches both variants in the same gradle invocation |
| `--module-filter <regex>` | _(all)_ | Glob, comma-separated. Selects which modules to dispatch. Applies to `parallel` / `changed` / `android` / `benchmark` / `describe` |
| `--device <serial>` | _(none)_ | (`androidInstrumented` only) Pin the ADB device serial. Validated against `adb devices`; pins `ANDROID_SERIAL` for AGP. Mismatched serial → `errors[].code: instrumented_setup_failed` (exit 3). Applies to `parallel --test-type androidInstrumented` / `android` |
| `--device-task <name>` | _(none)_ | (`androidInstrumented` only) Force an explicit gradle task on the instrumented leg. Preempts every other resolution (project-model probe, `kmpAndroidLibrary` `androidConnectedCheck`, AGP `connected{Variant}AndroidTest`). Applies to `parallel --test-type androidInstrumented` / `android` |
| `--auto-retry` | _(off)_ | (`androidInstrumented` only) Re-dispatch instrumented tasks that ran but failed at runtime. One retry per task; mutually exclusive with cascade-isolation. Surfaces `parallel.legs[i].retries[]`. Applies to `parallel --test-type androidInstrumented` / `android` |
| `--clear-data` | _(off)_ | (`androidInstrumented` only) `adb shell pm clear <package>` between failed dispatch + retry. Implies `--auto-retry` to fire. Reads package from AndroidManifest.xml. Applies to `parallel --test-type androidInstrumented` / `android` |
| `--flavor <name>` | _(none)_ | (`androidInstrumented` only) Android `productFlavors` weave: `connected${Cap}${Variant}AndroidTest`. Modules without flavor declarations ignore the flag. Applies to `parallel --test-type androidInstrumented` / `android` |
| `--gradle-args <string>` | _(none)_ | Escape hatch — append tokens to every gradlew invocation. Repeatable; whitespace-split. Tokens go LAST so they OVERRIDE CLI defaults via gradle's last-wins (`--gradle-args "--no-parallel"` wins over `--parallel`). Applies to `parallel` / `changed` / `android` / `benchmark` |
| `--isolated` | _(off)_ | Run gradle with `--project-cache-dir <tmp>` so concurrent `kmp-test` invocations don't share configuration cache. Tier-3 isolation. Applies to `parallel` / `changed` / `android` / `benchmark`. See [`docs/concurrency.md`](docs/concurrency.md) |
| `--isolated-cache-dir <path>` | _(per-run tmpdir)_ | Override the temp project-cache-dir location. Implies `--isolated` |
| `--isolated-no-lock` | _(off)_ | Skip the OS-level cache-dir lockfile. Implies `--isolated`. Use only when lockfile contention itself is the bottleneck (rare) |

**Env vars (skip-list):**

| Variable | Applies when | Effect |
|----------|--------------|--------|
| `SKIP_DESKTOP_MODULES` | `--test-type common` / `desktop` | Comma-separated short module names skipped from the desktop test pass |
| `SKIP_ANDROID_MODULES` | `--test-type androidUnit` (default) | Same shape, for Android-side dispatch |
| `SKIP_IOS_MODULES` | `--test-type ios` | Same shape, for iOS dispatch |
| `SKIP_MACOS_MODULES` | `--test-type macos` | Same shape, for macOS dispatch |
| `PARENT_ONLY_MODULES` | always | Comma-separated module names that are aggregator-only (skipped at discovery time) |

### Project config — `.kmp-test-runner.json`

Drop a `.kmp-test-runner.json` at your project root to pin stable defaults instead of repeating CLI flags or relying on env vars. Resolution precedence: **CLI flag > env var > config file > built-in default**. Schema:

```json
{
  "sharedProject": { "name": "shared-libs", "path": "../shared-libs" },
  "defaults":     { "testType": "common", "coverageTool": "kover", "excludeModules": "*:test-fakes" },
  "skip":         { "android": ["legacy-app"], "ios": ["bench-android"] }
}
```

All fields are optional. Unknown fields are preserved silently for forward compat. Type-mismatched fields are dropped with a `[WARN]` line on stderr.

### Quick start: gitignore CLI artifacts

The CLI writes its outputs (cache, coverage reports, Android log dumps) under a single `.kmp-test-runner/` subdir at your project root. Add this one line to your project `.gitignore`:

```
# kmp-test-runner local artifacts (CLI output — never commit)
.kmp-test-runner/
```

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
{"tool":"kmp-test","subcommand":"parallel","version":"0.9.0","project_root":"/abs/path","exit_code":0,"duration_ms":83000,"tests":{"total":42,"passed":42,"failed":0,"skipped":0},"modules":["core-foo","core-bar"],"coverage":{"tool":"kover","missed_lines":16,"modules_with_kover_plugin":["core-foo","core-bar"],"modules_with_jacoco_plugin":[]},"isolated":{"enabled":false,"cache_dir":null,"kept":false,"locked":true},"skipped":[],"errors":[],"warnings":[]}
```

That's ~300 bytes — roughly **80–200 tokens** vs. tens of thousands for the 🔻 baseline (A). For an agent running tests on every iteration of a coding loop, the difference compounds quickly. The full per-tokenizer table is at the [top of this README](#why-this-exists--token-cost-per-agent-test-run-iteration); methodology and the captured run output are in [`docs/token-cost-measurement.md`](docs/token-cost-measurement.md).

### Why this gap matters

Google's [`android` CLI for agents](https://developer.android.com/tools/agents/android-cli) is the canonical agentic toolbelt for Android development — it has `create`, `describe`, `run`, `emulator`, `screen`, `layout`, `info`, `sdk`, and a pluggable `skills` system. It does **not** have a test command. An agent reaching for "the official tool" to run tests has to fall back to raw `./gradlew` invocations and parse multi-KB report files — exactly approach **A** above. `kmp-test --json` is the agent-friendly testing complement: same shape as `android describe` (single-line JSON, parseable, stable schema), focused on the test slice the official CLI doesn't cover.

### What the JSON guarantees

- **Always valid JSON**, even if parsing the script output partially fails. Parse gaps are surfaced in the `errors[]` array rather than crashing the CLI.
- **Stable schema**: `tool`, `subcommand`, `version`, `project_root`, `exit_code`, `duration_ms`, `tests {total/passed/failed/skipped}`, `modules[]`, `coverage {tool, missed_lines}`, `errors[]`, `warnings[]`.
- **`errors` vs `warnings`**: `errors[]` carries fatal signals an agent must act on (`code: "lock_held"`, `"jdk_mismatch"`, BUILD FAILED, parse gaps). `warnings[]` carries non-fatal signals an agent can branch on differently — currently `code: "gradle_deprecation"` (gradle exit 1 caused solely by Gradle 9+ deprecation warnings while every task passed). The corresponding `BUILD FAILED` line is not duplicated to `errors[]` when paired with a deprecation notice.
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
{"tool":"kmp-test","subcommand":"parallel","version":"0.9.0","dry_run":true,"exit_code":0,"plan":{"spawn_cmd":"bash","spawn_args":["…/run-parallel-coverage-suite.sh","--project-root","/abs"],"script_path":"…/run-parallel-coverage-suite.sh","final_args":["--project-root","/abs"],"test_filter":null},…}
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

### `kmp-test doctor` — environment diagnosis

Six quick checks that catch the usual "why isn't this running" suspects:

```sh
kmp-test doctor
# CHECK          STATUS  VALUE       MESSAGE
# Node           OK      v22.5.0     >=18 required
# bash           OK      available   shell present
# gradlew        OK      present     /path/to/project
# JDK            OK      21.0.10     >=17 recommended
# JDK catalogue  OK      3 installs  JDK 11 (Adoptium), JDK 17 (Adoptium), JDK 21 (Azul Zulu)
# ADB            WARN    not found   install Android SDK platform-tools to run android subcommand
```

Exit `0` if every check is OK or WARN; exit `3` if any FAIL (Node <18, missing shell, missing JDK). The "JDK catalogue" row (v0.6.1+) lists every JDK detected in the system locations consulted by the [auto-select chain](#jdk-toolchain-mismatch-auto-resolved-when-possible-since-v061) — empty catalogue → WARN ("auto-select disabled, gate will fire on JDK mismatch"). `--json` emits the same data as a structured array for agents, plus a top-level `gradle_config{}` diagnostic (v0.8.1):

```json
{"tool":"kmp-test","subcommand":"doctor","exit_code":0,"checks":[{"name":"Node","status":"OK","value":"v22.5.0","message":">=18 required"},…,{"name":"JDK catalogue","status":"OK","value":"3 installs","message":"JDK 11 (Eclipse Adoptium), JDK 17 (Eclipse Adoptium), JDK 21 (Azul Systems, Inc.)"}],"gradle_config":{"parallel":true,"workers_max":4,"caching":true,"daemon":true,"jvmargs":"-Xmx4g","configureondemand":false,"sources":{"project":true,"user":false}}}
```

The `gradle_config{}` block (v0.8.1+) is informational, not a check — it surfaces the resolved values from `<project>/gradle.properties` merged on top of `~/.gradle/gradle.properties`. Agents read these to decide whether to layer their own parallel scheduler on top of gradle's. The human banner renders it as a separate block below the CHECK table:

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

Pass `--no-adb` (or set `KMP_TEST_SKIP_ADB=1`) to skip the ADB probe when it's slow or hangs.

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
    id("io.github.oscardlfr.kmp-test-runner") version "0.9.0"
}

kmpTestRunner {
    projectRoot = rootDir.absolutePath
    maxWorkers = 4
    coverageTool = "kover"           // "kover" | "jacoco" | "none"
    coverageModules = ":core,:app"
    minMissedLines = 0
    sharedProjectName = "my-shared-lib"
    // v0.7.0: opt into a specific test type. Empty = wrapper auto-detects.
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

A token with `read:packages` scope is sufficient for consumers. Maven Central will be the recommended channel from v0.4.0 onward (no auth needed).

## Configuration

### npm CLI flags

| Flag | Default | Description |
|------|---------|-------------|
| `--project-root` | `$PWD` | Path to the Gradle project root |
| `--max-workers` | `4` | Maximum parallel Gradle workers |
| `--coverage-tool` | `kover` | `kover` \| `jacoco` \| `none` |
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

kmp-test-runner uses a three-shape model — an npm CLI, a Gradle plugin, and shell installers — all backed by the same set of Node orchestrators in `lib/` (`parallel-orchestrator.js`, `coverage-orchestrator.js`, `changed-orchestrator.js`, `android-orchestrator.js`, `benchmark-orchestrator.js`). The shell scripts in `scripts/sh/` and `scripts/ps1/` are thin wrappers (~6–80 LOC each) that `exec` the corresponding Node module — moving 6,196 lines of duplicated bash + PowerShell logic into ~470 lines of platform-glue, with the orchestration logic deduplicated into `lib/` (~2,200 LOC). The npm CLI and Gradle plugin both invoke the same orchestrators with identical argument shapes, ensuring cross-shape parity; `CrossShapeParityTest` enforces this structurally in CI by asserting that every npm subcommand flag has a matching Gradle task name without spawning a subprocess. This design lets the runner be consumed as a global tool (installer), a project devDependency (npm), or a Gradle task (plugin) with no behavioral difference.

## Contributing

Open issues and pull requests are welcome. See **[CONTRIBUTING.md](CONTRIBUTING.md)** for the full contributor guide — branch model, conventional commits, the SH/PS1 parity rule, the test matrix per change area, and the release flow.

Quick check before a PR:

```bash
npm test                                       # vitest (~810 tests at v0.8.1)
npx bats tests/bats/ tests/installer/          # bats (~197 tests, Linux/macOS)
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
