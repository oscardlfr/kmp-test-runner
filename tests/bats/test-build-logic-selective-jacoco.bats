#!/usr/bin/env bats
# v0.6.x Gap 4 — fixture-driven verification that per-module convention-plugin
# coverage detection only inherits when the consumer module APPLIES a
# coverage-adding convention plugin (vs the v0.6.0 broad inheritance that
# over-predicted on nowinandroid-style setups).
#
# Fixture: tests/fixtures/build-logic-selective-jacoco/
#   build-logic publishes 2 plugins (myproj.android.jacoco, myproj.android.noop)
#   3 consumer modules:
#     :app-with-jacoco  → applies the jacoco-adding plugin → inherit jacoco
#     :app-with-noop    → applies the noop plugin → null
#     :app-no-convention → applies neither → null

FIXTURE="tests/fixtures/build-logic-selective-jacoco"

setup() {
    rm -rf "$FIXTURE/.kmp-test-runner-cache"
}

teardown() {
    rm -rf "$FIXTURE/.kmp-test-runner-cache"
}

# Build the model JSON (skipProbe — no gradle invocation needed) and emit
# per-module summary lines: <module>:cov=<value-or-null>
_dump_module_coverage() {
    node --input-type=module -e "
        import { buildProjectModel } from './lib/project-model.js';
        const m = buildProjectModel('$FIXTURE', { skipProbe: true });
        for (const [name, mod] of Object.entries(m.modules)) {
            const c = mod.coveragePlugin === null ? 'null' : mod.coveragePlugin;
            console.log(\`\${name}:cov=\${c}\`);
        }
    "
}

@test "module that applies jacoco-adding convention plugin inherits coveragePlugin=jacoco" {
    run _dump_module_coverage
    [ "$status" -eq 0 ]
    [[ "$output" == *":app-with-jacoco:cov=jacoco"* ]]
}

@test "module that applies non-coverage convention plugin → coveragePlugin=null (no over-predict)" {
    run _dump_module_coverage
    [ "$status" -eq 0 ]
    [[ "$output" == *":app-with-noop:cov=null"* ]]
}

@test "module with no convention plugin → coveragePlugin=null" {
    run _dump_module_coverage
    [ "$status" -eq 0 ]
    [[ "$output" == *":app-no-convention:cov=null"* ]]
}

@test "exactly 1 of 3 modules has coveragePlugin=jacoco (selective inheritance)" {
    run _dump_module_coverage
    [ "$status" -eq 0 ]
    count=$(echo "$output" | grep -c "cov=jacoco" || true)
    [ "$count" -eq 1 ]
}
