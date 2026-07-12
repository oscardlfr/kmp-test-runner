// SPDX-License-Identifier: MIT
package io.github.oscardlfr.kmptestrunner

import org.gradle.testkit.runner.GradleRunner
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.CleanupMode
import org.junit.jupiter.api.io.TempDir
import java.io.File
import kotlin.test.assertEquals
import kotlin.test.assertNotNull

class CaptureOnFailExtensionTest {
    @TempDir
    lateinit var projectDir: File

    // CleanupMode.NEVER: Gradle Tooling API always starts a daemon in testKitDir
    // that holds file locks on Windows. JUnit 5 cannot delete a live daemon's files.
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
            ?: error("plugin.version system property not set")
        val testMavenRepo = System.getProperty("test.maven.repo")
            ?: error("test.maven.repo system property not set")
        projectDir.resolve("settings.gradle.kts").writeText(
            """
            pluginManagement {
                repositories {
                    maven { url = uri("$testMavenRepo") }
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

        assertNotNull(
            result.output.lines().find { it.startsWith("androidTests") },
            "androidTests task should be registered with captureOnFail set"
        )
        assertNotNull(
            result.output.lines().find { it.startsWith("parallelTests") },
            "parallelTests task should be registered with captureOnFail set"
        )
    }
}
