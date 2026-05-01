#!/usr/bin/env bats
# v0.7.0 — fixture-driven verification of iOS / macOS source-set + task
# resolution against tests/fixtures/kmp-with-ios/.
#
# Strategy: mirror tests/bats/test-js-wasm-support.bats. Each test computes
# the canonical cache key for the fixture, pre-writes the
# `tasks-<sha>.txt` cache file with the expected gradle output, then invokes
# `buildProjectModel` with `skipProbe: true` so the probe layer reads from
# cache and never spawns gradle.

FIXTURE="tests/fixtures/kmp-with-ios"

setup() {
    rm -rf "$FIXTURE/.kmp-test-runner-cache"
    SHA="$(node --input-type=module -e "
        import { computeCacheKey } from './lib/project-model.js';
        process.stdout.write(computeCacheKey('$FIXTURE'));
    ")"
    [ -n "$SHA" ]
    mkdir -p "$FIXTURE/.kmp-test-runner-cache"
    cat > "$FIXTURE/.kmp-test-runner-cache/tasks-${SHA}.txt" <<EOF
ios-only:iosX64Test - Runs the tests for iosX64 target
macos-only:macosArm64Test - Runs the tests for macosArm64 target
kmp-multi:jvmTest - Runs the tests for jvm target
kmp-multi:iosSimulatorArm64Test - Runs the tests for iosSimulatorArm64 target
EOF
}

teardown() {
    rm -rf "$FIXTURE/.kmp-test-runner-cache"
}

# Build the model JSON for the fixture and emit per-module summary lines:
#   <module>:type=<t>:unit=<u>:ios=<i>:macos=<x>
_dump_modules() {
    node --input-type=module -e "
        import { buildProjectModel } from './lib/project-model.js';
        const m = buildProjectModel('$FIXTURE', { skipProbe: true });
        for (const [name, mod] of Object.entries(m.modules)) {
            const u = mod.resolved.unitTestTask === null ? 'null' : mod.resolved.unitTestTask;
            const i = mod.resolved.iosTestTask === null ? 'null' : mod.resolved.iosTestTask;
            const x = mod.resolved.macosTestTask === null ? 'null' : mod.resolved.macosTestTask;
            console.log(\`\${name}:type=\${mod.type}:unit=\${u}:ios=\${i}:macos=\${x}\`);
        }
    "
}

@test "ios-only KMP module: iosTestTask is iosX64Test, unitTestTask stays null" {
    run _dump_modules
    [ "$status" -eq 0 ]
    [[ "$output" == *":ios-only:type=kmp:unit=null:ios=iosX64Test:macos=null"* ]]
}

@test "macos-only KMP module: macosTestTask is macosArm64Test, unitTestTask stays null" {
    run _dump_modules
    [ "$status" -eq 0 ]
    [[ "$output" == *":macos-only:type=kmp:unit=null:ios=null:macos=macosArm64Test"* ]]
}

@test "kmp-multi (KMP+iOS): unitTestTask still picks jvmTest, iosTestTask exposes iosSimulatorArm64Test" {
    run _dump_modules
    [ "$status" -eq 0 ]
    [[ "$output" == *":kmp-multi:type=kmp:unit=jvmTest:ios=iosSimulatorArm64Test:macos=null"* ]]
}

@test "pm_get_ios_test_task reads iosTestTask from the model" {
    # shellcheck disable=SC1090
    source scripts/sh/lib/project-model.sh
    node --input-type=module -e "
        import { buildProjectModel } from './lib/project-model.js';
        buildProjectModel('$FIXTURE', { skipProbe: true });
    "
    result="$(pm_get_ios_test_task "$FIXTURE" "ios-only")"
    [ "$result" = "iosX64Test" ]
    result="$(pm_get_ios_test_task "$FIXTURE" "kmp-multi")"
    [ "$result" = "iosSimulatorArm64Test" ]
}

@test "pm_get_macos_test_task reads macosTestTask from the model" {
    # shellcheck disable=SC1090
    source scripts/sh/lib/project-model.sh
    node --input-type=module -e "
        import { buildProjectModel } from './lib/project-model.js';
        buildProjectModel('$FIXTURE', { skipProbe: true });
    "
    result="$(pm_get_macos_test_task "$FIXTURE" "macos-only")"
    [ "$result" = "macosArm64Test" ]
}

@test "pm_get_ios_test_task / pm_get_macos_test_task return empty when model is absent" {
    # shellcheck disable=SC1090
    source scripts/sh/lib/project-model.sh
    rm -rf "$FIXTURE/.kmp-test-runner-cache"
    result="$(pm_get_ios_test_task "$FIXTURE" "kmp-multi")"
    [ -z "$result" ]
    result="$(pm_get_macos_test_task "$FIXTURE" "macos-only")"
    [ -z "$result" ]
}
