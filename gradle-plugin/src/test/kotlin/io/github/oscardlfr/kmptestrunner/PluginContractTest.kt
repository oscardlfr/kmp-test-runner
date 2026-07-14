// SPDX-License-Identifier: MIT
package io.github.oscardlfr.kmptestrunner

import io.github.oscardlfr.kmptestrunner.tasks.AndroidTestsTask
import io.github.oscardlfr.kmptestrunner.tasks.BenchmarkTestsTask
import io.github.oscardlfr.kmptestrunner.tasks.ChangedTestsTask
import io.github.oscardlfr.kmptestrunner.tasks.CoverageTask
import io.github.oscardlfr.kmptestrunner.tasks.ParallelTestsTask
import org.junit.jupiter.api.Test
import kotlin.test.assertNotNull

class PluginContractTest {

    @Test
    fun `jar contains required runtime resources`() {
        val required = listOf(
            "/lib/runner.js",
            "/lib/cli.js",
            "/lib/orchestrators/parallel-orchestrator.js",
            "/lib/orchestrators/android-orchestrator.js",
            "/lib/orchestrators/benchmark-orchestrator.js",
            "/lib/orchestrators/changed-orchestrator.js",
            "/lib/orchestrators/coverage-orchestrator.js",
            "/scripts/sh/run-parallel-coverage-suite.sh",
            "/package.json",
        )
        for (path in required) {
            assertNotNull(
                KmpTestRunnerPlugin::class.java.getResource(path),
                "Missing from plugin JAR: $path"
            )
        }
    }

    @Test
    fun `all five task classes are accessible`() {
        assertNotNull(ParallelTestsTask::class.java)
        assertNotNull(ChangedTestsTask::class.java)
        assertNotNull(AndroidTestsTask::class.java)
        assertNotNull(BenchmarkTestsTask::class.java)
        assertNotNull(CoverageTask::class.java)
    }
}
