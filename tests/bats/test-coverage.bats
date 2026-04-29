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
    # --skip-tests must not produce an unknown-option error
    [[ "$output" != *"Unknown option"* ]]
    [[ "$output" != *"--project-root is required"* ]]
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
# v0.5.1 Bug B'' — per-module coverage-task probe
# ---------------------------------------------------------------------------
@test "coverage (Bug B''): script sources gradle-tasks-probe.sh" {
    grep -q 'lib/gradle-tasks-probe.sh' "$SCRIPT"
}

@test "coverage (Bug B''): module-classification loop calls module_has_task" {
    grep -q 'module_has_task' "$SCRIPT"
}

@test "coverage (Bug B''): emits [SKIP coverage] when probe says task missing" {
    # The skip line is the user-visible signal that B'' triggered.
    grep -q '\[SKIP coverage\]' "$SCRIPT"
    grep -q 'no coverage plugin applied' "$SCRIPT"
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

@test "coverage (Phase 4 step 6): ProjectModel fast-path tier 1 wired before legacy chain" {
    # The script must source project-model.sh + consult pm_get_coverage_task
    # BEFORE the existing get_coverage_gradle_task + module_has_task chain.
    grep -q 'lib/project-model.sh' "$SCRIPT"
    grep -q 'pm_get_coverage_task' "$SCRIPT"
    pm_line="$(grep -n 'pm_get_coverage_task' "$SCRIPT" | head -1 | cut -d: -f1)"
    legacy_line="$(grep -n 'get_coverage_gradle_task "\$mod_cov_tool"' "$SCRIPT" | head -1 | cut -d: -f1)"
    [ "$pm_line" -lt "$legacy_line" ]
}
