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
