---
scope: standalone
version: 1
last_updated: "2026-03"
assumes_read: testing-hub
token_budget: 1015
description: "Coverage strategy, platform-specific tests, Kover configuration, and CI patterns"
slug: testing-patterns-coverage
status: active
parent: testing-patterns

category: testing
---

# Coverage and Platform Testing Patterns

## Overview

Coverage targets by architectural layer, platform-specific test organization, Android MainDispatcherRule, and coverage workflow integration with Kover.

**Core Principle**: Cover behavior, not lines. Focus coverage effort on domain and data layers where bugs are most impactful.

---

## 1. Platform-Specific Tests

### 1.1 Source Set Organization

```
module/
├── src/
│   ├── commonMain/
│   ├── commonTest/           # Shared tests
│   ├── desktopMain/
│   ├── desktopTest/          # Desktop-only tests
│   ├── androidMain/
│   └── androidUnitTest/      # Android-only tests
```

### 1.2 Android-Specific: MainDispatcherRule

For Android ViewModels that use `Dispatchers.Main`:

```kotlin
// In testing module
class MainDispatcherRule(
    private val testDispatcher: TestDispatcher = UnconfinedTestDispatcher()
) : TestWatcher() {
    override fun starting(description: Description) {
        Dispatchers.setMain(testDispatcher)
    }

    override fun finished(description: Description) {
        Dispatchers.resetMain()
    }
}

// In tests
class ViewModelTest {
    @get:Rule
    val mainDispatcherRule = MainDispatcherRule()

    @Test
    fun `viewModel updates state`() = runTest {
        // Dispatchers.Main is now testDispatcher
    }
}
```

---

## 2. Coverage Strategy

> For Kover setup, Gradle tasks, report structure, and skill integration, see [gradle-patterns.md SS 6](gradle-patterns.md#6-kover-coverage-configuration).

### 2.1 Coverage Targets by Layer

| Layer | Target | Rationale |
|-------|--------|-----------|
| Domain (UseCases) | 90%+ | Pure logic, fully testable, highest ROI |
| Data (Repositories) | 80%+ | Data transformation, caching, error paths |
| ViewModel | 80%+ | State transitions, event handling |
| Model | 70%+ | Mostly data classes; test validation/computed props |
| Platform (expect/actual) | 60%+ | Integration tests, harder to unit test |
| UI (Compose/SwiftUI) | Skip | Screenshot tests or manual QA |

### 2.2 What to Test

| Component | Test Focus |
|-----------|------------|
| UseCase | Input/output, error handling, edge cases |
| Repository | Data transformation, caching logic |
| ViewModel | State transitions, UI events |
| Scheduler | Start/stop, trigger conditions, error recovery |
| DataSource | CRUD operations, query results |

### 2.3 What NOT to Test Directly

- Infinite loops (test via trigger methods)
- DI module wiring (integration tests)
- Generated code (mappers, serializers)
- Platform-specific implementations (use integration tests)

---

## 3. Coverage Workflow

```
1. Write/modify code
2. Run tests:          /test  or  /test-full
3. Check coverage:     /coverage --module-filter "core:domain"
4. Find gaps:          /coverage-full --min-lines 5
5. Auto-generate:      /auto-cover
6. Verify threshold:   ./gradlew koverVerify
```

### 3.1 Meaningful Coverage Guidelines

- **Cover behavior, not lines**: A test that asserts the right output for meaningful inputs is worth more than one that just executes code paths
- **Error paths matter**: Network failures, invalid data, and cancellation are where bugs live
- **Don't chase 100%**: Diminishing returns past 90%. Focus on domain and data layers
- **Missed lines report**: Use `/coverage --min-lines 5` to focus on files with real gaps, not single-line misses

---

## References

- [Kover documentation](https://kotlin.github.io/kotlinx-kover/)
- [nowinandroid testing](https://github.com/android/nowinandroid)
- Parent doc: [testing-patterns.md](testing-patterns.md)
