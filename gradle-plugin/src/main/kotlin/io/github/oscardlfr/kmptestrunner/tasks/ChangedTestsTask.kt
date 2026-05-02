// SPDX-License-Identifier: MIT
package io.github.oscardlfr.kmptestrunner.tasks

import io.github.oscardlfr.kmptestrunner.KmpTestRunnerExtension
import org.gradle.api.DefaultTask
import org.gradle.api.tasks.Internal
import org.gradle.api.tasks.TaskAction
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption

open class ChangedTestsTask : DefaultTask() {
    @get:Internal
    lateinit var extension: KmpTestRunnerExtension

    // v0.8 STRATEGIC PIVOT (sub-entry 2): changed orchestrator now lives in
    // lib/changed-orchestrator.js. The orchestrator subprocess-dispatches to
    // run-parallel-coverage-suite.sh (sub-entry 5 will refactor to in-process),
    // so we extract both the lib/ tree AND the parallel suite + its sourced
    // helpers. Once sub-entry 5 lands, the scripts/sh/ entries can be dropped.
    private val libResources = listOf(
        "/lib/runner.js",
        "/lib/changed-orchestrator.js",
        "/lib/orchestrator-utils.js",
        "/lib/cli.js",
        "/lib/jdk-catalogue.js",
        "/lib/project-model.js",
        "/package.json",
        // Parallel suite + transitive helpers (subprocess dispatch target).
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
        val tempDir = Files.createTempDirectory("kmp-test-changed-")
        try {
            for (resource in libResources) {
                val url = javaClass.getResource(resource)
                    ?: error("Bundled resource not found: $resource")
                val dest: Path = tempDir.resolve(resource.trimStart('/'))
                Files.createDirectories(dest.parent)
                url.openStream().use { Files.copy(it, dest, StandardCopyOption.REPLACE_EXISTING) }
            }
            // Make the bundled .sh scripts executable so the orchestrator's
            // bash-spawn dispatch can reach the parallel suite.
            tempDir.resolve("scripts/sh/run-parallel-coverage-suite.sh").toFile().setExecutable(true)
            val runnerPath = tempDir.resolve("lib/runner.js").toString()
            val cmd = mutableListOf(
                "node", runnerPath, "changed",
                "--project-root", extension.projectRoot,
                "--min-missed-lines", extension.minMissedLines.toString(),
                "--coverage-tool", extension.coverageTool
            )
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
            if (rc != 0) error("[changedTests] runner exited with code $rc")
        } finally {
            try {
                Files.walk(tempDir).sorted(Comparator.reverseOrder()).forEach { Files.deleteIfExists(it) }
            } catch (_: Exception) { /* best-effort */ }
        }
    }
}
