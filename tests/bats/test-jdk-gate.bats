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

    # Stub java that reports JDK 23 (mismatch versus jvmToolchain(17) below).
    cat > "$WORK_DIR/bin/java" << 'EOF'
#!/usr/bin/env bash
# `java -version` writes to stderr in real JDKs; mirror that.
echo 'openjdk version "23.0.1" 2024-10-15' >&2
exit 0
EOF
    chmod +x "$WORK_DIR/bin/java"

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
    [[ "$output" == *"current JDK is 23"* ]]
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
    source "$LIB"
    run gate_jdk_mismatch "$WORK_DIR" "false"
    [ "$status" -eq 0 ]
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
