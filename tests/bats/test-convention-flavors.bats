#!/usr/bin/env bats
# Finding #2 — flavored androidUnit + jacoco classification, end-to-end.
#
# The convention-flavors fixture applies product flavors (demo/prod) AND jacoco
# unit-test coverage via a ROOT build.gradle.kts `subprojects {}` convention —
# neither :app nor :core-foo references them in its OWN build file. So:
#   1. STATIC detection alone (skipProbe) is blind → hasFlavor false. This locks
#      the Finding #2 root cause (the static-vs-probe gap, flavor dimension).
#   2. The `gradlew tasks --all` probe (a fake gradlew emitting flavored unit +
#      per-variant AGP coverage tasks) populates resolved.flavors +
#      coverageReportTasks; effectiveHasFlavor / effectiveCoveragePlugin upgrade.
#   3. `describe` (which exposes explicit --skip-probe/--no-cache flags the
#      caller controls) surfaces has_flavor=true + flavors=[demo,prod] when
#      probed. `parallel --dry-run`, however, is forced no-probe/no-cache
#      unconditionally (fix(parallel): make dry-run side-effect free — no
#      gradle spawn allowed on a cold cache), so its module preview is
#      static-only there and reports has_flavor=false on a cold cache.
#
# Mirrors tests/pester/Convention-Flavors.Tests.ps1 + the vitest unit +
# runParallel integration tests (which cover the actual flavored task dispatch).

FIXTURE="tests/fixtures/convention-flavors"

setup() {
    rm -rf "$FIXTURE/.kmp-test-runner" "$FIXTURE/.kmp-test-runner-cache"
}
teardown() {
    rm -rf "$FIXTURE/.kmp-test-runner" "$FIXTURE/.kmp-test-runner-cache"
}

@test "convention-flavors: static detection alone is blind (hasFlavor false)" {
    run node --input-type=module -e "
        import path from 'node:path';
        import { buildProjectModel } from './lib/project-model.js';
        const m = buildProjectModel(path.resolve('$FIXTURE'), { skipProbe: true });
        for (const [name, mod] of Object.entries(m.modules)) {
            console.log(\`\${name}:\${mod.hasFlavor ? 'flavored' : 'blind'}\`);
        }
    "
    [ "$status" -eq 0 ]
    [[ "$output" == *":app:blind"* ]]
    [[ "$output" == *":core-foo:blind"* ]]
}

@test "convention-flavors: probe recovers flavors + classifies jacoco" {
    run node --input-type=module -e "
        import path from 'node:path';
        import { buildProjectModel } from './lib/project-model.js';
        import { effectiveHasFlavor, effectiveCoveragePlugin, effectiveFlavors } from './lib/orchestrators/orchestrator-utils.js';
        const m = buildProjectModel(path.resolve('$FIXTURE'), { skipProbe: false, useCache: false });
        for (const [name, mod] of Object.entries(m.modules)) {
            console.log(\`\${name}:\${effectiveFlavors(mod).join('+')}:\${effectiveHasFlavor(mod)}:\${effectiveCoveragePlugin(mod) ?? 'null'}\`);
        }
    "
    [ "$status" -eq 0 ]
    [[ "$output" == *":app:demo+prod:true:jacoco"* ]]
    [[ "$output" == *":core-foo:demo+prod:true:jacoco"* ]]
}

@test "convention-flavors: describe reports has_flavor true + flavors" {
    run node --input-type=module -e "
        import path from 'node:path';
        import { runDescribe } from './lib/orchestrators/describe-orchestrator.js';
        const { envelope } = runDescribe({ projectRoot: path.resolve('$FIXTURE'), args: [] });
        const app = envelope.describe.modules.find(x => x.name === ':app');
        console.log('has_flavor=' + app.has_flavor + ' flavors=' + app.flavors.join('+'));
    "
    [ "$status" -eq 0 ]
    [[ "$output" == *"has_flavor=true"* ]]
    [[ "$output" == *"flavors=demo+prod"* ]]
}

# fix(parallel): make dry-run side-effect free — resolveDryRunModules now
# calls buildProjectModel with { useCache: false, skipProbe: true } so a cold
# cache can never trigger a gradle probe spawn or a cache write. That means
# dry-run's module preview is STATIC-ONLY on a cold cache, same blind spot as
# the "static detection alone is blind" test above: has_flavor/flavors come
# back false/[] instead of the probe-recovered true/[demo,prod]. Both modules
# still correctly APPEAR in plan.modules (unlike the flavored-unit-only
# fixture, where the flavor gap also hides the module's only test source
# set) — this fixture's modules have ordinary src/test/ trees, so static
# detection still finds them as testable, just not as flavored. A warm cache
# (from a prior real run) still reads the accurate probe-recovered values.
@test "convention-flavors: parallel --dry-run plan is static-only on a cold cache (has_flavor false)" {
    run node bin/kmp-test.js parallel --project-root "$FIXTURE" --test-type androidUnit --dry-run --json
    [ "$status" -eq 0 ]
    [[ "$output" == *'"has_flavor":false'* ]]
    [[ "$output" == *'"flavors":[]'* ]]
}
