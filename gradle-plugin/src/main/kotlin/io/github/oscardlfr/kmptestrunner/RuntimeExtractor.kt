// SPDX-License-Identifier: MIT
package io.github.oscardlfr.kmptestrunner

import org.gradle.process.ExecOperations
import java.io.File
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption.REPLACE_EXISTING
import java.util.Comparator.reverseOrder
import java.util.jar.JarFile

internal object RuntimeExtractor {

    fun extractTo(destDir: Path, loader: Class<*>) {
        val srcFile = File(loader.protectionDomain.codeSource.location.toURI())
        if (srcFile.isFile) extractFromJar(destDir, srcFile)
        else extractFromClassDir(destDir, srcFile)
        makeShExecutable(destDir)
    }

    private fun extractFromJar(destDir: Path, jar: File) {
        JarFile(jar).use { jf ->
            jf.entries().asSequence()
                .filter { !it.isDirectory && isRuntimeEntry(it.name) }
                .forEach { entry ->
                    val dest = destDir.resolve(entry.name)
                    Files.createDirectories(dest.parent)
                    jf.getInputStream(entry).use { Files.copy(it, dest, REPLACE_EXISTING) }
                }
        }
    }

    // Fallback for development (class directory, not a JAR).
    // Recursively copies lib/, scripts/, and package.json from the class root.
    private fun extractFromClassDir(destDir: Path, classDir: File) {
        for (prefix in listOf("lib", "scripts")) {
            val src = File(classDir, prefix)
            if (!src.isDirectory) continue
            src.walkTopDown().filter { it.isFile }.forEach { file ->
                val dest = destDir.resolve(file.toRelativeString(classDir)).toFile()
                dest.parentFile.mkdirs()
                file.copyTo(dest, overwrite = true)
            }
        }
        File(classDir, "package.json")
            .takeIf { it.exists() }
            ?.copyTo(destDir.resolve("package.json").toFile(), overwrite = true)
    }

    private fun isRuntimeEntry(name: String) =
        name.startsWith("lib/") || name.startsWith("scripts/") || name == "package.json"

    private fun makeShExecutable(dir: Path) {
        if (File.separator != "/") return
        Files.walk(dir).use { stream ->
            stream.filter { it.toString().endsWith(".sh") }
                  .forEach { it.toFile().setExecutable(true) }
        }
    }

    fun cleanup(dir: Path) {
        try {
            Files.walk(dir).use { stream ->
                stream.sorted(reverseOrder()).forEach(Files::deleteIfExists)
            }
        } catch (_: Exception) { /* best-effort */ }
    }
}

/**
 * Builds the node command list for spawning the bundled runner.
 *
 * Production default is always `["node", runnerPath, ...]`.
 * KMP_NODE_LAUNCHER is a test-only hook: tests on Windows inject
 * "cmd.exe /c node" here so that a node.bat recorder shim placed on PATH
 * is found via PATHEXT (CreateProcess ignores PATHEXT without cmd.exe routing).
 * This variable is never set in production and has no user-facing semantics.
 */
internal fun buildNodeCommand(runnerPath: String, vararg extra: String): List<String> {
    val launcher = System.getenv("KMP_NODE_LAUNCHER")
    return if (!launcher.isNullOrEmpty())
        launcher.split(" ") + listOf(runnerPath, *extra)
    else
        listOf("node", runnerPath, *extra)
}

/**
 * Spawns the bundled runner via Gradle's injected [ExecOperations] — the
 * Gradle-recommended replacement for raw `java.lang.ProcessBuilder`/
 * `Project.exec` inside tasks (process lifecycle stays visible to Gradle,
 * and it's the configuration-cache-compatible path). Not a correctness fix
 * on its own: a prior false-green bug where these tasks reported
 * BUILD SUCCESSFUL regardless of the runner's real exit code was traced to
 * `lib/runner.js`'s own entrypoint guard, not to the process-spawning API —
 * see `isRunnerEntrypoint` in that file.
 *
 * `standardOutput`/`errorOutput` are wired straight to [System.out] — Gradle
 * pumps both streams live as the child writes them (matching the previous
 * `redirectErrorStream(true)` + streaming `transferTo` behavior: real-time
 * console output, no end-of-run buffering, no UTF-8 round-trip through an
 * intermediate buffer). `workingDir` pins to `effectiveRoot`; `--project-root`
 * is always passed explicitly, but leaving the child's cwd otherwise
 * undefined has no upside.
 *
 * Non-zero exit throws `"[$taskName] runner exited with code $rc"` (never
 * left to ExecOperations' own default failure handling, so the existing
 * per-task error-message contract is unchanged).
 */
internal fun runNodeRunner(
    execOperations: ExecOperations,
    taskName: String,
    cmd: List<String>,
    projectRoot: String,
    sharedProjectName: String,
) {
    val result = execOperations.exec { spec ->
        spec.commandLine(cmd)
        spec.workingDir(File(projectRoot))
        spec.isIgnoreExitValue = true
        spec.standardOutput = System.out
        spec.errorOutput = System.out
        if (sharedProjectName.isNotEmpty()) {
            spec.environment("SHARED_PROJECT_NAME", sharedProjectName)
        }
    }
    val rc = result.exitValue
    if (rc != 0) error("[$taskName] runner exited with code $rc")
}
