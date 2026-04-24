---
scope: standalone
slug: testing-hub
status: active
category: testing
description: "Testing category hub: KMP testing patterns — runTest, fakes, coroutine dispatchers, coverage"
version: 1
last_updated: "2026-04"
---

# Testing

Standard patterns for testing Kotlin Multiplatform projects.

> Use `StandardTestDispatcher` injected via constructor — never `Dispatchers.Default` in tests.

## Documents

| Document | Description |
|----------|-------------|
| [testing-patterns](testing-patterns.md) | Hub: core testing patterns, test structure, quick reference |
| [testing-patterns-coroutines](testing-patterns-coroutines.md) | Coroutine testing — runTest, TestScope, StateFlow |
| [testing-patterns-fakes](testing-patterns-fakes.md) | Fake patterns — FakeRepository, FakeClock, why fakes over mocks |
| [testing-patterns-coverage](testing-patterns-coverage.md) | Coverage — Kover config, thresholds, platform tests |
| [testing-patterns-schedulers](testing-patterns-schedulers.md) | Scheduler testing — advancing time, virtual clocks |
| [testing-patterns-benchmarks](testing-patterns-benchmarks.md) | Benchmark patterns — dispatcher selection, androidx vs kotlinx-benchmark |
| [testing-patterns-dispatcher-scopes](testing-patterns-dispatcher-scopes.md) | Dispatcher scopes — Path A (stateIn/VM) vs Path B (startObserving), shared testScheduler |

## Key Rules

- Inject `CoroutineDispatcher` in ViewModels — switch via `testDispatcher` in tests
- Use fakes not mocks — pure Kotlin, no reflection, deterministic behavior
- Coverage threshold ≥80% on `commonMain`; per-module via Kover
