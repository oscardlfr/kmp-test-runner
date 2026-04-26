// SPDX-License-Identifier: MIT
package io.github.oscardlfr.kmptestrunner.tasks

import io.github.oscardlfr.kmptestrunner.KmpTestRunnerExtension
import org.gradle.api.DefaultTask
import org.gradle.api.tasks.TaskAction
import java.nio.file.Files
import java.nio.file.StandardCopyOption

open class ChangedTestsTask : DefaultTask() {
    lateinit var extension: KmpTestRunnerExtension

    @TaskAction
    fun run() {
        val url = javaClass.getResource("/scripts/sh/run-changed-modules-tests.sh")
            ?: error("Bundled script not found: run-changed-modules-tests.sh")
        val tempScript = Files.createTempFile("kmp-test-", ".sh")
        try {
            url.openStream().use { Files.copy(it, tempScript, StandardCopyOption.REPLACE_EXISTING) }
            tempScript.toFile().setExecutable(true)
            val cmd = mutableListOf(
                "bash", tempScript.toString(),
                "--project-root", extension.projectRoot,
                "--min-missed-lines", extension.minMissedLines.toString(),
                "--coverage-tool", extension.coverageTool
            )
            val pb = ProcessBuilder(cmd).redirectErrorStream(true)
            if (extension.sharedProjectName.isNotEmpty()) {
                pb.environment()["SHARED_PROJECT_NAME"] = extension.sharedProjectName
            }
            val proc = pb.start()
            proc.inputStream.transferTo(System.out)
            val rc = proc.waitFor()
            if (rc != 0) error("[changedTests] script exited with code $rc")
        } finally {
            Files.deleteIfExists(tempScript)
        }
    }
}
