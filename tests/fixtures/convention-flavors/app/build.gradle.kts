// This module declares neither product flavors nor coverage in its OWN build
// file — both are inherited from the root `subprojects {}` convention (one dir
// up). Static detection must therefore see nothing (has_flavor false,
// coveragePlugin null); the probe-backed effective* helpers recover both from
// the flavored task graph the `gradlew tasks --all` probe reveals.
plugins {
    id("com.android.application")
}
