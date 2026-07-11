# Claude Code handoff prompt — audit corrections execution

Use this prompt in a fresh Claude Code session from the repository root:

```text
You are working on `kmp-test-runner` on Windows, branch base `develop`.

Mission:
Implement the audit corrections from the final GPT-5.6 SOL + Fable 5 plan in the correct order. The source of truth is:

`docs/audits/full-repo-audit-improvement-plan-v3.2.md`

Before changing anything:
1. Read `AGENTS.md`, `BACKLOG.md`, and the v3.2 plan above.
2. Check `git status`.
3. Create a feature branch from current `develop`; never work directly on `develop` or `main`.
4. Do not merge or push unless explicitly asked.

Execution order:
Follow the v3.2 PR order exactly. Start with Phase 0 privacy:

1. PR-00 `feat(tools): fail-closed wet-evidence generator`
2. PR-01 `fix(privacy): replace the real device serial with a synthetic placeholder`
3. PR-02 `refactor(tools): decouple-audit v2 — external private patterns, fail-closed, fork-safe`

After Phase 0, continue with Phase 1 in this order:

4. PR-04 guarded uninstall
5. PR-05 PowerShell 5.1 compatibility + skill-script hardening
6. PR-06 trusted release path + SHA/checksum hardening
7. PR-19 CI concurrency/timeouts/caches + macOS jobs manual-only
8. PR-20b supported Node versions + line endings
9. PR-20c dev vulnerability remediation
10. PR-06b checksum verification + atomic install

Then proceed to PR-07 and the remaining phases exactly as listed in the v3.2 plan.

Important constraints:
- Treat privacy as P0. Do not print, commit, or summarize real private project names, user paths, device serials, raw logs, or raw captures.
- Replace real device serial examples with `<DEVICE_SERIAL>` or another obviously non-real placeholder.
- PR-02 has a selected implementation: trusted base-code scanner via `workflow_dispatch`/privileged check, inputs `{ pr_number, head_sha }`, validates exact SHA, fetches PR contents as data only, never executes untrusted PR code, loads private patterns from secrets/local git-ignored state, publishes anonymized PASS/FAIL only.
- PR-00 and PR-02 must share one redaction core.
- No new production dependencies unless the plan explicitly allows it.
- No new recurring macOS CI load. Heavy macOS/iOS checks are manual `workflow_dispatch` only.
- Do not weaken or delete tests to make implementation pass.
- Keep envelope-visible changes additive unless the plan explicitly says a migration note is required.

Quality gate for every PR:
- Run real wet validation on at least one official workspace project and at least one private project.
- `--dry-run` never counts as wet evidence.
- Keep private projects local: anonymized aliases only, alias-to-path map outside the repo, no raw private logs/artifacts committed or uploaded.
- Windows is mandatory for every PR.
- Android-relevant changes must also be validated on the connected Samsung S22 Ultra.
- macOS/iOS/installers/Bash-3.2/Gradle-plugin host-native changes may use the available macOS machine when needed, but must not add recurring macOS CI.
- Evidence must be emitted only through the PR-00 generator once it exists.

Standard verification:
- Use `npm ci` before Node validation.
- Use `npm run test:coverage`; do not use `npx vitest run --coverage`.
- For plugin changes, run from `gradle-plugin/`: Unix/macOS `./gradlew test`; Windows `.\gradlew.bat test`.
- Run bats/Pester for script changes.
- Run decouple-audit v2 before push once PR-02 exists.
- Update docs, envelope-contract, skill catalogue and CHANGELOG in the same PR when behavior or envelope-visible contracts change.

Work style:
- Implement one PR-sized unit at a time unless the plan explicitly allows combining PR-00/01/02 or PR-25/10.
- For each unit, start with a failing test or reproducible proof where the plan asks for it.
- At the end of each unit, report:
  - files changed,
  - tests run,
  - wet evidence summary with sanitized aliases,
  - remaining risks,
  - whether the next PR can begin.

Start now with PR-00 unless the user explicitly chooses to combine PR-00/PR-01/PR-02 into one privacy PR.
```
