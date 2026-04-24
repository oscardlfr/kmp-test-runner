---
scope: standalone
version: 2
last_updated: "2026-03"
assumes_read: testing-hub
token_budget: 1399
description: "Coroutine test patterns: runTest, TestScope, virtual time, StateFlow collection, common pitfalls"
slug: testing-patterns-coroutines
status: active
parent: testing-patterns
category: testing
validate_upstream:
  - url: "https://developer.android.com/kotlin/coroutines/test"
    assertions:
      - type: api_present
        value: "runTest"
        context: "Primary coroutine test builder"
      - type: api_present
        value: "StandardTestDispatcher"
        context: "Test dispatcher we inject"
      - type: api_present
        value: "UnconfinedTestDispatcher"
        context: "Used for StateFlow collection in tests"
      - type: deprecation_scan
        value: "runBlockingTest"
        context: "Deprecated predecessor — we must not recommend it"
    on_failure: HIGH
---

# Coroutine Testing Patterns

## Overview

Patterns for testing coroutines in Kotlin Multiplatform projects, including virtual time control, StateFlow collection, and common pitfalls. Aligned with Google's nowinandroid approaches.

**Core Principle**: Tests should be deterministic, fast, and isolated. Use virtual time for coroutine tests to avoid flakiness.

---

## 1. Test Dependencies

```kotlin
// build.gradle.kts (commonTest)
kotlin {
    sourceSets {
        commonTest.dependencies {
            implementation(kotlin("test"))
            implementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.10.2")
        }
    }
}
```

---

## 2. Coroutine Testing Fundamentals

### TestScope and runTest

Always use `runTest` for coroutine tests. It provides virtual time control.

**DO:**
```kotlin
import kotlinx.coroutines.test.runTest
import kotlin.test.Test

class MyUseCaseTest {
    @Test
    fun `use case returns success`() = runTest {
        val repository = FakeRepository()
        val useCase = MyUseCase(repository)
        val result = useCase.invoke()
        assertTrue(result is Result.Success)
    }
}
```

**DON'T:**
```kotlin
// BAD: Using runBlocking -- no virtual time control, tests are slow and flaky
@Test
fun `use case returns success`() = runBlocking {
    val result = useCase.invoke()  // Waits real time for delays
}
```

### Time Advancement

```kotlin
@Test
fun `debounce waits before emitting`() = runTest {
    val flow = MutableSharedFlow<String>()
    val results = mutableListOf<String>()

    backgroundScope.launch(UnconfinedTestDispatcher()) {
        flow.debounce(500).collect { results.add(it) }
    }

    flow.emit("a")
    advanceTimeBy(400) // Not yet debounced
    assertEquals(0, results.size)

    advanceTimeBy(200) // Now debounced
    assertEquals(1, results.size)
}
```

---

## 3. Testing StateFlow Collection

### The Google Pattern (nowinandroid)

```kotlin
@Test
fun `state updates when data loads`() = runTest {
    val viewModel = MyViewModel(fakeRepository)

    // CRITICAL: Collect in backgroundScope to keep collection active
    backgroundScope.launch(UnconfinedTestDispatcher()) {
        viewModel.uiState.collect()
    }

    fakeRepository.emit(testData)
    assertEquals(UiState.Success(testData), viewModel.uiState.value)
}
```

**Why `backgroundScope`?**
- Automatically cancelled when the test ends
- Prevents `UncompletedCoroutinesError`
- Allows StateFlow to stay subscribed during the test

### Multiple StateFlows

```kotlin
@Test
fun `multiple states update correctly`() = runTest {
    val viewModel = SettingsViewModel(repository)

    backgroundScope.launch(UnconfinedTestDispatcher()) {
        viewModel.uiState.collect()
    }
    backgroundScope.launch(UnconfinedTestDispatcher()) {
        viewModel.isLoading.collect()
    }

    viewModel.loadSettings()
    advanceUntilIdle()

    assertFalse(viewModel.isLoading.value)
    assertTrue(viewModel.uiState.value is UiState.Success)
}
```

---

## 4. Common Pitfalls

### Don't Swallow CancellationException

```kotlin
// BAD: CancellationException caught and swallowed
viewModelScope.launch {
    try {
        repository.save(data)
    } catch (e: Exception) {
        _uiState.value = MyUiState.Error(UiText.DynamicString(e.message ?: "Error"))
    }
}

// GOOD: Always rethrow CancellationException
viewModelScope.launch {
    try {
        repository.save(data)
    } catch (e: CancellationException) {
        throw e  // ALWAYS rethrow
    } catch (e: Exception) {
        _uiState.value = MyUiState.Error(UiText.DynamicString(e.message ?: "Error"))
    }
}
```

### Don't Use `testScope.runTest` for Schedulers

```kotlin
// BAD: Separate TestScope + advanceTimeBy causes OOM with infinite loops
private val testScope = TestScope()

@Test
fun `scheduler loop test`() = testScope.runTest {
    val scheduler = BackgroundSyncScheduler(scope = testScope)
    scheduler.start()
    advanceTimeBy(10000)  // OOM: infinite loop runs forever
}

// GOOD: Use runTest scope directly, test via triggerNow()
@Test
fun `scheduler lifecycle test`() = runTest {
    val scheduler = BackgroundSyncScheduler(scope = this)
    scheduler.start()
    advanceUntilIdle()
    assertTrue(scheduler.state.value.isRunning)
    scheduler.stop()
}
```

### Always Stop Schedulers in Tests

```kotlin
@Test
fun `test with scheduler`() = runTest {
    val scheduler = createScheduler()
    scheduler.start()
    try {
        // Test logic...
    } finally {
        scheduler.stop()  // Ensure cleanup
    }
}
```

### Use @AfterTest for Cleanup

```kotlin
class SchedulerTest {
    private lateinit var scheduler: BackgroundSyncScheduler

    @BeforeTest
    fun setup() { scheduler = createScheduler() }

    @AfterTest
    fun teardown() { scheduler.stop() }
}
```

---

## References

- [nowinandroid testing](https://github.com/android/nowinandroid)
- [kotlinx-coroutines-test guide](https://kotlinlang.org/api/kotlinx.coroutines/kotlinx-coroutines-test/)
- [Testing Flows on Android](https://developer.android.com/kotlin/flow/test)
- See also: [testing-patterns-schedulers.md](testing-patterns-schedulers.md) for scheduler-specific testing
- Parent doc: [testing-patterns.md](testing-patterns.md)
