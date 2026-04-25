---
scope: standalone
version: 4
last_updated: "2026-04"
assumes_read: testing-hub
token_budget: 752
description: "Hub doc: Standard patterns for testing in Kotlin Multiplatform projects"
slug: testing-patterns
status: active
category: testing

---

# Testing Patterns for Kotlin Multiplatform

---

## Overview

This document defines standard patterns for testing in Kotlin Multiplatform projects, with special focus on testing coroutines, schedulers, and background tasks. These patterns are aligned with Google's official approaches in nowinandroid and other reference projects.

**Core Principle**: Tests should be deterministic, fast, and isolated. Use virtual time for coroutine tests to avoid flakiness.

### Key Rules

- Always use `runTest` for coroutine tests (never `runBlocking`)
- Pure-Kotlin fakes over mocks (fakes work in commonTest across all KMP targets)
- **Path A** (VM/stateIn): `UnconfinedTestDispatcher` for everything, collect in `backgroundScope` BEFORE actions
- **Path B** (infrastructure/startObserving): `backgroundScope` (StandardTestDispatcher) for CUT scope, `advanceUntilIdle()` after start
- **Path B2** (SharedFlow/no-replay): CoroutineScope(UnconfinedTestDispatcher(testScheduler)) for subscriber, no backgroundScope
- See [testing-patterns-dispatcher-scopes](testing-patterns-dispatcher-scopes.md) for decision tree and code examples
- Test schedulers via `triggerNow()`, NEVER test infinite loops directly
- Inject `testDispatcher` into UseCases (not `Dispatchers.Default`)
- Always rethrow `CancellationException` in catch blocks

---

## Sub-documents

This document is split into focused sub-docs for token-efficient loading:

- **[testing-patterns-coroutines](testing-patterns-coroutines.md)**: Coroutine test patterns -- runTest, TestScope, virtual time, StateFlow collection, common pitfalls
- **[testing-patterns-schedulers](testing-patterns-schedulers.md)**: Scheduler testing -- triggerNow pattern, lifecycle tests, backoff/retry, test configs, interruption scenarios
- **[testing-patterns-fakes](testing-patterns-fakes.md)**: Fake and test double patterns -- FakeRepository, FakeClock, FakeLogger, why fakes over mocks
- **[testing-patterns-coverage](testing-patterns-coverage.md)**: Coverage and CI patterns -- Kover config, coverage targets by layer, platform-specific tests, MainDispatcherRule
- **[testing-patterns-benchmarks](testing-patterns-benchmarks.md)**: Benchmark patterns -- dispatcher selection for coroutine benchmarks, androidx.benchmark vs kotlinx-benchmark, runTest vs runBlocking(Dispatchers.Default)
- **[testing-patterns-dispatcher-scopes](testing-patterns-dispatcher-scopes.md)**: Dispatcher scope patterns -- Path A (VM/stateIn) vs Path B (infrastructure/startObserving), shared testScheduler, anti-patterns

---

## Quick Reference

- Use `runTest` for all coroutine tests
- **Path A** (stateIn): `UnconfinedTestDispatcher` everywhere, collect in `backgroundScope`, assert immediately
- **Path B** (startObserving): `backgroundScope` for CUT, `advanceUntilIdle()` after start, before assert
- NEVER `CoroutineScope(UnconfinedTestDispatcher())` standalone outside `runTest`
- See [testing-patterns-dispatcher-scopes](testing-patterns-dispatcher-scopes.md) for decision tree
- See [testing-patterns-coroutines](testing-patterns-coroutines.md) for code examples
- See [testing-patterns-fakes](testing-patterns-fakes.md) for fake implementations

---

## References

- [nowinandroid testing](https://github.com/android/nowinandroid)
- [kotlinx-coroutines-test guide](https://kotlinlang.org/api/kotlinx.coroutines/kotlinx-coroutines-test/)
- [Kover documentation](https://kotlin.github.io/kotlinx-kover/)

---

**Status**: Active | **Last Validated**: March 2026 with kotlinx-coroutines-test 1.10.x / Kover 0.9.x
