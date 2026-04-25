// SPDX-License-Identifier: Apache-2.0
package io.github.oscardlfr.kmptestrunner

import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.MethodSource
import java.util.stream.Stream
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class CrossShapeParityTest {

    private data class NpmCmd(val script: String, val flags: List<String>)
    private data class GradleTask(val scriptResource: String, val flags: List<String>)

    private val npmShape: Map<String, NpmCmd> = mapOf(
        "parallel"    to NpmCmd(script = "run-parallel-coverage-suite.sh", flags = listOf("--project-root")),
        "changed"     to NpmCmd(script = "run-changed-modules-tests.sh",   flags = listOf("--project-root")),
        "android"     to NpmCmd(script = "run-android-tests.sh",            flags = listOf("--project-root")),
        "benchmark"   to NpmCmd(script = "run-benchmarks.sh",               flags = listOf("--project-root")),
        "coverage"    to NpmCmd(script = "run-parallel-coverage-suite.sh",  flags = listOf("--project-root", "--skip-tests")),
    )

    private val gradleShape: Map<String, GradleTask> = mapOf(
        "parallelTests"   to GradleTask(scriptResource = "/scripts/sh/run-parallel-coverage-suite.sh", flags = listOf("--project-root")),
        "changedTests"    to GradleTask(scriptResource = "/scripts/sh/run-changed-modules-tests.sh",   flags = listOf("--project-root")),
        "androidTests"    to GradleTask(scriptResource = "/scripts/sh/run-android-tests.sh",           flags = listOf("--project-root")),
        "benchmarkTests"  to GradleTask(scriptResource = "/scripts/sh/run-benchmarks.sh",              flags = listOf("--project-root")),
        "coverageTask"    to GradleTask(scriptResource = "/scripts/sh/run-parallel-coverage-suite.sh", flags = listOf("--project-root", "--skip-tests")),
    )

    companion object {
        @JvmStatic
        fun pairProvider(): Stream<Array<String>> = Stream.of(
            arrayOf("parallel",  "parallelTests"),
            arrayOf("changed",   "changedTests"),
            arrayOf("android",   "androidTests"),
            arrayOf("benchmark", "benchmarkTests"),
            arrayOf("coverage",  "coverageTask"),
        )
    }

    @ParameterizedTest
    @MethodSource("pairProvider")
    fun `parity per pair`(npmCmd: String, gradleTask: String) {
        val n = npmShape.getValue(npmCmd)
        val g = gradleShape.getValue(gradleTask)

        assertEquals(
            n.script,
            g.scriptResource.substringAfterLast('/'),
            "Cross-shape parity: $npmCmd ↔ $gradleTask script basenames diverge"
        )
        assertTrue("--project-root" in n.flags, "npm $npmCmd missing --project-root")
        assertTrue("--project-root" in g.flags, "Gradle $gradleTask missing --project-root")
        if (npmCmd == "coverage") {
            assertTrue("--skip-tests" in n.flags, "npm coverage missing --skip-tests")
            assertTrue("--skip-tests" in g.flags, "Gradle coverageTask missing --skip-tests")
        }
    }
}
