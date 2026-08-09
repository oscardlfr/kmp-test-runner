# `no_changed_modules` — working tree clean (soft code)

The `changed` subcommand ran `git status` (or `git diff --cached` under `--staged-only`) and found nothing to test. This is a **soft code** — does NOT promote `exit_code` via WS-5. Legitimate exit-0 outcome with structured signal.

## Symptom

```json
{
  "exit_code": 0,
  "errors": [{
    "code": "no_changed_modules",
    "message": "Working tree clean — no changed modules to test"
  }],
  "tests": { "total": 0, "passed": 0, "failed": 0, "skipped": 0 }
}
```

Applies to the `changed` subcommand only.

## Why this is soft

Soft codes (`no_summary`, `no_changed_modules`) carry useful signal but DO NOT trigger WS-5 promotion. The CLI exits `0` because there's nothing wrong — the user asked "what changed?", git's answer was "nothing", `kmp-test` correctly did nothing.

Agents should:
- Surface the `message` to the user verbatim ("No changes detected since `HEAD`").
- NOT escalate to an error — the workflow ran correctly.
- NOT auto-retry — re-running the same detection against the same working tree will return the same result.

## Root causes

1. **Clean working tree**: the user committed (or stashed) every change before running `kmp-test changed`. Expected outcome.
2. **`--staged-only` with nothing staged**: `git diff --cached` returns empty even when the working tree has unstaged modifications. Recovery: drop `--staged-only` or stage the changes first.
3. **Changes only in non-module paths**: the user edited `README.md`, `.github/`, `.editorconfig`, or `gradle/libs.versions.toml`. These don't belong to any module → silently dropped during longest-prefix mapping → empty changed set.
4. **Detached HEAD or zero commits yet — NOT actually a distinct cause**: `changed` uses `git status --porcelain` (or `git diff --cached --name-only` under `--staged-only`), and neither command depends on `HEAD` pointing to a branch or even existing as a real commit — both work identically to the normal case. If you see `no_changed_modules` while on a detached `HEAD` (e.g. after checking out a tag mid-investigation), it's cause #1 (clean working tree at that point), not the detached `HEAD` itself.
5. **Wrong branch**: the user expected to be on a feature branch with changes, but they're actually on `main` (or vice versa). `git status` clarifies.

## Recovery path

For "clean working tree" (most common):

1. Confirm with the user: "no uncommitted changes — did you mean to test something specific?"
2. Suggest `kmp-test parallel` for a full-suite run.
3. Suggest `kmp-test parallel --module-filter "<glob>"` if they want to test a specific module range without changes.

For "`--staged-only` with nothing staged":

1. Suggest dropping `--staged-only`.
2. Or suggest `git add <files>` first if they want to validate before committing.

For "non-module paths only":

1. Surface what `git status` shows.
2. If the user edited `gradle/libs.versions.toml`, suggest `kmp-test parallel` (the change affects every module that consumes the version catalogue).
3. If they edited `.github/workflows/`, no tests apply — confirm and exit.

## Recovery commands

```bash
# Confirm git state
git status --short
git diff --name-only HEAD
git diff --cached --name-only

# Preview the changed-modules computation without running anything
kmp-test changed --show-modules-only --json

# Fall back to full suite
kmp-test parallel --json

# Or full suite filtered by module
kmp-test parallel --module-filter "core-*" --json
```

## AGP / JDK quirks

None — `no_changed_modules` is git + module-mapping logic only; no AGP or JDK interaction.

## See also

- [`../cli/envelope-schema.md#errors-discriminated-codes`](../cli/envelope-schema.md#errors-discriminated-codes) — full code table (soft codes section)
- [`../cli/exit-codes.md`](../cli/exit-codes.md) — exit-code semantics + WS-5 invariant explains why soft codes don't promote
- [`overview.md`](overview.md) — troubleshooting hub
- [`../workflows/changed.md`](../workflows/changed.md) — workflow context
- [`no-summary.md`](no-summary.md) — the other soft code
