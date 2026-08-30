# Evidence1 Hyper-V Ops Toolkit

This toolkit exists to make the Evidence1 Windows runner repeatable from a host session without
turning the host into a general-purpose elevated shell. It does not authorize live sessions.

## Boundary

- The VM is still the isolation boundary for Evidence1 live execution.
- The host scripts update the harness, verify launch evidence, perform one controlled live handoff,
  validate the deterministic product wet gate and one-cell dry-run plans, read privacy-safe
  progress, or copy finalized operational artifacts.
- Raw transcript files and per-cell stderr transcript artifacts are never read by these scripts.
- Do not run another live campaign from this PR. Live execution still requires the separate literal
  authorization phrase after readiness has passed.

## Elevated Runner

Install the runner once from an elevated PowerShell:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File docs\audits\evidence1-host-elevated-runner-install.ps1
```

After that, a non-elevated host session can queue only the allowlisted Evidence1 scripts:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File docs\audits\evidence1-host-elevated-runner-client.ps1 `
  -ScriptPath docs\audits\evidence1-hyperv-read-live-progress.ps1
```

The scheduled task runs as the interactive user with `RunLevel Highest`; it is intentionally not a
generic admin command runner. The allowlist is in
`docs/audits/evidence1-host-elevated-runner.ps1`, and defaults to the directory that contains the
runner itself.

The runner does not expose a generic VM stop command or the low-level autorun placement script.
The only allowlisted launch mutation is `evidence1-hyperv-start-authorized-live.ps1`, which owns the
whole transition and delegates internally to the placement script after every gate has passed.

## Post-Merge Validation Before Live

Follow [Evidence1 Post-Merge Validation](evidence1-post-merge-validation.md) for the Stage V
sequence and deployment custody. The explicit validation allowlist additions are:

- `evidence1-hyperv-verify-wet-gate-v2-direct.ps1`: one real product/Gradle invocation in the
  guest, with the exact coverage budget contract and a 300-second cap. It never runs Claude.
- `evidence1-hyperv-verify-canary-dryrun-v3-direct.ps1`: separate registered Product and
  FreeBaseline plans, one session each, without spawning agents or writing live records.

Readiness's eight-cell dry-run does not replace these stages. Updating the guest harness also
does not update the host task's allowlist: deploy the reviewed operational checkout to the
actual task action path while the task and queue are idle. Keep the trusted directory unchanged.

## Standard Retake Flow

1. Update the guest harness from the current target:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File docs\audits\evidence1-host-elevated-runner-client.ps1 `
  -ScriptPath docs\audits\evidence1-hyperv-update-harness-from-bundle.ps1 `
  -ScriptArgumentsJson '["-TargetCommit","<40-hex commit>","-TargetTree","<40-hex tree>"]'
```

`TargetCommit` and `TargetTree` must match. If omitted, the update script resolves `origin/develop`
after fetching.

2. Regenerate readiness in the VM:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File docs\audits\evidence1-host-elevated-runner-client.ps1 `
  -ScriptPath docs\audits\evidence1-hyperv-regenerate-readiness-direct.ps1 `
  -ScriptArgumentsJson '["-TargetCommit","<40-hex commit>","-TargetTree","<40-hex tree>"]'
```

3. Run the separately authorized remote-auth canary. It makes one minimal Claude request without
accessing a repository, skill, or tools. It deliberately does not use `--bare`, because bare mode
skips OAuth/keychain reads and cannot validate the interactive Claude login. Instead, it runs from
an empty temporary directory with only user settings, disables slash commands and built-in tools,
and forces an empty MCP configuration with `--strict-mcp-config`.
Its only durable output is a privacy-safe record: event counts, terminal flags, sanitized HTTP
statuses, and no raw model content. A successful
`claude auth status` alone is not sufficient because it only proves local credential presence.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File docs\audits\evidence1-host-elevated-runner-client.ps1 `
  -ScriptPath docs\audits\evidence1-hyperv-verify-guest-claude-auth-direct.ps1 `
  -ScriptArgumentsJson '["-RunRemoteAuthCanary","-RemoteAuthCanaryAuthorizationPhrase","<exact separately authorized canary phrase>"]'
```

The canary record expires after 30 minutes and is invalidated by credential-override environment
variables. Do not replace this step with an interactive-login artifact or a previous live result.

4. Start the authorized handoff only after readiness PASS, a fresh passing remote-auth canary, and
a fresh live authorization phrase. The state flow is deliberately singular:

`Running + verified -> Off -> Armed -> Running`

The coordinator verifies the exact commit/tree anchors, verifies prior-run terminal custody, asks
the guest to shut down through the normal Hyper-V integration path, stages one autorun while the
VHD is offline, and starts the VM again. It never uses `Stop-VM -TurnOff`, never falls back to a
hard power cut, and never replaces an existing autorun or run artifacts.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File docs\audits\evidence1-host-elevated-runner-client.ps1 `
  -ScriptPath docs\audits\evidence1-hyperv-start-authorized-live.ps1 `
  -ScriptArgumentsJson '["-ExpectedTargetCommit","<40-hex commit>","-ExpectedTargetTree","<40-hex tree>","-LiveAuthorizationPhrase","<literal authorization phrase>"]'
```

The command writes a privacy-safe handoff state record under
`C:\kmp-eval\scratch\hyperv-start-authorized-live`. Treat any state other than `started` as a HARD
STOP. Do not rerun the command to repair `stopping`, `off`, `armed`, or `failed`; inspect the state
and preserve custody first. A previous `started` handoff can be superseded only after
`evidence1-hyperv-copy-live-artifacts.ps1` has copied a valid terminal record for the same run id.

5. Monitor progress without raw access:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File docs\audits\evidence1-host-elevated-runner-client.ps1 `
  -ScriptPath docs\audits\evidence1-hyperv-read-live-progress.ps1
```

6. If the progress summary is not enough, read bounded operational tails only:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File docs\audits\evidence1-host-elevated-runner-client.ps1 `
  -ScriptPath docs\audits\evidence1-hyperv-read-live-operational-tail.ps1
```

7. After the VM has stopped, copy terminal artifacts:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File docs\audits\evidence1-host-elevated-runner-client.ps1 `
  -ScriptPath docs\audits\evidence1-hyperv-copy-live-artifacts.ps1 `
  -ScriptArgumentsJson '["-ExpectedRunId","<run-guid>"]'
```

## Verification

This toolkit is covered by `tests/vitest/evidence1-hyperv-ops-toolkit.test.js`, which checks:

- PowerShell parse health on Windows.
- No private host paths or stale SHA pins in the versioned ops scripts.
- Elevated runner allowlist remains narrow.
- The authorized live handoff owns the complete VM state transition without a hard-power fallback.
- Existing autoruns and uncopied prior-run artifacts fail closed instead of being replaced.
- Documentation preserves the no-live authorization boundary.
- A live launcher requires a recent privacy-safe remote-auth canary rather than treating local
  login state as proof of remote credential acceptance.
