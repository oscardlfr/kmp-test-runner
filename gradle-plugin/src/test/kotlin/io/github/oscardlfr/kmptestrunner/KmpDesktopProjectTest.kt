// SPDX-License-Identifier: Apache-2.0
package io.github.oscardlfr.kmptestrunner

import org.gradle.testkit.runner.GradleRunner
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.CleanupMode
import org.junit.jupiter.api.io.TempDir
import java.io.File
import kotlin.test.assertNotNull

class KmpDesktopProjectTest {
    @TempDir(cleanup = CleanupMode.NEVER)
    lateinit var projectDir: File

    @TempDir(cleanup = CleanupMode.NEVER)
    lateinit var testKitDir: File

    @Test
    fun `all 5 tasks are registered for kmp desktop project shape`() {
        val pluginVersion = System.getProperty("plugin.version")
            ?: error("plugin.version system property not set — did the build script wire it up?")
        projectDir.resolve("settings.gradle.kts").writeText(
            """
            pluginManagement {
                repositories {
                    mavenLocal()
                    gradlePluginPortal()
                }
            }
            rootProject.name = "test-kmp-desktop-project"
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
}
