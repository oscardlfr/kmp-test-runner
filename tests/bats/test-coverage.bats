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

@test "coverage: --skip-tests flag accepted without error" {
    run bash "$SCRIPT" --project-root "$WORK_DIR" --skip-tests --module-filter "nonexistent-module-xyz"
    # v0.8 sub-entry 4: --skip-tests now exec's lib/runner.js coverage. Either
    # path (legacy or migrated) must NOT bail with the "unknown option" or
    # "--project-root is required" errors.
    [[ "$output" != *"Unknown option"* ]]
    [[ "$output" != *"--project-root is required"* ]]
}

@test "coverage (sub-entry 4): --skip-tests delegates to lib/runner.js coverage" {
    # The wrapper must exec node BEFORE doing any of the legacy bash work
    # so coverage runs even when the parallel codepath is irrelevant.
    grep -q 'exec node.*lib/runner.js.*coverage' "$SCRIPT"
}

@test "coverage (sub-entry 4): bash Gap A helpers detect_coverage_tool / get_coverage_gradle_task removed from coverage-detect.sh" {
    ! grep -qE '^\s*detect_coverage_tool\(\)' scripts/sh/lib/coverage-detect.sh
    ! grep -qE '^\s*get_coverage_gradle_task\(\)' scripts/sh/lib/coverage-detect.sh
}

@test "coverage: error path exits 1 when --project-root is missing" {
    run bash "$SCRIPT"
    [ "$status" -eq 1 ]
    [[ "$output" == *"--project-root is required"* ]]
}

@test "coverage: lib sourcing uses SCRIPT_DIR not absolute paths" {
    local sources
    sources=$(grep -E '^source ' "$SCRIPT" || true)
    [[ "$sources" != *"/Users/"* ]]
    [[ "$sources" != *"/home/"* ]]
    [[ "$sources" != *"/root/"* ]]
    if [[ -n "$sources" ]]; then
        [[ "$sources" == *'$SCRIPT_DIR'* ]]
    fi
}

# ---------------------------------------------------------------------------
# v0.5.1 Bug B'' — per-module coverage-task probe (parallel codepath only)
# v0.8 sub-entry 4: the coverage codepath no longer reaches this probe (it
# exec's lib/runner.js). The parallel codepath still sources gradle-tasks-probe
# for non-coverage probing; sub-entry 5 will lift the rest.
# ---------------------------------------------------------------------------
@test "coverage (Bug B''): script sources gradle-tasks-probe.sh" {
    grep -q 'lib/gradle-tasks-probe.sh' "$SCRIPT"
}

# ---------------------------------------------------------------------------
# v0.5.1 Bug E — no-coverage-data banner + machine marker
# ---------------------------------------------------------------------------
@test "coverage (Bug E): script counts MODULES_CONTRIBUTING (modules with total > 0)" {
    grep -q 'MODULES_CONTRIBUTING=' "$SCRIPT"
    # The increment must gate on total > 0 (real coverage data, not just any XML).
    grep -A 10 'MODULES_CONTRIBUTING=0' "$SCRIPT" | grep -q 'total.*-gt 0'
    grep -A 12 'MODULES_CONTRIBUTING=0' "$SCRIPT" | grep -q 'MODULES_CONTRIBUTING + 1'
}

@test "coverage (Bug E): emits [!] No coverage data ... when MODULES_CONTRIBUTING == 0" {
    grep -q '\[!\] No coverage data collected from any module' "$SCRIPT"
    grep -q 'github.com/oscardlfr/kmp-test-runner#coverage-setup' "$SCRIPT"
}

@test "coverage (Bug E): emits machine-readable COVERAGE_MODULES_CONTRIBUTING marker" {
    grep -q 'COVERAGE_MODULES_CONTRIBUTING:' "$SCRIPT"
}

@test "coverage (Bug E): banner is gated on MODULES_CONTRIBUTING -gt 0" {
    # The [OK] banner must be inside an `if MODULES_CONTRIBUTING -gt 0` branch.
    grep -B 1 -A 1 '"\[OK\] Full coverage report generated' "$SCRIPT" | grep -q 'MODULES_CONTRIBUTING'
}

@test "coverage (sub-entry 4): pm_get_coverage_task is the only coverage-tool source in the wrapper" {
    # The legacy detect_coverage_tool / get_coverage_gradle_task fallback was
    # removed in sub-entry 4. project-model is now the single source of truth
    # for the wrapper's parallel codepath; coverage codepath is migrated to
    # lib/coverage-orchestrator.js.
    grep -q 'lib/project-model.sh' "$SCRIPT"
    grep -q 'pm_get_coverage_task' "$SCRIPT"
    # The legacy callers must be gone (only comments may mention the helpers).
    ! grep -qE '^\s*[^#]*\bdetect_coverage_tool\b' "$SCRIPT"
    ! grep -qE '^\s*[^#]*\bget_coverage_gradle_task\b' "$SCRIPT"
}
