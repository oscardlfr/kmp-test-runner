// Root build file applies product flavors (demo/prod) AND jacoco unit-test
// coverage to every Android subproject via a `subprojects {}` convention — a
// common pattern in large multi-module builds (e.g. Now-in-Android's
// AndroidApplicationFlavorsConventionPlugin + configureJacoco). Neither :app nor
// :core-foo references productFlavors or jacoco in its OWN build file, so the
// per-module static scan sees nothing: has_flavor=false, coveragePlugin=null.
//
// The `gradlew tasks --all` probe (here a fake gradlew emitting canned lines),
// however, lists `test${Flavor}${BuildType}UnitTest` and the per-variant
// `create${Variant}UnitTestCoverageReport` tasks on every module — exactly what
// effectiveHasFlavor / effectiveCoveragePlugin (probe fallback) key off to
// recover the flavors + jacoco classification. Illustrative only; the fake
// gradlew never executes this script.
subprojects {
    // demo / prod product flavors + jacoco unit-test coverage, applied here by
    // convention so the module build files stay flavor-/coverage-free.
}
