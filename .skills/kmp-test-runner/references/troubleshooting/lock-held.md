# `lock_held` — another `kmp-test` invocation is active for this project

`kmp-test` holds a per-project advisory lockfile at `<project-root>/.kmp-test-runner/runner.lock` while a subcommand is running. When a second invocation hits the same `--project-root`, it exits with `ENV_ERROR` (3) and `errors[0].code: "lock_held"` rather than racing on the shared gradle cache. The error envelope tells the user how to recover.

## Symptom

```json
{
  "exit_code": 3,
  "errors": [{
    "code": "lock_held",
    "message": "another kmp-test (parallel) is already running with PID 15512 (started 4m25s ago). Options: (a) wait for it to finish; (b) run with --isolated-cache-dir <path> to use a separate gradle cache and skip the lock; (c) run with --project-root <other-path> against a different project; (d) pass --force to bypass (risks gradle cache races if both runs touch the same modules)."
  }]
}
```

Applies to `parallel`, `coverage`, `changed`, `android`, `benchmark` (every subcommand that spawns gradle). `doctor` and `--dry-run` skip the lockfile probe and never emit this code.

## Why it exists

The gradle daemon serialises invocations against the same `--project-cache-dir`, but two concurrent `kmp-test` runs can still corrupt:

- gradle's local model and configuration cache (when both runs write/read the same `.gradle/` tree)
- the project-model cache at `.kmp-test-runner/cache/project-model.json`
- ADB / iOS simulator state shared by the host

The lockfile preempts those races with an explicit, actionable error before any gradle work starts.

## Root causes (ranked)

1. **Genuine concurrent runs**: a CI matrix, two terminal tabs, or a watcher fired a second `kmp-test` while the first is still working. Common and benign — the lock is doing its job.
2. **Stale lock from a killed process**: `acquireLock` reclaims locks whose recorded PID is dead, so this is rare. If it happens, the wrapper prints `stale lockfile reclaimed (previous PID was dead)` and continues. If it does NOT reclaim, the OS still reports the PID as live (the kernel may not have cleared it yet, or another unrelated process recycled the PID — bad luck).
3. **Deliberate parallel use against the same project**: agentic workflows that want two concurrent runs against the same checkout. The default lock-held error is correct for that intent — the user needs to opt into a bypass.

## Recovery path

Branch by intent:

- **You actually want to wait.** Let the first run finish. Re-run when it exits.
- **You want two concurrent runs against this project.** Pass `--isolated-cache-dir <unique-path>` on at least one of them. The cache-dir flag puts each run in its own gradle cache tree, so the shared-cache race the lockfile guards against can't happen — and the dispatcher therefore skips the lockfile probe for that run.
- **You want to run a different project.** Pass `--project-root <other-checkout>`. Each project has its own lockfile.
- **You believe the lock is stale and reclaim didn't fire.** Verify with `kmp-test doctor --project-root <path>` (it does NOT take the lock) and inspect `.kmp-test-runner/runner.lock` yourself. If the recorded PID is dead and you trust the assessment, pass `--force` to bypass. Use sparingly — if the lock is genuinely held, `--force` lets both runs race on the gradle cache.

## Recovery commands

```bash
# Wait — re-run after the first finishes
kmp-test parallel --project-root /path/to/project --json

# Two concurrent runs against the same checkout
kmp-test parallel --project-root /path/to/project --isolated-cache-dir /tmp/cache-A --json &
kmp-test parallel --project-root /path/to/project --isolated-cache-dir /tmp/cache-B --json

# Different project — independent lock
kmp-test parallel --project-root /path/to/other-project --json

# Force-bypass a believed-stale lock (verify first)
kmp-test doctor --project-root /path/to/project --json
cat /path/to/project/.kmp-test-runner/runner.lock
kmp-test parallel --project-root /path/to/project --force --json
```

```pwsh
# Wait — re-run after the first finishes
kmp-test parallel --project-root C:\path\to\project --json

# Two concurrent runs against the same checkout (PowerShell job pattern)
Start-Job { kmp-test parallel --project-root C:\path\to\project --isolated-cache-dir C:\Temp\cache-A --json }
kmp-test parallel --project-root C:\path\to\project --isolated-cache-dir C:\Temp\cache-B --json

# Verify and force-bypass (last resort)
kmp-test doctor --project-root C:\path\to\project --json
Get-Content C:\path\to\project\.kmp-test-runner\runner.lock
kmp-test parallel --project-root C:\path\to\project --force --json
```

## See also

- [`../cli/envelope-schema.md#errors-discriminated-codes`](../cli/envelope-schema.md#errors-discriminated-codes) — full code table
- [`../cli/exit-codes.md`](../cli/exit-codes.md) — `errors[].code` → `exit_code` mapping (`lock_held` → `ENV_ERROR` / 3)
- [`isolated-runtime-race.md`](isolated-runtime-race.md) — sibling guard for runtime races `--isolated` can't isolate (ADB / iOS sim)
- [`overview.md`](overview.md) — troubleshooting hub
