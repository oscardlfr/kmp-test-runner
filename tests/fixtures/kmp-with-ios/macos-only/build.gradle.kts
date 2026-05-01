// macOS-only KMP module — only declares macosArm64() target. Surfaces the
// new macosTestTask field; macOS dispatches host-natively (no simulator
// boot dance like iOS).
plugins {
    kotlin("multiplatform")
}

kotlin {
    macosArm64()
}
