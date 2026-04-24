# kmp-test-runner

Generic parallel test runner for Kotlin Multiplatform and Android Gradle projects. Ships as an npm CLI, Gradle plugin, and shell installer. Apache-2.0.

## Install

[TODO: finalize in sub-wave c]

Planned install methods:
- **npm CLI** — `npm install -g kmp-test-runner`
- **Gradle plugin** — `plugins { id("io.github.oscardlfr.kmp-test-runner") version "0.2.0" }`
- **Shell installer** — `curl -fsSL .../install.sh | bash`

## Usage

[TODO: finalize in sub-wave c]

Planned CLI subcommands:
- `kmp-test parallel --project-root <path>` — run all tests in parallel with coverage
- `kmp-test changed --project-root <path>` — run tests only for modules with uncommitted changes
- `kmp-test android --project-root <path>` — run Android instrumented tests
- `kmp-test benchmark --project-root <path>` — run benchmark suites
- `kmp-test coverage --project-root <path>` — generate coverage report (skips test execution)

## License

Apache-2.0 — see [LICENSE](./LICENSE).
