// Root build file applies JaCoCo to every subproject via a `subprojects {}`
// convention — a completely valid, common pattern in large multi-module builds.
// Neither core-foo nor core-bar references jacoco in its OWN build file, so the
// per-module static scan (analyzeModule's coveragePlugin regex) sees nothing and
// reports `coveragePlugin: null`. The `gradlew tasks --all` probe, however, lists
// `jacocoTestReport` on both modules — which is exactly what effectiveCoveragePlugin
// (resolved.coverageTask fallback) keys off to classify them as jacoco.
subprojects {
    apply(plugin = "jacoco")
}
