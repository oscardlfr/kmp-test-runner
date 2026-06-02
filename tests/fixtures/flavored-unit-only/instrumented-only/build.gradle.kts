// True-negative module: instrumented tests only (src/androidTest/), no unit
// tests, no flavors. The probe lists only connected*AndroidTest tasks (no
// *UnitTest), so resolved.flavors stays empty and the androidUnit leg correctly
// skips it.
plugins {
    id("com.android.library")
}
