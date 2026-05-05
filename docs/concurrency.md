# Concurrency model — kmp-test-runner

> Status: **Tier 1 shipped** in v0.3.8 (2026-04-26). **Tier 2 collision matrix shipped** in v0.8.1 (locked contract — see below). Tier 3 (`--isolated`) is still queued — see [BACKLOG.md](../BACKLOG.md#concurrent-invocation-safety-multi-agent-scenarios).

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

#### Signal delivery — when the handler actually fires

The handlers above run only if the OS delivers the signal to Node. Delivery is OS- and shell-specific:

| Environment                                                         | Result                                                                                       |
|---------------------------------------------------------------------|----------------------------------------------------------------------------------------------|
| Linux / macOS — any terminal, `Ctrl-C` or `kill <pid>`              | UNIX signals propagate normally. SIGINT + SIGTERM handlers fire, cleanup runs.               |
| Windows native console (cmd, Windows Terminal, IDE, PowerShell)     | `Ctrl-C` produces `CTRL_C_EVENT`; libuv translates it to a JS `'SIGINT'`. Handler fires.     |
| Windows under MinGW / Cygwin / Git Bash, `kill <pid>` (SIGTERM)     | MinGW invokes `TerminateProcess` with shutdown semantics. libuv emits `'SIGTERM'`. Handler fires. |
| Windows under MinGW / Cygwin / Git Bash, `kill -INT $bg_pid`        | The `&`-backgrounded process is detached from bash's console group, so `CTRL_C_EVENT` can't reach it. Node never sees `'SIGINT'`. Handler does **not** fire — lockfile may remain stale. |
| Process killed with `kill -9` / `taskkill /F` / power loss          | No signal delivered, no handler fires. Lockfile remains stale.                               |

**Stale-lock reclaim is the safety net.** When the cleanup handler does not fire for any reason, the next `kmp-test` invocation reads the orphan lockfile, checks the holder PID via `process.kill(pid, 0)`, finds it dead, and reclaims silently. No manual cleanup is needed — concurrent safety self-heals on the next run.

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

## Tier 2 — collision matrix (v0.8.1)

The full subcommand × resource × outcome matrix. This locks the v0.8.1 contract — what each shared resource produces under collision today, and which tier mitigates it. Future Tier 3 (`--isolated`) work flips the "deferred" rows to "isolated via `--isolated`"; until then, the rows below are the canonical reference.

| Subcommand | Resource | Collision behaviour | Mitigation status |
|---|---|---|---|
| `parallel` / `coverage` | `coverage-full-report.md` (mirror copy) | last-writer wins on the stable name; per-run `coverage-full-report-<run-id>.md` preserved alongside | **Tier 1** (v0.3.8 — versioned filenames) |
| `parallel` / `coverage` | `coverage-full-report-<run-id>.md` (versioned) | unique run-id segment — never collides | **Tier 1** (v0.3.8) |
| `benchmark` | `benchmark-report.md` (mirror copy) | last-writer wins on the stable name; per-run `benchmark-report-<run-id>.md` preserved alongside | **Tier 1** (v0.3.8) |
| `benchmark` | `benchmark-report-<run-id>.md` (versioned) | unique run-id segment — never collides | **Tier 1** (v0.3.8) |
| `parallel` / `coverage` | `${TMPDIR}/gradle-parallel-tests-<run-id>.log` | unique run-id segment — never collides | **Tier 1** (v0.3.8) |
| `android` | `emulator-5554` (single attached device) | both runs share the device — instrumented tests interleave on-device, last-writer wins on `connectedAndroidTest` HTML report | **Tier 3** (`--isolated` + `--device-pool`) deferred |
| `changed` | `git status` / `git diff` snapshot | each run computes the changed-module set independently — modules diverge if files change between snapshots | inherent race — agents should snapshot files before parallel runs |
| `*` | `.gradle/` daemon + build cache | Gradle serialises internally on the configuration cache lock — *correct* (no corruption) but *slow* under contention | **Tier 3** (`--isolated` injects `--project-cache-dir <tmp>`) deferred |
| `*` | `.kmp-test-runner.lock` (advisory) | second invocation refused with exit `3` + `errors[].code = "lock_held"`; `--force` overrides | **Tier 1** (v0.3.8) |
| `*` | `<project>/.kmp-test-runner/` config-derived defaults | read-only; multiple runs read independently | not applicable — read-only |

Out of the matrix above, the only currently-unmitigated paths are `android` device sharing and `.gradle/` daemon contention. Both are gated by Tier 3 (`--isolated`).

## Tier 3 — `--isolated` (queued)

Even with Tier 1 lockfile + Tier 2's matrix lock, two runs targeting the same project still share Gradle's daemon and `.gradle/` build cache. Gradle's own lockfile makes this *correct* (no corruption) but *slow* (second run waits). `--isolated` would inject `--project-cache-dir <tmp>` into every Gradle invocation, giving each run its own cache. Slower (no warm cache) but truly parallel-safe. Ideal for CI multi-agent fan-out where you'd rather burn CPU than serialize.

`--isolated` would also handle the `android` device-sharing case via a `--device-pool` companion flag (round-robin attached devices when more than one is connected; refuse-with-exit-3 when only one is attached and another run holds it).

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
