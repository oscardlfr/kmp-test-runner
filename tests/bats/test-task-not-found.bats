#!/usr/bin/env bats
# v0.7.x WS-1 / UX-1 — coordinated proactive + reactive fix for the
# "PASS fantasma when gradle reports 'Cannot locate tasks that match'" bug
# surfaced 2026-05-01 against Confetti.
#
# Pre-fix on macOS: `kmp-test parallel --test-type ios` against a project
# where some modules don't declare iOS targets reported every module as
# `[PASS]` + exit 0 + BUILD SUCCESSFUL even though gradle aborted at task
# graph resolution and ran zero tests.
#
# Two-layer fix:
#   - UX-1 (proactive, primary): the wrapper consults
#     module_supports_test_type before queuing gradle tasks. Modules without
#     an iOS / macOS target (project model task lookup, with filesystem
#     fallback for src/ios*Main and src/ios*Test dirs) are skipped with
#     `[SKIP] <mod> (no <type> target)` reason. Prevents the Cannot-locate
#     scenario in the first place.
#   - WS-1 (reactive, defense-in-depth): if a module survives UX-1 (e.g.
#     project model is stale or filesystem dirs misrepresent the build
#     config) and gradle does emit "Cannot locate tasks that match", the
#     wrapper now (a) forwards the gradle line to its own stderr so the
#     parser's task_not_found discriminator fires, (b) marks ALL testable
#     modules failed because gradle aborts the entire invocation at
#     task-graph resolution — none of the queued tasks ran, regardless of
#     which one gradle named in the error.
#
# Combined with the WS-5 invariant in lib/cli.js (errors[] non-empty ⇒
# exit_code != 0), the JSON envelope contract becomes consistent end-to-end.

PARALLEL="scripts/sh/run-parallel-coverage-suite.sh"

# ----------------------------------------------------------------------------
# Shared helpers
# ----------------------------------------------------------------------------

_setup_common() {
    mkdir -p "$WORK_DIR/bin"
    # Stub java.cmd / java for the JDK gate.
    cat > "$WORK_DIR/bin/java" << 'EOF'
#!/usr/bin/env bash
echo 'openjdk version "17.0.10" 2024-01-16' >&2
exit 0
EOF
    chmod +x "$WORK_DIR/bin/java"
    export PATH="$WORK_DIR/bin:$PATH"
}

# Stub gradlew that succeeds with no test results — used by UX-1 tests where
# we want the only module that survives the proactive filter to dispatch
# cleanly so the assertion focuses on what UX-1 *skipped* vs *forwarded*.
_install_gradlew_success() {
    cat > "$WORK_DIR/gradlew" << 'EOF'
#!/usr/bin/env bash
echo "BUILD SUCCESSFUL (stub): $*"
exit 0
EOF
    chmod +x "$WORK_DIR/gradlew"
    printf '@echo off\r\nexit /b 0\r\n' > "$WORK_DIR/gradlew.bat"
}

# Stub gradlew that mimics gradle 8.x abort on task graph resolution failure.
# Used by WS-1 reactive tests — UX-1 is intentionally bypassed by giving the
# module a real iOS source dir on disk (so it survives the filter) while the
# stub gradlew rejects the dispatched task.
_install_gradlew_cannot_locate() {
    cat > "$WORK_DIR/gradlew" << 'EOF'
#!/usr/bin/env bash
cat >&2 <<'STDERR'

FAILURE: Build failed with an exception.

* What went wrong:
Cannot locate tasks that match ':edge-case:iosSimulatorArm64Test' as task 'iosSimulatorArm64Test' not found in project ':edge-case'.
STDERR
echo "BUILD FAILED in 850ms"
exit 1
EOF
    chmod +x "$WORK_DIR/gradlew"
    printf '@echo off\r\nexit /b 1\r\n' > "$WORK_DIR/gradlew.bat"
}

# ----------------------------------------------------------------------------
# Layer 1: UX-1 proactive — modules without iOS target are skipped before
# the wrapper queues any gradle task.
# ----------------------------------------------------------------------------

setup_ux1() {
    WORK_DIR="$(mktemp -d)"
    _setup_common
    _install_gradlew_success

    cat > "$WORK_DIR/settings.gradle.kts" << 'EOF'
rootProject.name = "ux1-fixture"
include(":ios-mod")
include(":android-only")
EOF
    # :ios-mod has iosMain (declared target) — UX-1 lets it through.
    mkdir -p "$WORK_DIR/ios-mod/src/iosMain"
    mkdir -p "$WORK_DIR/ios-mod/src/commonTest"
    echo "kotlin { iosSimulatorArm64() }" > "$WORK_DIR/ios-mod/build.gradle.kts"
    # :android-only has only Android source sets — UX-1 should skip it.
    mkdir -p "$WORK_DIR/android-only/src/androidUnitTest"
    echo "kotlin { jvmToolchain(17) }" > "$WORK_DIR/android-only/build.gradle.kts"
}

teardown_ux1() {
    rm -rf "$WORK_DIR"
}

@test "UX-1: --test-type ios skips Android-only module before gradle dispatch" {
    setup_ux1
    run bash "$PARALLEL" --project-root "$WORK_DIR" --module-filter "*" --test-type ios
    [ "$status" -eq 0 ]
    [[ "$output" == *"[SKIP] android-only (no ios target)"* ]]
    [[ "$output" == *"[PASS] ios-mod"* ]]
    # UX-1 must not have flipped to the reactive WS-1 path.
    [[ "$output" != *"task not found"* ]]
    [[ "$output" != *"build aborted at resolution"* ]]
    [[ "$output" == *"BUILD SUCCESSFUL"* ]]
    teardown_ux1
}

@test "UX-1: src/iosMain alone (no iosTest) lets the module through (gradle no-op task)" {
    # Confetti's :shared shape: declares iosX64()/iosSimulatorArm64() in
    # build.gradle.kts (evidenced on disk by src/iosMain) but has no iosTest
    # source set yet. The gradle task :module:iosSimulatorArm64Test still
    # exists (gradle creates it from the target declaration) — UX-1 must NOT
    # skip the module just because the *test* source set is absent.
    setup_ux1
    # Strip the existing commonTest dir from :ios-mod so iosMain is the only
    # source-of-truth for "this module is iOS-capable".
    rm -rf "$WORK_DIR/ios-mod/src/commonTest"
    run bash "$PARALLEL" --project-root "$WORK_DIR" --module-filter "*" --test-type ios --include-untested
    [ "$status" -eq 0 ]
    [[ "$output" != *"[SKIP] ios-mod"* ]]
    [[ "$output" == *"[SKIP] android-only (no ios target)"* ]]
    teardown_ux1
}

@test "UX-1 + parser: skipped[] envelope carries the disambiguated reason" {
    setup_ux1
    run node bin/kmp-test.js --json parallel --project-root "$WORK_DIR" --module-filter "*" --test-type ios
    first_line=$(echo "$output" | grep -m1 '^{' || true)
    [ -n "$first_line" ]
    # Both the UX-1 reason wording and the canonical [SKIP] format must
    # round-trip through parseSkippedModules into skipped[].
    [[ "$first_line" == *'"module":"android-only"'* ]]
    [[ "$first_line" == *'"reason":"no ios target"'* ]]
    teardown_ux1
}

# UX-1 extension to common/desktop test types — same proactive filter,
# different evidence pattern (looks for src/jvmMain | src/desktopMain |
# src/jvmTest | src/desktopTest because gradle's desktopTest task needs
# a jvm() / jvm("desktop") target).
setup_ux1_common() {
    WORK_DIR="$(mktemp -d)"
    _setup_common
    _install_gradlew_success

    cat > "$WORK_DIR/settings.gradle.kts" << 'EOF'
rootProject.name = "ux1-common-fixture"
include(":jvm-mod")
include(":android-only")
EOF
    # :jvm-mod has jvmMain (declared jvm target) — UX-1 lets it through.
    mkdir -p "$WORK_DIR/jvm-mod/src/jvmMain"
    mkdir -p "$WORK_DIR/jvm-mod/src/jvmTest"
    echo "kotlin { jvm() }" > "$WORK_DIR/jvm-mod/build.gradle.kts"
    # :android-only has only Android source sets — UX-1 should skip it.
    mkdir -p "$WORK_DIR/android-only/src/main"
    mkdir -p "$WORK_DIR/android-only/src/test"
    echo "android { ... }" > "$WORK_DIR/android-only/build.gradle.kts"
}

@test "UX-1: --test-type common skips Android-only module (no jvm/desktop target)" {
    setup_ux1_common
    run bash "$PARALLEL" --project-root "$WORK_DIR" --module-filter "*" --test-type common
    [ "$status" -eq 0 ]
    [[ "$output" == *"[SKIP] android-only (no common target)"* ]]
    [[ "$output" == *"[PASS] jvm-mod"* ]]
    [[ "$output" == *"BUILD SUCCESSFUL"* ]]
    teardown_ux1
}

@test "UX-1: --test-type desktop alias also skips modules without jvm target" {
    setup_ux1_common
    run bash "$PARALLEL" --project-root "$WORK_DIR" --module-filter "*" --test-type desktop
    [ "$status" -eq 0 ]
    [[ "$output" == *"[SKIP] android-only (no desktop target)"* ]]
    [[ "$output" == *"[PASS] jvm-mod"* ]]
    teardown_ux1
}

# ----------------------------------------------------------------------------
# Layer 2: WS-1 reactive — when a module survives UX-1 (model stale, or
# filesystem dir present without matching build config) and gradle DOES emit
# "Cannot locate tasks that match", the wrapper marks ALL testable modules
# failed because gradle aborts before any task runs. The first-named task
# is reported but every other queued task is also doomed.
# ----------------------------------------------------------------------------

setup_ws1() {
    WORK_DIR="$(mktemp -d)"
    _setup_common
    _install_gradlew_cannot_locate

    cat > "$WORK_DIR/settings.gradle.kts" << 'EOF'
rootProject.name = "ws1-fixture"
include(":edge-case")
include(":also-doomed")
EOF
    # Both modules have iOS source sets on disk so UX-1 lets them through —
    # the stub gradlew then rejects the task at resolution time.
    mkdir -p "$WORK_DIR/edge-case/src/iosSimulatorArm64Test"
    echo "kotlin { iosSimulatorArm64() }" > "$WORK_DIR/edge-case/build.gradle.kts"
    mkdir -p "$WORK_DIR/also-doomed/src/iosSimulatorArm64Test"
    echo "kotlin { iosSimulatorArm64() }" > "$WORK_DIR/also-doomed/build.gradle.kts"
}

teardown_ws1() {
    rm -rf "$WORK_DIR"
}

@test "WS-1: gradle 'Cannot locate' marks ALL testable modules as FAIL (not just the named one)" {
    setup_ws1
    run bash "$PARALLEL" --project-root "$WORK_DIR" --module-filter "*" --test-type ios
    [ "$status" -eq 1 ]
    # Both modules must be flagged failed even though gradle only named
    # :edge-case in its error — gradle aborted before running anything, so
    # :also-doomed didn't run either.
    [[ "$output" == *"[FAIL] edge-case"* ]]
    [[ "$output" == *"[FAIL] also-doomed"* ]]
    [[ "$output" == *"build aborted at resolution"* ]]
    [[ "$output" == *"BUILD FAILED"* ]]
    [[ "$output" != *"[PASS]"* ]]
    [[ "$output" != *"BUILD SUCCESSFUL"* ]]
    teardown_ws1
}

@test "WS-1: gradle 'Cannot locate' line is forwarded to wrapper stderr" {
    # Without the WS-1 stderr forwarding, the parser cannot fire the
    # task_not_found discriminator (gradle's stderr is captured into a
    # temp log and never re-emitted).
    setup_ws1
    run bash "$PARALLEL" --project-root "$WORK_DIR" --module-filter "*" --test-type ios
    [[ "$output" == *"Cannot locate tasks that match"* ]]
    [[ "$output" == *":edge-case:iosSimulatorArm64Test"* ]]
    teardown_ws1
}

@test "WS-1 + WS-5: JSON envelope has exit_code = 1 AND errors[].code = 'task_not_found'" {
    setup_ws1
    run node bin/kmp-test.js --json parallel --project-root "$WORK_DIR" --module-filter "*" --test-type ios
    first_line=$(echo "$output" | grep -m1 '^{' || true)
    [ -n "$first_line" ]
    # Pre-fix: exit_code:0 + errors[].code:"task_not_found" — WS-5 violation.
    [[ "$first_line" == *'"exit_code":1'* ]]
    [[ "$first_line" == *'"code":"task_not_found"'* ]]
    [ "$status" -eq 1 ]
    teardown_ws1
}
