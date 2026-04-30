// Module that applies a non-coverage convention plugin. Pre-fix (Bug 6
// broad inheritance) would have falsely set coveragePlugin = "jacoco".
// Post-fix: descriptor for `myproj.android.noop` has addsCoverage=null,
// so coveragePlugin stays null.
plugins {
    alias(libs.plugins.myproj.android.noop)
}
