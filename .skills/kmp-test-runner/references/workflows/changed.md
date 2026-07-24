# Changed-only tests — `kmp-test changed`

Detect modules touched by uncommitted git changes and run only their tests. In-process delegation to the `parallel` workflow — the same auto-detect, cascade-retry, and envelope shape, narrowed to the modules the user actually edited.

## Goal

Run `git diff` against the working tree (default) or the staged index (`--staged-only`), map each changed file's path to its enclosing gradle module via longest-prefix matching, build an internal `--module-filter` value (not a user-facing flag — see Common flags), and dispatch the unit-tests workflow against just those modules. Surface the diff + dispatch in a single JSON envelope.

## When to use this workflow

The agent should dispatch `kmp-test changed` when the user asks any of:

- "Run only the tests for the files I just changed"
- "Test the modules I've touched" / "test what I edited"
- "Quick test pass on my changes" / "fast CI re-run"
- "What modules would my changes affect?" — combine with `--show-modules-only`
- "Run only on staged files" — `--staged-only`

Do **not** dispatch `changed` for:

- Full suite runs — `parallel` ([`unit-tests.md`](unit-tests.md)).
- Coverage-only re-aggregation — `coverage` ([`coverage.md`](coverage.md)).
- "Test this specific class" — `parallel --test-filter <FQN>` is narrower than file-level detection.
- Running tests on files committed to a different branch — `changed` reads the working tree against `HEAD`, not against an arbitrary ref. The user must check out the branch first.

## Quickstart

```bash
kmp-test changed --json
```

That command:

1. Runs `git diff --name-only HEAD` (default) or `git diff --cached --name-only` (`--staged-only`) plus `git status --porcelain` for untracked.
2. Maps each path to its enclosing gradle module by walking the project model (`discoverIncludedModules()` in `lib/orchestrators/changed-orchestrator.js`) — longest-prefix wins, handles arbitrary nesting (`feature/<name>/<api|impl>/...`).
3. Deduplicates the module set, normalises the module names (`:core:network` vs `core/network/`).
4. Builds an internal `--module-filter <comma-list>` value (not user-settable) and delegates **in-process** to the parallel orchestrator's `runParallel()`. No subprocess hop, no re-spawn cost.
5. Emits a JSON envelope with the changed-files diff, the resolved modules, and the per-module test outcomes.

If no modules changed: exit 0 with `errors[].code: no_changed_modules` (**soft code** — does NOT promote `exit_code` via WS-5).

## Common flags

Defaults grounded in `lib/cli.js` SUBCOMMAND_HELP. Full matrix in [`../cli/flags-reference.md`](../cli/flags-reference.md). `changed` inherits most flags from `parallel` because it delegates in-process; the differences below are the changed-specific surface plus the parallel-flag defaults that diverge.

| Flag | Default | Notes |
|------|---------|-------|
| `--json` | off | Mandatory for agent consumption. |
| `--staged-only` | off | Only consider files in the git staging area (`git diff --cached`). Useful for pre-commit hooks. |
| `--show-modules-only` | off | List detected modules in the envelope, exit 0 **without** running tests. Pair with `--json` for a machine-readable preview. |
| `--max-failures <N>` | `0` | Stop after `N` per-module failures. `0` = run all modules, accumulate failures. Useful in CI gates for early termination. |
| `--test-type <type>` | auto-detect | Forwarded to parallel-orchestrator. Same enum (`all` / `common` / `androidUnit` / etc.). |
| `--test-filter <pattern>` | none | Inherited. Filter to single class/method. Globs work on JVM; Android resolves to FQN. |
| `--coverage-tool <tool>` | `jacoco` | **Distinct from `parallel`'s `auto` default.** Set via `kmp-test changed`'s SUBCOMMAND_HELP. Override with `--coverage-tool auto` if mixing kover + jacoco modules. |
| `--no-coverage` | off | Alias for `--coverage-tool none`. Expanded via CLI alias (`expandNoCoverageAlias` in `lib/parsers/argv.js`). |
| `--min-missed-lines <N>` | `0` | Same gate as `parallel`. |
| `--exclude-modules <list>` | none | Globs to skip entirely. Composes with changed-derived filter. |
| `--exclude-coverage <list>` | none | Modules to skip from coverage aggregation only. |
| `--include-untested` | off | Re-include modules auto-skipped because their filesystem path has no `src/*Test*` directory. |
| `--include-shared` | off | Include changes in sibling shared-libs project (composite-build context). |
| `--variant <auto\|debug\|release\|all>` | `auto` | Android variant selector. Forwarded to parallel-orchestrator. |
| `--gradle-args "<args>"` | none | Escape hatch — tokens appended LAST (gradle last-wins). |
| `--isolated` | off | Wrap gradle with `--project-cache-dir <tmp>`. |
| `--isolated-cache-dir <path>` | per-run tmpdir | Override cache-dir location. Implies `--isolated`. |
| `--isolated-no-lock` | off | Skip the OS-level cache-dir lockfile. Implies `--isolated`. |
| `--java-home <path>` | none | Explicit JDK. |
| `--no-jdk-autoselect` | off | Disable JDK catalogue auto-select. |
| `--ignore-jdk-mismatch` | off | Downgrade JDK gate to WARN. |
| `--dry-run` | off | Plan envelope, exit 0, no gradle spawn. Useful with `--show-modules-only` to see which modules WOULD run. |
| `--color <mode>` | `auto` | `always` / `never` / `auto`. |

Note that `changed` does **not** accept `--module-filter` (`parseArgs` rejects it as `unknown_flag`)
— its module set always comes from the git diff. To narrow it, use `--exclude-modules` (globs to
skip) or `--staged-only`/`--include-shared` to change what counts as "changed"; to preview the
resolved set before running anything, use `--show-modules-only` or `--dry-run`.

## Behaviors únicos

### Git diff strategy

Two modes:

1. **Default (working tree)**: `git diff --name-only HEAD` (modified) ∪ `git status --porcelain` untracked files (filter on `??`, `A`). Captures both staged-but-not-committed AND unstaged changes.
2. **`--staged-only`**: `git diff --cached --name-only` only. Excludes untracked files. Matches what `git commit` would record.

Renames (`R<score> old → new`) are handled — both old and new paths feed the module-mapping step, so a rename across module boundaries triggers tests in both.

### Longest-prefix module mapping

Per `lib/orchestrators/changed-orchestrator.js#discoverIncludedModules`, each changed file's path walks up the project's settings-resolved module list and picks the **longest matching prefix**. So:

- `feature/auth/impl/src/main/kotlin/Foo.kt` → maps to `:feature:auth:impl` (NOT `:feature:auth`).
- `gradle/libs.versions.toml` → maps to root module (no enclosing gradle module).
- `core/network/src/commonMain/kotlin/Bar.kt` → maps to `:core:network`.

This avoids the v0.5.x "hardcoded `core/feature/` heuristic" bug — any nesting depth works.

Files outside any module (e.g. `README.md`, `gradle/`, `.github/`) are dropped silently. The envelope's `changed.files[]` array surfaces what was found; `changed.modules[]` is the deduplicated module set.

### In-process delegation

After resolving the module set, `changed` calls `runParallel()` in-process (no subprocess hop, no re-spawn). This means:

- Flags `changed` recognizes and forwards behave the same as they do for `parallel` (cascade-retry, auto-detect, console-mode injection, gradle-properties parallel respect since v0.10 #2) — but `changed` only recognizes its own documented flag subset (see Common flags above); an unrecognized `parallel` flag like `--max-workers` or `--module-filter` is rejected as `unknown_flag` before ever reaching `parallel`.
- The envelope's `parallel:{}` block is present too — `changed` adds `changed:{}` on top.
- Performance: ~100 ms faster than spawning a separate `kmp-test parallel` subprocess.

The trade-off: the `parallel` orchestrator's behavior leaks into `changed` for the flags it does forward.

### Soft `no_changed_modules` outcome

When `git diff` returns zero files (clean working tree), `changed` emits:

```json
{
  "exit_code": 0,
  "errors": [{ "code": "no_changed_modules", "message": "Working tree clean — no changed modules to test" }],
  "tests": { "total": 0, "passed": 0, "failed": 0, "skipped": 0 }
}
```

`no_changed_modules` is a **soft code** — it does NOT trigger WS-5 promotion. `exit_code` stays at `0`. Agents should treat this as a legitimate "nothing to do" outcome, not an error. Surface the message to the user but don't escalate.

## Edge cases

- **Renamed file across module boundaries** (`R75 core/a/Foo.kt → core/b/Foo.kt`): both `:core:a` and `:core:b` enter the changed set. Tests run on both — usually desired (verify the move didn't break either side).
- **Only build-config changes** (`build.gradle.kts`, `gradle/libs.versions.toml`, `settings.gradle.kts`): map to root module which has no test source set → exit 0 with `no_changed_modules`. Pass `--include-untested` to force inclusion if you've added build-logic that needs validation.
- **`--show-modules-only` envelope**: emits `changed.detected_modules[]` populated but `tests.total = 0`, `parallel:{}` block absent. Useful for agentic preview ("show me what would run before I commit to a 5-minute test pass"). Note the field is `detected_modules`, not `modules`.
- **`--max-failures 1` for early termination**: the orchestrator interrupts gradle after the first per-module failure. The envelope's `modules[]` will be partial — only the modules dispatched before the interrupt are included. `tests.skipped` reflects the cut.
- **`--exclude-modules "core-*"` combined with a git-derived changed set**: if I changed `:feature:auth` AND `:core:network`, passing `--exclude-modules "core-*"` drops `:core:network`, leaving only `:feature:auth` dispatched.
- **Detached HEAD or no commits yet**: `git diff HEAD` fails. `changed` surfaces the git error in `errors[]` with a generic message. Recovery: ensure the project has at least one commit.
- **`--staged-only` with nothing staged**: emits `no_changed_modules` (soft, exit 0).
- **JDK toolchain mismatch on the dispatched modules**: same gate as `parallel` — exit 3 with `errors[].code: unsupported_class_version` (or auto-select if a catalogue match exists). Recovery: see [`unit-tests.md`](unit-tests.md) JDK section.
- **Coverage tool default divergence**: `changed`'s default is `jacoco` while `parallel`'s is `auto`. Historical reason (changed was added before auto-detect was reliable per-module). For modern projects pass `--coverage-tool auto` explicitly to avoid forcing the wrong tool on Kover-only modules.

## Envelope shape excerpt

```json
{
  "tool": "kmp-test",
  "schema_version": 2,
  "subcommand": "changed",
  "exit_code": 0,
  "tests": { "total": 4, "passed": 4, "failed": 0, "skipped": 0 },
  "modules": [
    { "name": ":feature:auth:impl", "type": "android", "coverage_plugin": "jacoco", "test_failures": [] }
  ],
  "coverage": { "tool": "jacoco", "missed_lines": 0, "modules_with_kover_plugin": [], "modules_with_jacoco_plugin": [":feature:auth:impl"] },
  "changed": {
    "detected_modules": [":feature:auth:impl"],
    "staged_only": false,
    "base_ref": "HEAD"
  },
  "parallel": {
    "test_type": "androidUnit",
    "max_workers": 0,
    "timeout_s": 600,
    "legs": [
      {
        "test_type": "androidUnit",
        "exit_code": 0,
        "execution": { "fresh": 1, "up_to_date": 0, "from_cache": 0, "no_source": 0, "skipped_by_gradle": 0, "failed": 0, "no_evidence": 0 },
        "cascade_detected": false,
        "retry_fired": false
      }
    ]
  },
  "errors": [],
  "warnings": []
}
```

The `changed:{}` block carries the diff metadata: `detected_modules` is the deduplicated module set the orchestrator resolved from `git diff`, `staged_only` reflects whether `--staged-only` was set, `base_ref` is the git ref used as the comparison base (`HEAD` for working-tree, the index for `--staged-only`). The `parallel:{}` block (present because `changed` delegates in-process to `parallel`) carries the dispatch metadata. `--show-modules-only` omits the `parallel:{}` block.

Raw file paths feeding the longest-prefix module mapping are not surfaced in the envelope — they are an implementation detail of `discoverIncludedModules()` in `lib/orchestrators/changed-orchestrator.js`. Agents needing the file list should re-run `git diff --name-only HEAD` directly.

## Troubleshooting

Branch on `errors[].code`:

- `no_changed_modules` (soft) → [`../troubleshooting/no-changed-modules.md`](../troubleshooting/no-changed-modules.md) (legitimate exit-0 outcome — surface but don't escalate)
- `no_test_modules` → [`../troubleshooting/no-test-modules.md`](../troubleshooting/no-test-modules.md) (modules changed but none have tests)
- `module_failed` → [`../troubleshooting/module-failed.md`](../troubleshooting/module-failed.md)
- `task_not_found` → [`../troubleshooting/task-not-found.md`](../troubleshooting/task-not-found.md)
- `unsupported_class_version` → [`../troubleshooting/unsupported-class-version.md`](../troubleshooting/unsupported-class-version.md)
- `coverage_threshold_exceeded` → [`../troubleshooting/coverage-threshold-exceeded.md`](../troubleshooting/coverage-threshold-exceeded.md)
- `isolated_runtime_race` → [`../troubleshooting/isolated-runtime-race.md`](../troubleshooting/isolated-runtime-race.md)

## See also

- [`overview.md`](overview.md) — workflows hub
- [`unit-tests.md`](unit-tests.md) — `parallel` workflow that `changed` delegates to
- [`../cli/envelope-schema.md`](../cli/envelope-schema.md) — full JSON envelope contract
- [`../cli/exit-codes.md`](../cli/exit-codes.md) — exit-code semantics + WS-5 invariant (note `no_changed_modules` is soft)
- [`../cli/flags-reference.md`](../cli/flags-reference.md) — full per-subcommand flag matrix
