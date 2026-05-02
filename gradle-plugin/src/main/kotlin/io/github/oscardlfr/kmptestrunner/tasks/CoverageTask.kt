// SPDX-License-Identifier: MIT
package io.github.oscardlfr.kmptestrunner.tasks

import io.github.oscardlfr.kmptestrunner.KmpTestRunnerExtension
import org.gradle.api.DefaultTask
import org.gradle.api.tasks.Internal
import org.gradle.api.tasks.TaskAction
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption

open class CoverageTask : DefaultTask() {
    @get:Internal
    lateinit var extension: KmpTestRunnerExtension
    @get:Internal
    internal var koverDetected: Boolean = false

    // v0.8 STRATEGIC PIVOT (sub-entry 4): coverage orchestrator now lives in
    // lib/coverage-orchestrator.js. The bundled Python parser at
    // scripts/lib/parse-coverage-xml.py is reused as-is (Kover/JaCoCo XML
    // parser shared with the parallel codepath). The wrapper script's
    // --skip-tests branch is a thin node-exec shim that delegates to
    // lib/runner.js coverage; we extract both libResources for completeness.
    private val libResources = listOf(
        "/lib/runner.js",
        "/lib/coverage-orchestrator.js",
        "/lib/orchestrator-utils.js",
        "/lib/cli.js",
        "/lib/jdk-catalogue.js",
        "/lib/project-model.js",
        "/package.json",
        "/scripts/lib/parse-coverage-xml.py",
        // Wrapper retained for parallel-codepath bundling (changed-orchestrator
        // subprocess-hops here too); coverage takes the Node fast-path.
        "/scripts/sh/run-parallel-coverage-suite.sh",
        "/scripts/sh/lib/audit-append.sh",
        "/scripts/sh/lib/coverage-detect.sh",
        "/scripts/sh/lib/gradle-tasks-probe.sh",
        "/scripts/sh/lib/jdk-check.sh",
        "/scripts/sh/lib/project-model.sh",
        "/scripts/sh/lib/script-utils.sh",
    )

    @TaskAction
    fun run() {
        val tempDir = Files.createTempDirectory("kmp-test-coverage-")
        try {
            for (resource in libResources) {
                val url = javaClass.getResource(resource)
                    ?: error("Bundled resource not found: $resource")
                val dest: Path = tempDir.resolve(resource.trimStart('/'))
                Files.createDirectories(dest.parent)
                url.openStream().use { Files.copy(it, dest, StandardCopyOption.REPLACE_EXISTING) }
            }
            tempDir.resolve("scripts/sh/run-parallel-coverage-suite.sh").toFile().setExecutable(true)
            val runnerPath = tempDir.resolve("lib/runner.js").toString()
            val cmd = mutableListOf(
                "node", runnerPath, "coverage",
                "--project-root", extension.projectRoot,
                "--coverage-tool", extension.coverageTool,
                "--min-missed-lines", extension.minMissedLines.toString()
            )
            if (extension.coverageModules.isNotEmpty()) {
                cmd += listOf("--coverage-modules", extension.coverageModules)
            }
            val pb = ProcessBuilder(cmd).redirectErrorStream(true)
            if (extension.sharedProjectName.isNotEmpty()) {
                pb.environment()["SHARED_PROJECT_NAME"] = extension.sharedProjectName
            }
            val proc = pb.start()
            proc.inputStream.transferTo(System.out)
            val rc = proc.waitFor()
            if (rc != 0) error("[coverageTask] runner exited with code $rc")
        } finally {
            try {
                Files.walk(tempDir).sorted(Comparator.reverseOrder()).forEach { Files.deleteIfExists(it) }
            } catch (_: Exception) { /* best-effort */ }
        }
    }
}
