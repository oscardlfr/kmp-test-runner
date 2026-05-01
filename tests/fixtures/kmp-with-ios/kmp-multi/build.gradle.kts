// KMP module with BOTH jvmTest and iosSimulatorArm64Test. Demonstrates the
// regression guard for v0.7.0: unitTestTask must still pick the JVM-side
// task; the iOS-side surfaces only via the new iosTestTask field.
plugins {
    kotlin("multiplatform")
}

kotlin {
    jvm()
    iosSimulatorArm64()
}
