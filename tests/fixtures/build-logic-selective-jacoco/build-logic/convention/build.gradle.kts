// nowinandroid-style fixture for v0.6.x Gap 4: build-logic publishes TWO
// convention plugins, one of which adds jacoco to its consumers. Pre-fix
// (v0.6 Bug 6 broad inheritance), all 3 consumer modules below would
// inherit `coveragePlugin: 'jacoco'` because the project-wide hint
// detected jacoco-related class names. Post-fix (Gap 4 per-module
// detection), only `:app-with-jacoco` should inherit — the other two
// don't apply the jacoco-adding plugin id.
plugins {
    `kotlin-dsl`
}

gradlePlugin {
    plugins {
        register("androidJacoco") {
            id = libs.plugins.myproj.android.jacoco.get().pluginId
            implementationClass = "AndroidApplicationJacocoConventionPlugin"
        }
        register("androidNoop") {
            id = libs.plugins.myproj.android.noop.get().pluginId
            implementationClass = "AndroidApplicationNoopConventionPlugin"
        }
    }
}
