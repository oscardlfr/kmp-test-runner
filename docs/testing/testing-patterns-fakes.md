---
scope: standalone
version: 1
last_updated: "2026-03"
assumes_read: testing-hub
token_budget: 1135
description: "Fake and test double patterns: FakeRepository, FakeClock, test DI, why fakes over mocks"
slug: testing-patterns-fakes
status: active
parent: testing-patterns

monitor_urls:
  - url: "https://github.com/Kotlin/kotlinx.coroutines/releases"
    type: github-releases
    tier: 2
category: testing
rules:
  - id: no-mocks-in-common-tests
    type: banned-import
    message: "Use pure Kotlin fakes in commonTest, not Mockito or MockK"
    detect:
      in_source_set: commonTest
      banned_import_prefixes:
        - "io.mockk"
        - "org.mockito"
      prefer: "pure Kotlin fake class"
    hand_written: false

---

# Fake and Test Double Patterns

## Overview

Patterns for creating pure-Kotlin fakes that work across all KMP targets. Fakes are preferred over mocks (MockK) because they work in commonTest, catch interface changes at compile time, and are self-documenting.

**Core Principle**: Pure-Kotlin fakes over mocks. Fakes implement the real interface -- the compiler catches any interface changes.

---

## 1. Why Fakes Over Mocks

Pure-Kotlin fakes work in commonTest across all KMP targets. MockK (1.14.7) only works on JVM. Fakes are self-documenting and catch interface changes at compile time.

**DON'T (Anti-pattern):**
```kotlin
// BAD: Mocks are JVM-only, don't work in commonTest, and don't catch interface changes
import io.mockk.mockk  // MockK 1.14.7 -- only available in jvmTest

@Test
fun `test with mock`() = runTest {
    val repository = mockk<SnapshotRepository>()
    every { repository.getSnapshots() } returns flowOf(listOf(snapshot1))

    // Mock doesn't break when repository interface changes -- you get runtime failures instead
}
```

**DO (Correct):**
```kotlin
// Fake implements the real interface -- compiler catches any interface changes
class FakeSnapshotRepository : SnapshotRepository {
    private val _snapshots = MutableStateFlow<List<Snapshot>>(emptyList())
    override fun observeSnapshots(): Flow<List<Snapshot>> = _snapshots
    fun setSnapshots(snapshots: List<Snapshot>) { _snapshots.value = snapshots }
}
```

**Key insight:** Fakes are compile-time safe, work in commonTest, and behave like the real implementation. Reserve MockK for legacy JVM-only tests where creating a fake is impractical.

---

## 2. Fake Clock

For time-dependent tests, use a controllable clock:

```kotlin
class FakeClock : Clock {
    private var currentTime = Instant.fromEpochMilliseconds(0L)

    override fun now(): Instant = currentTime

    fun advanceBy(millis: Long) {
        currentTime = Instant.fromEpochMilliseconds(
            currentTime.toEpochMilliseconds() + millis
        )
    }

    fun setTime(instant: Instant) {
        currentTime = instant
    }
}
```

---

## 3. Fake Repository Pattern

```kotlin
class FakeSnapshotRepository : SnapshotRepository {
    private val _snapshots = MutableStateFlow<List<Snapshot>>(emptyList())

    var deleteDelay: Long = 0L
    val deletedIds = mutableListOf<String>()

    override fun observeSnapshots(): Flow<List<Snapshot>> = _snapshots

    fun setSnapshots(snapshots: List<Snapshot>) {
        _snapshots.value = snapshots
    }

    override suspend fun deleteSnapshot(id: String): Result<Unit> {
        if (deleteDelay > 0) delay(deleteDelay)
        deletedIds.add(id)
        _snapshots.value = _snapshots.value.filterNot { it.id == id }
        return Result.Success(Unit)
    }
}
```

---

## 4. Fake Logger for Event Verification

```kotlin
data class LogEntry(
    val level: LogLevel,
    val event: LogEvent
)

class FakeEventLogger : EventLogger {
    val events = mutableListOf<LogEntry>()

    override fun info(event: LogEvent) {
        events.add(LogEntry(LogLevel.INFO, event))
    }

    override fun warning(event: LogEvent) {
        events.add(LogEntry(LogLevel.WARNING, event))
    }

    fun clear() {
        events.clear()
    }
}
```

---

## 5. Best Practices

- **One fake per interface**: Each domain interface gets a corresponding fake in the testing module
- **MutableStateFlow for observable state**: Use `MutableStateFlow` in fakes for data that the SUT observes
- **Test control methods**: Add methods like `setSnapshots()`, `setError()`, `advanceBy()` for test setup
- **Track interactions**: Use `val deletedIds = mutableListOf<String>()` to verify method calls without mocks
- **Simulated delays**: Use `var deleteDelay: Long = 0L` to simulate slow operations for interruption testing
- **Place in testing module**: Shared fakes go in `core/testing/` for reuse across feature test suites

---

## References

- [nowinandroid testing](https://github.com/android/nowinandroid) - Example fake implementations
- Parent doc: [testing-patterns.md](testing-patterns.md)
