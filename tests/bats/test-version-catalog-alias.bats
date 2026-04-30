#!/usr/bin/env bats
# v0.6.x Gap 3 — fixture-driven verification of alias(libs.plugins.<X>)
# module-type detection against tests/fixtures/version-catalog-alias-plugins/.
#
# Pre-fix every module here classified as `unknown` because analyzeModule's
# regex only matched the literal `id()` and `kotlin()` plugin forms. Post-fix
# the version catalog (or the suffix heuristic) resolves alias(...) calls to
# their real plugin ids, which then participate in type classification.

FIXTURE="tests/fixtures/version-catalog-alias-plugins"

setup() {
    rm -rf "$FIXTURE/.kmp-test-runner-cache"
}

teardown() {
    rm -rf "$FIXTURE/.kmp-test-runner-cache"
}

# Build the model JSON (skipProbe — no gradle invocation needed) and emit
# per-module summary lines: <module>:type=<t>
_dump_module_types() {
    node --input-type=module -e "
        import { buildProjectModel } from './lib/project-model.js';
        const m = buildProjectModel('$FIXTURE', { skipProbe: true });
        for (const [name, mod] of Object.entries(m.modules)) {
            console.log(\`\${name}:type=\${mod.type}\`);
        }
    "
}

@test "alias(libs.plugins.android.application) classifies :app as android (TOML resolved)" {
    run _dump_module_types
    [ "$status" -eq 0 ]
    [[ "$output" == *":app:type=android"* ]]
}

@test "alias(libs.plugins.kotlin.multiplatform) classifies :shared as kmp (TOML resolved)" {
    run _dump_module_types
    [ "$status" -eq 0 ]
    [[ "$output" == *":shared:type=kmp"* ]]
}

@test "alias(libs.plugins.kotlin.jvm) classifies :jvm-lib as jvm (TOML string-form resolved)" {
    run _dump_module_types
    [ "$status" -eq 0 ]
    [[ "$output" == *":jvm-lib:type=jvm"* ]]
}

@test "namespaced alias key (libs.plugins.nowinandroid.android.application) resolves heuristically to android" {
    run _dump_module_types
    [ "$status" -eq 0 ]
    [[ "$output" == *":namespaced-app:type=android"* ]]
}
