// Root build file: in a real project a `subprojects {}` convention here would
// apply demo/prod product flavors to every Android module (the Now-in-Android
// AndroidApplicationFlavorsConventionPlugin pattern). The per-module build files
// therefore stay flavor-free, so the static scan reports has_flavor=false — yet
// the `gradlew tasks --all` probe (a fake gradlew here) lists the flavored
// test<Flavor><BuildType>UnitTest tasks, which the probe-backed flavor recovery
// reads to repopulate the flavors. Illustrative only; the fake gradlew never
// runs this script.
subprojects {
    // demo / prod product flavors applied here by convention so the module
    // build files stay flavor-free.
}
