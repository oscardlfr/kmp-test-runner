// Per-module build file with NO per-module jacoco reference. The
// build-logic only NAMES jacoco-related convention plugins (registration
// noise) without ever applying jacoco itself or via a real Plugin<Project>
// source. detectBuildLogicCoverageHints must return hasJacoco=null —
// :core-baz's coveragePlugin must remain null.
plugins {
    kotlin("jvm")
}
