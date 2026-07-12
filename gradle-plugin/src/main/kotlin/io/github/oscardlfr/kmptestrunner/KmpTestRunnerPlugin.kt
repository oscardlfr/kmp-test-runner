// SPDX-License-Identifier: MIT
package io.github.oscardlfr.kmptestrunner

import io.github.oscardlfr.kmptestrunner.tasks.AndroidTestsTask
import io.github.oscardlfr.kmptestrunner.tasks.BenchmarkTestsTask
import io.github.oscardlfr.kmptestrunner.tasks.ChangedTestsTask
import io.github.oscardlfr.kmptestrunner.tasks.CoverageTask
import io.github.oscardlfr.kmptestrunner.tasks.ParallelTestsTask
import org.gradle.api.GradleException
import org.gradle.api.Plugin
import org.gradle.api.Project
import org.gradle.util.GradleVersion

class KmpTestRunnerPlugin : Plugin<Project> {
    override fun apply(project: Project) {
        if (GradleVersion.current() < GradleVersion.version("7.6"))
            throw GradleException("kmp-test-runner requires Gradle 7.6 or newer")

        val ext = project.extensions.create("kmpTestRunner", KmpTestRunnerExtension::class.java)
        val defaultRoot = project.rootDir.absolutePath

        project.tasks.register("parallelTests", ParallelTestsTask::class.java) { task ->
            task.extension = ext
            task.defaultProjectRoot = defaultRoot
        }
        project.tasks.register("changedTests", ChangedTestsTask::class.java) { task ->
            task.extension = ext
            task.defaultProjectRoot = defaultRoot
        }
        project.tasks.register("androidTests", AndroidTestsTask::class.java) { task ->
            task.extension = ext
            task.defaultProjectRoot = defaultRoot
        }
        project.tasks.register("benchmarkTests", BenchmarkTestsTask::class.java) { task ->
            task.extension = ext
            task.defaultProjectRoot = defaultRoot
        }
        project.tasks.register("coverageTask", CoverageTask::class.java) { task ->
            task.extension = ext
            task.defaultProjectRoot = defaultRoot
        }
    }
}
