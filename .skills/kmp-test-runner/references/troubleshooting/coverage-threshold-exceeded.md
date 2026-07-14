# `coverage_threshold_exceeded` — aggregated missed lines above the gate

The `--min-missed-lines <N>` gate fired. Aggregated `coverage.missed_lines` across all dispatched modules exceeded `N`.

## Symptom

```json
{
  "exit_code": 1,
  "errors": [{
    "code": "coverage_threshold_exceeded",
    "message": "Coverage missed-lines threshold exceeded: 247 > 100"
  }],
  "coverage": {
    "tool": "kover",
    "missed_lines": 247,
    "modules_with_kover_plugin": [":core:network", ":feature:auth"],
    "modules_with_jacoco_plugin": []
  }
}
```

Applies to `parallel` (when `--min-missed-lines` is passed) and `coverage`.

## Related signals

`coverage.missed_lines` (the value this gate compares against `N`) is always the **complete, unfiltered** project total — `--min-missed-lines` never removes coverage data. It only decides (a) whether this error fires, and (b) which classes appear in the markdown report's per-class "Detailed Class Coverage" section. Concretely:

- This error should never co-occur with a contradictory bare `no_coverage_data` warning — if you see both together with `module_buckets.with_data` non-empty, that combination is a bug, not an expected outcome.
- If `coverage_parse_failed` or `coverage_xml_oversized` also appear in `warnings[]`, the aggregate is *incomplete* — one or more modules' XML couldn't be read, independent of the threshold check. Fix those first; the "real" missed-lines total may be different once every module's XML parses cleanly.

## Root causes

1. **Real coverage regression**: someone added production code without matching tests. Coverage genuinely dropped. Recovery: write tests for the uncovered code paths.
2. **`--min-missed-lines 0` over-strict gate**: zero missed lines means 100% coverage required. Almost never achievable on real projects (logging, error paths, generated code). Recovery: pick a realistic threshold based on baseline.
3. **Convention-plugin inheritance change** (v0.6.1+): a refactor moved coverage application from a broad convention plugin to per-module explicit applies. Modules that previously inherited coverage now don't → aggregated `missed_lines` includes only the explicit modules, which may actually be lower OR higher depending on which modules dropped out.
4. **`--exclude-coverage` adjustment**: tightening or loosening the exclude list changes the aggregate baseline. A previously-stable gate may now fire when modules with high coverage are excluded.
5. **JaCoCo + Kover mixed counting**: the aggregate is sum-of-modules regardless of tool. If a module's Kover XML reports differently from its JaCoCo XML, the count shifts. Usually small but can drift over time.

## Recovery path

For "real coverage regression":

1. Surface the missed-lines count: `coverage.missed_lines: 247` vs gate `100`.
2. Locate the regression: re-run with `--coverage-modules "<single-module>"` per module to find the one that grew.
3. Inspect `build/reports/kover/reportDesktop.xml` / `build/reports/jacoco/test/jacocoTestReport.xml` for that module — read the `<class>` entries with `missed > 0`.
4. Suggest writing tests for the uncovered code paths.

For "gate too strict":

1. Run `kmp-test coverage --json` without the gate to get the current baseline.
2. Suggest a realistic threshold (current baseline + 10-20 line headroom).
3. Update CI config / scripts.

For "convention-plugin inheritance change":

1. `kmp-test coverage --json | jq '.coverage.modules_with_kover_plugin, .coverage.modules_with_jacoco_plugin'`.
2. Compare against the previous run's module list.
3. If modules dropped from inheritance, decide: apply coverage explicitly, or accept the new baseline.

## Recovery commands

```bash
# Baseline check without the gate
kmp-test coverage --json | jq '.coverage'

# Per-module coverage breakdown
kmp-test coverage --coverage-modules ":core:network" --json
# (repeat per module to localise regression)

# Verify which modules currently apply coverage
kmp-test coverage --json | jq '{
  with_kover: .coverage.modules_with_kover_plugin,
  with_jacoco: .coverage.modules_with_jacoco_plugin,
  skipped: .skipped
}'

# Realistic gate (e.g. current + 30 line headroom)
kmp-test coverage --min-missed-lines 280 --json
```

## AGP / JDK quirks

- **Kover XML location varies by KMP target**: `reportDesktop.xml` (KMP-desktop projects), `reportDebug.xml` (Android variant), `report.xml` (umbrella). The aggregate walks all three. Different KMP versions can shift which file is canonical.
- **JaCoCo XML strict vs lenient**: JaCoCo 0.8.x reports differ in how partial coverage (branch coverage) is rolled into "missed lines". `kmp-test` only counts missed LINES, not branches; if your gate also cares about branches, set up JaCoCo's own enforcement in `build.gradle.kts`.
- **Generated code skew**: `@Generated`-annotated code (data classes, Hilt modules, KSP output) inflates missed-line counts unless excluded. Configure Kover / JaCoCo to exclude generated packages at the plugin level — `kmp-test` doesn't filter generated code itself.

## See also

- [`../cli/envelope-schema.md#coverage-shape`](../cli/envelope-schema.md#coverage-shape) — `coverage:{}` field shape
- [`../cli/exit-codes.md`](../cli/exit-codes.md) — exit-code → code mapping
- [`overview.md`](overview.md) — troubleshooting hub
- [`../workflows/coverage.md`](../workflows/coverage.md) — workflow context
- [`../workflows/unit-tests.md`](../workflows/unit-tests.md) — `parallel` workflow which also accepts `--min-missed-lines`
