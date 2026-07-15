// SPDX-License-Identifier: MIT
package io.github.oscardlfr.kmptestrunner.tasks

import io.github.oscardlfr.kmptestrunner.KmpTestRunnerExtension
import org.gradle.api.DefaultTask
import org.gradle.api.tasks.Internal
import org.gradle.process.ExecOperations
import javax.inject.Inject

/**
 * Shared base for the 5 kmp-test-runner Gradle tasks (parallelTests,
 * changedTests, androidTests, benchmarkTests, coverageTask): the plugin
 * extension, the pre-resolved default project root, and Gradle's injected
 * process-exec service each task's `@TaskAction` passes to `runNodeRunner`.
 */
abstract class NodeRunnerTask : DefaultTask() {
    @get:Internal
    lateinit var extension: KmpTestRunnerExtension

    @get:Internal
    var defaultProjectRoot: String = ""

    @get:Inject
    abstract val execOperations: ExecOperations
}
