// SPDX-License-Identifier: MIT
package io.github.oscardlfr.kmptestrunner

import org.gradle.testkit.runner.GradleRunner
import org.gradle.testkit.runner.TaskOutcome
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.CleanupMode
import org.junit.jupiter.api.io.TempDir
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.Arguments
import org.junit.jupiter.params.provider.MethodSource
import java.io.File
import java.util.stream.Stream
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Resolves the real node.exe for TaskActionTest's Windows shim without ever shelling out to
 * cmd.exe: on hosts where a child cmd.exe process inherits an empty PATH regardless of the
 * caller's own environment, the previous `cmd.exe /c where node` discovery failed outright.
 * `KMP_LOCAL_CI_NODE_EXE` (set by
 * tools/local-ci/windows-gate.ps1 to the already-validated node24 path) is used when present and
 * is REQUIRED to be valid -- an invalid override is a configuration bug in the caller and must
 * fail closed, not silently fall through to the PATH walk. When the variable is absent entirely
 * (e.g. running this test directly from an IDE, outside windows-gate.ps1), falls back to a pure
 * Kotlin walk of PATH for a regular `node.exe` file -- still no cmd.exe involved.
 */
internal fun resolveWindowsNodeExe(env: Map<String, String>): String {
    val override = env["KMP_LOCAL_CI_NODE_EXE"]
    if (override != null) {
        val f = File(override)
        if (!f.isAbsolute) error("KMP_LOCAL_CI_NODE_EXE must be an absolute path, got: $override")
        if (!f.isFile) error("KMP_LOCAL_CI_NODE_EXE does not point to an existing regular file: $override")
        return f.absolutePath
    }
    val pathKey = env.keys.firstOrNull { it.equals("PATH", ignoreCase = true) } ?: "PATH"
    for (dir in env[pathKey].orEmpty().split(File.pathSeparator)) {
        if (dir.isBlank()) continue
        val candidate = File(dir, "node.exe")
        if (candidate.isFile) return candidate.absolutePath
    }
    error("Cannot locate node.exe: KMP_LOCAL_CI_NODE_EXE is not set and no node.exe was found on PATH")
}

class TaskActionTest {

    @TempDir lateinit var projectDir: File
    // CleanupMode.NEVER: Gradle Tooling API always starts a daemon in testKitDir
    // that holds file locks on Windows. JUnit 5 cannot delete a live daemon's files.
    @TempDir(cleanup = CleanupMode.NEVER) lateinit var testKitDir: File
    @TempDir lateinit var shimDir: File

    // -------------------------------------------------------------------------
    // Shim infrastructure
    // -------------------------------------------------------------------------

    private val isWindows = File.separator == "\\"

    private fun createRecorderJs(dir: File): File =
        File(dir, "node-recorder.js").also {
            it.writeText(
                "const fs = require('fs');\n" +
                "const log = process.env.KMP_SHIM_LOG;\n" +
                "if (log) fs.appendFileSync(log, process.argv.slice(2).join('\\0') + '\\n');\n" +
                "process.exit(0);\n"
            )
        }

    /** POSIX: shell script named 'node' that delegates to the real node with our recorder. */
    private fun createPosixShim(logFile: File): Map<String, String> {
        val realNode = ProcessBuilder(listOf("sh", "-c", "which node"))
            .start().inputStream.bufferedReader().readLine()?.trim()
            ?: error("Cannot locate node on PATH")
        val recorderJs = createRecorderJs(shimDir)
        File(shimDir, "node").apply {
            writeText("#!/bin/sh\n\"$realNode\" \"${recorderJs.absolutePath}\" \"\$@\"\n")
            setExecutable(true)
        }
        return buildShimEnv(logFile)
    }

    /**
     * Windows: points KMP_NODE_LAUNCHER directly at the real, already-resolved node.exe (a single
     * executable, no .bat, no cmd.exe -- resolveNodeCommand treats it as one argv element).
     * Recording argv no longer needs a node.bat intermediary: NODE_OPTIONS preloads the recorder
     * via `--require`, which runs (and, since it calls process.exit(0), terminates the process)
     * BEFORE the real runnerPath entry script ever starts -- process.argv is unaffected by
     * --require preloading, so the recorder's existing process.argv.slice(2) read is unchanged.
     * A single explicit assignment (not an append) so this fixture's own preload is never
     * accidentally combined with an inherited ambient NODE_OPTIONS from the calling environment.
     * NODE_OPTIONS's own parser treats backslash as an escape character (confirmed directly: a
     * raw Windows path here silently lost every backslash, producing an unresolvable module path)
     * -- forward slashes are used instead, which Windows/Node accept interchangeably in paths.
     */
    private fun createWindowsShim(logFile: File): Map<String, String> {
        val realNode = resolveWindowsNodeExe(System.getenv())
        val recorderJs = createRecorderJs(shimDir)
        val recorderJsForNodeOptions = recorderJs.absolutePath.replace('\\', '/')
        return buildShimEnv(logFile).toMutableMap().also {
            it["KMP_NODE_LAUNCHER"] = realNode
            it["NODE_OPTIONS"] = "--require \"$recorderJsForNodeOptions\""
        }
    }

    private fun buildShimEnv(logFile: File): Map<String, String> {
        val env = System.getenv().toMutableMap()
        // Windows may use "Path" (not "PATH") — find the actual key case-insensitively
        val pathKey = env.keys.firstOrNull { it.equals("PATH", ignoreCase = true) } ?: "PATH"
        env[pathKey] = "${shimDir.absolutePath}${File.pathSeparator}${env[pathKey].orEmpty()}"
        env["KMP_SHIM_LOG"] = logFile.absolutePath
        return env
    }

    // -------------------------------------------------------------------------
    // Minimal project helper
    // -------------------------------------------------------------------------

    // extraBuildScript appends to build.gradle.kts, e.g. a `kmpTestRunner { }`
    // extension-configuration block a specific test needs beyond the bare
    // `plugins {}` block every other test uses.
    private fun writeMinimalProject(extraBuildScript: String = "") {
        val testMavenRepo = System.getProperty("test.maven.repo")
            ?: error("test.maven.repo system property not set")
        val pluginVersion = System.getProperty("plugin.version")
            ?: error("plugin.version system property not set")
        projectDir.resolve("settings.gradle.kts").writeText(
            """
            pluginManagement {
                repositories {
                    maven { url = uri("$testMavenRepo") }
                    gradlePluginPortal()
                }
            }
            rootProject.name = "task-action-test"
            """.trimIndent()
        )
        projectDir.resolve("build.gradle.kts").writeText(
            """
            plugins {
                id("io.github.oscardlfr.kmp-test-runner") version "$pluginVersion"
            }
            $extraBuildScript
            """.trimIndent()
        )
    }

    // -------------------------------------------------------------------------
    // Parameterized arg-recording tests (POSIX + Windows)
    // -------------------------------------------------------------------------

    @ParameterizedTest
    @MethodSource("taskAndSubcommand")
    fun `TaskAction records correct subcommand and project-root flag`(
        taskName: String,
        expectedSubcommand: String
    ) {
        writeMinimalProject()
        val logFile = File(testKitDir, "$taskName.log")
        val env = if (isWindows) createWindowsShim(logFile) else createPosixShim(logFile)

        GradleRunner.create()
            .withProjectDir(projectDir)
            .withTestKitDir(testKitDir)
            .withEnvironment(env)
            .withArguments(taskName)
            .withGradleVersion("9.1.0")
            .build()

        val recorded = logFile.readText()
        assertTrue(expectedSubcommand in recorded,
            "Expected subcommand '$expectedSubcommand' in recorded args:\n$recorded")
        assertTrue("--project-root" in recorded,
            "Expected --project-root flag in recorded args:\n$recorded")
    }

    @ParameterizedTest
    @MethodSource("taskAndSubcommand")
    fun `TaskAction records correct subcommand on Gradle 7 6 1 (declared minimum)`(
        taskName: String,
        expectedSubcommand: String
    ) {
        writeMinimalProject()
        val logFile = File(testKitDir, "${taskName}-76.log")
        val env = if (isWindows) createWindowsShim(logFile) else createPosixShim(logFile)

        GradleRunner.create()
            .withProjectDir(projectDir)
            .withTestKitDir(testKitDir)
            .withEnvironment(env)
            .withArguments(taskName)
            .withGradleVersion("7.6.1")
            .build()

        val recorded = logFile.readText()
        assertTrue(expectedSubcommand in recorded,
            "Expected '$expectedSubcommand' in args under Gradle 7.6.1:\n$recorded")
    }

    companion object {
        @JvmStatic
        fun taskAndSubcommand(): Stream<Arguments> = Stream.of(
            Arguments.of("parallelTests",  "parallel"),
            Arguments.of("changedTests",   "changed"),
            Arguments.of("androidTests",   "android"),
            Arguments.of("benchmarkTests", "benchmark"),
            Arguments.of("coverageTask",   "coverage"),
        )

        // The 4 tasks whose smoke-test failure trigger is uniform: a project
        // with zero testable modules is a real, task-specific error for all
        // four (see each task's own error text). coverageTask is excluded —
        // it treats zero contributing modules as a legitimate no-op success,
        // so its smoke test needs a different fixture; see its own @Test.
        @JvmStatic
        fun uniformSmokeTestTasks(): Stream<String> =
            Stream.of("benchmarkTests", "parallelTests", "changedTests", "androidTests")
    }

    // -------------------------------------------------------------------------
    // Configuration-cache store/reuse
    // -------------------------------------------------------------------------

    @Test
    fun `configuration cache stores and is reused for benchmarkTests`() {
        writeMinimalProject()
        val logFile = File(testKitDir, "cc-bench.log")
        val env = if (isWindows) createWindowsShim(logFile) else createPosixShim(logFile)

        val runner = GradleRunner.create()
            .withProjectDir(projectDir)
            .withTestKitDir(testKitDir)
            .withEnvironment(env)
            .withArguments("benchmarkTests", "--configuration-cache")
            .withGradleVersion("9.1.0")

        val r1 = runner.build()
        assertTrue("Configuration cache entry stored" in r1.output,
            "Expected CC entry to be stored on first run")

        val r2 = runner.build()
        assertTrue("Reusing configuration cache" in r2.output,
            "Expected CC entry to be reused on second run")
    }

    // -------------------------------------------------------------------------
    // Cross-platform smoke (real node, task expected to fail). Each proves the
    // ExecOperations-based runner spawn (RuntimeExtractor.runNodeRunner)
    // correctly propagates a real non-zero runner exit code into a Gradle
    // TaskOutcome.FAILED — closing a false-green gap where these tasks could
    // report BUILD SUCCESSFUL with zero output regardless of what the spawned
    // runner actually returned (traced to lib/runner.js's own entrypoint
    // guard, not to the process-spawning API — see isRunnerEntrypoint).
    // -------------------------------------------------------------------------

    @ParameterizedTest
    @MethodSource("uniformSmokeTestTasks")
    fun `TaskAction fires and reports runner error (smoke)`(taskName: String) {
        writeMinimalProject()

        val result = GradleRunner.create()
            .withProjectDir(projectDir)
            .withTestKitDir(testKitDir)
            .withArguments(taskName)
            .withGradleVersion("7.6.1")
            .buildAndFail()

        assertEquals(TaskOutcome.FAILED, result.task(":$taskName")?.outcome)
        assertTrue("[$taskName]" in result.output,
            "Expected task error prefix in output:\n${result.output}")
    }

    // coverageTask treats zero contributing modules as a legitimate no-op
    // success (nothing to aggregate), so the shared zero-module fixture above
    // can't exercise its failure path. An invalid `coverageTool` extension
    // value forces a real CLI-level rejection (exit 2) instead.
    //
    // Gradle version: 9.1.0, not 7.6.1 like the other 4 smoke tests. The
    // `kmpTestRunner { ... }` extension-configuration block this needs (to
    // set the bad coverageTool) makes Gradle's Kotlin DSL script compiler do
    // real work beyond the bare `plugins {}` block the other fixtures use —
    // Gradle 7.6.1's bundled DSL compiler hits a real (separate, unrelated)
    // protobuf/JDK-23 incompatibility on that heavier compilation path
    // (`InvalidProtocolBufferException: Protocol message contained an
    // invalid tag`), independent of the entrypoint-guard fix under test here.
    // The pre-existing parameterized shim tests above already cover
    // coverageTask's success path under both 7.6.1 and 9.1.0.
    @Test
    fun `coverageTask TaskAction fires and reports runner error (smoke)`() {
        writeMinimalProject(
            """
            kmpTestRunner {
                coverageTool = "not-a-real-tool"
            }
            """.trimIndent()
        )

        val result = GradleRunner.create()
            .withProjectDir(projectDir)
            .withTestKitDir(testKitDir)
            .withArguments("coverageTask")
            .withGradleVersion("9.1.0")
            .buildAndFail()

        assertEquals(TaskOutcome.FAILED, result.task(":coverageTask")?.outcome)
        assertTrue("[coverageTask]" in result.output,
            "Expected task error prefix in output:\n${result.output}")
    }
}
