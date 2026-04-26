// SPDX-License-Identifier: MIT
package io.github.oscardlfr.kmptestrunner.tasks

import io.github.oscardlfr.kmptestrunner.KmpTestRunnerExtension
import org.gradle.api.DefaultTask
import org.gradle.api.tasks.TaskAction
import java.nio.file.Files
import java.nio.file.StandardCopyOption

open class BenchmarkTestsTask : DefaultTask() {
    lateinit var extension: KmpTestRunnerExtension

    @TaskAction
    fun run() {
        val url = javaClass.getResource("/scripts/sh/run-benchmarks.sh")
            ?: error("Bundled script not found: run-benchmarks.sh")
        val tempScript = Files.createTempFile("kmp-test-", ".sh")
        try {
            url.openStream().use { Files.copy(it, tempScript, StandardCopyOption.REPLACE_EXISTING) }
            tempScript.toFile().setExecutable(true)
            val cmd = mutableListOf(
                "bash", tempScript.toString(),
                "--project-root", extension.projectRoot
            )
            val pb = ProcessBuilder(cmd).redirectErrorStream(true)
            if (extension.sharedProjectName.isNotEmpty()) {
                pb.environment()["SHARED_PROJECT_NAME"] = extension.sharedProjectName
            }
            val proc = pb.start()
            proc.inputStream.transferTo(System.out)
            val rc = proc.waitFor()
            if (rc != 0) error("[benchmarkTests] script exited with code $rc")
        } finally {
            Files.deleteIfExists(tempScript)
        }
    }
}
