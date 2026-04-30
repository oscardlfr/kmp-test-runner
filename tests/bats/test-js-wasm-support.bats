#!/usr/bin/env bats
# v0.6 Bug 3 — fixture-driven verification of JS / Wasm source-set + task
# resolution against tests/fixtures/kmp-with-js/.
#
# Strategy: avoid relying on `gradlew tasks --all --quiet` execution from JS
# (cross-platform spawnSync EINVAL with .bat files on Windows). Instead each
# test computes the canonical cache key for the fixture, pre-writes the
# `tasks-<sha>.txt` cache file with the expected gradle output, then invokes
# `buildProjectModel` so the probe layer reads from cache and never spawns.

FIXTURE="tests/fixtures/kmp-with-js"

setup() {
    rm -rf "$FIXTURE/.kmp-test-runner-cache"
    SHA="$(node --input-type=module -e "
        import { computeCacheKey } from './lib/project-model.js';
        process.stdout.write(computeCacheKey('$FIXTURE'));
    ")"
    [ -n "$SHA" ]
    mkdir -p "$FIXTURE/.kmp-test-runner-cache"
    cat > "$FIXTURE/.kmp-test-runner-cache/tasks-${SHA}.txt" <<EOF
web-only:jsTest - Runs the tests for js target
kmp-multi:jvmTest - Runs the tests for jvm target
kmp-multi:jsTest - Runs the tests for js target
EOF
}

teardown() {
    rm -rf "$FIXTURE/.kmp-test-runner-cache"
}

# Build the model JSON for the fixture and emit per-module summary lines:
#   <module>:type=<t>:unit=<u>:web=<w>:jsTest=<true|false>
_dump_modules() {
    node --input-type=module -e "
        import { buildProjectModel } from './lib/project-model.js';
        const m = buildProjectModel('$FIXTURE', { skipProbe: true });
        for (const [name, mod] of Object.entries(m.modules)) {
            const u = mod.resolved.unitTestTask === null ? 'null' : mod.resolved.unitTestTask;
            const w = mod.resolved.webTestTask === null ? 'null' : mod.resolved.webTestTask;
            console.log(\`\${name}:type=\${mod.type}:unit=\${u}:web=\${w}:jsTest=\${mod.sourceSets.jsTest}\`);
        }
    "
}

@test "web-only KMP module: unitTestTask falls back to jsTest, webTestTask is jsTest" {
    run _dump_modules
    [ "$status" -eq 0 ]
    [[ "$output" == *":web-only:type=kmp:unit=jsTest:web=jsTest:jsTest=true"* ]]
}

@test "kmp-multi (KMP+JS): unitTestTask still picks jvmTest, webTestTask exposes jsTest" {
    run _dump_modules
    [ "$status" -eq 0 ]
    [[ "$output" == *":kmp-multi:type=kmp:unit=jvmTest:web=jsTest:jsTest=true"* ]]
}

@test "pm_get_web_test_task reads webTestTask from the model" {
    # shellcheck disable=SC1090
    source scripts/sh/lib/project-model.sh
    # First make the model exist (buildProjectModel side effect).
    node --input-type=module -e "
        import { buildProjectModel } from './lib/project-model.js';
        buildProjectModel('$FIXTURE', { skipProbe: true });
    "
    result="$(pm_get_web_test_task "$FIXTURE" "kmp-multi")"
    [ "$result" = "jsTest" ]
    result="$(pm_get_web_test_task "$FIXTURE" "web-only")"
    [ "$result" = "jsTest" ]
}

@test "pm_get_web_test_task returns empty when model is absent" {
    # shellcheck disable=SC1090
    source scripts/sh/lib/project-model.sh
    rm -rf "$FIXTURE/.kmp-test-runner-cache"
    result="$(pm_get_web_test_task "$FIXTURE" "kmp-multi")"
    [ -z "$result" ]
}
