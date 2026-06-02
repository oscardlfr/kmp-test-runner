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

# parse-coverage-xml.py smoke: a 100%-covered sourcefile must list no missed
# lines, and only fully-uncovered lines (ci==0) are reported — never partials
# (mi>0 AND ci>0). python3 is preinstalled on the ubuntu/macOS bats runners.
@test "parse-coverage-xml.py: 100% sourcefile shows no lines; partials excluded" {
    if ! command -v python3 >/dev/null 2>&1; then skip "python3 not available"; fi
    cat > "$WORK_DIR/cov.xml" << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<report name="t">
  <package name="com/example">
    <sourcefile name="Full.kt">
      <line nr="10" mi="0" ci="3"/>
      <line nr="11" mi="2" ci="5"/>
      <counter type="LINE" missed="0" covered="2"/>
    </sourcefile>
    <sourcefile name="Partial.kt">
      <line nr="20" mi="0" ci="4"/>
      <line nr="21" mi="3" ci="2"/>
      <line nr="22" mi="4" ci="0"/>
      <counter type="LINE" missed="1" covered="2"/>
    </sourcefile>
  </package>
</report>
EOF
    run python3 scripts/lib/parse-coverage-xml.py "$WORK_DIR/cov.xml" ":app"
    [ "$status" -eq 0 ]
    # Full.kt at 100% ends with an empty missed-lines field (trailing pipe).
    [[ "$output" == *"Full.kt|Full|2|0|2|100.0|"* ]]
    # Partial.kt reports only the fully-missed line 22, not the partial 21.
    [[ "$output" == *"Partial.kt|Partial|2|1|3|66.7|22"* ]]
    [[ "$output" != *"|21,22"* ]]
}
