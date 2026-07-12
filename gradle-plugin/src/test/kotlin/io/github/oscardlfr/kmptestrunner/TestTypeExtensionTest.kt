// SPDX-License-Identifier: MIT
package io.github.oscardlfr.kmptestrunner

import org.gradle.testkit.runner.GradleRunner
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.CleanupMode
import org.junit.jupiter.api.io.TempDir
import java.io.File
import kotlin.test.assertEquals
import kotlin.test.assertNotNull

class TestTypeExtensionTest {
    @TempDir
    lateinit var projectDir: File

    // CleanupMode.NEVER: Gradle Tooling API always starts a daemon in testKitDir
    // that holds file locks on Windows. JUnit 5 cannot delete a live daemon's files.
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

        assertNotNull(
            result.output.lines().find { it.startsWith("parallelTests") },
            "parallelTests task should be registered even with testType=ios"
        )
    }

    @Test
    fun `extension accepts testType = macos without DSL error`() {
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
