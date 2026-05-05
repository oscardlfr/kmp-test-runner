#!/usr/bin/env bats
# Tests for coverage subcommand — uses same script as parallel
# (run-parallel-coverage-suite.sh with --skip-tests injected by bin/kmp-test.js)

SCRIPT="scripts/sh/run-parallel-coverage-suite.sh"

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

# v0.8 sub-entry 5: wrapper is now a thin Node launcher; coverage logic
# lives entirely in lib/coverage-orchestrator.js. The legacy bash internals
# (MODULES_CONTRIBUTING counter, detect_coverage_tool helpers, gate functions)
# no longer exist in the wrapper. The Bug A/B''/E/sub-entry-4 contracts are
# verified end-to-end via tests/vitest/coverage-orchestrator.test.js.
@test "coverage: --skip-tests flag accepted without error" {
    run bash "$SCRIPT" --project-root "$WORK_DIR" --skip-tests --module-filter "nonexistent-module-xyz" --ignore-jdk-mismatch
    [[ "$output" != *"Unknown option"* ]]
}

@test "coverage: wrapper delegates --skip-tests to lib/runner.js coverage" {
    grep -q 'exec node.*lib/runner.js.*coverage' "$SCRIPT"
}

@test "coverage: bash Gap A helpers detect_coverage_tool / get_coverage_gradle_task removed from coverage-detect.sh" {
    ! grep -qE '^\s*detect_coverage_tool\(\)' scripts/sh/lib/coverage-detect.sh
    ! grep -qE '^\s*get_coverage_gradle_task\(\)' scripts/sh/lib/coverage-detect.sh
}
