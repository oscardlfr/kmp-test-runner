// This module declares no product flavors in its OWN build file — they come from
// the root convention (one dir up). Its unit tests live only in src/testDemo/
// and src/testProd/; there is no bare src/test/ and no instrumented source set.
// Static detection therefore sees has_flavor=false and no tracked unit-test
// source set, while the `gradlew tasks --all` probe lists
// test<Flavor><BuildType>UnitTest, which the probe-backed flavor recovery turns
// into resolved.flavors=[demo, prod].
plugins {
    id("com.android.application")
}
