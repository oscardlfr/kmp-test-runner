// This module declares neither product flavors nor coverage in its OWN build
// file — both are inherited from the root `subprojects {}` convention (one dir
// up). Static detection sees nothing (has_flavor false, coveragePlugin null);
// the probe-backed effective* helpers recover both from the flavored task graph.
plugins {
    id("com.android.library")
}
