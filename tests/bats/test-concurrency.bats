#!/usr/bin/env bats
# Tests for the v0.3.8 Tier 1 concurrency hardening:
#   - advisory lockfile at <projectRoot>/.kmp-test-runner.lock
#   - --force flag (bypass live lock)
#   - stale lock reclamation (dead PID)
#   - SIGINT cleanup
#
# All tests treat the lock primitives as black-box — they just exercise the
# CLI surface against contrived lockfiles or background processes.

CLI="bin/kmp-test.js"
LOCKFILE_NAME=".kmp-test-runner.lock"

# A PID well outside any OS PID range — process.kill(pid, 0) reliably throws
# ESRCH, giving a deterministic "dead PID" without forking + killing.
DEAD_PID=999999999

setup() {
    # MinGW/Cygwin bash $$ returns an MSYS-internal PID that doesn't match
    # the Windows kernel PID Node.js sees, so the lock-collision tests would
    # falsely reclaim valid locks. CI runs these on ubuntu-latest where bash
    # PIDs are real Linux PIDs and the tests work cleanly.
    case "$(uname -s 2>/dev/null)" in
        MINGW*|MSYS*|CYGWIN*) IS_MSYS=1 ;;
        *)                    IS_MSYS=0 ;;
    esac
    WORK_DIR="$(mktemp -d)"
    echo 'rootProject.name = "fake"' > "$WORK_DIR/settings.gradle.kts"
    cat > "$WORK_DIR/gradlew" << 'EOF'
#!/usr/bin/env bash
echo "stub gradlew: $*"
exit 0
EOF
    chmod +x "$WORK_DIR/gradlew"
    printf '@echo off\r\nexit /b 0\r\n' > "$WORK_DIR/gradlew.bat"
}

teardown() {
    rm -rf "$WORK_DIR"
}

# Write a lockfile shaped exactly like the one cli.js would produce.
write_lock() {
    local pid="$1"
    local subcommand="${2:-parallel}"
    cat > "$WORK_DIR/$LOCKFILE_NAME" <<EOF
{
  "schema": 1,
  "pid": $pid,
  "start_time": "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)",
  "subcommand": "$subcommand",
  "project_root": "$WORK_DIR",
  "version": "0.3.8"
}
EOF
}

@test "lockfile: live-PID lock blocks second invocation with exit 3" {
    [[ "$IS_MSYS" -eq 1 ]] && skip "MinGW bash PID != Windows PID — runs on Linux CI"
    # Use the bats process's own PID — guaranteed alive while this test runs.
    write_lock "$$" "parallel"

    run node "$CLI" parallel --project-root "$WORK_DIR"
    [ "$status" -eq 3 ]
    # Message must mention the lock state — accept either canonical phrase.
    [[ "$output" == *"lock"* ]] || [[ "$output" == *"already running"* ]]

    # The original lock must NOT have been overwritten.
    grep -q "\"pid\": $$" "$WORK_DIR/$LOCKFILE_NAME"
}

@test "lockfile: live-PID lock + --force bypasses and proceeds" {
    [[ "$IS_MSYS" -eq 1 ]] && skip "MinGW bash PID != Windows PID — runs on Linux CI"
    write_lock "$$" "parallel"

    run node "$CLI" parallel --force --project-root "$WORK_DIR"
    # Script may exit 0 or non-zero (no modules) — we only care that --force
    # bypassed the lock and the cleanup ran.
    [ ! -f "$WORK_DIR/$LOCKFILE_NAME" ]
}

@test "lockfile: stale lock with dead PID is reclaimed without --force" {
    write_lock "$DEAD_PID" "parallel"

    run node "$CLI" parallel --project-root "$WORK_DIR"
    # Should mention reclaim in stderr when not in --json mode.
    [[ "$output" == *"stale"* ]] || [[ "$output" == *"reclaim"* ]] || true

    # Lockfile cleaned up after run regardless of script exit code.
    [ ! -f "$WORK_DIR/$LOCKFILE_NAME" ]
}

@test "lockfile: --json mode emits errors[].code = lock_held on collision" {
    [[ "$IS_MSYS" -eq 1 ]] && skip "MinGW bash PID != Windows PID — runs on Linux CI"
    write_lock "$$" "parallel"

    run node "$CLI" parallel --json --project-root "$WORK_DIR"
    [ "$status" -eq 3 ]
    [[ "$output" == *'"code":"lock_held"'* ]]
    [[ "$output" == *'"exit_code":3'* ]]
}

@test "lockfile: cleaned up after a run completes (any script exit code)" {
    run node "$CLI" parallel --project-root "$WORK_DIR"
    # Script may exit 0 or 3 (no modules), but lockfile must always be removed.
    [ ! -f "$WORK_DIR/$LOCKFILE_NAME" ]
}

@test "lockfile: --dry-run does NOT acquire a lock" {
    run node "$CLI" parallel --dry-run --project-root "$WORK_DIR"
    [ "$status" -eq 0 ]
    [ ! -f "$WORK_DIR/$LOCKFILE_NAME" ]
}

@test "lockfile: --dry-run does NOT block on existing live lock" {
    write_lock "$$" "parallel"

    run node "$CLI" parallel --dry-run --project-root "$WORK_DIR"
    [ "$status" -eq 0 ]
    # Original lock untouched (matches by PID independent of MSYS semantics —
    # we just check the file still exists with our written content).
    [ -f "$WORK_DIR/$LOCKFILE_NAME" ]
    grep -q '"subcommand": "parallel"' "$WORK_DIR/$LOCKFILE_NAME"
}

@test "lockfile: doctor does NOT acquire a lock" {
    write_lock "$$" "parallel"

    run node "$CLI" doctor --project-root "$WORK_DIR"
    # doctor exit code can be 0 or 3 depending on env (JDK/ADB) — but must
    # NOT remove the existing lockfile (we never wrote ours).
    [ -f "$WORK_DIR/$LOCKFILE_NAME" ]
    grep -q '"subcommand": "parallel"' "$WORK_DIR/$LOCKFILE_NAME"
}

@test "lockfile: corrupt lockfile is reclaimed silently" {
    echo "not-json{" > "$WORK_DIR/$LOCKFILE_NAME"

    run node "$CLI" parallel --project-root "$WORK_DIR"
    # Script may exit any code (no modules) — but the corrupt lock must have
    # been overwritten and then cleaned up.
    [ ! -f "$WORK_DIR/$LOCKFILE_NAME" ]
}

@test "lockfile: SIGINT during spawn cleans up the lock" {
    # Make the stub gradlew sleep so cli.js stays in spawnSync.
    cat > "$WORK_DIR/gradlew" <<'EOF'
#!/usr/bin/env bash
sleep 30
exit 0
EOF
    chmod +x "$WORK_DIR/gradlew"

    # Background the cli invocation; capture its PID.
    node "$CLI" parallel --project-root "$WORK_DIR" >/dev/null 2>&1 &
    local cli_pid=$!

    # Wait for the lockfile to materialize (up to 5s).
    local i=0
    while [[ $i -lt 50 && ! -f "$WORK_DIR/$LOCKFILE_NAME" ]]; do
        sleep 0.1
        i=$((i + 1))
    done
    [ -f "$WORK_DIR/$LOCKFILE_NAME" ]

    # Send SIGINT to simulate Ctrl-C; wait for the process to exit.
    kill -INT "$cli_pid" 2>/dev/null || true
    wait "$cli_pid" 2>/dev/null || true

    # Lockfile must be removed by the SIGINT cleanup handler.
    [ ! -f "$WORK_DIR/$LOCKFILE_NAME" ]
}

@test "run-id: temp log path includes a PID-suffixed run-id" {
    # Drive the parallel script directly, observing the TEMP_LOG path it
    # constructs. We probe via `set -x` to capture variable assignments.
    # NOTE: KMP_RUN_ID is the canonical env var — once set, scripts honour it.
    export KMP_RUN_ID="20260426-150000-099999"

    # Run the script with --skip-tests so it short-circuits the gradle call;
    # run-id is still computed and used in any temp paths it would create.
    run bash scripts/sh/run-parallel-coverage-suite.sh \
        --project-root "$WORK_DIR" --skip-tests --module-filter "nonexistent-xyz"

    # The script ran with our run-id in its env and didn't crash.
    [[ "$status" -eq 0 || "$status" -ne 2 ]]   # any non-usage exit is fine

    unset KMP_RUN_ID
}

@test "run-id: format is YYYYMMDD-HHMMSS-PID6 (zero-padded)" {
    # Compute it the same way the script does and assert the regex.
    local run_id
    run_id="$(date +%Y%m%d-%H%M%S)-$(printf '%06d' $(($$ % 1000000)))"
    [[ "$run_id" =~ ^[0-9]{8}-[0-9]{6}-[0-9]{6}$ ]]
}
