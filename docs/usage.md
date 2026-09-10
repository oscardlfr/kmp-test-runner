# Usage and recipes

`--project-root` defaults to the current directory. Start with a non-mutating inspection when adopting the tool in a new repository:

```sh
kmp-test doctor --json
kmp-test describe --json
kmp-test parallel --dry-run --json
```

## Unit and platform tests

```sh
# Auto-detected unit leg
kmp-test parallel --json

# Explicit targets
kmp-test parallel --test-type common --json
kmp-test parallel --test-type androidUnit --json
kmp-test parallel --test-type js --json
kmp-test parallel --test-type wasm --json

# macOS-only targets
kmp-test parallel --test-type ios --json
kmp-test parallel --test-type macos --json
```

`all` creates several concrete legs; it does not invoke a literal Gradle task named `all`. Platform-incompatible legs fail with typed errors instead of silently passing.

## Narrow the work

```sh
kmp-test parallel --module-filter "core-*,feature-login" --json
kmp-test parallel --test-filter "com.example.LoginTest" --json
kmp-test parallel --test-filter "com.example.LoginTest#invalidPassword" --json
kmp-test changed --staged-only --json
```

Module filters are runner filters. Test filters are translated to the target's supported Gradle or instrumentation mechanism. Run the subcommand help before using a test filter with benchmarks, where JVM benchmark tasks cannot accept Gradle `--tests`.

## Coverage

```sh
kmp-test parallel --coverage-tool auto --json
kmp-test coverage --min-missed-lines 25 --json
```

Without `--output-file`, reports are written below `.kmp-test-runner/reports/coverage/` using a run ID plus `latest.md`. A custom relative path is resolved from the project root.

## Android instrumented tests

```sh
kmp-test android --list-only --json
kmp-test android --device <serial> --json
kmp-test android --auto-retry --capture-on-fail --json
```

Failure capture is best-effort and forensic-only: it adds screenshot/UI-hierarchy paths to the envelope but never changes the underlying test exit code.

## Concurrent callers

The default project lock prevents two processes from racing over shared Gradle state. For intentional concurrency:

```sh
kmp-test parallel --isolated --json
```

See [Concurrency](concurrency.md) before combining isolation with a shared emulator or simulator.

## Project configuration

Stable defaults can live in `.kmp-test-runner.json`; command-line arguments win. Use `kmp-test <command> --help` and the [CLI reference](cli-reference.md) for supported flags. Runner-owned output belongs in `.kmp-test-runner/` and should normally be gitignored.

```gitignore
.kmp-test-runner/
.kmp-test-runner.lock
```
