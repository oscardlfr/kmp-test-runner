#!/usr/bin/env bats
# v0.7.0 Phase 2 — verify the parallel wrapper accepts the new ios / macos
# TEST_TYPE values and surfaces them in the configuration banner.
#
# Strategy: build a synthetic project with a stub `gradlew` and per-module
# iOS / macOS test source-set markers (so module_has_test_sources counts
# them as testable via the legacy filesystem walker — extended in v0.7.0
# to recognize iosX64Test / iosArm64Test / iosSimulatorArm64Test /
# macosTest / macosX64Test / macosArm64Test). No project model JSON is
# pre-written; the wrapper falls back to its default iOS / macOS task
# names. Per-module model lookup is verified by tests/bats/test-ios-macos-support.bats.

SCRIPT="scripts/sh/run-parallel-coverage-suite.sh"

setup() {
    WORK_DIR="$(mktemp -d)"
    cat > "$WORK_DIR/settings.gradle.kts" <<'EOF'
rootProject.name = "ios-dispatch-fixture"
include(":ios-only")
include(":macos-only")
EOF
    mkdir -p "$WORK_DIR/ios-only/src/iosX64Test"
    cat > "$WORK_DIR/ios-only/build.gradle.kts" <<'EOF'
plugins { kotlin("multiplatform") }
kotlin { iosX64() }
EOF
    mkdir -p "$WORK_DIR/macos-only/src/macosArm64Test"
    cat > "$WORK_DIR/macos-only/build.gradle.kts" <<'EOF'
plugins { kotlin("multiplatform") }
kotlin { macosArm64() }
EOF
    cat > "$WORK_DIR/gradlew" << 'EOF'
#!/usr/bin/env bash
echo "BUILD SUCCESSFUL"
exit 0
EOF
    chmod +x "$WORK_DIR/gradlew"
    printf '@echo off\r\nexit /b 0\r\n' > "$WORK_DIR/gradlew.bat"
}

teardown() {
    rm -rf "$WORK_DIR"
}

@test "wrapper --help surfaces ios | macos as valid --test-type values" {
    run bash "$SCRIPT" --help
    [ "$status" -eq 0 ]
    [[ "$output" == *"ios"* ]]
    [[ "$output" == *"macos"* ]]
}

@test "wrapper --test-type ios is accepted (not a usage error)" {
    run bash "$SCRIPT" --project-root "$WORK_DIR" --test-type ios \
        --module-filter "ios-only" --ignore-jdk-mismatch --coverage-tool none
    # Wrapper may exit non-zero for downstream reasons (e.g. coverage report
    # generation) but must NOT print "Unknown option" / usage errors for the
    # new test type.
    [[ "$output" != *"Unknown option"* ]]
    [[ "$output" != *"--project-root is required"* ]]
}

@test "wrapper --test-type macos is accepted (not a usage error)" {
    run bash "$SCRIPT" --project-root "$WORK_DIR" --test-type macos \
        --module-filter "macos-only" --ignore-jdk-mismatch --coverage-tool none
    [[ "$output" != *"Unknown option"* ]]
    [[ "$output" != *"--project-root is required"* ]]
}

@test "wrapper --test-type ios surfaces 'Test Type: ios (per-module iosTestTask)' in config banner" {
    run bash "$SCRIPT" --project-root "$WORK_DIR" --test-type ios \
        --module-filter "ios-only" --ignore-jdk-mismatch --coverage-tool none
    [[ "$output" == *"Test Type: ios (per-module iosTestTask)"* ]]
}

@test "wrapper --test-type macos surfaces 'Test Type: macos (per-module macosTestTask, host-native)' in config banner" {
    run bash "$SCRIPT" --project-root "$WORK_DIR" --test-type macos \
        --module-filter "macos-only" --ignore-jdk-mismatch --coverage-tool none
    [[ "$output" == *"Test Type: macos (per-module macosTestTask, host-native)"* ]]
}

@test "wrapper --test-type ios dispatches :module:iosSimulatorArm64Test (default fallback when model absent)" {
    run bash "$SCRIPT" --project-root "$WORK_DIR" --test-type ios \
        --module-filter "ios-only" --ignore-jdk-mismatch --coverage-tool none
    # The diagnostic line ("    :ios-only:iosSimulatorArm64Test") confirms
    # the wrapper resolved the iOS-default task and queued it for gradle.
    [[ "$output" == *":ios-only:iosSimulatorArm64Test"* ]]
}

@test "wrapper --test-type macos dispatches :module:macosArm64Test (default fallback when model absent)" {
    run bash "$SCRIPT" --project-root "$WORK_DIR" --test-type macos \
        --module-filter "macos-only" --ignore-jdk-mismatch --coverage-tool none
    [[ "$output" == *":macos-only:macosArm64Test"* ]]
}

@test "legacy fs walker counts iosX64Test source set as testable (v0.7.0)" {
    # Without --include-untested, modules without test source sets get
    # auto-skipped. iOS-arch source sets must register as testable.
    run bash "$SCRIPT" --project-root "$WORK_DIR" --test-type ios \
        --module-filter "ios-only" --ignore-jdk-mismatch --coverage-tool none
    [[ "$output" != *"[SKIP] :ios-only (no test source set"* ]]
    [[ "$output" == *"Modules found: 1"* ]]
}
