// NO per-module jacoco reference — coverage is inherited from the root
// `subprojects {}` block (one dir up). Static detection must report
// coveragePlugin: null; the probe-backed effectiveCoveragePlugin upgrades it.
plugins {
    kotlin("jvm")
}
