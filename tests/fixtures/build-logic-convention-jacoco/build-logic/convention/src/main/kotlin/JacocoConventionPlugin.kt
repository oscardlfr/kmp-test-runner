// Convention plugin that applies jacoco to consumer modules.
// Path is under build-logic/<sub>/src/main/kotlin/ — the precompiled-script /
// Plugin<Project> location, which detectBuildLogicCoverageHints maps to
// kind='convention'. Modules with no per-module jacoco reference inherit
// `coveragePlugin: 'jacoco'` from this fixture.
class JacocoConventionPlugin : org.gradle.api.Plugin<org.gradle.api.Project> {
    override fun apply(target: org.gradle.api.Project) {
        target.pluginManager.apply("jacoco")
    }
}
