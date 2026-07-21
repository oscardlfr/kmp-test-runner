<!--
PR title MUST follow Conventional Commits v1.0.0 (enforced by `commit-lint` CI):
  <type>(<scope>): <description>

Examples:
  feat(cli): add --dry-run flag
  fix(installer): handle PowerShell 7 redirect headers
  docs(readme): clarify --module-filter glob syntax
  release: v0.8.1

Valid types: feat | fix | docs | style | refactor | perf | test | build | ci | chore | revert | release
Suggested scopes: cli, scripts, gradle-plugin, installer, tools, tests, ci, docs, deps
Description: starts lowercase, no trailing period, ≤72 chars.
-->

## Summary

<!-- One paragraph: what does this PR do, and why? Link the issue or BACKLOG entry it closes. -->

## What changed

<!--
Bulleted list of concrete changes by area. Group by file or module.

Example:
- `lib/cli.js`: add `--my-flag` parsing in `parseCommonArgs`
- `scripts/sh/run-parallel-coverage-suite.sh`: propagate `--my-flag` to gradle invocation
- `scripts/ps1/run-parallel-coverage-suite.ps1`: PowerShell sibling (parity)
- `tests/vitest/cli.test.js`: 4 new cases covering --my-flag dispatch
- `tests/pester/Invoke-ScriptSmoke.Tests.ps1`: AST splat-parity assertion
-->

## Tests

<!--
What test coverage was added/updated? CI must stay green:
- `build (ubuntu-latest)` + `build (windows-latest)` — vitest
- `secrets-scan`
- `gradle-plugin-test`
- `installer-e2e (ubuntu-latest)` + `installer-e2e (windows-latest)`
- `Commit Lint`

Per CONTRIBUTING.md: every change needs tests. SH ↔ PS1 parity is enforced.
-->

- [ ] Full local gate (`pwsh -NoProfile -File tools/local-ci/run.ps1 -Lane All`) before ready-for-review
- [ ] vitest (`npm test`)
- [ ] bats (`npx bats tests/bats/ tests/installer/`) — if shell scripts touched
- [ ] Pester — if PS1 scripts touched
- [ ] Gradle TestKit (`cd gradle-plugin && ./gradlew test`) — if gradle plugin touched
- [ ] `node tools/sync-versions.js --check` — if version-bumping

## Out of scope

<!--
What did you deliberately NOT do in this PR? Helps reviewers stay focused and helps
future contributors find related work.

Example:
- Tier 2 of the gradle-config diagnostic (`--gradle-args` passthrough) — deferred to v0.9
- macOS installer E2E parity — separate work in #XXX
-->

## Test plan

<!--
How did you verify this works end-to-end (beyond the automated tests)? Include exact
commands so a reviewer can reproduce.

Example:
1. `npm test` → 806 passing
2. Built artifact locally: `bash scripts/build-artifact.sh 0.8.1 dist/`
3. Installed: `bash scripts/install.sh --version 0.8.1 --prefix /tmp/kmp --archive dist/...tar.gz`
4. Verified: `/tmp/kmp/lib/bin/kmp-test.js --version` → 0.8.1
5. Ran against a multi-module KMP project: `kmp-test parallel --module-filter ":core-*"` → all green
-->
