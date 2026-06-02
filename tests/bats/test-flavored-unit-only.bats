#!/usr/bin/env bats
# Flavored unit-test source-set gap, end-to-end.
#
# The flavored-unit-only fixture's :app keeps its unit tests in src/testDemo/ +
# src/testProd/ with NO bare src/test/ and NO androidTest/. The static walker
# tracks only fixed source-set names, so it sees no unit-test source set at all;
# only the `gradlew tasks --all` probe (a fake gradlew emitting flavored unit
# tasks) reveals test${Flavor}${BuildType}UnitTest → resolved.flavors. So:
#   1. STATIC detection alone (skipProbe) is blind → hasFlavor false + no tracked
#      unit-test source set.
#   2. The probe populates resolved.flavors and resolves the umbrella `test`.
#   3. `describe` reports unit=test, matching the dispatch umbrella :app:test
#      (no describe/dispatch divergence).
#   4. :instrumented-only (no flavored unit tasks) stays a true negative.
#
# Mirrors tests/pester/Flavored-Unit-Only.Tests.ps1 + the vitest unit +
# runParallel integration tests (which cover the actual umbrella dispatch).

FIXTURE="tests/fixtures/flavored-unit-only"

setup() {
    rm -rf "$FIXTURE/.kmp-test-runner" "$FIXTURE/.kmp-test-runner-cache"
}
teardown() {
    rm -rf "$FIXTURE/.kmp-test-runner" "$FIXTURE/.kmp-test-runner-cache"
}

@test "flavored-unit-only: static scan is blind (:app no flavors, no unit source set)" {
    run node --input-type=module -e "
        import path from 'node:path';
        import { buildProjectModel } from './lib/project-model.js';
        const app = buildProjectModel(path.resolve('$FIXTURE'), { skipProbe: true }).modules[':app'];
        console.log('hasFlavor=' + app.hasFlavor + ' test=' + app.sourceSets.test + ' androidUnitTest=' + app.sourceSets.androidUnitTest);
    "
    [ "$status" -eq 0 ]
    [[ "$output" == *"hasFlavor=false test=false androidUnitTest=false"* ]]
}

@test "flavored-unit-only: probe recovers flavors + resolves umbrella unit task on :app" {
    run node --input-type=module -e "
        import path from 'node:path';
        import { buildProjectModel } from './lib/project-model.js';
        const app = buildProjectModel(path.resolve('$FIXTURE'), { skipProbe: false, useCache: false }).modules[':app'];
        console.log('unit=' + app.resolved.unitTestTask + ' flavors=' + app.resolved.flavors.join('+'));
    "
    [ "$status" -eq 0 ]
    [[ "$output" == *"unit=test flavors=demo+prod"* ]]
}

@test "flavored-unit-only: describe reports unit=test on :app (matches dispatch umbrella)" {
    run node --input-type=module -e "
        import path from 'node:path';
        import { runDescribe } from './lib/orchestrators/describe-orchestrator.js';
        const { envelope } = runDescribe({ projectRoot: path.resolve('$FIXTURE'), args: [] });
        const app = envelope.describe.modules.find(x => x.name === ':app');
        console.log('unit=' + app.test_tasks.unit + ' has_flavor=' + app.has_flavor);
    "
    [ "$status" -eq 0 ]
    [[ "$output" == *"unit=test has_flavor=true"* ]]
}

@test "flavored-unit-only: parallel --dry-run plan keeps :app (has_flavor true, not skipped)" {
    run node bin/kmp-test.js parallel --project-root "$FIXTURE" --test-type androidUnit --module-filter :app --dry-run --json
    [ "$status" -eq 0 ]
    [[ "$output" == *'"has_flavor":true'* ]]
    [[ "$output" == *'"flavors":["demo","prod"]'* ]]
}
