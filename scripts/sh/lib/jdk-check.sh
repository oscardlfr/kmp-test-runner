#!/usr/bin/env bash
# =============================================================================
# jdk-check.sh — JDK pre-flight gate for any script that spawns gradle.
#
# Source this file and call:
#   gate_jdk_mismatch "$PROJECT_ROOT" "$IGNORE_JDK_MISMATCH" || exit $?
#
# Behavior:
#   1. If gradle.properties has `org.gradle.java.home` pointing to an existing
#      directory: export JAVA_HOME to that path and return 0 (gradle uses its
#      own java home; no mismatch possible).
#   2. Else: scan *.gradle.kts and *.kt for any of these JDK requirement
#      signals — `jvmToolchain(N)`, `JvmTarget.JVM_N`,
#      `JavaVersion.VERSION_N` — and take the MAX. If found, compare against
#      current `java -version`.
#   3. On mismatch: print actionable error to stderr and return 3, unless
#      $IGNORE_JDK_MISMATCH == "true", in which case print a WARN and return 0.
#   4. On no mismatch (or no signal found, or no java on PATH): return 0.
#
# Exit code 3 matches kmp-test's EXIT.ENV_ERROR convention.
# =============================================================================

# Print a per-OS hint for setting JAVA_HOME to the required version.
_jdk_hint() {
    local required="$1"
    local script_name="${2:-kmp-test parallel}"
    case "$(uname -s 2>/dev/null)" in
        Darwin) echo "JAVA_HOME=\$(/usr/libexec/java_home -v $required) $script_name" ;;
        *)      echo "JAVA_HOME=/usr/lib/jvm/java-$required $script_name" ;;
    esac
}

# Returns 0 (OK or auto-detected gradle.properties JAVA_HOME) or 3 (mismatch).
# When ignore=="true" and a mismatch is detected, prints a WARN and returns 0.
gate_jdk_mismatch() {
    local project_root="$1"
    local ignore="${2:-false}"
    local gradle_java=""

    # 1. Honor explicit gradle.properties org.gradle.java.home (user opt-in).
    if [[ -f "$project_root/gradle.properties" ]]; then
        gradle_java="$(grep "^org.gradle.java.home" "$project_root/gradle.properties" 2>/dev/null \
            | sed 's/.*=//' | tr -d ' \r' || true)"
        if [[ -n "$gradle_java" && -d "$gradle_java" ]]; then
            export JAVA_HOME="$gradle_java"
            return 0
        fi
    fi

    # 2. Detect required JDK version. Three signals — pick the max:
    #    a) jvmToolchain(N)          — gradle compile/test toolchain
    #    b) JvmTarget.JVM_N          — kotlin bytecode target
    #    c) JavaVersion.VERSION_N    — Android source/target compatibility
    # Scan both *.gradle.kts and *.kt (convention plugins live in build-logic/*.kt).
    local jvm_version=0
    local n
    while IFS= read -r n; do
        [[ -n "$n" && "$n" -gt "$jvm_version" ]] && jvm_version="$n"
    done < <(
        grep -rhE 'jvmToolchain[[:space:]]*\([[:space:]]*[0-9]+' "$project_root" \
            --include="*.gradle.kts" --include="*.kt" \
            --exclude-dir=build --exclude-dir=.gradle --exclude-dir=node_modules --exclude-dir=.git \
            2>/dev/null | grep -oE '[0-9]+' || true
        grep -rhE 'JvmTarget\.JVM_[0-9]+' "$project_root" \
            --include="*.gradle.kts" --include="*.kt" \
            --exclude-dir=build --exclude-dir=.gradle --exclude-dir=node_modules --exclude-dir=.git \
            2>/dev/null | grep -oE 'JVM_[0-9]+' | grep -oE '[0-9]+' || true
        grep -rhE 'JavaVersion\.VERSION_[0-9]+' "$project_root" \
            --include="*.gradle.kts" --include="*.kt" \
            --exclude-dir=build --exclude-dir=.gradle --exclude-dir=node_modules --exclude-dir=.git \
            2>/dev/null | grep -oE 'VERSION_[0-9]+' | grep -oE '[0-9]+' || true
    )
    if [[ "$jvm_version" -eq 0 ]]; then
        return 0
    fi

    # 3. Read current `java -version` (works even if JAVA_HOME unset).
    local current_version
    current_version="$(java -version 2>&1 | head -1 | grep -oE '"[0-9]+' | tr -d '"' || true)"
    if [[ -z "$current_version" || "$current_version" == "$jvm_version" ]]; then
        return 0
    fi

    # 4. Mismatch detected.
    if [[ "$ignore" == "true" ]]; then
        echo "[!] WARN: JDK mismatch (required: $jvm_version, current: $current_version) — bypassed by --ignore-jdk-mismatch" >&2
        return 0
    fi

    local hint
    hint="$(_jdk_hint "$jvm_version")"
    {
        echo ""
        echo "[ERROR] JDK mismatch — project requires JDK $jvm_version but current JDK is $current_version"
        echo "        Tests will fail with UnsupportedClassVersionError if we proceed."
        echo ""
        echo "        Fix: set JAVA_HOME to a JDK $jvm_version install. Example:"
        echo "          $hint"
        echo ""
        echo "        Bypass (not recommended): pass --ignore-jdk-mismatch"
        echo ""
    } >&2
    return 3
}
