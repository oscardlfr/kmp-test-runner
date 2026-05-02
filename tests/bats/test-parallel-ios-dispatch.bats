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

# v0.8 sub-entry 5: the wrapper is now a thin Node launcher and does not
# render its own --help text or banners. The CLI-level --help (kmp-test
# parallel --help) still documents ios|macos as valid test types — see
# tests/vitest/cli.test.js. The per-module task resolution
# (iosTestTask / macosTestTask candidate chain) lives in
# lib/project-model.js and is covered by tests/bats/test-ios-macos-support.bats
# and tests/vitest/parallel-orchestrator.test.js (pickGradleTaskFor cases).

@test "wrapper --test-type ios is accepted (not a usage error)" {
    # On non-mac hosts the orchestrator emits platform_unsupported (exit 3)
    # but it must NOT print "Unknown option".
    run bash "$SCRIPT" --project-root "$WORK_DIR" --test-type ios \
        --module-filter "ios-only" --ignore-jdk-mismatch --coverage-tool none
    [[ "$output" != *"Unknown option"* ]]
}

@test "wrapper --test-type macos is accepted (not a usage error)" {
    run bash "$SCRIPT" --project-root "$WORK_DIR" --test-type macos \
        --module-filter "macos-only" --ignore-jdk-mismatch --coverage-tool none
    [[ "$output" != *"Unknown option"* ]]
}

@test "wrapper --test-type ios on macOS dispatches :module:iosX64Test (resolved from source set)" {
    # On non-mac hosts this fires platform_unsupported BEFORE any dispatch.
    if [[ "$(uname)" != "Darwin" ]]; then
        skip "iOS dispatch requires macOS host"
    fi
    # Fixture has src/iosX64Test → resolveTasksFor picks iosX64Test as the
    # iosTestTask candidate (first in the chain that's present on disk).
    run bash "$SCRIPT" --project-root "$WORK_DIR" --test-type ios \
        --module-filter "ios-only" --ignore-jdk-mismatch --coverage-tool none
    [[ "$output" == *":ios-only:iosX64Test"* ]]
}

@test "wrapper --test-type macos dispatches :module:macosArm64Test (default fallback when model absent)" {
    if [[ "$(uname)" != "Darwin" ]]; then
        skip "macOS dispatch requires macOS host"
    fi
    run bash "$SCRIPT" --project-root "$WORK_DIR" --test-type macos \
        --module-filter "macos-only" --ignore-jdk-mismatch --coverage-tool none
    [[ "$output" == *":macos-only:macosArm64Test"* ]]
}
