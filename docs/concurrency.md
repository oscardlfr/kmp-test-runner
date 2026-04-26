# Concurrency model — kmp-test-runner

> Status: **Tier 1 shipped** in v0.3.8 (2026-04-26). Tier 2 (full audit + matrix) and Tier 3 (`--isolated`) are still queued — see [BACKLOG.md](../BACKLOG.md#concurrent-invocation-safety-multi-agent-scenarios).

## When this matters

Multiple `kmp-test` invocations against the **same project root** at the same time. Common scenarios:

- Two AI agents working in the same repo (one running `kmp-test parallel`, another running `kmp-test changed`).
- Human + agent overlap (developer running tests locally while an automated workflow fires).
- CI matrix shards that share a build cache.

If your runs target *different* project roots, none of this applies — you're already isolated.

> **Same-host coordination only.** The lockfile is filesystem-local. Cross-host coordination (CI agents on different runners reading shared blob storage) needs a real lock manager — out of scope.

## What v0.3.8 fixes (Tier 1)

### Advisory lockfile

On every spawning subcommand (`parallel`, `changed`, `android`, `benchmark`, `coverage`) the CLI:

1. Reads `<project>/.kmp-test-runner.lock` if it exists.
2. **No lock found** → writes its own (`{schema:1, pid, start_time, subcommand, project_root, version}` JSON), proceeds.
3. **Lock found, holder PID alive** → refuses with exit code `3` (`ENV_ERROR`). Stderr prints PID + age + subcommand. `--json` mode emits `errors[].code = "lock_held"`.
4. **Lock found, holder PID dead** (e.g. previous run was killed `-9`) → reclaims silently and proceeds.
5. **Lock found but unparseable** → reclaims silently and proceeds.

Cleanup is automatic on:

- Normal `process.exit` (success or failure path).
- `SIGINT` (Ctrl-C) — handler removes the lock, then exits 130.
- `SIGTERM` — handler removes the lock, then exits 143.
- `uncaughtException` — last-resort cleanup before exit 1.

### `--force` — deliberate concurrent runs

When you actually want two runs to overlap (e.g. debug session alongside CI smoke), pass `--force`:

```sh
kmp-test parallel --force
```

`--force` writes a new lockfile reflecting your invocation, so a third arrival still sees coherent state.

### `doctor` and `--dry-run` skip the lock

These are read-only — no gradle spawn, no report writes — so coordinating them adds no value:

```sh
kmp-test doctor              # no lock acquired, runs even if a parallel run holds the lock
kmp-test parallel --dry-run  # no lock acquired, prints the resolved plan and exits
```

### Run-id naming

Every run computes a run-id of the form `YYYYMMDD-HHMMSS-PID6` (zero-padded last 6 digits of PID) and uses it to name:

| File                                                | Default                                       | v0.3.8 versioned form                                |
|-----------------------------------------------------|-----------------------------------------------|------------------------------------------------------|
| Coverage report (parallel/coverage)                 | `<project>/coverage-full-report.md`           | `<project>/coverage-full-report-<run-id>.md`         |
| Benchmark report                                    | `<project>/benchmark-report.md`               | `<project>/benchmark-report-<run-id>.md`             |
| Gradle parallel-test temp log                       | `${TMPDIR}/gradle-parallel-tests-<ts>.log`    | `${TMPDIR}/gradle-parallel-tests-<run-id>.log`       |

The legacy stable filenames are kept as a "last finished run" mirror copy so existing consumers keep working — last writer wins, no corruption from interleaved writes.

## What's still in scope (Tier 2 / Tier 3)

### Tier 2 — full collision audit + matrix (queued)

The Tier 1 ship audited the most-likely collision paths. A complete pass against every output path in `scripts/sh/` and `scripts/ps1/` would surface anything still subtly racy. The deliverable is a subcommand × resource × outcome matrix (e.g. "`android` + `--device` auto-detect" against two parallel runs → both pick `emulator-5554`, tests interleave).

### Tier 3 — `--isolated` (queued)

Even with Tier 1 lockfile, two runs targeting the same project still share Gradle's daemon and `.gradle/` build cache. Gradle's own lockfile makes this *correct* (no corruption) but *slow* (second run waits). `--isolated` would inject `--project-cache-dir <tmp>` into every Gradle invocation, giving each run its own cache. Slower (no warm cache) but truly parallel-safe. Ideal for CI multi-agent fan-out where you'd rather burn CPU than serialize.

## Out of scope

- Cross-host coordination (use a real lock manager — Redis, etcd, etc.).
- Gradle-internal concurrency tuning beyond `--project-cache-dir`.
- Rewriting the daemon model.

## Reference

The lockfile JSON schema:

```json
{
  "schema": 1,
  "pid": 12345,
  "start_time": "2026-04-26T13:42:11.123Z",
  "subcommand": "parallel",
  "project_root": "C:\\path\\to\\project",
  "version": "0.3.8"
}
```

Stable in `schema: 1` for v0.3.x. Future shape changes will bump the schema number — readers should refuse unknown schemas instead of misinterpreting them.
