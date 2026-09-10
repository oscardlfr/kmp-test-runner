# Concurrency model — kmp-test-runner

> Status: **Tier 1 shipped** in v0.3.8 (2026-04-26). **Tier 2 collision matrix shipped** in v0.8.1. **Tier 3 (`--isolated`) shipped** in v0.9 (2026-05-05) — opt-in `--project-cache-dir <tmp>` injection for true parallel multi-agent fan-out.

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

The full subcommand × resource × outcome matrix. Each shared resource has a documented collision behaviour and the tier that mitigates it.

| Subcommand | Resource | Collision behaviour | Mitigation status |
|---|---|---|---|
| `parallel` / `coverage` | `coverage-full-report.md` (mirror copy) | last-writer wins on the stable name; per-run `coverage-full-report-<run-id>.md` preserved alongside | **Tier 1** (v0.3.8 — versioned filenames) |
| `parallel` / `coverage` | `coverage-full-report-<run-id>.md` (versioned) | unique run-id segment — never collides | **Tier 1** (v0.3.8) |
| `benchmark` | `benchmark-report.md` (mirror copy) | last-writer wins on the stable name; per-run `benchmark-report-<run-id>.md` preserved alongside | **Tier 1** (v0.3.8) |
| `benchmark` | `benchmark-report-<run-id>.md` (versioned) | unique run-id segment — never collides | **Tier 1** (v0.3.8) |
| `parallel` / `coverage` | `${TMPDIR}/gradle-parallel-tests-<run-id>.log` | unique run-id segment — never collides | **Tier 1** (v0.3.8) |
| `android` | single attached device (`emulator-5554` etc.) | both runs share the device — instrumented tests interleave on-device, last-writer wins on `connectedAndroidTest` HTML report | inherent for single-device hosts; multi-device fan-out via `--device <serial>` per run |
| `changed` | `git status` / `git diff` snapshot | each run computes the changed-module set independently — modules diverge if files change between snapshots | inherent race — agents should snapshot files before parallel runs |
| `*` | `.gradle/` daemon + build cache | Gradle serialises internally on the configuration cache lock — *correct* (no corruption) but *slow* under contention | **Tier 3** (`--isolated` injects `--project-cache-dir <tmp>` — v0.9) |
| `*` | `.kmp-test-runner.lock` (advisory) | second invocation refused with exit `3` + `errors[].code = "lock_held"`; `--force` overrides | **Tier 1** (v0.3.8); `--isolated-no-lock` opts out (Tier 3 — v0.9) |
| `*` | `<project>/.kmp-test-runner/` config-derived defaults | read-only; multiple runs read independently | not applicable — read-only |

## Tier 3 — `--isolated` (v0.9)

Even with Tier 1 lockfile, two runs targeting the same project share Gradle's daemon + per-project `.gradle/` (configuration cache, build outputs). Gradle's own lockfile makes this *correct* (no corruption) but *slow* (second run waits). `--isolated` injects `--project-cache-dir <tmp>` into every gradle spawn, giving each run its own cache dir. Slower (no warm cache) but truly parallel-safe. Ideal for CI multi-agent fan-out where you'd rather burn CPU than serialize.

### Flags

| Flag | Effect |
|---|---|
| `--isolated` | Inject `--project-cache-dir <project>/.kmp-test-runner/cache-isolated/<runId>` into every gradle spawn. The runId dir is auto-removed after the run. |
| `--isolated-cache-dir <path>` | Use `<path>` instead of the default. Implies `--isolated`. The dir is treated as user-owned — it is **never** auto-removed. Useful for CI tmpfs / RAM-disk pinning. |
| `--isolated-no-lock` | Bypass the Tier 1 advisory lockfile (`.kmp-test-runner.lock`). Required for true concurrent fan-out — without it, the lock still serializes runs. |
| `KMP_TEST_KEEP_ISOLATED=1` (env) | Skip cleanup of auto-generated dirs. Debug aid — preserve the cache for inspection. |

### Envelope

Every spawning subcommand surfaces the isolated state at the JSON top level:

```json
"isolated": {
  "enabled": true,
  "cache_dir": "C:/path/to/project/.kmp-test-runner/cache-isolated/1778018148121-34584",
  "kept": false,
  "locked": true
}
```

`coverage-orchestrator` is the only spawning subcommand that does NOT spawn gradle (XML-only), so it omits the field entirely.

### Multi-agent CI fan-out

The killer use case: 5 agents each smoke-running a different module slice concurrently against the same project. Tier 1 alone serializes; pair `--isolated` with `--isolated-no-lock`:

```sh
# Agent A — runs in parallel with Agent B against the same project root:
kmp-test parallel --isolated --isolated-no-lock --module-filter "core-*" --json &
# Agent B
kmp-test parallel --isolated --isolated-no-lock --module-filter "feature-*" --json &
wait
```

Each run gets its own `.kmp-test-runner/cache-isolated/<runId>/` dir. Cleanup runs at the end of each invocation. The shared `~/.gradle/caches/modules-2` (dependency cache) is unaffected — Gradle handles concurrent reads safely there.

### What `--isolated` does NOT isolate

- `~/.gradle/caches/modules-2` (dependency cache) — read-mostly, Gradle-managed locking.
- `~/.gradle/daemon` (daemon registry) — Gradle reuses daemons across runs.
- `~/.gradle/wrapper/dists` (wrapper distributions) — read-only.
- A single attached android device — `kmp-test android --device <serial>` per run still required for multi-device fan-out.
- `git status` snapshot drift between two `kmp-test changed` runs — inherent race.

## Out of scope

- Cross-host coordination (use a real lock manager — Redis, etcd, etc.).
- Gradle-internal concurrency tuning beyond `--project-cache-dir`.
- Rewriting the daemon model.
- Symlink resolution in the project-model cache key. `computeCacheKey`
  hashes build files by their walked path content without `realpathSync`,
  so two worktrees sharing gradle sources via symlinks hash identically and
  share one cache entry. Deliberate trade-off: symlinked gradle build files
  are rare and resolving every file adds I/O per walk; if two such worktrees
  must not share a model cache, run one with `--no-cache` or distinct
  project roots.

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
