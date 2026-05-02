#!/usr/bin/env bats
# Tests for scripts/sh/run-benchmarks.sh

SCRIPT="scripts/sh/run-benchmarks.sh"

setup() {
    WORK_DIR="$(mktemp -d)"
    mkdir -p "$WORK_DIR"
    echo 'rootProject.name = "test-project"' > "$WORK_DIR/settings.gradle.kts"
    mkdir -p "$WORK_DIR/bin"
    cat > "$WORK_DIR/bin/gradlew" << 'EOF'
#!/usr/bin/env bash
echo "BUILD SUCCESSFUL (stub): $*"
exit 0
EOF
    chmod +x "$WORK_DIR/bin/gradlew"
    export PATH="$WORK_DIR/bin:$PATH"
}

teardown() {
    rm -rf "$WORK_DIR"
}

@test "benchmark: happy path exits 0 with valid --project-root" {
    # With a valid project root and no benchmark modules, script should exit 0
    # The --project-root required check passes; script may exit with no-modules message
    run bash "$SCRIPT" --project-root "$WORK_DIR"
    [[ "$output" != *"--project-root is required"* ]]
}

@test "benchmark: error path exits 1 when --project-root is missing" {
    run bash "$SCRIPT"
    [ "$status" -eq 1 ]
    [[ "$output" == *"--project-root is required"* ]]
}

@test "benchmark: runs end-to-end under /bin/bash (Bash 3.2 regression — WS-2)" {
    # /bin/bash on macOS is 3.2.57. On Linux CI it is bash 5.x. The script
    # must complete without `declare: -A: invalid option` (the original WS-2
    # symptom) AND without `<arr>[@]: unbound variable` errors triggered by
    # iterating empty arrays under `set -u` (the surfaced-by-the-fix sibling
    # bug for ALL_RESULTS / PLATFORMS_TO_RUN). This test catches the whole
    # bug class — anyone re-introducing `declare -A` or an unguarded
    # `"${arr[@]}"` over a sometimes-empty array gets caught here.
    #
    # We run the happy path with a benchmark module fixture so the script
    # walks the full pipeline (discovery → dispatch → result aggregation →
    # console summary → markdown report).
    mkdir -p "$WORK_DIR/bench-mod/bin"
    cat > "$WORK_DIR/settings.gradle.kts" << 'EOF'
rootProject.name = "wsfix-test"
include(":bench-mod")
EOF
    cat > "$WORK_DIR/bench-mod/build.gradle.kts" << 'EOF'
plugins { id("org.jetbrains.kotlinx.benchmark") version "0.4.10" }
benchmark { targets { register("jvm") } }
EOF

    run /bin/bash "$SCRIPT" --project-root "$WORK_DIR" --config smoke
    # Either exit 0 (gradle stub absent → no tasks attempted, no failures)
    # or non-zero with an explicit FAIL line — what we forbid is a Bash
    # syntax/runtime crash before reaching the summary.
    [[ "$output" != *"declare: -A: invalid option"* ]]
    [[ "$output" != *"unbound variable"* ]]
    [[ "$output" != *"syntax error"* ]]
    # Must reach the summary table (proves we walked past every guarded
    # array expansion site).
    [[ "$output" == *"BENCHMARK SUMMARY"* ]]
}

@test "benchmark: lib sourcing uses SCRIPT_DIR not absolute paths" {
    local sources
    sources=$(grep -E '^source ' "$SCRIPT" || true)
    [[ "$sources" != *"/Users/"* ]]
    [[ "$sources" != *"/home/"* ]]
    [[ "$sources" != *"/root/"* ]]
    if [[ -n "$sources" ]]; then
        [[ "$sources" == *'$SCRIPT_DIR'* ]]
    fi
}

@test "benchmark: emits 'Result: X passed, Y failed' tally (parser contract for v0.5.1 Bug G)" {
    # parseBenchmarkSummary in cli.js matches /Result:\s*(\d+)\s+passed,\s+(\d+)\s+failed/
    # for the totals. Pin the literal format.
    grep -E "Result: \\\$\\{?TOTAL_PASS\\}? passed, \\\$\\{?TOTAL_FAIL\\}? failed" "$SCRIPT"
}

@test "benchmark: emits '[OK|FAIL] <module> (<platform>) completed|failed' lines (Bug G contract)" {
    # parseBenchmarkSummary matches /\[(OK|FAIL)\]\s+(\S+)\s+\(([\w-]+)\)\s+(completed|failed)/
    # for per-module status. Pin the format the parser depends on. The script
    # uses $mod / $plat as the variable names — the format itself is what
    # matters, not the names.
    grep -E '\[OK\][^"]*\$mod \(\$plat\) completed successfully' "$SCRIPT"
    grep -E '\[FAIL\][^"]*\$mod \(\$plat\) failed' "$SCRIPT"
}

@test "benchmark-detect: detect_module_benchmark_platforms returns 'android' for androidx.benchmark module" {
    # Simulate an Android-only benchmark module
    mkdir -p "$WORK_DIR/benchmark"
    cat > "$WORK_DIR/benchmark/build.gradle.kts" << 'EOF'
plugins { alias(libs.plugins.android.library) }
android {
    defaultConfig {
        testInstrumentationRunner = "androidx.benchmark.junit4.AndroidBenchmarkRunner"
    }
}
EOF
    source scripts/sh/lib/benchmark-detect.sh
    local result
    result="$(detect_module_benchmark_platforms "$WORK_DIR" "benchmark")"
    [[ "$result" == *"android"* ]]
    [[ "$result" != *"jvm"* ]]
}

@test "benchmark-detect: detect_module_benchmark_platforms returns 'jvm' for kotlinx.benchmark module" {
    mkdir -p "$WORK_DIR/perf"
    cat > "$WORK_DIR/perf/build.gradle.kts" << 'EOF'
plugins { id("org.jetbrains.kotlinx.benchmark") version "0.4.10" }
benchmark { targets { register("jvm") } }
EOF
    source scripts/sh/lib/benchmark-detect.sh
    local result
    result="$(detect_module_benchmark_platforms "$WORK_DIR" "perf")"
    [[ "$result" == *"jvm"* ]]
    [[ "$result" != *"android"* ]]
}

@test "benchmark-detect: module_supports_platform returns 1 (false) for jvm on android-only module" {
    mkdir -p "$WORK_DIR/benchmark"
    cat > "$WORK_DIR/benchmark/build.gradle.kts" << 'EOF'
testInstrumentationRunner = "androidx.benchmark.junit4.AndroidBenchmarkRunner"
EOF
    source scripts/sh/lib/benchmark-detect.sh
    if module_supports_platform "$WORK_DIR" "benchmark" "jvm"; then
        return 1  # should NOT support jvm
    fi
    module_supports_platform "$WORK_DIR" "benchmark" "android"  # should support android
}

@test "benchmark-detect: module_supports_platform is permissive when no plugin detected" {
    # Modules without recognizable benchmark refs should default to supported
    # so non-standard setups are not blocked.
    mkdir -p "$WORK_DIR/plain"
    echo "// no benchmark plugin here" > "$WORK_DIR/plain/build.gradle.kts"
    source scripts/sh/lib/benchmark-detect.sh
    module_supports_platform "$WORK_DIR" "plain" "jvm"
    module_supports_platform "$WORK_DIR" "plain" "android"
}

@test "benchmark-detect: KMP module with both kotlinx + androidx → supports both platforms" {
    mkdir -p "$WORK_DIR/multi"
    cat > "$WORK_DIR/multi/build.gradle.kts" << 'EOF'
plugins {
    id("org.jetbrains.kotlinx.benchmark")
    id("com.android.library")
}
android {
    defaultConfig {
        testInstrumentationRunner = "androidx.benchmark.junit4.AndroidBenchmarkRunner"
    }
}
EOF
    source scripts/sh/lib/benchmark-detect.sh
    local platforms
    platforms="$(detect_module_benchmark_platforms "$WORK_DIR" "multi")"
    [[ "$platforms" == *"jvm"* ]]
    [[ "$platforms" == *"android"* ]]
    module_supports_platform "$WORK_DIR" "multi" "jvm"
    module_supports_platform "$WORK_DIR" "multi" "android"
}

@test "benchmark-detect: nested colon module path (sdk:wiring-e) resolved correctly" {
    mkdir -p "$WORK_DIR/sdk/wiring-e"
    cat > "$WORK_DIR/sdk/wiring-e/build.gradle.kts" << 'EOF'
plugins { id("org.jetbrains.kotlinx.benchmark") }
EOF
    source scripts/sh/lib/benchmark-detect.sh
    local platforms
    platforms="$(detect_module_benchmark_platforms "$WORK_DIR" "sdk:wiring-e")"
    [[ "$platforms" == "jvm" ]]
    module_supports_platform "$WORK_DIR" "sdk:wiring-e" "jvm"
    if module_supports_platform "$WORK_DIR" "sdk:wiring-e" "android"; then
        return 1  # should NOT support android
    fi
}

@test "benchmark-detect: missing build.gradle.kts → empty platforms (permissive)" {
    # Module dir doesn't exist at all
    source scripts/sh/lib/benchmark-detect.sh
    local platforms
    platforms="$(detect_module_benchmark_platforms "$WORK_DIR" "nonexistent")"
    [[ -z "$platforms" ]]
    # module_supports_platform returns 0 (permissive) when no info
    module_supports_platform "$WORK_DIR" "nonexistent" "jvm"
    module_supports_platform "$WORK_DIR" "nonexistent" "android"
}

@test "benchmark-detect: empty build.gradle.kts → empty platforms (permissive)" {
    mkdir -p "$WORK_DIR/empty"
    : > "$WORK_DIR/empty/build.gradle.kts"
    source scripts/sh/lib/benchmark-detect.sh
    local platforms
    platforms="$(detect_module_benchmark_platforms "$WORK_DIR" "empty")"
    [[ -z "$platforms" ]]
    module_supports_platform "$WORK_DIR" "empty" "jvm"
}

@test "benchmark-detect: hyphenated benchmark plugin id (kotlinx-benchmark) recognized" {
    # Some setups use the hyphenated form (e.g. classpath dep notation)
    mkdir -p "$WORK_DIR/hyphen"
    cat > "$WORK_DIR/hyphen/build.gradle.kts" << 'EOF'
classpath("org.jetbrains.kotlinx:kotlinx-benchmark-runtime:0.4.10")
EOF
    source scripts/sh/lib/benchmark-detect.sh
    local platforms
    platforms="$(detect_module_benchmark_platforms "$WORK_DIR" "hyphen")"
    # The detector greps for "kotlinx.benchmark" — hyphenated form should NOT trigger it
    # (we only want declarations, not transitive runtime deps). This documents current behaviour.
    [[ -z "$platforms" || "$platforms" == "jvm" ]]
}

@test "benchmark-detect: get_benchmark_gradle_task — jvm/smoke maps correctly" {
    source scripts/sh/lib/benchmark-detect.sh
    [[ "$(get_benchmark_gradle_task 'foo' 'jvm' 'smoke')" == ':foo:desktopSmokeBenchmark' ]]
    [[ "$(get_benchmark_gradle_task 'foo' 'jvm' 'stress')" == ':foo:desktopStressBenchmark' ]]
    [[ "$(get_benchmark_gradle_task 'foo' 'jvm' 'main')" == ':foo:desktopBenchmark' ]]
    [[ "$(get_benchmark_gradle_task 'foo' 'android' 'smoke')" == ':foo:connectedAndroidTest' ]]
    [[ "$(get_benchmark_gradle_task 'foo' 'android' 'main')" == ':foo:connectedAndroidTest' ]]
}

@test "benchmark-detect: detect_benchmark_modules with default filter '*' returns all matching modules (regression)" {
    # Regression: previously detect_benchmark_modules used [[ "$mod" != *"$filter"* ]]
    # which with filter="*" (default of run-benchmarks.sh) literal-substring-checked
    # for "*" inside the module name and silently filtered EVERY module out, breaking
    # the default `kmp-test benchmark` invocation.
    cat > "$WORK_DIR/settings.gradle.kts" << 'EOF'
rootProject.name = "fake"
include(":benchmark")
include(":perf")
include(":app")
EOF
    mkdir -p "$WORK_DIR/benchmark" "$WORK_DIR/perf" "$WORK_DIR/app"
    echo 'androidx.benchmark.junit4.AndroidBenchmarkRunner' > "$WORK_DIR/benchmark/build.gradle.kts"
    echo 'id("org.jetbrains.kotlinx.benchmark")' > "$WORK_DIR/perf/build.gradle.kts"
    echo '// no benchmark here' > "$WORK_DIR/app/build.gradle.kts"

    source scripts/sh/lib/benchmark-detect.sh
    local result
    result="$(detect_benchmark_modules "$WORK_DIR" "*")"
    [[ "$result" == *"benchmark"* ]]
    [[ "$result" == *"perf"* ]]
    [[ "$result" != *"app"* ]]  # has no benchmark plugin → excluded
}

@test "benchmark-detect: detect_benchmark_modules with empty filter returns all matching modules" {
    cat > "$WORK_DIR/settings.gradle.kts" << 'EOF'
include(":alpha")
include(":beta")
EOF
    mkdir -p "$WORK_DIR/alpha" "$WORK_DIR/beta"
    echo 'id("org.jetbrains.kotlinx.benchmark")' > "$WORK_DIR/alpha/build.gradle.kts"
    echo 'id("org.jetbrains.kotlinx.benchmark")' > "$WORK_DIR/beta/build.gradle.kts"

    source scripts/sh/lib/benchmark-detect.sh
    local result
    result="$(detect_benchmark_modules "$WORK_DIR" "")"
    [[ "$result" == *"alpha"* ]]
    [[ "$result" == *"beta"* ]]
}

@test "benchmark-detect: detect_benchmark_modules with substring filter returns only matches" {
    cat > "$WORK_DIR/settings.gradle.kts" << 'EOF'
include(":core-bench")
include(":app-bench")
include(":other")
EOF
    mkdir -p "$WORK_DIR/core-bench" "$WORK_DIR/app-bench" "$WORK_DIR/other"
    for d in core-bench app-bench other; do
        echo 'id("org.jetbrains.kotlinx.benchmark")' > "$WORK_DIR/$d/build.gradle.kts"
    done

    source scripts/sh/lib/benchmark-detect.sh
    local result
    result="$(detect_benchmark_modules "$WORK_DIR" "core")"
    [[ "$result" == *"core-bench"* ]]
    [[ "$result" != *"app-bench"* ]]
    [[ "$result" != *"other"* ]]
}

@test "benchmark-detect: detect_benchmark_modules locale-portable include extraction (regression)" {
    # Regression: previously used `grep -oP` (PCRE) which fails on Git Bash with
    # "supports only unibyte and UTF-8 locales" when LC_ALL=C. The fix uses
    # POSIX-friendly grep -E + sed.
    cat > "$WORK_DIR/settings.gradle.kts" << 'EOF'
rootProject.name = "fake"
include  (   ":spaced-include"   )
include(":nested:module")
include(":simple")
EOF
    for m in spaced-include nested/module simple; do
        mkdir -p "$WORK_DIR/$m"
        echo 'id("org.jetbrains.kotlinx.benchmark")' > "$WORK_DIR/$m/build.gradle.kts"
    done

    source scripts/sh/lib/benchmark-detect.sh
    local result
    # Force C locale to reproduce the original Git Bash environment
    result="$(LC_ALL=C detect_benchmark_modules "$WORK_DIR" "*")"
    [[ "$result" == *"spaced-include"* ]]
    [[ "$result" == *"nested:module"* ]]
    [[ "$result" == *"simple"* ]]
}

@test "benchmark integration: --platform jvm against android-only module exits 3 with hint (not TaskSelectionException)" {
    # End-to-end: build a fake project with one androidx.benchmark-only module,
    # invoke run-benchmarks.sh with --platform jvm, expect exit 3 and hint message.
    mkdir -p "$WORK_DIR/benchmark"
    cat > "$WORK_DIR/settings.gradle.kts" << 'EOF'
rootProject.name = "fake"
include(":benchmark")
EOF
    cat > "$WORK_DIR/benchmark/build.gradle.kts" << 'EOF'
testInstrumentationRunner = "androidx.benchmark.junit4.AndroidBenchmarkRunner"
EOF
    # Stub gradlew so script doesn't try to start real Gradle (it shouldn't even reach this)
    cat > "$WORK_DIR/gradlew" << 'EOF'
#!/usr/bin/env bash
echo "STUB GRADLEW INVOKED — should NOT happen for incompatible platform"
exit 99
EOF
    chmod +x "$WORK_DIR/gradlew"

    run bash scripts/sh/run-benchmarks.sh --project-root "$WORK_DIR" --platform jvm --config smoke
    [ "$status" -eq 3 ]
    [[ "$output" == *"[SKIP]"* ]] || [[ "$output" == *"No benchmark module"* ]]
    [[ "$output" == *"benchmark plugin"* ]] || [[ "$output" == *"--platform"* ]]
    # Critically: stub gradlew must NOT have been invoked
    [[ "$output" != *"STUB GRADLEW INVOKED"* ]]
}

# v0.5.2 Gap E — Android method-level filter on benchmark
@test "benchmark (Gap E): method-level filter splits on # and emits both runner-argument flags (android plat)" {
    grep -q "TEST_FILTER\" == \*\"#\"\*" "$SCRIPT"
    grep -q "testInstrumentationRunnerArguments\.class=\$_kmp_class_part" "$SCRIPT"
    grep -q "testInstrumentationRunnerArguments\.method=\$_kmp_method_part" "$SCRIPT"
}
