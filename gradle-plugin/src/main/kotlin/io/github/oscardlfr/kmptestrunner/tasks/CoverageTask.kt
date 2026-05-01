// SPDX-License-Identifier: MIT
package io.github.oscardlfr.kmptestrunner.tasks

import io.github.oscardlfr.kmptestrunner.KmpTestRunnerExtension
import org.gradle.api.DefaultTask
import org.gradle.api.tasks.TaskAction
import java.nio.file.Files
import java.nio.file.StandardCopyOption

open class CoverageTask : DefaultTask() {
    lateinit var extension: KmpTestRunnerExtension
    internal var koverDetected: Boolean = false

    @TaskAction
    fun run() {
        if (extension.coverageTool == "kover" && !koverDetected) {
            logger.info("[kmp-test-runner] Kover not detected — coverage reporting skipped")
            return
        }
        val url = javaClass.getResource("/scripts/sh/run-parallel-coverage-suite.sh")
            ?: error("Bundled script not found: run-parallel-coverage-suite.sh")
        val tempScript = Files.createTempFile("kmp-test-", ".sh")
        try {
            url.openStream().use { Files.copy(it, tempScript, StandardCopyOption.REPLACE_EXISTING) }
            tempScript.toFile().setExecutable(true)
            val cmd = mutableListOf(
                "bash", tempScript.toString(),
                "--skip-tests",
                "--project-root", extension.projectRoot,
                "--max-workers", extension.maxWorkers.toString(),
                "--coverage-tool", extension.coverageTool,
                "--min-missed-lines", extension.minMissedLines.toString()
            )
            if (extension.coverageModules.isNotEmpty()) {
                cmd += listOf("--coverage-modules", extension.coverageModules)
            }
            if (extension.testType.isNotEmpty()) {
                cmd += listOf("--test-type", extension.testType)
            }
            val pb = ProcessBuilder(cmd).redirectErrorStream(true)
            if (extension.sharedProjectName.isNotEmpty()) {
                pb.environment()["SHARED_PROJECT_NAME"] = extension.sharedProjectName
            }
            val proc = pb.start()
            proc.inputStream.transferTo(System.out)
            val rc = proc.waitFor()
            if (rc != 0) error("[coverageTask] script exited with code $rc")
        } finally {
            Files.deleteIfExists(tempScript)
        }
    }
}
