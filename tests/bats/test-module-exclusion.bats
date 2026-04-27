#!/usr/bin/env bats
# Tests for module exclusion + auto-skip-untested (v0.5.0 — Bug B).
# Verifies scripts/sh/lib/script-utils.sh module_has_test_sources +
# scripts/sh/run-parallel-coverage-suite.sh find_modules filtering.

PARALLEL="scripts/sh/run-parallel-coverage-suite.sh"
UTILS="scripts/sh/lib/script-utils.sh"

setup() {
    WORK_DIR="$(mktemp -d)"
    mkdir -p "$WORK_DIR/bin"

    # Stub gradlew that exits 0 — we don't actually want to run anything.
    cat > "$WORK_DIR/bin/gradlew" << 'EOF'
#!/usr/bin/env bash
echo "BUILD SUCCESSFUL (stub): $*"
exit 0
EOF
    chmod +x "$WORK_DIR/bin/gradlew"

    # Stub java that reports JDK 17 (matches typical jvmToolchain so the
    # JDK gate from Bug A doesn't fire mid-test).
    cat > "$WORK_DIR/bin/java" << 'EOF'
#!/usr/bin/env bash
echo 'openjdk version "17.0.10" 2024-01-16' >&2
exit 0
EOF
    chmod +x "$WORK_DIR/bin/java"

    # Minimal multi-module KMP project:
    #   :core-domain   (has tests)
    #   :feature-home  (has tests)
    #   :api           (NO tests by convention)
    #   :build-logic   (NO tests by convention)
    cat > "$WORK_DIR/settings.gradle.kts" << 'EOF'
rootProject.name = "test-project"
include(":core-domain")
include(":feature-home")
include(":api")
include(":build-logic")
EOF

    for mod in core-domain feature-home api build-logic; do
        mkdir -p "$WORK_DIR/$mod"
        echo "kotlin { jvmToolchain(17) }" > "$WORK_DIR/$mod/build.gradle.kts"
    done

    # Only core-domain and feature-home have test source sets.
    mkdir -p "$WORK_DIR/core-domain/src/commonTest"
    mkdir -p "$WORK_DIR/feature-home/src/test"

    export PATH="$WORK_DIR/bin:$PATH"
}

teardown() {
    rm -rf "$WORK_DIR"
}

# -----------------------------------------------------------------------------
# Helper unit tests against the lib directly
# -----------------------------------------------------------------------------

@test "module_has_test_sources: true when src/test exists" {
    source "$UTILS"
    run module_has_test_sources "$WORK_DIR/feature-home"
    [ "$status" -eq 0 ]
}

@test "module_has_test_sources: true when src/commonTest exists" {
    source "$UTILS"
    run module_has_test_sources "$WORK_DIR/core-domain"
    [ "$status" -eq 0 ]
}

@test "module_has_test_sources: false when no src/*Test* dir" {
    source "$UTILS"
    run module_has_test_sources "$WORK_DIR/api"
    [ "$status" -eq 1 ]
}

@test "module_has_test_sources: true for src/jvmTest, src/desktopTest, src/androidUnitTest, src/androidTest, src/iosTest, src/nativeTest" {
    source "$UTILS"
    for sd in jvmTest desktopTest androidUnitTest androidInstrumentedTest androidTest iosTest nativeTest; do
        local mod_path="$WORK_DIR/test-$sd"
        mkdir -p "$mod_path/src/$sd"
        run module_has_test_sources "$mod_path"
        [ "$status" -eq 0 ] || { echo "FAIL: $sd not detected"; return 1; }
    done
}

# -----------------------------------------------------------------------------
# End-to-end: parallel.sh discovery + filtering
# -----------------------------------------------------------------------------

# The script's MODULE_COUNT print line lets us assert how many modules made it
# past discovery + filtering. Pattern: "  Modules found: N"
extract_modules_found() {
    echo "$1" | grep -oE 'Modules found: [0-9]+' | grep -oE '[0-9]+' | head -1
}

@test "parallel.sh: auto-skips :api and :build-logic (no test source set) by default" {
    run bash "$PARALLEL" --project-root "$WORK_DIR" --module-filter "*"
    local count
    count="$(extract_modules_found "$output")"
    # 2 modules with tests should remain (core-domain + feature-home).
    [ "$count" = "2" ]
    # SKIP lines mention the no-test modules.
    [[ "$output" == *"[SKIP] api"* ]]
    [[ "$output" == *"[SKIP] build-logic"* ]]
    [[ "$output" == *"no test source set"* ]]
}

@test "parallel.sh: --include-untested re-includes untested modules" {
    run bash "$PARALLEL" --project-root "$WORK_DIR" --module-filter "*" --include-untested
    local count
    count="$(extract_modules_found "$output")"
    # All 4 modules now in scope.
    [ "$count" = "4" ]
}

@test "parallel.sh: --exclude-modules removes matching modules with [SKIP] reason" {
    run bash "$PARALLEL" --project-root "$WORK_DIR" --module-filter "*" --exclude-modules "feature-*"
    local count
    count="$(extract_modules_found "$output")"
    # Only core-domain remains: feature-home excluded explicitly,
    # api + build-logic auto-skipped (no test sources).
    [ "$count" = "1" ]
    [[ "$output" == *"[SKIP] feature-home (excluded by --exclude-modules)"* ]]
}

@test "parallel.sh: --exclude-modules accepts comma-separated globs" {
    run bash "$PARALLEL" --project-root "$WORK_DIR" --module-filter "*" \
        --exclude-modules "api,build-logic" --include-untested
    local count
    count="$(extract_modules_found "$output")"
    # core-domain + feature-home remain (api/build-logic explicitly excluded
    # — --include-untested keeps the count honest about what stayed).
    [ "$count" = "2" ]
    [[ "$output" == *"[SKIP] api"* ]]
    [[ "$output" == *"[SKIP] build-logic"* ]]
}

@test "parallel.sh: --exclude-modules + auto-skip combine cleanly" {
    # Add a 5th module with tests, exclude it explicitly. Only core-domain +
    # feature-home should remain (api/build-logic auto-skipped, the 5th
    # explicitly excluded).
    mkdir -p "$WORK_DIR/extra/src/test"
    echo "kotlin { jvmToolchain(17) }" > "$WORK_DIR/extra/build.gradle.kts"
    echo 'include(":extra")' >> "$WORK_DIR/settings.gradle.kts"

    run bash "$PARALLEL" --project-root "$WORK_DIR" --module-filter "*" --exclude-modules "extra"
    local count
    count="$(extract_modules_found "$output")"
    [ "$count" = "2" ]
}

@test "parallel.sh: when no modules survive filtering → exits 3 with helpful message" {
    run bash "$PARALLEL" --project-root "$WORK_DIR" --module-filter "*" \
        --exclude-modules "core-*,feature-*"
    [ "$status" -eq 3 ]
    [[ "$output" == *"No modules found"* ]]
}
