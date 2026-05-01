// SPDX-License-Identifier: MIT
package io.github.oscardlfr.kmptestrunner

import org.gradle.testkit.runner.GradleRunner
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.CleanupMode
import org.junit.jupiter.api.io.TempDir
import java.io.File
import kotlin.test.assertEquals
import kotlin.test.assertNotNull

/**
 * v0.7.0 Phase 3 — verify the new `testType` extension property is accepted
 * at the DSL level for all relevant test-types (incl. "ios" and "macos") and
 * propagates correctly through plugin task registration. Runtime arg
 * propagation to the bundled wrapper scripts is covered by the bats / Pester
 * suites under tests/{bats,pester}/test-parallel-ios-dispatch.*.
 */
class TestTypeExtensionTest {
    @TempDir(cleanup = CleanupMode.NEVER)
    lateinit var projectDir: File

    @TempDir(cleanup = CleanupMode.NEVER)
    lateinit var testKitDir: File

    @Test
    fun `extension defaults testType to empty string (auto-detect)`() {
        val ext = KmpTestRunnerExtension()
        assertEquals("", ext.testType, "testType should default to empty (wrapper auto-detects)")
    }

    @Test
    fun `extension accepts testType = ios without DSL error`() {
        val pluginVersion = System.getProperty("plugin.version")
            ?: error("plugin.version system property not set — did the build script wire it up?")
        projectDir.resolve("settings.gradle.kts").writeText(
            """
            pluginManagement {
                repositories {
                    mavenLocal()
                    gradlePluginPortal()
                    google()
                    mavenCentral()
                }
            }
            rootProject.name = "test-ios-test-type"
            """.trimIndent()
        )
        projectDir.resolve("build.gradle.kts").writeText(
            """
            plugins {
                id("io.github.oscardlfr.kmp-test-runner") version "$pluginVersion"
            }
            kmpTestRunner {
                projectRoot = rootDir.absolutePath
                testType = "ios"
            }
            """.trimIndent()
        )

        val result = GradleRunner.create()
            .withProjectDir(projectDir)
            .withTestKitDir(testKitDir)
            .withArguments("tasks", "--all")
            .build()

        // DSL parsed without error AND the parallelTests task is still registered.
        assertNotNull(
            result.output.lines().find { it.startsWith("parallelTests") },
            "parallelTests task should be registered even with testType=ios"
        )
    }

    @Test
    fun `extension accepts testType = macos without DSL error`() {
        val pluginVersion = System.getProperty("plugin.version")
            ?: error("plugin.version system property not set — did the build script wire it up?")
        projectDir.resolve("settings.gradle.kts").writeText(
            """
            pluginManagement {
                repositories {
                    mavenLocal()
                    gradlePluginPortal()
                    google()
                    mavenCentral()
                }
            }
            rootProject.name = "test-macos-test-type"
            """.trimIndent()
        )
        projectDir.resolve("build.gradle.kts").writeText(
            """
            plugins {
                id("io.github.oscardlfr.kmp-test-runner") version "$pluginVersion"
            }
            kmpTestRunner {
                projectRoot = rootDir.absolutePath
                testType = "macos"
            }
            """.trimIndent()
        )

        val result = GradleRunner.create()
            .withProjectDir(projectDir)
            .withTestKitDir(testKitDir)
            .withArguments("tasks", "--all")
            .build()

        assertNotNull(
            result.output.lines().find { it.startsWith("changedTests") },
            "changedTests task should be registered even with testType=macos"
        )
        assertNotNull(
            result.output.lines().find { it.startsWith("coverageTask") },
            "coverageTask task should be registered even with testType=macos"
        )
    }
}
