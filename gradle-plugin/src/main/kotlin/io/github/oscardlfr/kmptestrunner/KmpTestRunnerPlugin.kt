// SPDX-License-Identifier: Apache-2.0
package io.github.oscardlfr.kmptestrunner

import io.github.oscardlfr.kmptestrunner.tasks.AndroidTestsTask
import io.github.oscardlfr.kmptestrunner.tasks.BenchmarkTestsTask
import io.github.oscardlfr.kmptestrunner.tasks.ChangedTestsTask
import io.github.oscardlfr.kmptestrunner.tasks.CoverageTask
import io.github.oscardlfr.kmptestrunner.tasks.ParallelTestsTask
import org.gradle.api.Plugin
import org.gradle.api.Project

class KmpTestRunnerPlugin : Plugin<Project> {
    override fun apply(project: Project) {
        val ext = project.extensions.create("kmpTestRunner", KmpTestRunnerExtension::class.java)

        project.tasks.register("parallelTests", ParallelTestsTask::class.java) { task ->
            task.extension = ext
        }
        project.tasks.register("changedTests", ChangedTestsTask::class.java) { task ->
            task.extension = ext
        }
        project.tasks.register("androidTests", AndroidTestsTask::class.java) { task ->
            task.extension = ext
        }
        project.tasks.register("benchmarkTests", BenchmarkTestsTask::class.java) { task ->
            task.extension = ext
        }
        project.tasks.register("coverageTask", CoverageTask::class.java) { task ->
            task.extension = ext
        }

        project.pluginManager.withPlugin("org.jetbrains.kotlinx.kover") {
            project.tasks.withType(CoverageTask::class.java).configureEach { task ->
                task.koverDetected = true
            }
        }
    }
}
