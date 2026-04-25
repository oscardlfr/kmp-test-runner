---
scope: standalone
version: 1
last_updated: "2026-03"
assumes_read: testing-hub
token_budget: 900
description: "Benchmark patterns: dispatcher selection for coroutine benchmarks, androidx.benchmark vs kotlinx-benchmark, when runTest vs runBlocking(Dispatchers.Default)"
slug: testing-patterns-benchmarks
status: active
parent: testing-patterns
category: testing
---

# Benchmark Patterns

## Overview

Dos frameworks de benchmarking, dos contextos de ejecución distintos. Elegir el incorrecto produce métricas que no reflejan el rendimiento real.

**Regla clave**: la regla `no-default-dispatcher-in-tests` aplica a tests funcionales, **no a benchmarks**. Los benchmarks de código suspend necesitan `Dispatchers.Default` para medir contención real entre threads.

---

## 1. Dos Frameworks, Dos Contextos

| | androidx.benchmark | kotlinx-benchmark |
|---|---|---|
| **Plataforma** | Android (instrumentación) | KMP (JVM, Native, JS) |
| **Runner** | `AndroidBenchmarkRunner` | JMH (JVM), nativo en otras plataformas |
| **API** | `benchmarkRule.measureRepeated {}` | `@Benchmark fun name()` |
| **Control de iteraciones** | Automático (warmup, iteraciones, GC) | Automático (warmup, iterations, mode) |
| **Código suspend** | No soportado directamente | Requiere contexto de coroutine explícito |
| **Cuándo usar** | Código Android síncrono (UI, serialización, cálculos) | Código KMP, operaciones suspend, concurrencia |

---

## 2. androidx.benchmark — Código Síncrono

Para código que no usa coroutines. El framework controla warmup, iteraciones y mide con `System.nanoTime()` en el device real.

```kotlin
@RunWith(AndroidJUnit4::class)
class SerializationBenchmark {

    @get:Rule
    val benchmarkRule = BenchmarkRule()

    @Test
    fun serializeUser() {
        val user = createTestUser()
        benchmarkRule.measureRepeated {
            Json.encodeToString(user)
        }
    }
}
```

**No necesita coroutines**: `measureRepeated` ejecuta el bloque directamente en el thread de instrumentación. Las métricas son reales porque `AndroidBenchmarkRunner` controla todo el entorno.

---

## 3. kotlinx-benchmark — Código Suspend y Concurrencia

Para código KMP con `suspend fun`, Flow, o contención multi-thread.

### El Problema: runTest + TestDispatcher

```kotlin
// ❌ MAL: TestDispatcher ejecuta TODO en un solo thread cooperativo
@Benchmark
fun concurrentResolution() = runTest {
    val jobs = List(50) {
        async { koin.get<MyService>() }  // 50 coroutines, pero en 1 thread
    }
    jobs.awaitAll()
}
```

`runTest` inyecta un `TestDispatcher` que ejecuta todas las coroutines en un único thread de forma cooperativa. Cuando escribes `concurrency = 50`, las 50 coroutines se **turnan** en el mismo thread en vez de correr en paralelo. Los tiempos de reloj son reales (`TimeSource.Monotonic`), pero:

- No hay contención real entre threads (locks de SQLite, mutexes de Koin, etc.)
- El benchmark mide throughput secuencial disfrazado de concurrente

### La Solución: runBlocking(Dispatchers.Default)

```kotlin
// ✅ BIEN: Dispatchers.Default usa el thread pool real de la plataforma
@Benchmark
fun concurrentResolution() = runBlocking(Dispatchers.Default) {
    val jobs = List(50) {
        async { koin.get<MyService>() }  // 50 coroutines en ForkJoinPool
    }
    jobs.awaitAll()
}
```

`Dispatchers.Default` lanza las coroutines en el thread pool real de la plataforma (JVM: `ForkJoinPool`, Android: thread pool compartido, Native: worker threads). Así `concurrency = 50` crea 50 tareas que compiten por CPU, locks, mutexes — métricas reales de contención.

### Cuándo Usar Cada Uno

| Escenario | Dispatcher | Por qué |
|-----------|-----------|---------|
| Benchmark de `suspend fun` secuencial | `runBlocking` (sin dispatcher) | Ejecuta en el thread del benchmark, sin overhead |
| Benchmark de concurrencia / contención | `runBlocking(Dispatchers.Default)` | Thread pool real, contención medible |
| Test funcional de coroutines | `runTest` (TestDispatcher) | Tiempo virtual, determinista, rápido |

---

## 4. Excepción a la Regla no-default-dispatcher-in-tests

La regla `no-default-dispatcher-in-tests` existe porque `Dispatchers.Default` en tests funcionales introduce no-determinismo, flakiness y rompe el tiempo virtual. Los benchmarks son la **excepción explícita**: necesitan el dispatcher real para medir scheduling, contención y latencia de la plataforma.

```kotlin
// test funcional → runTest (determinista)
@Test
fun `koin resolves service`() = runTest {
    val service = koin.get<MyService>()
    assertNotNull(service)
}

// benchmark → runBlocking(Dispatchers.Default) (métricas reales)
@Benchmark
fun koinResolutionUnderContention() = runBlocking(Dispatchers.Default) {
    val jobs = List(50) { async { koin.get<MyService>() } }
    jobs.awaitAll()
}
```

---

## 5. Configuración Gradle por Plataforma

### 5.1 Convention Plugin (recomendado)

Centralizar la configuración de benchmark en un convention plugin evita duplicación entre módulos:

```kotlin
// build-logic/.../KmpBenchmarkConventionPlugin.kt
class KmpBenchmarkConventionPlugin : Plugin<Project> {
    override fun apply(target: Project) = with(target) {
        with(pluginManager) {
            apply("org.jetbrains.kotlin.multiplatform")
            apply("com.android.kotlin.multiplatform.library")
            apply("org.jetbrains.kotlin.plugin.allopen")  // JMH requiere clases open
            apply("org.jetbrains.kotlinx.benchmark")
        }
        extensions.configure<KotlinMultiplatformExtension> {
            jvm("desktop") { compilerOptions { jvmTarget.set(JvmTarget.JVM_21) } }
            macosArm64(); macosX64()
            applyDefaultHierarchyTemplate()
        }
        // JMH requiere que las clases @State sean open
        extensions.findByName("allOpen")?.let { ext ->
            ext.javaClass.getMethod("annotation", String::class.java)
                .invoke(ext, "org.openjdk.jmh.annotations.State")
        }
        // Solo desktop (JVM) ejecuta JMH microbenchmarks
        val bExt = extensions.getByType(BenchmarksExtension::class.java)
        bExt.targets.register("desktop")
        // Tres configuraciones: main (CI), smoke (dev), stress (carga)
        bExt.configurations.named("main").configure {
            warmups = 10; iterations = 10; iterationTime = 2; iterationTimeUnit = "s"
            mode = "avgt"; outputTimeUnit = "ms"; reportFormat = "json"
            advanced("jvmForks", 2); advanced("nativeGCAfterIteration", true)
        }
        bExt.configurations.register("smoke").configure {
            warmups = 3; iterations = 3; iterationTime = 500; iterationTimeUnit = "ms"
            mode = "avgt"; outputTimeUnit = "ms"; reportFormat = "json"
        }
        bExt.configurations.register("stress").configure {
            warmups = 5; iterations = 20; iterationTime = 5; iterationTimeUnit = "s"
            mode = "avgt"; outputTimeUnit = "ms"; reportFormat = "json"
            advanced("nativeGCAfterIteration", true)
        }
    }
}
```

**Notas**: `allopen` es obligatorio — JMH necesita clases `@State` abiertas (Kotlin las genera `final`). Solo el target `desktop` (JVM) ejecuta JMH. Tres configuraciones: `main` (CI, rigurosa), `smoke` (dev, rápida), `stress` (carga).

### 5.2 Módulo Benchmark KMP (usa el convention plugin)

```kotlin
// benchmark-sdk/build.gradle.kts
plugins {
    id("com.grinx.shared.kmp.benchmark")  // convention plugin
}

kotlin {
    androidLibrary {
        namespace = "com.grinx.shared.benchmark.sdk"
        compileSdk = libs.versions.android.compileSdk.get().toInt()
        minSdk = libs.versions.android.minSdk.get().toInt()

        withDeviceTestBuilder {
            sourceSetTreeName = "test"  // instrumentación en device real
        }
    }

    sourceSets {
        commonMain.dependencies {
            implementation(project(":benchmark-infra"))
            implementation(libs.kotlinx.benchmark.runtime)
            implementation(libs.kotlinx.coroutines.core)
            implementation(libs.koin.core)
        }
        commonTest.dependencies {
            implementation(libs.kotlin.test)
            implementation(libs.kotlinx.coroutines.test)
        }
        val desktopTest by getting {
            dependencies { implementation(libs.kotlin.test.junit) }
        }
        val androidDeviceTest by getting {
            dependencies { implementation(libs.androidx.test.runner) }
        }
    }
}
```

**Source sets y dónde corre cada cosa**:

| Source set | Plataforma | Tipo de benchmark |
|-----------|-----------|-------------------|
| `commonMain` | Todas | `@Benchmark` con kotlinx-benchmark (JMH en JVM, nativo en macOS) |
| `commonTest` | Todas | Stress tests con `runBlocking(Dispatchers.Default)` |
| `desktopTest` | JVM | Tests JUnit que ejecutan JMH benchmarks |
| `androidDeviceTest` | Android | Instrumentación en device real |

### 5.3 Módulo Benchmark Android-Only (androidx.benchmark)

Para benchmarks exclusivos de Android con instrumentación. No usa KMP ni `kotlinx-benchmark`:

```kotlin
// benchmark-android-test/build.gradle.kts
plugins {
    alias(libs.plugins.android.library)  // NO KMP, solo Android
}

android {
    namespace = "com.grinx.shared.benchmark.android.test"
    compileSdk = libs.versions.android.compileSdk.get().toInt()
    defaultConfig {
        minSdk = libs.versions.android.minSdk.get().toInt()
        testInstrumentationRunner = "...BenchmarkTestRunner"  // hereda AndroidJUnitRunner
    }
}

dependencies {
    implementation(project(":benchmark-infra"))
    implementation(project(":core-storage-api"))
    implementation(project(":core-storage-datastore"))
    androidTestImplementation(libs.kotlin.test)
    androidTestImplementation(libs.androidx.test.runner)
}
```

**Diferencias clave con KMP**: usa `BenchmarkRule` en vez de `@Benchmark`, tests en `androidTest/` (instrumentación), backends reales como `implementation` (no `testImplementation`).

### 5.4 Tareas Gradle y Ejecución

```bash
# JMH microbenchmarks (desktop/JVM) — main | smoke | stress
./gradlew :benchmark-sdk:desktopBenchmark
./gradlew :benchmark-sdk:desktopSmokeBenchmark
./gradlew :benchmark-sdk:desktopStressBenchmark
# Stress tests (commonTest, todas las plataformas)
./gradlew :benchmark-sdk:desktopTest          # JVM
./gradlew :benchmark-sdk:macosArm64Test       # macOS ARM
# Android instrumentación (requiere device/emulator)
./gradlew :benchmark-android-test:connectedAndroidTest
# Reports → build/reports/benchmarks/desktop/main/
```

### 5.5 Decisiones por Plataforma

| Decisión | JVM (Desktop) | Android | macOS (Native) |
|----------|--------------|---------|----------------|
| **Framework** | kotlinx-benchmark (JMH) | androidx.benchmark o kotlinx-benchmark | kotlinx-benchmark (native) |
| **Plugin** | `allopen` + `kotlinx.benchmark` | `android.library` (o convention KMP) | Via convention KMP |
| **Ejecución** | `desktopBenchmark` | `connectedAndroidTest` | `macosArm64Test` |
| **Forks** | Sí (`jvmForks = 2`) | No (single process) | No (single process) |
| **GC control** | JMH maneja GC | `AndroidBenchmarkRunner` | `nativeGCAfterIteration` |
| **Output** | JSON en `build/reports/` | Logcat + JSON | JSON en `build/reports/` |

---

## References

- [kotlinx-benchmark](https://github.com/Kotlin/kotlinx-benchmark)
- [androidx.benchmark](https://developer.android.com/topic/performance/benchmarking/microbenchmark-overview)
- Parent doc: [testing-patterns.md](testing-patterns.md)
