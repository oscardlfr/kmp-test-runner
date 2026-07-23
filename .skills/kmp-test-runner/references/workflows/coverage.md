# Coverage aggregation — `kmp-test coverage`

Re-aggregate coverage reports (Kover XML / JaCoCo XML) across every module that has a coverage plugin applied. **Does not run tests.** Use when the gradle test reports are already on disk (e.g. from a prior `kmp-test parallel` run, or a CI step that ran tests separately).

## Goal

Walk every module's `build/reports/kover/**.xml` / `build/reports/jacoco/**.xml`, merge missed-line counts, render a `coverage-full-report.md` markdown summary, and emit a JSON envelope with the aggregate plus per-plugin module attribution. Optionally gate on a missed-lines threshold.

## When to use this workflow

The agent should dispatch `kmp-test coverage` when the user asks any of:

- "Generate the coverage report" / "what's the coverage?" / "show coverage"
- "Aggregate coverage from the existing reports" / "I already ran tests, just merge the reports"
- "Check that coverage didn't drop below X missed lines" — combine with `--min-missed-lines`
- "Coverage-only run" — equivalent to `kmp-test parallel --skip-tests`

Do **not** dispatch `coverage` for:

- Running tests + coverage in one shot — use `parallel` ([`unit-tests.md`](unit-tests.md)), which aggregates coverage by default.
- Coverage of a single test class — coverage is project-scoped, not per-test. Run `parallel --test-filter <FQN>` for narrow tests, then `coverage` separately if needed.

## Quickstart

```bash
kmp-test coverage --json
```

That command:

1. Probes the project for modules with a coverage plugin (Kover or JaCoCo) — uses the project model cache, falling back to a fresh probe.
2. Reads existing `build/reports/kover/**.xml` / `build/reports/jacoco/**.xml`. **No gradle invocation for tests** — only the coverage report generation if needed.
3. Walks XMLs via the bundled Node parser (`lib/parsers/coverage-xml.js`) to merge per-module + total line counts — pure Node, in-process, no Python interpreter required on the host.
4. Renders the markdown report at `.kmp-test-runner/reports/coverage/latest.md` (or wherever `--output-file` points).
5. Emits a JSON envelope with the aggregate.

Internally `coverage` is a thin shim that prefixes `--skip-tests` and delegates to the same wrapper that `parallel` uses. The shape of the gradle invocation is `./gradlew :<mod>:koverXmlReport :<mod>:koverHtmlReport` (or the jacoco equivalent) per module — no test tasks.

## Common flags

Defaults grounded in `lib/cli.js` SUBCOMMAND_HELP. Full matrix in [`../cli/flags-reference.md`](../cli/flags-reference.md).

| Flag | Default | Notes |
|------|---------|-------|
| `--json` | off | Mandatory for agent consumption. |
| `--coverage-tool <tool>` | `auto` | `auto` / `jacoco` / `kover` / `none`. `auto` picks per-module from the project model. `none` short-circuits the whole workflow to a no-op envelope. |
| `--coverage-modules <list>` | all modules with a plugin | Comma-separated **exact** module names (no leading `:`, no glob/substring matching) to include in aggregation. Other modules' reports are not read. |
| `--exclude-coverage <list>` | none | Comma-separated **exact** module names (same matching rules as `--coverage-modules`) to skip from aggregation. Useful for excluding `test-fakes` or `sample` modules by their real names. |
| `--min-missed-lines <N>` | `0` | Fail (`errors[].code: coverage_threshold_exceeded`, exit 1) if the aggregated (unfiltered) `coverage.missed_lines` exceeds `N`. `0` is "don't gate". Narrows only the markdown report's per-class "Detailed Class Coverage" section — it never removes data from `coverage.missed_lines` / `modules_contributing` / the JSON envelope, even when the gate fires. |
| `--output-file <name>` | `coverage-full-report.md` | Markdown report filename inside `.kmp-test-runner/reports/coverage/`. |
| `--skip-tests` | implicit | Accepted for parity with `parallel --skip-tests` (the `coverage` subcommand sets this internally). Silently consumed. |
| `--java-home <path>` | none | Override JDK location for this run. Skips auto-select. |
| `--no-jdk-autoselect` | off | Disable JDK catalogue auto-select; use the host's `JAVA_HOME` unmodified. |
| `--ignore-jdk-mismatch` | off | Downgrade the JDK-mismatch gate from BLOCK (exit 3) to WARN. Most projects shouldn't need this — coverage report generation runs JDK-version-bounded tasks. |
| `--dry-run` | off | Emit a plan envelope, exit 0, no gradle spawn. |
| `--json` | off | Single JSON envelope on stdout. |
| `--color <mode>` | `auto` | `always` / `never` / `auto`. Controls `--console=plain` injection. |

Note that `coverage` is the **only** non-instrumented subcommand that does NOT accept `--module-filter`, `--test-type`, `--variant`, or `--test-filter`. Use `--coverage-modules` / `--exclude-coverage` for module-level narrowing instead.

## Behaviors únicos

### Kover vs JaCoCo per-module detection

`--coverage-tool auto` walks the project model's `coveragePlugin` field for each module — populated by `lib/project/analyze-module.js` which detects:

- **Direct apply**: `plugins { id("org.jetbrains.kotlinx.kover") }` or `plugins { jacoco }` in `build.gradle.kts` (or `kotlin("kover")`, alias.libs.plugins, etc.).
- **Convention plugin inheritance** (v0.6.1+): per-module — if a module applies a `build-logic/<X>/` convention plugin whose registered class name matches `/Jacoco|Kover/i`, it inherits the coverage flavor. Otherwise it does NOT (closes the v0.6.0 broad-inheritance bug where all 35 nowinandroid modules reported jacoco when only 13 actually applied it).

Modules without any coverage plugin land in `skipped[]` with `reason: "no coverage plugin"`.

### Heterogeneous projects

When a project has a mix of Kover modules, JaCoCo modules, and zero-coverage modules, `--coverage-tool auto` handles all three cleanly:

- Kover modules → `koverXmlReport` task per module.
- JaCoCo modules → `jacocoTestReport` task per module.
- Zero-coverage modules → `[SKIP coverage]` line on stderr; module appears in `skipped[]`.

The aggregate `coverage.missed_lines` is summed across both flavors. The envelope's `modules_with_kover_plugin` and `modules_with_jacoco_plugin` arrays let agents see the split.

### Report XML location discovery

Per `lib/orchestrators/coverage-orchestrator.js`:

- **Kover**: `build/reports/kover/reportDebug.xml` (Android variant) → `build/reports/kover/reportDesktop.xml` (KMP) → `build/reports/kover/report.xml` (umbrella). First file present wins.
- **JaCoCo**: `build/reports/jacoco/test/jacocoTestReport.xml` (standard) → `build/reports/jacoco/**` (other variants).

If the XML doesn't exist (tests never ran, or `--skip-tests` was passed without a prior `parallel` run), the orchestrator falls back to running `koverXmlReport` / `jacocoTestReport` gradle tasks first.

## Edge cases

- **No modules have a coverage plugin**: emits `errors[].code: no_test_modules` (loose match — same code as the test-side variant) with `caused_by_filter: false` and `exit 3`. Suggest the user check whether the project actually uses Kover or JaCoCo at all.
- **`--coverage-tool kover` but the project has only JaCoCo modules**: forces Kover dispatch on modules that don't apply Kover → cascade of `task_not_found` per module. Recovery: use `--coverage-tool auto` (or `jacoco`).
- **`--min-missed-lines 0` with any missed lines**: exit 1, `errors[].code: coverage_threshold_exceeded`. `0` means "perfect coverage required" — usually too strict; set realistic thresholds.
- **74 MB Kover XML / HTML on a 70-module project**: the underlying tasks succeed cleanly but the markdown report can be ~10 K LOC. The `--json` envelope stays compact regardless — the heavy raw artefacts only matter if the agent reads `build/reports/**` directly (which it should NOT — defeats the whole reduction promise). See README "token cost" section for the 77,114× reduction headline. (The parser's own size cap defaults to 128 MB — comfortably above this real-world case; see the next bullet for what happens past that cap.)
- **A module's coverage XML fails to parse, or exceeds the parser's size cap**: the module lands in `module_buckets.parse_errored` and fires a discriminated `coverage_parse_failed` (malformed/unreadable XML) or `coverage_xml_oversized` (over `KMP_COVERAGE_XML_MAX_MB`, default 128 MB) warning — never silently folded into a bare `no_coverage_data`. Other modules' data is unaffected; only the failing module's contribution is excluded from the aggregate.
- **`--exclude-coverage "core-fakes,sample-demo"` combined with `--coverage-modules "core-network,core-fakes"`**: include first (`--coverage-modules`), then exclude — both lists are exact, comma-separated names (no glob/substring matching). A module in both lists ends up excluded.
- **Re-running after a clean test pass**: `coverage` re-reads the existing XML — fast (~5-15 s for a medium project) since no test tasks fire. If `build/reports/` is empty, the orchestrator triggers `koverXmlReport` / `jacocoTestReport` to regenerate them.
- **Cross-platform path separators**: report paths in the envelope use the OS native separator. Agents parsing them should not assume POSIX `/`.

## Envelope shape excerpt

```json
{
  "tool": "kmp-test",
  "schema_version": 2,
  "subcommand": "coverage",
  "exit_code": 0,
  "tests": { "total": 0, "passed": 0, "failed": 0, "skipped": 0 },
  "modules": [
    { "name": ":core:network", "type": "kmp", "coverage_plugin": "kover", "test_failures": [] }
  ],
  "coverage": {
    "tool": "kover",
    "missed_lines": 16,
    "modules_contributing": 2,
    "modules_with_kover_plugin": [":core:network", ":feature:auth"],
    "modules_with_jacoco_plugin": []
  },
  "skipped": [
    { "module": ":sample:demo", "reason": "no coverage plugin" }
  ],
  "errors": [],
  "warnings": []
}
```

`tests.total` is `0` because no tests were run. `coverage.missed_lines` is the aggregate across all included modules. The `coverage` subcommand does **not** emit an `isolated:{}` block even when `--isolated` is passed (it never spawns gradle for tests; concurrent isolation is moot).

`exit_code: 0` here means coverage was aggregated successfully. A non-zero exit can come from:

- `1` — `--min-missed-lines` gate fired (`errors[].code: coverage_threshold_exceeded`).
- `2` — invalid args (`--coverage-tool xyzzy`).
- `3` — environment problem (no `gradlew`, JDK mismatch, no modules have a coverage plugin).

## Troubleshooting

Branch on `errors[].code`:

- `coverage_threshold_exceeded` → [`../troubleshooting/coverage-threshold-exceeded.md`](../troubleshooting/coverage-threshold-exceeded.md)
- `no_test_modules` → [`../troubleshooting/no-test-modules.md`](../troubleshooting/no-test-modules.md) (rare on `coverage` — only when no module has a coverage plugin)
- `task_not_found` → [`../troubleshooting/task-not-found.md`](../troubleshooting/task-not-found.md) (forcing wrong `--coverage-tool` on a heterogeneous project)
- `unsupported_class_version` → [`../troubleshooting/unsupported-class-version.md`](../troubleshooting/unsupported-class-version.md)

## See also

- [`overview.md`](overview.md) — workflows hub
- [`../cli/envelope-schema.md`](../cli/envelope-schema.md#coverage-shape) — `coverage:{}` field shape
- [`../cli/exit-codes.md`](../cli/exit-codes.md) — exit-code semantics
- [`../cli/flags-reference.md`](../cli/flags-reference.md) — full per-subcommand flag matrix
- [`unit-tests.md`](unit-tests.md) — `parallel` workflow (runs tests + aggregates coverage in one shot)
