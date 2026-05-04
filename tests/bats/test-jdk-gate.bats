#!/usr/bin/env bats
# Tests for the JDK toolchain pre-flight gate (v0.5.0 — Bug A fix).
# Verifies scripts/sh/lib/jdk-check.sh BLOCKs on mismatch by default and
# honors --ignore-jdk-mismatch.

PARALLEL="scripts/sh/run-parallel-coverage-suite.sh"
CHANGED="scripts/sh/run-changed-modules-tests.sh"
LIB="scripts/sh/lib/jdk-check.sh"

setup() {
    WORK_DIR="$(mktemp -d)"
    mkdir -p "$WORK_DIR/bin"

    # Stub gradlew (kmp-test never reaches it under the gate, but parallel.sh's
    # later code does — keep happy-path callers working).
    cat > "$WORK_DIR/bin/gradlew" << 'EOF'
#!/usr/bin/env bash
echo "BUILD SUCCESSFUL (stub): $*"
exit 0
EOF
    chmod +x "$WORK_DIR/bin/gradlew"

    # Stub java that reports JDK 11 (host BELOW jvmToolchain(17) → mismatch).
    # v0.8.0 fix-PR-B: pre-fix this stub returned JDK 23 because the gate did
    # `==` equality and 23 != 17 triggered the mismatch path. Post-fix the gate
    # uses `>=` semantics (host satisfying the floor preserves the host), so
    # we need host < floor to keep exercising the mismatch branch.
    cat > "$WORK_DIR/bin/java" << 'EOF'
#!/usr/bin/env bash
# `java -version` writes to stderr in real JDKs; mirror that.
echo 'openjdk version "11.0.21" 2023-10-17' >&2
exit 0
EOF
    chmod +x "$WORK_DIR/bin/java"
    # Mirror the stub as java.cmd so Windows-local runs (where Node's spawnSync
    # uses PATHEXT and ignores extensionless stubs) also pick it up. CI bats
    # only runs on ubuntu so this is a local-dev-quality-of-life touch.
    cat > "$WORK_DIR/bin/java.cmd" << 'EOF'
@echo off
echo openjdk version "11.0.21" 2023-10-17 1>&2
exit /b 0
EOF

    # Minimal KMP project layout with a jvmToolchain(17) declaration.
    echo 'rootProject.name = "test-project"' > "$WORK_DIR/settings.gradle.kts"
    cat > "$WORK_DIR/build.gradle.kts" << 'EOF'
kotlin {
    jvmToolchain(17)
}
EOF

    export PATH="$WORK_DIR/bin:$PATH"
}

teardown() {
    rm -rf "$WORK_DIR"
}

# -----------------------------------------------------------------------------
# Helper sourcing (unit-style tests against the lib directly)
# -----------------------------------------------------------------------------

@test "jdk-check lib: gate_jdk_mismatch returns 3 on jvmToolchain mismatch" {
    # shellcheck disable=SC1090
    source "$LIB"
    run gate_jdk_mismatch "$WORK_DIR" "false"
    [ "$status" -eq 3 ]
    [[ "$output" == *"JDK mismatch"* ]]
    [[ "$output" == *"requires JDK 17"* ]]
    [[ "$output" == *"current JDK is 11"* ]]
    [[ "$output" == *"--ignore-jdk-mismatch"* ]]
}

@test "jdk-check lib: gate_jdk_mismatch with ignore=true returns 0 + warns" {
    source "$LIB"
    run gate_jdk_mismatch "$WORK_DIR" "true"
    [ "$status" -eq 0 ]
    [[ "$output" == *"WARN: JDK mismatch"* ]]
    [[ "$output" == *"bypassed by --ignore-jdk-mismatch"* ]]
}

@test "jdk-check lib: returns 0 when no jvmToolchain in any *.gradle.kts" {
    rm "$WORK_DIR/build.gradle.kts"
    echo 'plugins { kotlin("jvm") }' > "$WORK_DIR/build.gradle.kts"
    source "$LIB"
    run gate_jdk_mismatch "$WORK_DIR" "false"
    [ "$status" -eq 0 ]
}

@test "jdk-check lib: returns 0 when gradle.properties org.gradle.java.home points to existing dir" {
    # User explicitly configured gradle's java home → JAVA_HOME is moot.
    echo "org.gradle.java.home=$WORK_DIR" > "$WORK_DIR/gradle.properties"
    source "$LIB"
    run gate_jdk_mismatch "$WORK_DIR" "false"
    [ "$status" -eq 0 ]
}

@test "jdk-check lib: returns 0 when java major version matches jvmToolchain" {
    # Replace java stub with one reporting JDK 17 (matches the toolchain).
    cat > "$WORK_DIR/bin/java" << 'EOF'
#!/usr/bin/env bash
echo 'openjdk version "17.0.10" 2024-01-16' >&2
exit 0
EOF
    chmod +x "$WORK_DIR/bin/java"
    cat > "$WORK_DIR/bin/java.cmd" << 'EOF'
@echo off
echo openjdk version "17.0.10" 2024-01-16 1>&2
exit /b 0
EOF
    source "$LIB"
    run gate_jdk_mismatch "$WORK_DIR" "false"
    [ "$status" -eq 0 ]
}

@test "jdk-check lib: detects JvmTarget.JVM_N in build-logic/*.kt convention plugin (Bug F regression)" {
    # Real-world scenario surfaced 2026-04-27: a project with no jvmToolchain
    # anywhere has a convention plugin in build-logic/ that pins
    # `jvmTarget.set(JvmTarget.JVM_21)`. Bytecode v65 won't load on JDK 17
    # at runtime → gate must fire.
    rm "$WORK_DIR/build.gradle.kts"
    echo 'plugins { kotlin("jvm") }' > "$WORK_DIR/build.gradle.kts"
    mkdir -p "$WORK_DIR/build-logic/src/main/kotlin"
    cat > "$WORK_DIR/build-logic/src/main/kotlin/KmpBenchmarkConventionPlugin.kt" <<'EOF'
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

class KmpBenchmarkConventionPlugin {
    fun apply() {
        jvm("desktop") { compilerOptions { jvmTarget.set(JvmTarget.JVM_21) } }
    }
}
EOF
    source "$LIB"
    run gate_jdk_mismatch "$WORK_DIR" "false"
    [ "$status" -eq 3 ]
    [[ "$output" == *"requires JDK 21"* ]]
    [[ "$output" == *"current JDK is 11"* ]]
}

@test "jdk-check lib: takes MAX across mixed signals (jvmToolchain 17 + JvmTarget.JVM_21 → 21)" {
    cat > "$WORK_DIR/build.gradle.kts" <<'EOF'
kotlin {
    jvmToolchain(17)
    jvm("desktop") { compilerOptions { jvmTarget.set(JvmTarget.JVM_21) } }
}
EOF
    source "$LIB"
    run gate_jdk_mismatch "$WORK_DIR" "false"
    [ "$status" -eq 3 ]
    [[ "$output" == *"requires JDK 21"* ]]
}

# -----------------------------------------------------------------------------
# v0.5.2 Gap B — ProjectModel fast-path consultation
# -----------------------------------------------------------------------------
# When .kmp-test-runner-cache/model-<sha>.json exists with a numeric
# jdkRequirement.min, the gate must consult the model FIRST (broader 9-dir
# walker, depth=12). The legacy walker (4-dir exclude, unbounded depth)
# only runs when the model is absent.
# -----------------------------------------------------------------------------

@test "jdk-check lib (Gap B): fast-path uses model.json jdkRequirement.min when no walker signal exists" {
    # Build.gradle.kts has NO jvmToolchain / JvmTarget / JavaVersion signals
    # — the legacy walker would return 0 (no mismatch detected). But the
    # model file declares jdkRequirement.min=21 (e.g. derived from
    # build-logic convention plugins the walker missed) → gate must fire.
    rm "$WORK_DIR/build.gradle.kts"
    echo 'plugins { kotlin("jvm") }' > "$WORK_DIR/build.gradle.kts"

    # Compute the cache key the same way the model lib does.
    source scripts/sh/lib/gradle-tasks-probe.sh
    local sha
    sha="$(_kmp_compute_cache_key "$WORK_DIR")"
    [ -n "$sha" ]

    mkdir -p "$WORK_DIR/.kmp-test-runner-cache"
    cat > "$WORK_DIR/.kmp-test-runner-cache/model-${sha}.json" <<EOF
{
  "schemaVersion": 1,
  "projectRoot": "$WORK_DIR",
  "generatedAt": "2026-04-29T00:00:00Z",
  "cacheKey": "$sha",
  "jdkRequirement": { "min": 21, "signals": ["build-logic-convention-plugin"] },
  "settingsIncludes": [],
  "modules": {}
}
EOF

    source "$LIB"
    run gate_jdk_mismatch "$WORK_DIR" "false"
    [ "$status" -eq 3 ]
    [[ "$output" == *"requires JDK 21"* ]]
    [[ "$output" == *"current JDK is 11"* ]]
}

@test "jdk-check lib (Gap B): falls back to legacy walker when model.json is absent" {
    # No .kmp-test-runner-cache dir → model fast-path returns empty →
    # walker scans build.gradle.kts (jvmToolchain(17) from setup) → mismatch fires.
    [ ! -d "$WORK_DIR/.kmp-test-runner-cache" ]

    source "$LIB"
    run gate_jdk_mismatch "$WORK_DIR" "false"
    [ "$status" -eq 3 ]
    [[ "$output" == *"requires JDK 17"* ]]
}

# -----------------------------------------------------------------------------
# End-to-end: invoke the production parallel script and verify the gate fires
# -----------------------------------------------------------------------------

@test "parallel.sh: BLOCKs with exit 3 when JDK mismatches jvmToolchain (default)" {
    run bash "$PARALLEL" --project-root "$WORK_DIR"
    [ "$status" -eq 3 ]
    [[ "$output" == *"JDK mismatch"* ]]
    [[ "$output" == *"--ignore-jdk-mismatch"* ]]
}

@test "parallel.sh: --ignore-jdk-mismatch bypasses the gate" {
    run bash "$PARALLEL" --project-root "$WORK_DIR" --ignore-jdk-mismatch
    # Whatever exit code follows, it is NOT 3 from the JDK gate. The script may
    # still exit non-zero downstream (no real modules etc.) but the JDK error
    # message must not be the dominant one.
    [[ "$output" != *"requires JDK 17"* ]] || [[ "$output" == *"WARN: JDK mismatch"* ]]
}

@test "changed.sh: BLOCKs with exit 3 when JDK mismatches jvmToolchain (default)" {
    # Make WORK_DIR a git repo so changed.sh's subsequent checks don't override
    # the JDK gate's exit code.
    (cd "$WORK_DIR" && git init -q && git config user.email t@t && git config user.name t)
    run bash "$CHANGED" --project-root "$WORK_DIR"
    [ "$status" -eq 3 ]
    [[ "$output" == *"JDK mismatch"* ]]
}

@test "changed.sh: --ignore-jdk-mismatch bypasses the gate" {
    (cd "$WORK_DIR" && git init -q && git config user.email t@t && git config user.name t)
    run bash "$CHANGED" --project-root "$WORK_DIR" --ignore-jdk-mismatch
    [[ "$output" != *"requires JDK 17"* ]] || [[ "$output" == *"WARN: JDK mismatch"* ]]
}

# -----------------------------------------------------------------------------
# v0.8.0 fix-PR-B — preserve host JDK when it satisfies the floor
# -----------------------------------------------------------------------------
# The CLI-side preserve-host fix is in lib/cli.js#preflightJdkCheck, but the
# script-side gate (this lib) had the same `==` equality bug. Both must mirror
# the `host >= floor → preserve` semantic so the preserved-host run from cli.js
# actually reaches gradle. Without this, cli.js says "host is fine" but the
# script then re-gates and exits 3, breaking the preserve path end-to-end.
# Canonical scenario: host=23 + jvmToolchain(17) → preserve.
# -----------------------------------------------------------------------------

@test "jdk-check lib (v0.8.0 fix-PR-B): host JDK above floor → returns 0 (preserved)" {
    # Replace java stub with one reporting JDK 23 (above jvmToolchain(17)).
    cat > "$WORK_DIR/bin/java" << 'EOF'
#!/usr/bin/env bash
echo 'openjdk version "23.0.2" 2025-01-21' >&2
exit 0
EOF
    chmod +x "$WORK_DIR/bin/java"
    cat > "$WORK_DIR/bin/java.cmd" << 'EOF'
@echo off
echo openjdk version "23.0.2" 2025-01-21 1>&2
exit /b 0
EOF
    source "$LIB"
    run gate_jdk_mismatch "$WORK_DIR" "false"
    [ "$status" -eq 0 ]
    # No mismatch error must be emitted on this path.
    [[ "$output" != *"JDK mismatch"* ]]
    [[ "$output" != *"UnsupportedClassVersionError"* ]]
}
