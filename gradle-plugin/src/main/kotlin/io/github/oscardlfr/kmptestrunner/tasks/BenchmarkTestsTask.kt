// SPDX-License-Identifier: MIT
package io.github.oscardlfr.kmptestrunner.tasks

import io.github.oscardlfr.kmptestrunner.KmpTestRunnerExtension
import org.gradle.api.DefaultTask
import org.gradle.api.tasks.Internal
import org.gradle.api.tasks.TaskAction
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption

open class BenchmarkTestsTask : DefaultTask() {
    @get:Internal
    lateinit var extension: KmpTestRunnerExtension

    // v0.8 STRATEGIC PIVOT: benchmark logic now lives in lib/benchmark-orchestrator.js
    // (PRODUCT.md "logic in Node, plumbing in shell"). The bundled .sh wrapper is
    // a thin Node-launcher; this task extracts the lib/ tree alongside it and
    // invokes `node lib/runner.js benchmark` directly, bypassing the shell hop.
    // Requires `node` on PATH (npm-installed gradle-plugin users typically have
    // it). Sub-entries 2-5 will follow the same pattern.
    private val libResources = listOf(
        "/lib/runner.js",
        "/lib/benchmark-orchestrator.js",
        "/lib/orchestrator-utils.js",
        "/lib/cli.js",
        "/lib/jdk-catalogue.js",
        "/lib/project-model.js",
        "/package.json",
    )

    @TaskAction
    fun run() {
        val tempDir = Files.createTempDirectory("kmp-test-bench-")
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
                "node", runnerPath, "benchmark",
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
            // Best-effort cleanup of the staged tree.
            try {
                Files.walk(tempDir).sorted(Comparator.reverseOrder()).forEach { Files.deleteIfExists(it) }
            } catch (_: Exception) { /* best-effort */ }
        }
    }
}
