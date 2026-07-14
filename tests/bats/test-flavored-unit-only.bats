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

# fix(parallel): make dry-run side-effect free — resolveDryRunModules now
# forces { useCache: false, skipProbe: true } so a cold cache can never
# trigger a gradle probe spawn or a cache write. That closes the H8 side-
# effect bug, but it also means dry-run's module preview is STATIC-ONLY on a
# cold cache — same blind spot as the "static scan is blind" test above.
# Unlike convention-flavors (whose modules keep an ordinary src/test/ tree
# and just lose their flavor labels), :app HERE has no test source set the
# static walker recognizes at all (only src/testDemo/ + src/testProd/), so it
# is now genuinely reclassified into skipped[] with reason "no test source
# set" on a cold-cache dry-run — an honest reflection of what static analysis
# alone can see, even though a real run (or a dry-run against a warm cache
# from a prior real run) would still find and dispatch it correctly. This is
# an accepted, bounded trade-off of the no-gradle-probe dry-run contract, not
# a regression in the real dispatch path (unaffected — see the "probe
# recovers..." test above and the runParallel integration tests).
@test "flavored-unit-only: parallel --dry-run on a cold cache reclassifies :app as skipped (static-only blind spot)" {
    run node bin/kmp-test.js parallel --project-root "$FIXTURE" --test-type androidUnit --module-filter :app --dry-run --json
    [ "$status" -eq 0 ]
    [[ "$output" == *'"module":"app"'* ]]
    [[ "$output" == *'"reason":"no test source set"'* ]]
}
