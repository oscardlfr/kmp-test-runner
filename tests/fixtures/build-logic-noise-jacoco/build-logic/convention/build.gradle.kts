// nowinandroid-style fixture: build-logic/convention/build.gradle.kts that
// only NAMES jacoco-related convention plugins via gradlePlugin {} register()
// blocks. The string "jacoco" appears multiple times (in `register(...)`,
// `id = libs.plugins.<...>.jacoco.<...>`, and `implementationClass = "...Jacoco..."`)
// but jacoco is NEVER applied to build-logic itself — and there are no
// Plugin<Project> sources under src/main/kotlin/ in this fixture either.
//
// Pre-fix: the naive `\bjacoco\b` scan returned hasJacoco=true.
// Post-fix: registration noise is stripped; result is hasJacoco=null.
// Consumer module `:core-baz` must NOT inherit jacoco from this hint.
plugins {
    `kotlin-dsl`
}

gradlePlugin {
    plugins {
        register("androidApplicationJacoco") {
            id = libs.plugins.fixture.android.application.jacoco.get().pluginId
            implementationClass = "AndroidApplicationJacocoConventionPlugin"
        }
        register("androidLibraryJacoco") {
            id = libs.plugins.fixture.android.library.jacoco.get().pluginId
            implementationClass = "AndroidLibraryJacocoConventionPlugin"
        }
    }
}
