# Repository instructions

This is the portable, canonical instruction file for coding agents working on
`kmp-test-runner`. Keep it concise and stable. `CLAUDE.md` is only a Claude Code
adapter and must not duplicate these rules.

## Sources of truth

- `package.json` owns the current version and npm scripts.
- `README.md` owns the current user-facing CLI, Gradle, installer, and platform
  surface.
- `PRODUCT.md` owns product principles and architecture direction.
- `CONTRIBUTING.md` owns the contributor and pull-request workflow.
- `BACKLOG.md` owns current and queued work. Read the relevant section when a
  task concerns prioritization, roadmap scope, or an existing backlog item.
- `CHANGELOG.md` owns release chronology and migration notes.
- `docs/envelope-contract.md` owns the machine-readable envelope and semantic
  exit-code contract.
- `docs/maintainers/release-process.md` owns the release runbook.
- `docs/testing/local-ci.md` owns the full local validation procedure.
- `.claude/rules/*.md` contains path-scoped implementation rules. Claude Code
  loads matching files automatically; other agents must consult the matching
  rule before editing those paths.

Do not copy versions, dated status snapshots, completed milestone narratives,
or release history into agent instruction files. Derive live facts from the
sources above.

## Repository shape

- `bin/` and `lib/`: Node.js ESM CLI and orchestration logic.
- `scripts/sh/` and `scripts/ps1/`: thin POSIX and PowerShell entry points.
- `gradle-plugin/`: Gradle plugin tasks that dispatch the same runtime.
- `tests/vitest/`, `tests/bats/`, `tests/pester/`, and `tests/installer/`:
  cross-platform regression coverage.
- `.skills/kmp-test-runner/`: consumer-facing Agent Skill. It teaches agents
  how to use the published CLI; it is not a maintainer instruction bundle.
- `.claude-plugin/`: Claude Code plugin manifest for the consumer skill.

Keep orchestration, parsing, project discovery, and envelope construction in
Node. Shell and PowerShell are platform plumbing, not a second implementation.

## Working agreement

- Work only in this repository unless the user explicitly expands scope.
- Preserve unrelated changes, untracked files, worktrees, and stashes.
- Start agent work from current `origin/develop` on a dedicated `codex/*`
  branch. Never push directly to `develop` or `main`.
- Pull requests target `develop`. Do not merge unless the user explicitly asks.
- Do not create, rename, move, or drop milestones without an explicit user
  decision.
- Use Conventional Commits for commits and PR titles:
  `<type>[scope][!]: <lowercase description>` with no trailing period and at
  most 72 characters.
- Keep changes focused. Do not weaken or delete an existing test to make a
  change pass; fix the implementation or the invalid assumption.

## Product invariants

- The JSON envelope, semantic exit codes, documented CLI flags,
  configuration/environment variables, and Gradle DSL are public API. Preserve
  compatibility across shared surfaces; incompatible changes require an
  intentional breaking release and migration note.
- Keep npm CLI, Gradle plugin, installers, and POSIX/PowerShell dispatch in
  parity where a surface is shared.
- Preserve the repository privacy boundary. Private project identifiers,
  personal home paths, IDE workspace paths, and private composite names must
  remain absent; `tools/decouple-audit.mjs` is the enforcement source.
- Keep macOS hosted work minimal. Heavy Apple-platform validation belongs in
  the manually dispatched macOS workflow, not the per-PR matrix.
- README metrics must compare numerator and denominator from the same project
  and capture. Label any deliberate cross-project comparison inline.
- Keep `README.md` timeless. Release highlights and version history belong in
  `CHANGELOG.md`.

## Verification

Choose checks based on the paths changed, then run the full local gate for a
code-changing final candidate:

- Node/tooling: `npm test`
- Focused Vitest: `npx vitest run <test-files...>`
- POSIX scripts/installers: `npx bats tests/bats/ tests/installer/ tests/skill-scripts/`
- PowerShell scripts/installers: Pester 5 over the matching suites
- Gradle plugin: `./gradlew test` from `gradle-plugin/`
- Shell lint: `npm run shellcheck`
- Agent configuration: `node tools/validate-agent-config.mjs`
- Privacy: `node tools/decouple-audit.mjs`
- Version pins: `node tools/sync-versions.js --check`
- Final Windows-host gate: `pwsh -NoProfile -File tools/local-ci/run.ps1 -Lane All`

Never claim completion without showing the relevant verification result. Tests
use disposable fixtures and no production credentials; run focused tests and
repair failures caused by the requested change without asking for approval.

## Agent configuration and memory

- There are no repository-owned generic agent roles. Runtime roles such as
  debugger, verifier, researcher, or codebase mapper are platform capabilities,
  not files to mirror under `.claude/agents/` or `.codex/agents/`.
- Add a project-owned subagent only when it has a distinct project-specific
  contract, bounded tools, an owner, and validation; update the validator in
  the same change.
- Do not commit session diaries, dated handoff snapshots, or repository-local
  auto-memory. Distill durable lessons into this file, a path-scoped rule,
  `PRODUCT.md`, or a focused maintainer document. Keep transient progress in
  the task, issue, pull request, or branch.
- Follow `docs/maintainers/agent-configuration.md` when changing any agent
  instruction, rule, role, skill, or memory surface.
