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

### Windows hermeticity: avoiding a broken child cmd.exe

Some Windows hosts run child `cmd.exe` processes with an inherited PATH that is empty regardless
of what the parent process's own environment contains — this breaks anything that shells out
through `cmd.exe` for a bare-name lookup: npm's own lifecycle-script execution (`npm ci`'s
`esbuild` postinstall spawns `cmd.exe /d /s /c node install.js`), a `.bat` file located and
launched via PowerShell (PowerShell always routes `.bat`/`.cmd` execution through `cmd.exe`
internally), or `ProcessBuilder(listOf("cmd.exe", "/c", "where node"))`-style discovery code. A
plain (non-`PATH`) environment variable carrying an absolute path is unaffected and survives that
same boundary intact.

`windows-gate.ps1` resolves `powershell.exe` via `Get-Command` and sets `npm_config_script_shell`
to it for the duration of the gate (restored exactly afterward, present-with-a-value or
genuinely-absent, via `Set-ScopedEnvVar`/`Restore-ScopedEnvVar` in `environment-utils.ps1`) — this
routes npm's own lifecycle scripts through PowerShell instead of `cmd.exe`. It also exposes
`KMP_LOCAL_CI_NODE_EXE`, the already-validated absolute path to the Node 24 executable in use,
restored the same way. `TaskActionTest`'s Windows fixture (`gradle-plugin/src/test/kotlin/.../
TaskActionTest.kt`) reads that variable (falling back to a pure-Kotlin PATH walk, never `cmd.exe`,
when run standalone outside this gate) instead of shelling out to `cmd.exe /c where node` to find
node.exe, and points the plugin's own test-only `KMP_NODE_LAUNCHER` hook directly at that resolved
executable (a single absolute path, never combined with `cmd.exe`) rather than at a `.bat` shim
routed through it. `windows-metachar.test.js`'s Candidate B fixture (`echo-args.bat`) similarly
takes the exact Node running Vitest via a dedicated `KMP_METACHAR_NODE_EXE` environment variable
instead of a bare `node` PATH lookup.

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
