#!/usr/bin/env bats
# Groovy Gradle DSL support — end-to-end discovery + classification + dispatch.
#
# The groovy-dsl fixture uses Groovy `settings.gradle` (`include ':app'` plus
# the multi-arg `include ':core-lib', ':data'`) and Groovy module `build.gradle`
# files: legacy `apply plugin: 'com.android.library'`, a `plugins { id ... }`
# kotlin.jvm block, and a short-id `apply plugin: 'kotlin-android'`. The tool
# must discover all three modules and classify android / jvm / android, then
# plan the Android modules for an androidUnit run.
#
# Mirrors tests/pester/Groovy-Dsl.Tests.ps1 + the vitest unit tests.

FIXTURE="tests/fixtures/groovy-dsl"

setup() {
    rm -rf "$FIXTURE/.kmp-test-runner" "$FIXTURE/.kmp-test-runner-cache"
}
teardown() {
    rm -rf "$FIXTURE/.kmp-test-runner" "$FIXTURE/.kmp-test-runner-cache"
}

@test "groovy-dsl: discovers Groovy modules and classifies types" {
    run node --input-type=module -e "
        import path from 'node:path';
        import { buildProjectModel } from './lib/project-model.js';
        const m = buildProjectModel(path.resolve('$FIXTURE'), { skipProbe: true, useCache: false });
        for (const [name, mod] of Object.entries(m.modules)) console.log(\`\${name}:\${mod.type}\`);
    "
    [ "$status" -eq 0 ]
    [[ "$output" == *":app:android"* ]]
    [[ "$output" == *":core-lib:jvm"* ]]
    [[ "$output" == *":data:android"* ]]
}

@test "groovy-dsl: describe enumerates all three Groovy modules" {
    run node --input-type=module -e "
        import path from 'node:path';
        import { runDescribe } from './lib/orchestrators/describe-orchestrator.js';
        const { envelope } = runDescribe({ projectRoot: path.resolve('$FIXTURE'), args: [] });
        console.log(envelope.describe.modules.map(x => x.name).sort().join(','));
    "
    [ "$status" -eq 0 ]
    [[ "$output" == *":app,:core-lib,:data"* ]]
}

@test "groovy-dsl: parallel --dry-run plans the Android modules" {
    run node bin/kmp-test.js parallel --project-root "$FIXTURE" --test-type androidUnit --dry-run --json
    [ "$status" -eq 0 ]
    [[ "$output" == *'"name":"app","type":"android"'* ]]
    [[ "$output" == *'"name":"data","type":"android"'* ]]
}
