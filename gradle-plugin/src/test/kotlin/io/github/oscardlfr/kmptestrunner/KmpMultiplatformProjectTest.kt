// SPDX-License-Identifier: MIT
package io.github.oscardlfr.kmptestrunner

import org.gradle.testkit.runner.GradleRunner
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.CleanupMode
import org.junit.jupiter.api.io.TempDir
import java.io.File
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class KmpMultiplatformProjectTest {
    @TempDir(cleanup = CleanupMode.NEVER)
    lateinit var projectDir: File

    @TempDir(cleanup = CleanupMode.NEVER)
    lateinit var testKitDir: File

    @Test
    fun `all 5 tasks are registered for kmp multiplatform project shape`() {
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
            rootProject.name = "test-kmp-multiplatform-project"
            """.trimIndent()
        )
        projectDir.resolve("build.gradle.kts").writeText(
            """
            plugins {
                id("io.github.oscardlfr.kmp-test-runner") version "$pluginVersion"
            }
            kmpTestRunner {
                projectRoot = rootDir.absolutePath
            }
            """.trimIndent()
        )

        val result = GradleRunner.create()
            .withProjectDir(projectDir)
            .withTestKitDir(testKitDir)
            .withArguments("tasks", "--all")
            .build()

        assertNotNull(result.output.lines().find { it.startsWith("parallelTests") },
            "parallelTests task not registered")
        assertNotNull(result.output.lines().find { it.startsWith("changedTests") },
            "changedTests task not registered")
        assertNotNull(result.output.lines().find { it.startsWith("androidTests") },
            "androidTests task not registered")
        assertNotNull(result.output.lines().find { it.startsWith("benchmarkTests") },
            "benchmarkTests task not registered")
        assertNotNull(result.output.lines().find { it.startsWith("coverageTask") },
            "coverageTask task not registered")
    }

    @Test
    fun `coverageTask kover auto-detect fires when kover plugin present`() {
        val pluginVersion = System.getProperty("plugin.version")
            ?: error("plugin.version system property not set — did the build script wire it up?")
        projectDir.resolve("settings.gradle.kts").writeText(
            """
            pluginManagement {
                repositories {
                    mavenLocal()
                    gradlePluginPortal()
                    mavenCentral()
                }
            }
            rootProject.name = "test-kmp-multiplatform-kover"
            """.trimIndent()
        )
        projectDir.resolve("build.gradle.kts").writeText(
            """
            plugins {
                id("io.github.oscardlfr.kmp-test-runner") version "$pluginVersion"
                id("org.jetbrains.kotlinx.kover") version "0.9.1"
            }
            kmpTestRunner {
                projectRoot = rootDir.absolutePath
                coverageTool = "kover"
            }
            """.trimIndent()
        )

        val result = GradleRunner.create()
            .withProjectDir(projectDir)
            .withTestKitDir(testKitDir)
            .withArguments("tasks", "--all")
            .build()

        assertNotNull(result.output.lines().find { it.startsWith("coverageTask") },
            "coverageTask not registered when Kover present")
        assertTrue(result.output.contains("BUILD SUCCESSFUL"),
            "Build should succeed when Kover present")
    }
}
