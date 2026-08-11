# Changed-only tests — `kmp-test changed`

Detect modules touched by uncommitted git changes and run only their tests. In-process delegation to the `parallel` workflow — the same auto-detect and cascade-retry mechanics, narrowed to the modules the user actually edited.

## Goal

Run `git status` against the working tree (default) or `git diff` against the staged index (`--staged-only`), map each changed file's path to its enclosing gradle module via longest-prefix matching, build an internal `--module-filter` value (not a user-facing flag — see Common flags), and dispatch the unit-tests workflow against just those modules. Surface the resolved modules + dispatch outcome in a single JSON envelope (raw file paths themselves are not surfaced — see Envelope shape excerpt).

## When to use this workflow

The agent should dispatch `kmp-test changed` when the user asks any of:

- "Run only the tests for the files I just changed"
- "Test the modules I've touched" / "test what I edited"
- "Quick test pass on my changes" / "fast CI re-run"
- "What modules would my changes affect?" — combine with `--show-modules-only`
- "Run only on staged files" — `--staged-only`
- "There's a pending change somewhere and I haven't said which module — find it and test just that"
- "Whatever I already edited locally, test only that; you'll need to work out where it is"

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

1. Runs `git status --porcelain` (default) or `git diff --cached --name-only` (`--staged-only`) — mutually exclusive, never both in the same run.
2. Maps each path to its enclosing gradle module by walking the project model (`discoverIncludedModules()` in `lib/orchestrators/changed-orchestrator.js`) — longest-prefix wins, handles arbitrary nesting (`feature/<name>/<api|impl>/...`).
3. Deduplicates the module set into bare, colon-less module names (e.g. `core:network`, not `:core:network` or `core/network/`).
4. Builds an internal `--module-filter <comma-list>` value (not user-settable) and delegates **in-process** to the parallel orchestrator's `runParallel()`. No subprocess hop, no re-spawn cost.
5. Emits a JSON envelope with the resolved modules and the per-module test outcomes.

If no modules changed: exit 0 with `errors[].code: no_changed_modules` (**soft code** — does NOT promote `exit_code` via WS-5).

## Common flags

Defaults grounded in `lib/cli.js` SUBCOMMAND_HELP. Full matrix in [`../cli/flags-reference.md`](../cli/flags-reference.md). `changed` inherits most flags from `parallel` because it delegates in-process; the differences below are the changed-specific surface plus the parallel-flag defaults that diverge.

| Flag | Default | Notes |
|------|---------|-------|
| `--json` | off | Mandatory for agent consumption. |
| `--staged-only` | off | Only consider files in the git staging area (`git diff --cached`). Useful for pre-commit hooks. |
| `--show-modules-only` | off | List detected modules in the envelope, exit 0 **without** running tests. Pair with `--json` for a machine-readable preview. |
| `--test-type <type>` | auto-detect | Forwarded to parallel-orchestrator. Same enum (`all` / `common` / `androidUnit` / etc.). |
| `--test-filter <pattern>` | none | Inherited. Filter to single class/method. Globs work on JVM; Android resolves to FQN. |
| `--coverage-tool <tool>` | `auto` | Same default as `parallel` — omitted, forwards nothing, and `parallel`'s own `auto` resolution applies. |
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
| `--dry-run` | off | Plan envelope, exit 0, no git call, no gradle spawn. `detected_modules` is always `[]` on dry-run, regardless of any other flag (including `--show-modules-only` — dry-run short-circuits first and wins). |
| `--color <mode>` | `auto` | `always` / `never` / `auto`. |

Note that `changed` does **not** accept `--module-filter` (`parseArgs` rejects it as `unknown_flag`)
— its module set always comes from git detection. To narrow it, use `--exclude-modules` (globs to
skip) or `--staged-only`/`--include-shared` to change what counts as "changed"; to preview the
resolved set before running anything, use `--show-modules-only` (runs real detection) or `--dry-run`
(never touches git at all).

## Behaviors únicos

### Change-detection strategy

Two mutually exclusive modes — never both in the same run:

1. **Default (working tree)**: `git status --porcelain` only. Captures modified, added, and untracked files in one command.
2. **`--staged-only`**: `git diff --cached --name-only` only. Excludes untracked files. Matches what `git commit` would record.

Renames are handled — for the default mode, `git status --porcelain` reports a rename as `R  old -> new`, and the parser keeps only the destination path (`new`); the source is discarded. `--staged-only`'s `git diff --cached --name-only` never emits an old→new pair at all (that's a `--name-status`/`--raw` shape), so there is nothing to strip there either — only the destination-side path is ever seen, by construction. In both modes, only the destination module is affected; the module the file used to live in is never touched.

### Longest-prefix module mapping

Per `lib/orchestrators/changed-orchestrator.js#discoverIncludedModules`, each changed file's path walks up the project's settings-resolved module list and picks the **longest matching prefix**. So:

- `feature/auth/impl/src/main/kotlin/Foo.kt` → maps to `feature:auth:impl` (NOT `feature:auth`).
- `gradle/libs.versions.toml` → matches no module prefix at all — discarded, same as any other unmatched path. There is no "root module" concept.
- `core/network/src/commonMain/kotlin/Bar.kt` → maps to `core:network`.

This avoids the v0.5.x "hardcoded `core/feature/` heuristic" bug — any nesting depth works.

Files outside any module (e.g. `README.md`, `gradle/`, `.github/`) are dropped silently — they never appear anywhere in the envelope. Only the deduplicated module set survives, as `changed.detected_modules[]` (bare, colon-less names).

### In-process delegation

After resolving the module set, `changed` calls `runParallel()` in-process (no subprocess hop, no re-spawn). This means:

- Flags `changed` recognizes and forwards behave the same as they do for `parallel` (cascade-retry, auto-detect, console-mode injection, gradle-properties parallel respect since v0.10 #2) — but `changed` only recognizes its own documented flag subset (see Common flags above); an unrecognized `parallel` flag like `--max-workers` or `--module-filter` is rejected as `unknown_flag` before ever reaching `parallel`.
- The final envelope does **not** carry a top-level `parallel:{}` block, ever — `changed` only copies specific fields out of the delegate's result (`tests`, `modules`, `skipped`, `coverage`, `errors`, `warnings`, `isolated`) and adds its own `changed:{}` block on top. The delegate's own `parallel:{legs, ...}` block and any `android:{}` block (on instrumented runs) are not among the copied fields, so their detail is not forwarded either.
- Performance: ~100 ms faster than spawning a separate `kmp-test parallel` subprocess.

The trade-off: the `parallel` orchestrator's behavior leaks into `changed` for the flags it does forward, but its envelope's own dispatch-metadata blocks do not.

### Soft `no_changed_modules` outcome

When change detection returns nothing (clean working tree, or `--staged-only` with nothing staged), `changed` emits:

```json
{
  "exit_code": 0,
  "errors": [{ "code": "no_changed_modules", "message": "No modules with uncommitted changes detected." }],
  "tests": { "total": 0, "passed": 0, "failed": 0, "skipped": 0 }
}
```

`no_changed_modules` is a **soft code** — it does NOT trigger WS-5 promotion. `exit_code` stays at `0`. Agents should treat this as a legitimate "nothing to do" outcome, not an error. Surface the message to the user but don't escalate.

## Edge cases

- **Renamed file across module boundaries** (default mode, `R  core/a/Foo.kt -> core/b/Foo.kt`): only `core:b` enters the changed set — the source module (`core:a`) is discarded along with the source path.
- **Only *root-level* build-config changes** (`gradle/libs.versions.toml`, `settings.gradle.kts`, or a root-level `build.gradle.kts` — not one living inside a module directory): match no module prefix → discarded → exit 0 with `no_changed_modules`. A module's *own* `build.gradle.kts` (e.g. `core/b/build.gradle.kts`) is a normal file under `core/b/` and maps to `core:b` like any other file in that module — it is not discarded. Pass `--include-untested` to force inclusion if a matched module has no test source set — but note that only applies to files that DID map to a module; a root-level config file with no module match at all still can't be forced in, since there's no module to attach it to.
- **`--show-modules-only` envelope**: `changed.detected_modules[]` is populated (bare, colon-less names — the field is `detected_modules`, not `modules`) and `tests.total = 0`. The top-level `modules[]` field is *also* populated in this mode, but as the same bare-string array (`["core:b"]`), not the object shape (`{name, type, coverage_plugin, test_failures}`) a real dispatch produces — see Envelope shape excerpt. Like every other `changed` envelope, there is no top-level `parallel:{}` block. Useful for agentic preview ("show me what would run before I commit to a 5-minute test pass").
- **`--exclude-modules "core:*"` combined with a git-derived changed set**: if I changed `feature:auth` AND `core:network`, passing `--exclude-modules "core:*"` drops `core:network`, leaving only `feature:auth` dispatched. The glob is matched against the bare, colon-separated module name — a hyphen-style glob like `"core-*"` will NOT match `core:network` (no hyphen in the name); use `core:*` or the bare substring `core`.
- **Detached HEAD or a repository with zero commits yet**: neither actually causes a failure. `git status --porcelain` and `git diff --cached --name-only` don't require HEAD to point at a branch, or even to exist as a real commit — both work identically to the normal case. (`git diff HEAD` — a *different* command `changed` never runs — is the one that would fail on an unborn HEAD; it's not part of this contract.)
- **`--staged-only` with nothing staged**: emits `no_changed_modules` (soft, exit 0).
- **JDK toolchain mismatch on the dispatched modules**: same gate as `parallel` — exit 3 with `errors[].code: unsupported_class_version` (or auto-select if a catalogue match exists). Recovery: see [`unit-tests.md`](unit-tests.md) JDK section.
- **Coverage tool default**: `changed` and `parallel` share the same `auto` default — `changed` forwards nothing when `--coverage-tool` is unset, so `parallel`'s own auto-detection applies.

## Envelope shape excerpt

```json
{
  "tool": "kmp-test",
  "schema_version": 2,
  "subcommand": "changed",
  "exit_code": 0,
  "tests": { "total": 4, "passed": 4, "failed": 0, "skipped": 0 },
  "modules": [
    { "name": "feature:auth:impl", "type": "android", "coverage_plugin": "jacoco", "test_failures": [] }
  ],
  "coverage": { "tool": "jacoco", "missed_lines": 0, "modules_with_kover_plugin": [], "modules_with_jacoco_plugin": ["feature:auth:impl"] },
  "changed": {
    "detected_modules": ["feature:auth:impl"],
    "staged_only": false,
    "base_ref": "HEAD"
  },
  "errors": [],
  "warnings": []
}
```

There is no top-level `parallel:{}` block on any `changed` envelope, ever — not even on a normal, real run. `changed` copies specific fields out of the delegate's result (`tests`, `modules`, `skipped`, `coverage`, `errors`, `warnings`, `isolated`) directly onto its own top level; it never re-attaches the delegate's own `parallel:{legs, ...}` block, and on instrumented runs it does not forward the delegate's `android:{}` block either.

The `changed:{}` block carries exactly 3 fields, always: `detected_modules` (the deduplicated, bare/colon-less module set resolved from git detection), `staged_only` (echoes whether `--staged-only` was set), and `base_ref` — which is always the literal string `"HEAD"`, in both default and `--staged-only` modes. `--staged-only` changes what's compared (the index vs. the working tree), not `base_ref`'s value.

Raw file paths feeding the longest-prefix module mapping are not surfaced in the envelope — they are an implementation detail of `discoverIncludedModules()` in `lib/orchestrators/changed-orchestrator.js`. Agents needing the file list should re-run the same detection directly: `git status --porcelain` for the default mode, or `git diff --cached --name-only` for `--staged-only`.

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
