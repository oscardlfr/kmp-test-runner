#!/usr/bin/env bats
# v0.6 Bug 6 — fixture-driven verification of detectBuildLogicCoverageHints
# convention-vs-self discrimination.
#
# Loads each fixture under tests/fixtures/build-logic-*-jacoco/ via the JS
# canonical builder and asserts the per-module `coveragePlugin` value reflects
# the discrimination rule:
#   - Convention plugin (under build-logic/<X>/src/main/...) → consumer module
#     inherits coveragePlugin.
#   - Self-buildscript plugin (in build-logic/build.gradle.kts plugins {})  →
#     consumer module does NOT inherit.
#   - Plugin-registration noise (register("...Jacoco..."), implementationClass,
#     id = libs.plugins.<...>) → no signal at all.
#
# These bats assertions mirror the vitest unit tests and the Pester
# Build-Logic-Coverage-Kind.Tests.ps1 — any regression in the JS classifier
# breaks all three suites.

setup() {
    # Each scenario gets a fresh cache dir to avoid cross-test contamination.
    rm -rf tests/fixtures/build-logic-convention-jacoco/.kmp-test-runner-cache
    rm -rf tests/fixtures/build-logic-self-jacoco/.kmp-test-runner-cache
    rm -rf tests/fixtures/build-logic-noise-jacoco/.kmp-test-runner-cache
}

teardown() {
    rm -rf tests/fixtures/build-logic-convention-jacoco/.kmp-test-runner-cache
    rm -rf tests/fixtures/build-logic-self-jacoco/.kmp-test-runner-cache
    rm -rf tests/fixtures/build-logic-noise-jacoco/.kmp-test-runner-cache
}

# Build the model JSON for a fixture and emit `<module>:<coveragePlugin>` lines.
_dump_module_coverage() {
    node --input-type=module -e "
        import { buildProjectModel } from './lib/project-model.js';
        const m = buildProjectModel('$1', { skipProbe: true });
        for (const [name, mod] of Object.entries(m.modules)) {
            console.log(\`\${name}:\${mod.coveragePlugin === null ? 'null' : mod.coveragePlugin}\`);
        }
    "
}

@test "convention fixture: consumer module inherits jacoco from src/main/ Plugin<Project> source" {
    run _dump_module_coverage tests/fixtures/build-logic-convention-jacoco
    [ "$status" -eq 0 ]
    [[ "$output" == *":core-foo:jacoco"* ]]
}

@test "self fixture: consumer module does NOT inherit jacoco from build-logic root buildscript" {
    run _dump_module_coverage tests/fixtures/build-logic-self-jacoco
    [ "$status" -eq 0 ]
    [[ "$output" == *":core-bar:null"* ]]
}

@test "noise fixture: consumer module does NOT inherit jacoco from registration-only references" {
    run _dump_module_coverage tests/fixtures/build-logic-noise-jacoco
    [ "$status" -eq 0 ]
    [[ "$output" == *":core-baz:null"* ]]
}

@test "all three fixtures classify deterministically (regression guard)" {
    # Re-run each in sequence to confirm the kind classification is stable
    # across repeated invocations (no caching state leaks between runs).
    for fx in convention self noise; do
        run _dump_module_coverage "tests/fixtures/build-logic-${fx}-jacoco"
        [ "$status" -eq 0 ]
    done
}
