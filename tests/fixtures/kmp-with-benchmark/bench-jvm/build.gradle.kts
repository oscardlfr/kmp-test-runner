// JVM-only kotlinx-benchmark module. Orchestrator should detect this and
// dispatch :bench-jvm:desktop{Smoke|Stress|}Benchmark per --config.
plugins {
    kotlin("multiplatform")
    id("org.jetbrains.kotlinx.benchmark")
}

kotlin {
    jvm()
}

benchmark {
    targets {
        register("jvm")
    }
}
