// KMP module with BOTH jvmTest and jsTest. Demonstrates the regression
// guard for Bug 3: unitTestTask must still pick the JVM-side task; the
// JS-side surfaces only via the new webTestTask field.
plugins {
    kotlin("multiplatform")
}

kotlin {
    jvm()
    js(IR) {
        browser()
    }
}
