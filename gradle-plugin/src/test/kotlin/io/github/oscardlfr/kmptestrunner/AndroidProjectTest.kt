// SPDX-License-Identifier: MIT
package io.github.oscardlfr.kmptestrunner

import org.gradle.testkit.runner.GradleRunner
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.CleanupMode
import org.junit.jupiter.api.io.TempDir
import java.io.File
import kotlin.test.assertNotNull

class AndroidProjectTest {
    @TempDir
    lateinit var projectDir: File

    // CleanupMode.NEVER: Gradle Tooling API always starts a daemon in testKitDir
    // that holds file locks on Windows. JUnit 5 cannot delete a live daemon's files.
    @TempDir(cleanup = CleanupMode.NEVER)
    lateinit var testKitDir: File

    @Test
    fun `all 5 tasks are registered for android project shape`() {
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
                }
            }
            rootProject.name = "test-android-project"
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
