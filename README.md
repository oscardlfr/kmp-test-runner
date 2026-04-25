# kmp-test-runner

Standalone parallel test runner for Kotlin Multiplatform and Android Gradle projects.

## Requirements

- Node.js 18+
- Either:
  - **Unix (Linux/macOS)**: bash
  - **Windows**: PowerShell 5.1+ (built-in) or pwsh 7+
- JDK 17+ and Gradle 8+ on the target project

<!-- TODO: finalize in sub-wave c -->
## Install

```sh
npm install -g kmp-test-runner
```

<!-- TODO: finalize in sub-wave c -->
## Usage

```sh
# Run all tests in parallel with coverage
kmp-test parallel --project-root /path/to/project

# Run only changed modules
kmp-test changed --project-root /path/to/project

# Run Android instrumented tests
kmp-test android --project-root /path/to/project

# Run benchmarks
kmp-test benchmark --project-root /path/to/project

# Generate coverage report only (skip test run)
kmp-test coverage --project-root /path/to/project
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
