// SPDX-License-Identifier: MIT
package io.github.oscardlfr.kmptestrunner

import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * Discriminant tests for [resolveNodeCommand] (the pure logic behind [buildNodeCommand]'s
 * KMP_NODE_LAUNCHER hook) and a real-environment regression guard for [buildNodeCommand] itself.
 */
class BuildNodeCommandTest {

    @Test
    fun `no launcher produces exactly node, runnerPath, extra args in order`() {
        assertEquals(
            listOf("node", "runner.js", "--flag", "value"),
            resolveNodeCommand(null, "runner.js", "--flag", "value"),
        )
    }

    @Test
    fun `an empty-string launcher is treated the same as no launcher`() {
        assertEquals(
            listOf("node", "runner.js"),
            resolveNodeCommand("", "runner.js"),
        )
    }

    @Test
    fun `a launcher path containing spaces stays a single argv element, never split on whitespace`() {
        val launcher = "C:\\Program Files\\nodejs\\node.exe"
        assertEquals(
            listOf(launcher, "runner.js", "--flag"),
            resolveNodeCommand(launcher, "runner.js", "--flag"),
        )
    }

    @Test
    fun `a launcher with no extra args produces launcher followed by only runnerPath`() {
        assertEquals(
            listOf("/usr/bin/node", "runner.js"),
            resolveNodeCommand("/usr/bin/node", "runner.js"),
        )
    }

    @Test
    fun `buildNodeCommand against this JVM's real (unset) environment matches the production default`() {
        // The `test` task itself never sets KMP_NODE_LAUNCHER -- only TaskActionTest's nested
        // GradleRunner invocations set it, in a CHILD process's own environment, never this one.
        assertNull(System.getenv("KMP_NODE_LAUNCHER"))
        assertEquals(listOf("node", "runner.js", "x"), buildNodeCommand("runner.js", "x"))
    }
}
