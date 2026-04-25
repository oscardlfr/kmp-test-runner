# Backlog

> Active and queued tasks for `kmp-test-runner`. Newest first. Read `CLAUDE.md` first for repo state + gitflow rules.

---

## ACTIVE — Agentic CLI improvements (v0.3.4)

**Branch**: `feature/agentic-cli`
**Target tag**: `v0.3.4` (after PR squash-merge to main)
**Estimated effort**: 3–4h

### Goal

Make `kmp-test` (the npm CLI) friendly for AI agents and lower-token usage, plus DX wins for human users.

### Scope (6 deliverables in single PR)

#### 1. Default `--project-root` to CWD (cli.js)

Currently `kmp-test parallel --project-root /path/to/project` is required. Change so that:

- If `--project-root <path>` is passed: use `<path>` (current behaviour)
- If `--project-root` is NOT passed: use `process.cwd()` as the project root

So users can `cd into-their-project && kmp-test parallel` without typing the path.

Update help text to reflect this default.

#### 2. `--json` / `--format json` output mode (cli.js)

For AI agents and structured-output consumers. When `--json` (or `--format json`) is passed:

- Suppress human-readable progress output to stderr (or buffer it)
- At end, emit a single JSON object on stdout with this shape:

```json
{
  "tool": "kmp-test",
  "subcommand": "parallel",
  "version": "0.3.4",
  "project_root": "/abs/path/to/project",
  "exit_code": 0,
  "duration_ms": 12345,
  "tests": {
    "total": 42,
    "passed": 42,
    "failed": 0,
    "skipped": 0
  },
  "modules": ["core-foo", "core-bar"],
  "coverage": {
    "tool": "kover",
    "missed_lines": 12
  },
  "errors": [
    {"module": "core-baz", "test": "FooTest.bar", "message": "AssertionError: ..."}
  ]
}
```

Implementation notes:
- Wrap the bash/PowerShell script invocation via `spawn` (Node `child_process`)
- Capture stdout + stderr
- Parse Gradle output patterns for test counts:
  - `BUILD SUCCESSFUL` / `BUILD FAILED`
  - `> Task :module:test ... X tests completed, Y failed, Z skipped`
  - Test failure stack frames
- If parsing partially fails: still emit valid JSON with `errors: [{...}]` describing the parse gap; do NOT crash
- Default (no `--json`): pass through the bash script output as-is to terminal (current behaviour)

This is the lowest-token output shape — agents can grep / parse without re-rendering ANSI.

#### 3. Per-subcommand `--help` (cli.js)

Currently `kmp-test --help` lists all subcommands but `kmp-test parallel --help` doesn't show parallel-specific flags. Add:

- `kmp-test parallel --help` → flags accepted by `parallel` (e.g., `--project-root`, `--max-workers`, `--coverage-tool`, etc.)
- Same for `changed`, `android`, `benchmark`, `coverage`

Help text should be ≤30 lines per subcommand. Include 1 example command.

#### 4. Pre-flight gradlew check (cli.js)

Before invoking the bash/PowerShell script, verify:
- `<project_root>/gradlew` exists (Linux/macOS) or `<project_root>/gradlew.bat` (Windows)
- If missing, print a helpful error and exit non-zero (use exit code 3 — see #5):
  - "kmp-test: no gradlew found in <project_root>"
  - "Either pass --project-root <dir> pointing to a Gradle project, or cd into one"
  - "If this IS a Gradle project, run `gradle wrapper` to generate the wrapper"

#### 5. Semantic exit codes (cli.js)

Document and implement:
- `0` — success (all tests passed)
- `1` — test failure (script ran, but tests failed)
- `2` — config error (invalid flag, bad CLI usage)
- `3` — environment error (gradlew not found, JDK missing, Gradle not on PATH, etc.)

Update help text to list these.

#### 6. Tests + README + CHANGELOG v0.3.4

- **vitest tests** (`tests/unit/`):
  - Test that default `--project-root` falls back to `process.cwd()`
  - Test that `--json` output is valid JSON with required keys
  - Test that `--json` parsing handles "no tests run" gracefully
  - Test that pre-flight gradlew check errors helpfully when missing
  - Test exit codes: success → 0, parse error → 2, missing gradlew → 3
- **bats tests** (`tests/bats/`): smoke test for `kmp-test --json parallel --project-root <fake-gradle-project>` (use a fixture with stub gradlew that prints fake test output)
- **README.md**:
  - Update Usage section with `--json` flag documented and 1 example
  - Note default `--project-root` behaviour
  - Document exit codes
- **CHANGELOG.md**: add `## [0.3.4] — <release-date>` entry under `## [Unreleased]` (or replace `[Unreleased]`); footer link `[0.3.4]: https://github.com/oscardlfr/kmp-test-runner/compare/v0.3.3...v0.3.4`
- **package.json**: bump `version` from `0.3.3` to `0.3.4` BEFORE tagging (the `installer-e2e` regression test would catch this anyway, but bump it deliberately as part of the release prep)

### Acceptance

- All 6 existing CI checks stay green
- New vitest tests pass with ≥80% line coverage on `bin/kmp-test.js` + `lib/cli.js`
- Manual smoke test: `cd <some-real-kmp-project> && kmp-test parallel --json` → returns valid JSON
- Manual smoke test: `kmp-test parallel --help` → shows parallel-specific flags
- Manual smoke test: `kmp-test parallel --project-root /tmp/no-gradle` → exits 3 with helpful error

### Out of scope (defer to separate PR)

- `kmp-test doctor` command (env diagnostic)
- `--dry-run` flag
- ANSI color management (auto-disable on non-TTY)
- Migrating L0 to consume kmp-test-runner CLI (that's `AndroidCommonDoc` repo work, not here)

---

## QUEUED — post-v0.3.4 ideas

- **`kmp-test doctor`** — env diagnostic (Node version, Gradle wrapper present, JDK version, etc.) — outputs human-readable + `--json` mode
- **`--dry-run`** — print what would run, exit 0 without invoking Gradle
- **ANSI color** — auto-detect TTY, plain output when piped
- **Maven Central publish** for Gradle plugin — currently GitHub Packages only; needs Sonatype account + signing keys
- **iOS/macOS TestKit** matrix — needs Mac hardware in CI
- **npm registry version sync** — manually trigger `publish-npm.yml` to publish v0.3.x to npm so npm consumers get the same version
- **VitePress/MkDocs docs site** — separate consumer-facing docs beyond README

---

## DONE (recent — newest first)

- 2026-04-25: **Full E2E installer test coverage** (W31.5c post-ship hardening) — `scripts/build-artifact.sh` + 5 bats E2E + 4 Pester E2E + `installer-e2e` CI matrix job. Catches all 3 historical bugs (wrapper dir, missing package.json, version sync) as regression tests.
- 2026-04-25: **v0.3.3** — third hotfix; `package.json` version bumped from stale `0.2.0` to `0.3.3`. First fully working release.
- 2026-04-25: **v0.3.2** — second hotfix; added `package.json` to release artifacts.
- 2026-04-25: **v0.3.1** — first hotfix; wrapped release artifacts in `kmp-test-runner-${VER}/` directory so installer extraction works.
- 2026-04-25: **v0.3.0** — W31.5c original ship. Installer scripts (POSIX + PowerShell) + `CHANGELOG.md` + README polish + `publish-release.yml` workflow.
- 2026-04-25: **v0.2.0** — W31.5b. Gradle plugin shape (5 tasks, Kover auto-detect, GitHub Packages publish).
- 2026-04-24: **v0.1.0** — W31.5a. Initial npm CLI release with 5 subcommands (parallel, changed, android, benchmark, coverage).
- 2026-04-25: **Branch protection** on `main` (PR required, 6 CI checks, linear history, enforce_admins).
