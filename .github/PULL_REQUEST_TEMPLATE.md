<!--
PR title: <type>[scope][!]: <lowercase description>, no trailing period, <=72 chars.
Allowed types: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert, release.
Target develop. Code-changing PRs start as drafts and become ready after the full local gate.
-->

## Summary

<!-- What does this change and why? Link the issue/backlog item when applicable. -->

## What changed

<!-- Concrete bullets grouped by file or subsystem. -->

## Tests

`.github/required-checks.json` is the canonical hosted-check list. Do not paste a volatile test count.

- [ ] Focused regression/docs checks
- [ ] `npm test`
- [ ] Platform-specific Bats/Pester/TestKit checks when applicable
- [ ] `node tools/decouple-audit.mjs`
- [ ] Full local gate before ready: `pwsh -NoProfile -File tools/local-ci/run.ps1 -Lane All`

## Out of scope

<!-- Deliberately excluded work and why. -->

## Reproduction / test plan

<!-- Exact commands and observable results. Sanitize paths, identities, and credentials. -->
