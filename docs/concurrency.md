# Concurrency and artifact ownership

`kmp-test` protects a project from accidental overlapping runs and provides opt-in cache isolation for intentional parallel callers.

## Default lock

A mutating test/benchmark invocation acquires `<project>/.kmp-test-runner.lock`. A second caller fails with exit 3 and `errors[].code = "lock_held"` instead of interleaving writes. `--force` bypasses the check and should be used only after confirming the previous owner is gone.

Read-only commands and previews do not take the lock:

```sh
kmp-test doctor --json
kmp-test describe --skip-probe --json
kmp-test parallel --dry-run --json
```

## Intentional parallelism

```sh
kmp-test parallel --isolated --json
```

`--isolated` assigns a run-scoped Gradle project cache under `.kmp-test-runner/cache-isolated/<run-id>`. `--isolated-cache-dir` chooses another location. `--isolated-no-lock` disables the runner's isolation-cache lock and is appropriate only when an external scheduler owns exclusivity.

Isolation does not make shared hardware independent. Two sessions can still race on one emulator, connected device, simulator, external service, or consumer-owned build output. Pin separate ADB serials and do not run Apple/device legs concurrently unless the surrounding infrastructure is partitioned.

## Runner-owned artifacts

| Artifact | Current default |
|---|---|
| Coverage markdown | `.kmp-test-runner/reports/coverage/<run-id>.md` plus `latest.md` |
| Android logs/captures | `.kmp-test-runner/logs/android/<run-id>/` |
| Benchmark logs | `.kmp-test-runner/logs/benchmark/<run-id>/` |
| Project-model cache | `.kmp-test-runner/cache/` |
| Isolated Gradle cache | `.kmp-test-runner/cache-isolated/<run-id>/` |
| Generated init scripts | `.kmp-test-runner/init-scripts/` |

Runner outputs are namespaced by run ID where concurrent attribution matters. Consumer-owned Gradle reports under module `build/` directories remain Gradle's responsibility.

Use `kmp-test clean --dry-run --json` to inspect cleanup and `kmp-test clean --all --json` to include caches. A configurable root for all runner-owned artifacts remains unimplemented and is tracked in [BACKLOG.md](../BACKLOG.md).

## Exit-code invariant

Concurrency controls must not mask the underlying outcome. The final envelope's top-level `exit_code` and the process status agree; warnings/errors retain typed codes. See the [envelope contract](envelope-contract.md).
