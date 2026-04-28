#!/usr/bin/env bats
# Tests for scripts/sh/lib/project-model.sh — bash readers over the
# ProjectModel JSON written by lib/project-model.js (v0.5.1 Phase 4).

PROBE_LIB="scripts/sh/lib/gradle-tasks-probe.sh"
MODEL_LIB="scripts/sh/lib/project-model.sh"

setup() {
    WORK_DIR="$(mktemp -d)"
    echo 'rootProject.name = "pm-test"' > "$WORK_DIR/settings.gradle.kts"
    # gradlew stub so the cache-key probe doesn't bail early.
    cat > "$WORK_DIR/gradlew" << 'EOF'
#!/usr/bin/env bash
exit 0
EOF
    chmod +x "$WORK_DIR/gradlew"

    # Compute the cache key the same way both gradle-tasks-probe.sh AND
    # lib/project-model.js do, so the readers find our fixture model.
    # shellcheck disable=SC1090
    source "$PROBE_LIB"
    SHA="$(_kmp_compute_cache_key "$WORK_DIR")"
    [ -n "$SHA" ]

    mkdir -p "$WORK_DIR/.kmp-test-runner-cache"
    cat > "$WORK_DIR/.kmp-test-runner-cache/model-${SHA}.json" << EOF
{
  "schemaVersion": 1,
  "projectRoot": "$WORK_DIR",
  "generatedAt": "2026-04-29T00:00:00Z",
  "cacheKey": "$SHA",
  "jdkRequirement": { "min": 21, "signals": [] },
  "settingsIncludes": [":core-encryption", ":core-jvm-only"],
  "modules": {
    ":core-encryption": {
      "type": "kmp",
      "androidDsl": "androidLibrary",
      "hasFlavor": false,
      "sourceSets": { "test": false, "commonTest": true, "jvmTest": false, "desktopTest": false, "androidUnitTest": false, "androidInstrumentedTest": true, "androidTest": false, "iosTest": false, "nativeTest": false },
      "coveragePlugin": null,
      "gradleTasks": ["desktopTest", "androidConnectedCheck"],
      "resolved": { "unitTestTask": "desktopTest", "deviceTestTask": "androidConnectedCheck", "coverageTask": null }
    },
    ":core-jvm-only": {
      "type": "jvm",
      "androidDsl": null,
      "hasFlavor": false,
      "sourceSets": { "test": true, "commonTest": false, "jvmTest": false, "desktopTest": false, "androidUnitTest": false, "androidInstrumentedTest": false, "androidTest": false, "iosTest": false, "nativeTest": false },
      "coveragePlugin": "jacoco",
      "gradleTasks": ["test", "jacocoTestReport"],
      "resolved": { "unitTestTask": "test", "deviceTestTask": null, "coverageTask": "jacocoTestReport" }
    }
  }
}
EOF
}

teardown() {
    rm -rf "$WORK_DIR"
}

@test "project-model lib sources cleanly" {
    # shellcheck disable=SC1090
    source "$MODEL_LIB"
    type pm_get_jdk_requirement >/dev/null
    type pm_get_unit_test_task >/dev/null
    type pm_get_device_test_task >/dev/null
    type pm_get_coverage_task >/dev/null
    type pm_module_type >/dev/null
    type pm_module_has_tests >/dev/null
}

@test "pm_get_jdk_requirement reads jdkRequirement.min from the model" {
    # shellcheck disable=SC1090
    source "$MODEL_LIB"
    result="$(pm_get_jdk_requirement "$WORK_DIR")"
    [ "$result" = "21" ]
}

@test "pm_get_jdk_requirement returns empty when model file is absent" {
    # shellcheck disable=SC1090
    source "$MODEL_LIB"
    rm -rf "$WORK_DIR/.kmp-test-runner-cache"
    result="$(pm_get_jdk_requirement "$WORK_DIR")"
    [ -z "$result" ]
}

@test "pm_get_unit_test_task resolves to desktopTest for KMP module" {
    # shellcheck disable=SC1090
    source "$MODEL_LIB"
    result="$(pm_get_unit_test_task "$WORK_DIR" "core-encryption")"
    [ "$result" = "desktopTest" ]
}

@test "pm_get_unit_test_task accepts both :module and bare module names" {
    # shellcheck disable=SC1090
    source "$MODEL_LIB"
    a="$(pm_get_unit_test_task "$WORK_DIR" "core-jvm-only")"
    b="$(pm_get_unit_test_task "$WORK_DIR" ":core-jvm-only")"
    [ "$a" = "test" ]
    [ "$b" = "test" ]
}

@test "pm_get_device_test_task resolves to androidConnectedCheck for KMP androidLibrary{}" {
    # shellcheck disable=SC1090
    source "$MODEL_LIB"
    result="$(pm_get_device_test_task "$WORK_DIR" "core-encryption")"
    [ "$result" = "androidConnectedCheck" ]
}

@test "pm_get_device_test_task returns empty for module without device task" {
    # shellcheck disable=SC1090
    source "$MODEL_LIB"
    result="$(pm_get_device_test_task "$WORK_DIR" "core-jvm-only")"
    [ -z "$result" ]
}

@test "pm_get_coverage_task returns jacocoTestReport when plugin applied" {
    # shellcheck disable=SC1090
    source "$MODEL_LIB"
    result="$(pm_get_coverage_task "$WORK_DIR" "core-jvm-only")"
    [ "$result" = "jacocoTestReport" ]
}

@test "pm_get_coverage_task returns empty when no plugin applied to module" {
    # shellcheck disable=SC1090
    source "$MODEL_LIB"
    result="$(pm_get_coverage_task "$WORK_DIR" "core-encryption")"
    [ -z "$result" ]
}

@test "pm_module_type reports kmp / jvm correctly" {
    # shellcheck disable=SC1090
    source "$MODEL_LIB"
    [ "$(pm_module_type "$WORK_DIR" "core-encryption")" = "kmp" ]
    [ "$(pm_module_type "$WORK_DIR" "core-jvm-only")" = "jvm" ]
}

@test "pm_module_has_tests returns true / false based on sourceSets[]" {
    # shellcheck disable=SC1090
    source "$MODEL_LIB"
    [ "$(pm_module_has_tests "$WORK_DIR" "core-encryption")" = "true" ]
    [ "$(pm_module_has_tests "$WORK_DIR" "core-jvm-only")" = "true" ]
}

@test "pm_module_has_tests returns false when all sourceSets are false" {
    # shellcheck disable=SC1090
    source "$MODEL_LIB"
    # Patch the model to have a third module with no test sources.
    python3 - "$WORK_DIR/.kmp-test-runner-cache/model-${SHA}.json" << 'PY'
import json, sys
with open(sys.argv[1], 'r', encoding='utf-8') as f:
    m = json.load(f)
m['modules'][':api-only'] = {
    'type': 'jvm',
    'androidDsl': None,
    'hasFlavor': False,
    'sourceSets': {k: False for k in [
        'test','commonTest','jvmTest','desktopTest','androidUnitTest',
        'androidInstrumentedTest','androidTest','iosTest','nativeTest'
    ]},
    'coveragePlugin': None,
    'gradleTasks': [],
    'resolved': {'unitTestTask': None, 'deviceTestTask': None, 'coverageTask': None}
}
with open(sys.argv[1], 'w', encoding='utf-8') as f:
    json.dump(m, f)
PY
    result="$(pm_module_has_tests "$WORK_DIR" "api-only")"
    [ "$result" = "false" ]
}

@test "readers fail-soft on malformed JSON (caller falls back to legacy)" {
    # shellcheck disable=SC1090
    source "$MODEL_LIB"
    # Corrupt the model file in-place.
    echo '{ not valid json' > "$WORK_DIR/.kmp-test-runner-cache/model-${SHA}.json"
    result="$(pm_get_jdk_requirement "$WORK_DIR")"
    [ -z "$result" ]
    # And the function still exits 0 — caller doesn't need to error-trap.
    pm_get_unit_test_task "$WORK_DIR" "core-encryption"
}
