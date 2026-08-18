// SPDX-License-Identifier: MIT
package io.github.oscardlfr.kmptestrunner

import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

/**
 * Discriminant tests for [resolveWindowsNodeExe] -- plain JUnit, no GradleRunner/TestKit, so these
 * run fast and never shell out to cmd.exe themselves. Exercises both the KMP_LOCAL_CI_NODE_EXE
 * override path (set by tools/local-ci/windows-gate.ps1) and the pure-Kotlin PATH-walk fallback
 * used when running this test standalone, outside that gate.
 */
class WindowsNodeExeResolverTest {

    @TempDir
    lateinit var tempDir: File

    private fun realNodeExe(dir: File = tempDir, name: String = "node.exe"): File =
        File(dir, name).apply { writeText("not a real binary, just needs to exist as a regular file") }

    // -------------------------------------------------------------------------
    // KMP_LOCAL_CI_NODE_EXE override -- happy path
    // -------------------------------------------------------------------------

    @Test
    fun `uses KMP_LOCAL_CI_NODE_EXE directly when it is an absolute path to a real file`() {
        val node = realNodeExe()
        val resolved = resolveWindowsNodeExe(mapOf("KMP_LOCAL_CI_NODE_EXE" to node.absolutePath))
        assertEquals(node.absolutePath, resolved)
    }

    // -------------------------------------------------------------------------
    // KMP_LOCAL_CI_NODE_EXE override -- fail-closed rejection, never a silent fallback
    // -------------------------------------------------------------------------

    @Test
    fun `rejects KMP_LOCAL_CI_NODE_EXE pointing at a path that does not exist`() {
        val missing = File(tempDir, "does-not-exist.exe").absolutePath
        assertFailsWith<IllegalStateException> {
            resolveWindowsNodeExe(mapOf("KMP_LOCAL_CI_NODE_EXE" to missing))
        }
    }

    @Test
    fun `rejects a non-absolute KMP_LOCAL_CI_NODE_EXE even if a same-named file exists on PATH`() {
        val node = realNodeExe()
        assertFailsWith<IllegalStateException> {
            resolveWindowsNodeExe(
                mapOf(
                    "KMP_LOCAL_CI_NODE_EXE" to "node.exe", // relative, not absolute
                    "PATH" to tempDir.absolutePath,
                )
            )
        }
        // Guard against the fixture itself being wrong: the file genuinely exists.
        assertEquals(true, node.isFile)
    }

    @Test
    fun `rejects KMP_LOCAL_CI_NODE_EXE pointing at a directory, not a regular file`() {
        val dirAsNode = File(tempDir, "node.exe").apply { mkdir() }
        assertFailsWith<IllegalStateException> {
            resolveWindowsNodeExe(mapOf("KMP_LOCAL_CI_NODE_EXE" to dirAsNode.absolutePath))
        }
    }

    // -------------------------------------------------------------------------
    // No override -- pure-Kotlin PATH walk, no cmd.exe
    // -------------------------------------------------------------------------

    @Test
    fun `falls back to walking PATH for node exe when KMP_LOCAL_CI_NODE_EXE is not set`() {
        val node = realNodeExe()
        val otherDir = File(tempDir, "other").apply { mkdir() }
        val resolved = resolveWindowsNodeExe(
            mapOf("PATH" to "${otherDir.absolutePath}${File.pathSeparator}${tempDir.absolutePath}")
        )
        assertEquals(node.absolutePath, resolved)
    }

    @Test
    fun `PATH walk finds the PATH key case-insensitively (Windows may use Path, not PATH)`() {
        val node = realNodeExe()
        val resolved = resolveWindowsNodeExe(mapOf("Path" to tempDir.absolutePath))
        assertEquals(node.absolutePath, resolved)
    }

    @Test
    fun `fails closed when KMP_LOCAL_CI_NODE_EXE is absent and no node exe is anywhere on PATH`() {
        val emptyDir = File(tempDir, "empty").apply { mkdir() }
        assertFailsWith<IllegalStateException> {
            resolveWindowsNodeExe(mapOf("PATH" to emptyDir.absolutePath))
        }
    }
}
