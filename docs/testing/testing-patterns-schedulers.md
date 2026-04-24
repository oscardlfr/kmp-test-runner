---
scope: standalone
version: 1
last_updated: "2026-03"
assumes_read: testing-hub
token_budget: 1391
monitor_urls:
  - url: "https://github.com/Kotlin/kotlinx.coroutines/releases"
    type: github-releases
    tier: 1
description: "Scheduler testing patterns: triggerNow, lifecycle tests, backoff/retry, test configs, interruption scenarios"
slug: testing-patterns-schedulers
status: active
parent: testing-patterns
category: testing
rules:
  - id: no-default-dispatcher-in-tests
    type: banned-usage
    message: "Tests must inject TestDispatcher; never use Dispatchers.Default directly"
    detect:
      in_source_set: commonTest
      banned_expression: "Dispatchers.Default"
      prefer: "injected testDispatcher parameter"
    hand_written: false

---

# Scheduler Testing Patterns

## Overview

Patterns for testing background schedulers that use infinite loops. The key insight: test outcomes via `triggerNow()`, never the infinite loop directly.

**Core Principle**: Test schedulers via explicit trigger methods, not by running the infinite loop. Testing infinite loops directly causes OutOfMemoryError.

---

## 1. The Problem with Infinite Loops

Schedulers often have infinite loops:

```kotlin
class BackgroundSyncScheduler(private val scope: CoroutineScope) {
    fun start() {
        scope.launch {
            while (isActive) {  // INFINITE LOOP
                delay(interval)
                performSync()
            }
        }
    }
}
```

**Testing infinite loops directly causes OutOfMemoryError** because `advanceTimeBy` triggers the loop repeatedly.

## 2. Solution: Test Outcomes, Not the Loop

Instead of testing the infinite loop, test through explicit trigger methods:

```kotlin
class BackgroundSyncScheduler(...) {
    fun start() { /* while(isActive) loop */ }

    // Explicit trigger (easy to test)
    suspend fun triggerNow() {
        if (shouldSync()) {
            performSync()
        }
    }
}
```

```kotlin
@Test
fun `triggerNow performs sync when online`() = runTest {
    networkMonitor.setOnline(true)
    scheduler.triggerNow()
    assertTrue(logger.events.any { it.event == "sync_triggered" })
}

@Test
fun `triggerNow skips sync when offline`() = runTest {
    networkMonitor.setOnline(false)
    scheduler.triggerNow()
    assertTrue(logger.events.any { it.event == "sync_skipped_offline" })
}
```

## 3. Testing Lifecycle (Start/Stop)

```kotlin
@Test
fun `start sets isRunning to true`() = runTest {
    scheduler.start()
    assertTrue(scheduler.state.value.isRunning)
    scheduler.stop()
}

@Test
fun `stop cancels the scheduler job`() = runTest {
    scheduler.start()
    advanceUntilIdle()
    scheduler.stop()
    assertFalse(scheduler.state.value.isRunning)
}

@Test
fun `start is idempotent`() = runTest {
    scheduler.start()
    advanceUntilIdle()
    logger.clear()

    scheduler.start() // Second call should be no-op
    assertFalse(logger.events.any { it.event == "scheduler_started" })

    scheduler.stop()
}
```

## 4. Testing Backoff and Retry Logic

```kotlin
@Test
fun `consecutive failures increase backoff`() = runTest {
    fakeSyncManager.syncResult = Result.Error(RuntimeException("Error"))

    val scheduler = BackgroundSyncScheduler(
        syncManager = fakeSyncManager,
        scope = this,
        config = BackgroundSyncSchedulerConfig.TEST
    )

    scheduler.triggerNow()
    assertEquals(1, scheduler.state.value.consecutiveFailures)

    fakeClock.advanceBy(config.minIntervalMs + 1)
    scheduler.triggerNow()
    assertEquals(2, scheduler.state.value.consecutiveFailures)

    scheduler.stop()
}

@Test
fun `success resets failure count`() = runTest {
    fakeSyncManager.syncResult = Result.Error(RuntimeException("Error"))

    val scheduler = BackgroundSyncScheduler(
        syncManager = fakeSyncManager,
        scope = this,
        config = BackgroundSyncSchedulerConfig.TEST
    )

    scheduler.triggerNow()
    assertEquals(1, scheduler.state.value.consecutiveFailures)

    fakeClock.advanceBy(config.minIntervalMs + 1)
    fakeSyncManager.syncResult = Result.Success(SyncState())
    scheduler.triggerNow()
    assertEquals(0, scheduler.state.value.consecutiveFailures)

    scheduler.stop()
}
```

## 5. Test-Specific Configurations

```kotlin
data class BackgroundSyncSchedulerConfig(
    val syncIntervalMs: Long = 15 * 60 * 1000L,  // 15 minutes
    val minIntervalMs: Long = 60 * 1000L,         // 1 minute
    val maxBackoffMs: Long = 60 * 60 * 1000L      // 1 hour
) {
    companion object {
        val DEFAULT = BackgroundSyncSchedulerConfig()
        val TEST = BackgroundSyncSchedulerConfig(
            syncIntervalMs = 1000L,    // 1 second
            minIntervalMs = 100L,      // 100ms
            maxBackoffMs = 5000L       // 5 seconds
        )
    }
}
```

## 6. Test Scope Injection

```kotlin
@Test
fun `scheduler uses injected scope`() = runTest {
    val scheduler = BackgroundSyncScheduler(
        syncManager = fakeSyncManager,
        scope = this,  // <-- Inject runTest scope
        config = BackgroundSyncSchedulerConfig.TEST
    )
    // Test behavior...
    scheduler.stop()
}
```

## 7. Testing Interruption Scenarios

```kotlin
@Test
fun `cleanup is interrupted when DAW opens`() = runTest {
    val scheduler = createCleanupScheduler()
    fakeRepository.setSnapshots(listOf(snap1, snap2, snap3))
    fakeRepository.deleteDelay = 500L

    fakeCoordinator.setStableMode(ProcessingMode.FullSpeed)
    scheduler.start()

    advanceTimeBy(5600)

    // Interrupt mid-cleanup
    fakeCoordinator.setStableMode(ProcessingMode.Silent)
    advanceUntilIdle()

    val stats = scheduler.lastCleanupStats.value
    assertTrue(stats?.wasInterrupted == true || fakeRepository.deletedIds.size < 3)

    scheduler.stop()
}
```

---

- See also: [testing-patterns-coroutines.md](testing-patterns-coroutines.md) for core coroutine testing
- Parent doc: [testing-patterns.md](testing-patterns.md)
