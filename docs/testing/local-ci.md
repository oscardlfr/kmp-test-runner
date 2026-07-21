# Local CI gate

The remote GitHub matrix is a final trust boundary, not an interactive debugger. Code-changing
pull requests must pass the local gate before they are marked ready for review.

## Run the complete gate on Windows

Prerequisites:

- WSL2 with Docker Engine or Docker Desktop
- Node 24.18.0 x64 installed under nvm-windows
- Node 18.20.8 x64 installed under nvm-windows
- Temurin JDK 17
- PowerShell 7 and Pester 5.7.1

```powershell
pwsh -NoProfile -File tools/local-ci/run.ps1 -Lane All
```

The runner accepts another checkout or worktree without modifying tracked source:

```powershell
pwsh -NoProfile -File tools/local-ci/run.ps1 `
  -Lane All `
  -RepoRoot C:\path\to\feature-worktree
```

Use `-Lane Linux`, `-Lane LinuxNode24`, `-Lane LinuxNode18`, or `-Lane Windows` only while
diagnosing a lane. A final pre-push validation uses `-Lane All`.

The native lane may create ignored build outputs such as `node_modules/` and
`gradle-plugin/build/` in the target worktree. It temporarily removes secret-shaped process
environment variables while tests run and restores them before returning.

## Coverage

The Linux containers reproduce the Ubuntu jobs with Node 24.18.0, JDK 17, Actionlint 1.7.12,
ShellCheck, Bats, Vitest coverage, Gradle TestKit, the POSIX installer round trip, Node 18
compatibility, package audits, bundle limits, skill/plugin validation, and repository
privacy/version checks. A Git-selected source archive is mounted read-only and copied into an
ephemeral synthetic Git repository. The container never receives the full host checkout or its
ignored files. Host credentials and API keys are not forwarded.

The Windows lane runs Pester, the `gradlew.bat` TaskAction smoke, Vitest under Node 24 and Node
18, line-ending checks, and dependency audits on the native host. Docker cannot emulate
`cmd.exe`, PowerShell process behavior, or Windows filesystem semantics, so this lane is not
optional for a full pre-push gate.

Remote-only checks remain: GitHub App branch-protection drift, TruffleHog's verified-secret
lookup, commit-title status, CodeRabbit, and the final hosted-runner confirmation. macOS remains
in the separate manually dispatched validation workflow.

## Cost discipline

Open code-changing pull requests as drafts. Draft pushes skip the hosted test matrix. Consolidate
implementation and review fixes locally, run the complete local gate, push the final candidate,
then mark the PR ready for review. The `ready_for_review` event starts the hosted matrix once.

For review-driven changes:

1. Finish the complete review pass before editing.
2. Reproduce each confirmed issue and add a discriminating regression test.
3. Fix the shared abstraction when several findings belong to one bug class.
4. Run focused tests, then a fresh adversarial diff review, then `-Lane All`.
5. Push the consolidated candidate and mark the draft ready exactly once.

If a hosted-only or review finding requires another change, return the PR to draft before the
next push, consolidate and validate locally again, then mark it ready once more. Do not use a
sequence of remote CI runs to discover failures that the local gate covers.
