// SPDX-License-Identifier: MIT
package io.github.oscardlfr.kmptestrunner.tasks

import io.github.oscardlfr.kmptestrunner.KmpTestRunnerExtension
import org.gradle.api.DefaultTask
import org.gradle.api.tasks.Internal
import org.gradle.api.tasks.TaskAction
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption

open class AndroidTestsTask : DefaultTask() {
    @get:Internal
    lateinit var extension: KmpTestRunnerExtension

    // v0.8 STRATEGIC PIVOT (sub-entry 3): android orchestrator now lives in
    // lib/android-orchestrator.js. The orchestrator dispatches gradle directly
    // (no subprocess to parallel-coverage-suite), so the bundle is just the
    // lib/ tree — no scripts/sh/ entries needed (unlike ChangedTestsTask).
    private val libResources = listOf(
        "/lib/runner.js",
        "/lib/android-orchestrator.js",
        "/lib/orchestrator-utils.js",
        "/lib/cli.js",
        "/lib/jdk-catalogue.js",
        "/lib/project-model.js",
        "/package.json",
    )

    @TaskAction
    fun run() {
        val tempDir = Files.createTempDirectory("kmp-test-android-")
        try {
            for (resource in libResources) {
                val url = javaClass.getResource(resource)
                    ?: error("Bundled resource not found: $resource")
                val dest: Path = tempDir.resolve(resource.trimStart('/'))
                Files.createDirectories(dest.parent)
                url.openStream().use { Files.copy(it, dest, StandardCopyOption.REPLACE_EXISTING) }
            }
            val runnerPath = tempDir.resolve("lib/runner.js").toString()
            val cmd = mutableListOf(
                "node", runnerPath, "android",
                "--project-root", extension.projectRoot
            )
            val pb = ProcessBuilder(cmd).redirectErrorStream(true)
            if (extension.sharedProjectName.isNotEmpty()) {
                pb.environment()["SHARED_PROJECT_NAME"] = extension.sharedProjectName
            }
            val proc = pb.start()
            proc.inputStream.transferTo(System.out)
            val rc = proc.waitFor()
            if (rc != 0) error("[androidTests] runner exited with code $rc")
        } finally {
            try {
                Files.walk(tempDir).sorted(Comparator.reverseOrder()).forEach { Files.deleteIfExists(it) }
            } catch (_: Exception) { /* best-effort */ }
        }
    }
}
