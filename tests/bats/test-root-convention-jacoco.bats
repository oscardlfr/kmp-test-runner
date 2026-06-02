#!/usr/bin/env bats
# v0.10.2 Bug 1 — root-convention JaCoCo classification, end-to-end.
#
# The root-convention-jacoco fixture applies JaCoCo via a ROOT build.gradle.kts
# `subprojects { apply(plugin = "jacoco") }` block — neither core-foo nor
# core-bar references jacoco in its OWN build file. So:
#   1. STATIC detection alone (skipProbe) sees nothing → coveragePlugin: null.
#      This locks the Bug-1 root cause.
#   2. The `gradlew tasks --all` probe (here a fake gradlew emitting canned
#      jacocoTestReport lines) populates resolved.coverageTask, and
#      effectiveCoveragePlugin upgrades the classification to jacoco.
#   3. `kmp-test describe` aggregates it to a project-wide coverage_tool: jacoco.
#
# Mirrors tests/pester/Root-Convention-Jacoco.Tests.ps1 and the vitest unit
# tests — any regression in the probe-backed classifier breaks all three.

FIXTURE="tests/fixtures/root-convention-jacoco"

setup() {
    rm -rf "$FIXTURE/.kmp-test-runner" "$FIXTURE/.kmp-test-runner-cache"
}
teardown() {
    rm -rf "$FIXTURE/.kmp-test-runner" "$FIXTURE/.kmp-test-runner-cache"
}

@test "root-convention: static detection alone sees no coverage (coveragePlugin null)" {
    run node --input-type=module -e "
        import path from 'node:path';
        import { buildProjectModel } from './lib/project-model.js';
        // Resolve to absolute, like the CLI / runDescribe do (relative paths
        // break the gradlew probe's child-cwd resolution).
        const m = buildProjectModel(path.resolve('$FIXTURE'), { skipProbe: true });
        for (const [name, mod] of Object.entries(m.modules)) {
            console.log(\`\${name}:\${mod.coveragePlugin === null ? 'null' : mod.coveragePlugin}\`);
        }
    "
    [ "$status" -eq 0 ]
    [[ "$output" == *":core-foo:null"* ]]
    [[ "$output" == *":core-bar:null"* ]]
}

@test "root-convention: probe-backed effectiveCoveragePlugin classifies jacoco" {
    run node --input-type=module -e "
        import path from 'node:path';
        import { buildProjectModel } from './lib/project-model.js';
        import { effectiveCoveragePlugin } from './lib/orchestrators/orchestrator-utils.js';
        const m = buildProjectModel(path.resolve('$FIXTURE'), { skipProbe: false, useCache: false });
        for (const [name, mod] of Object.entries(m.modules)) {
            console.log(\`\${name}:\${effectiveCoveragePlugin(mod) ?? 'null'}\`);
        }
    "
    [ "$status" -eq 0 ]
    [[ "$output" == *":core-foo:jacoco"* ]]
    [[ "$output" == *":core-bar:jacoco"* ]]
}

@test "root-convention: describe envelope reports project-wide coverage_tool jacoco" {
    run node --input-type=module -e "
        import { runDescribe } from './lib/orchestrators/describe-orchestrator.js';
        const { envelope } = runDescribe({ projectRoot: '$FIXTURE', args: [] });
        console.log('coverage_tool=' + envelope.describe.coverage_tool);
    "
    [ "$status" -eq 0 ]
    [[ "$output" == *"coverage_tool=jacoco"* ]]
}
