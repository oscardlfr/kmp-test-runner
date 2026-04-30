// JS-only KMP module — only declares js() target. Pre-Bug-3 the model
// would resolve no test task at all (jsTest wasn't in unitTestTask
// candidates). Post-fix: unitTestTask falls back to jsTest, AND a new
// webTestTask field surfaces it explicitly.
plugins {
    kotlin("multiplatform")
}

kotlin {
    js(IR) {
        browser()
        nodejs()
    }
}
