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

4. Place live autorun only after readiness PASS, a fresh passing remote-auth canary, and a fresh
live authorization phrase:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File docs\audits\evidence1-host-elevated-runner-client.ps1 `
  -ScriptPath docs\audits\evidence1-hyperv-place-live-autorun.ps1 `
  -ScriptArgumentsJson '["-LiveAuthorizationPhrase","<literal authorization phrase>"]'
```

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
- Documentation preserves the no-live authorization boundary.
- A live launcher requires a recent privacy-safe remote-auth canary rather than treating local
  login state as proof of remote credential acceptance.
