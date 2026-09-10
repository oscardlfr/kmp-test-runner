<!--
PR title MUST follow Conventional Commits v1.0.0 (enforced by Commit Lint):
  <type>[scope][!]: <description>

Examples:
  feat(cli): add a dispatch option
  fix(installer): preserve the existing user path
  docs(metrics): clarify benchmark provenance
  chore(release): prepare vX.Y.Z

Valid types: feat | fix | docs | style | refactor | perf | test | build | ci | chore | revert | release
Suggested scopes: cli, scripts, gradle-plugin, installer, tools, tests, ci, docs, deps
Description: starts lowercase and has no trailing period. The workflow warns above 72 characters.

Normal PRs target develop. main is advanced only by the protected Release workflow.
-->

## Summary

<!-- What does this PR change, why is it needed, and which issue/BACKLOG entry does it address? -->

## What changed

<!-- Group concrete changes by user-visible behavior or implementation area. -->

## Evidence and tests

<!--
List exact commands and outcomes. Do not paste volatile suite totals as durable claims.
Explain any unchecked item or why executable tests do not apply to a docs-only change.

The canonical required contexts live in .github/required-checks.json:
Commit Lint; build (ubuntu-latest); build (windows-latest); bundle-size;
decouple-audit; gradle-plugin-test; installer-e2e (ubuntu-latest);
installer-e2e (windows-latest); secrets-scan; skills-validate.
-->

- [ ] Focused tests for the changed behavior
- [ ] Regression test for each fixed bug class, where applicable
- [ ] Full local gate (`pwsh -NoProfile -File tools/local-ci/run.ps1 -Lane All`) before ready-for-review, for code changes
- [ ] Vitest (`npm test` or a focused `npx vitest run ...`)
- [ ] Bats (`npx bats tests/bats/ tests/installer/ tests/skill-scripts/`) if POSIX surfaces changed
- [ ] Pester (`Invoke-Pester -Path tests/pester/,tests/installer/,tests/skill-scripts/ -CI`) if Windows surfaces changed
- [ ] Gradle TestKit (`cd gradle-plugin && ./gradlew test`) if the plugin changed
- [ ] Version pins (`node tools/sync-versions.js --check`) if release metadata changed
- [ ] Documentation links, commands, tables, and implementation claims verified if docs changed
- [ ] Privacy/evidence gates run for agentic-eval or published evidence changes

## Reproduction or test plan

<!--
Give a reviewer the shortest deterministic path to verify the result. Include prerequisites,
fixtures/project commit, command, expected exit code, and expected output/artifact shape.
Use placeholders and sanitized evidence; never include credentials, private paths, real device
serials, unpublished project identifiers, or raw agent transcripts.
-->

## Compatibility and risk

<!--
Call out JSON/schema, CLI, config, Gradle DSL, installer, platform, privacy, release, or
backward-compatibility impact. State explicitly when there is none.
-->

## Out of scope

<!-- What related work was deliberately excluded? Link an existing BACKLOG item instead of silently deferring it. -->

## Documentation and release notes

<!--
- Which user-facing or operator docs changed?
- Does CHANGELOG.md need an entry?
- Are any published metrics same-capture, dated, and linked to committed evidence?
- For a release-preparation PR, did package.json drive node tools/sync-versions.js and was
  [Unreleased] promoted to the dated version section?
-->
