---
scope: standalone
version: 1
last_updated: "2026-04"
assumes_read: testing-patterns
token_budget: 900
description: "Dispatcher scope patterns: Path A (VM/stateIn) vs Path B (infrastructure/startObserving), shared testScheduler rules, anti-patterns"
slug: testing-patterns-dispatcher-scopes
status: active
parent: testing-patterns
category: testing
---

# Dispatcher Scope Patterns

Two architectures exist for classes that expose reactive state. Each requires a different test setup. Pick the right path.

---

## Decision Tree

**Does your class use `scope.launch { flow.collect {} }` imperatively?**
- YES (startObserving, init { launch {} }) --> **Path B**
- NO (stateIn, combine, flow operators only) --> **Path A**

---

## Path A: ViewModel / stateIn (Google pattern)

For classes that use `stateIn(WhileSubscribed)` or `combine()` to expose StateFlow. Collection starts lazily when a test-side observer subscribes. This is the nowinandroid/androidify pattern.

### Dispatcher setup

`UnconfinedTestDispatcher` for everything — Main dispatcher, injected dispatchers, test-side collectors. All share the same testScheduler inside `runTest`.

```kotlin
// MainDispatcherRule — nowinandroid pattern
class MainDispatcherRule(
    private val testDispatcher: TestDispatcher = UnconfinedTestDispatcher(),
) : TestWatcher() {
    override fun starting(description: Description) = Dispatchers.setMain(testDispatcher)
    override fun finished(description: Description) = Dispatchers.resetMain()
}
```

### Test pattern

```kotlin
@get:Rule val mainDispatcherRule = MainDispatcherRule()

private lateinit var viewModel: MyViewModel

@Before
fun setup() {
    viewModel = MyViewModel(fakeRepository)  // No advanceUntilIdle() needed
}

@Test
fun `state updates when data loads`() = runTest {
    // 1. Collect in backgroundScope (eager — UnconfinedTestDispatcher)
    backgroundScope.launch(UnconfinedTestDispatcher()) {
        viewModel.uiState.collect()
    }

    // 2. Mutate upstream fakes
    fakeRepository.emit(testData)

    // 3. Assert immediately — no advancement needed
    assertEquals(UiState.Success(testData), viewModel.uiState.value)
}
```

### Why no advanceUntilIdle() after construction?

`stateIn(WhileSubscribed)` does not launch coroutines until a collector subscribes. The test-side `backgroundScope.launch(UnconfinedTestDispatcher()) { .collect() }` triggers the upstream chain eagerly.

### advanceUntilIdle() usage in Path A

Only needed after **multi-step mutations** that must settle before asserting:

```kotlin
viewModel.updateTopicSelection("1", isChecked = true)
viewModel.updateTopicSelection("1", isChecked = false)
advanceUntilIdle()  // Let both mutations settle
assertEquals(expected, viewModel.uiState.value)
```

---

## Path B: Infrastructure / startObserving (imperative pattern)

For classes that launch internal collectors via `startObserving()`, `init { launch { } }`, or any method that calls `scope.launch { flow.collect { } }`. The scope is injected.

### Dispatcher setup

- **Class-under-test scope**: `backgroundScope` (StandardTestDispatcher — the default)
- **Test-side collectors**: `UnconfinedTestDispatcher(testScheduler)` for observing output
- Both share the same testScheduler

### Test pattern

```kotlin
@Test
fun `internal observer receives updates`() = runTest {
    val controller = PluginNudgeController(
        scope = backgroundScope,  // StandardTestDispatcher — queues launches
        dawStateFlow = dawState,
        snapshotsFlow = snapshots,
    )

    controller.startObserving()
    advanceUntilIdle()  // REQUIRED: drain queued launches so collectors subscribe

    // Now internal collectors are active
    dawState.value = DawState.RUNNING
    advanceUntilIdle()

    assertEquals(expected, controller.state.value)
}
```

### Helper pattern (recommended)

```kotlin
private fun TestScope.createController(): PluginNudgeController {
    val controller = PluginNudgeController(scope = backgroundScope, ...)
    controller.startObserving()
    advanceUntilIdle()  // drain queued launches before test body
    return controller
}
```

### Why advanceUntilIdle() IS required here?

`StandardTestDispatcher` queues coroutine launches — it does NOT run them eagerly. Without `advanceUntilIdle()`, the internal collectors from `startObserving()` have not subscribed yet. Upstream emissions are missed and assertions use stale state.

### Timer-based assertions (Path B)

```kotlin
@Test
fun `nudge fires after delay`() = runTest {
    val controller = createController(nudgeDelay = 10.minutes)

    backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {
        controller.pluginNudge.collect { nudgeEvents.add(it) }
    }

    dawState.value = DawState.RUNNING
    advanceUntilIdle()

    advanceTimeBy(9.minutes)
    advanceUntilIdle()
    assertEquals(0, nudgeEvents.size)  // Not yet

    advanceTimeBy(1.minutes)
    advanceUntilIdle()
    assertEquals(1, nudgeEvents.size)  // Fired
}
```

## Path B2: SharedFlow-Emitting Infrastructure (no replay)

For infrastructure classes that emit via `MutableSharedFlow(replay = 0)`. The subscriber MUST be
active BEFORE the emission — unlike StateFlow, there is no replay buffer to catch late subscribers.

### Why NOT backgroundScope for SharedFlow CUT?

`backgroundScope` uses `StandardTestDispatcher`, which **queues** coroutine launches. When the
CUT emits to a SharedFlow, the subscriber launched via `backgroundScope` has not started yet
(it's queued). The emission is lost — SharedFlow has no replay.

### CUT scope: UnconfinedTestDispatcher(testScheduler)

```kotlin
@Test
fun `shared event is received`() = runTest {
    // CUT scope — UnconfinedTestDispatcher so subscriber is IMMEDIATELY active
    val cutScope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
    val eventBus = EventBus(scope = cutScope)

    val events = mutableListOf<Event>()
    backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {
        eventBus.events.collect { events.add(it) }
    }

    eventBus.emit(Event.Started)
    advanceUntilIdle()

    assertEquals(listOf(Event.Started), events)
    cutScope.cancel()  // cleanup
}
```

### Decision: Path B vs Path B2

| CUT exposes... | CUT scope | Why |
|----------------|-----------|-----|
| `StateFlow` (replay = 1) | `backgroundScope` (Standard) | Replay — late subscriber gets last value |
| `SharedFlow` (replay = 0) | `CoroutineScope(UnconfinedTestDispatcher(testScheduler))` | No replay — subscriber must be active before emit |

---

## Universal Rules (both paths)

### Shared testScheduler (MANDATORY)

All `TestDispatcher` instances in a test MUST share a single `testScheduler`. Inside `runTest`, dispatchers created without an explicit scheduler inherit the TestScope's scheduler automatically.

```kotlin
// CORRECT — both share testScheduler implicitly inside runTest
runTest {
    val standard = StandardTestDispatcher(testScheduler)
    val unconfined = UnconfinedTestDispatcher(testScheduler)
}
```

### PROHIBITED: standalone CoroutineScope outside runTest

```kotlin
// BAD — creates isolated scheduler, delay() has no virtual time control
val scope = CoroutineScope(UnconfinedTestDispatcher())  // WRONG
val controller = MyController(scope = scope)
```

This is the #1 cause of broken timer tests. The standalone scope has its own scheduler — `advanceTimeBy()` from the test's TestScope has no effect on it.

### BANNED: runTest(UnconfinedTestDispatcher())

NEVER pass `UnconfinedTestDispatcher` as the `runTest` parameter. This changes the **test body**
scheduler — `advanceUntilIdle()` and `advanceTimeBy()` become no-ops on the test body itself.
The test body scheduler must always be `StandardTestDispatcher` (the `runTest` default).

```kotlin
// BANNED — test body scheduler changed, time control broken
runTest(UnconfinedTestDispatcher()) { ... }

// CORRECT — only the CUT scope uses UnconfinedTestDispatcher
runTest {
    val cutScope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
    ...
}
```

### Behavioral difference (NOT time difference)

Both dispatchers share virtual time via `testScheduler`. The difference is **dispatch eagerness**:

| | StandardTestDispatcher | UnconfinedTestDispatcher |
|---|---|---|
| New coroutines | Queued — need advanceUntilIdle() | Started eagerly on current thread |
| delay() | Suspends — needs advanceTimeBy() | Suspends — needs advanceTimeBy() |
| Virtual time | Shared testScheduler | Shared testScheduler |
| Best for | Path B (imperative), concurrency ordering | Path A (stateIn), test-side collectors |

---

## Library Behavior Uncertainty

When encountering unexpected behavior from kotlinx-coroutines-test, Compose, Koin, or any library:

1. **Consult Context7 FIRST** via context-provider — get current documentation before guessing
2. Only fall back to empirical testing if Context7 does not cover the specific scenario
3. This avoids wasted QG cycles from fixing symptoms instead of understanding the API contract

> 3 QG cycles were lost in a related project because the official kotlinx-coroutines-test docs had the answer.

---

## References

- [Android coroutine testing guide](https://developer.android.com/kotlin/coroutines/test)
- [kotlinx-coroutines-test API](https://kotlinlang.org/api/kotlinx.coroutines/kotlinx-coroutines-test/)
- [nowinandroid testing](https://github.com/android/nowinandroid) (Path A reference)
- Parent doc: [testing-patterns.md](testing-patterns.md)
- See also: [testing-patterns-coroutines.md](testing-patterns-coroutines.md)
