# Evidence1 Hyper-V Ops Toolkit

This toolkit exists to make the Evidence1 Windows runner repeatable from a host session without
turning the host into a general-purpose elevated shell. It does not authorize live sessions.

## Boundary

- The VM is still the isolation boundary for Evidence1 live execution.
- The host scripts only place launchers, update the harness, read privacy-safe progress, or copy
  finalized operational artifacts.
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

3. Place live autorun only after readiness PASS and a fresh live authorization phrase:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File docs\audits\evidence1-host-elevated-runner-client.ps1 `
  -ScriptPath docs\audits\evidence1-hyperv-place-live-autorun.ps1 `
  -ScriptArgumentsJson '["-LiveAuthorizationPhrase","<literal authorization phrase>"]'
```

4. Monitor progress without raw access:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File docs\audits\evidence1-host-elevated-runner-client.ps1 `
  -ScriptPath docs\audits\evidence1-hyperv-read-live-progress.ps1
```

5. If the progress summary is not enough, read bounded operational tails only:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File docs\audits\evidence1-host-elevated-runner-client.ps1 `
  -ScriptPath docs\audits\evidence1-hyperv-read-live-operational-tail.ps1
```

6. After the VM has stopped, copy terminal artifacts:

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
- Documentation preserves the no-live authorization boundary.
