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
 * Verify the `captureOnFail` / `captureDir` extension properties (--capture-on-fail
 * for `kmp-test android`) are accepted at the DSL level and that the
 * `androidTests` task still registers when they are set. Runtime arg propagation
 * to the bundled runner is unit-tested Node-side
 * (tests/vitest/android-orchestrator.test.js); the on-device behaviour is
 * validated manually (no device in CI). Mirrors TestTypeExtensionTest.
 */
class CaptureOnFailExtensionTest {
    @TempDir(cleanup = CleanupMode.NEVER)
    lateinit var projectDir: File

    @TempDir(cleanup = CleanupMode.NEVER)
    lateinit var testKitDir: File

    @Test
    fun `extension defaults captureOnFail to false and captureDir to empty`() {
        val ext = KmpTestRunnerExtension()
        assertEquals(false, ext.captureOnFail, "captureOnFail should default to false (opt-in)")
        assertEquals("", ext.captureDir, "captureDir should default to empty")
    }

    @Test
    fun `extension accepts captureOnFail and captureDir without DSL error`() {
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
            rootProject.name = "test-capture-on-fail"
            """.trimIndent()
        )
        projectDir.resolve("build.gradle.kts").writeText(
            """
            plugins {
                id("io.github.oscardlfr.kmp-test-runner") version "$pluginVersion"
            }
            kmpTestRunner {
                projectRoot = rootDir.absolutePath
                captureOnFail = true
                captureDir = "build/kmp-captures"
            }
            """.trimIndent()
        )

        val result = GradleRunner.create()
            .withProjectDir(projectDir)
            .withTestKitDir(testKitDir)
            .withArguments("tasks", "--all")
            .build()

        // DSL parsed without error AND the androidTests task is still registered.
        assertNotNull(
            result.output.lines().find { it.startsWith("androidTests") },
            "androidTests task should be registered with captureOnFail set"
        )
    }
}
