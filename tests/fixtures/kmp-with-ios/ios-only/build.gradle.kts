// iOS-only KMP module — only declares iosX64() target. Pre-v0.7 the model
// would resolve no test task at all (iOS candidates weren't in the
// resolveTasksFor return shape). Post-fix: a new iosTestTask field
// surfaces the iOS test task explicitly.
plugins {
    kotlin("multiplatform")
}

kotlin {
    iosX64()
}
