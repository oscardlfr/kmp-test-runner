// Module that EXPLICITLY applies the jacoco-adding convention plugin.
// Expected: coveragePlugin = "jacoco" (descriptor matches → inherit).
plugins {
    alias(libs.plugins.myproj.android.jacoco)
}
