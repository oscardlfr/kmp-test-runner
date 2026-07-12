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
     * Windows: creates node.bat so cmd.exe-routed invocations find it via PATHEXT.
     * Injects KMP_NODE_LAUNCHER="cmd.exe /c node" so buildNodeCommand gates through
     * cmd.exe — otherwise CreateProcess skips PATHEXT and node.bat is invisible.
     */
    private fun createWindowsShim(logFile: File): Map<String, String> {
        val realNode = ProcessBuilder(listOf("cmd.exe", "/c", "where node"))
            .start().inputStream.bufferedReader().readLine()?.trim()
            ?: error("Cannot locate node.exe on PATH")
        val recorderJs = createRecorderJs(shimDir)
        File(shimDir, "node.bat").writeText(
            "@echo off\r\n" +
            "\"$realNode\" \"${recorderJs.absolutePath}\" %*\r\n" +
            "exit /b 0\r\n"
        )
        return buildShimEnv(logFile).toMutableMap().also {
            it["KMP_NODE_LAUNCHER"] = "cmd.exe /c node"
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

    private fun writeMinimalProject() {
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
    // Cross-platform smoke (real node, task expected to fail)
    // -------------------------------------------------------------------------

    @Test
    fun `benchmarkTests TaskAction fires and reports runner error (smoke)`() {
        writeMinimalProject()

        val result = GradleRunner.create()
            .withProjectDir(projectDir)
            .withTestKitDir(testKitDir)
            .withArguments("benchmarkTests")
            .withGradleVersion("7.6.1")
            .buildAndFail()

        assertEquals(TaskOutcome.FAILED, result.task(":benchmarkTests")?.outcome)
        assertTrue("[benchmarkTests]" in result.output,
            "Expected task error prefix in output:\n${result.output}")
    }
}
