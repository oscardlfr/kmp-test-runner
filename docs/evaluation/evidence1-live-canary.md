# Evidence1 live canary runbook

This is the public operator sequence. The PowerShell files under `docs/audits/` are the executable source of truth and fail closed on stale reports, hash drift, active/unknown state, or consumed claims.

Run the one-time runner installer from an elevated Windows PowerShell 5.1 window. After that, run the allowlisted operations below from a normal Windows PowerShell window through the bounded client; do not replace it with a general-purpose elevated shell. PowerShell 7 (`pwsh`) is useful for repository development but is not what the installed Evidence1 scheduled runner invokes.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File docs\audits\evidence1-host-elevated-runner-install.ps1
```

## Safety contract

- One canary command launches exactly one new Claude session for one arm.
- No retries, replacements, or respawns.
- Product and free-baseline sessions use distinct run IDs and explicit authorization.
- At launch, readiness must be no older than 60 minutes and the remote-auth report no older than 30 minutes; the launcher enforces both.
- A process exit of zero is not task success; the structured grader decides the expected outcome.
- Never delete one-use claims or overwrite a failed V2/V3 report.
- Stop on unknown prior state and inspect custody before doing anything else.

## 1. Update the staged harness

Run the versioned host update script with the exact target commit/tree. Preserve its report and hash. The prepared VM and fixed path layout are prerequisites; see [Windows setup](evidence1-windows-setup.md).

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File docs\audits\evidence1-host-elevated-runner-client.ps1 `
  -ScriptPath docs\audits\evidence1-hyperv-update-harness-from-bundle.ps1 `
  -ScriptArgumentsJson '["-TargetCommit","<full-sha>","-TargetTree","<full-tree-sha>"]'
```

## 2. V1 — source and readiness

Regenerate the canonical readiness report and verify source inventory/anchors:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File docs\audits\evidence1-host-elevated-runner-client.ps1 `
  -ScriptPath docs\audits\evidence1-hyperv-regenerate-readiness-direct.ps1 `
  -ScriptArgumentsJson '["-TargetCommit","<full-sha>","-TargetTree","<full-tree-sha>"]'
```

V1 must be current, passing, and bound to the same commit/tree used by later stages.

## 3. V2 — wet product gate

Execute the product gate through the elevated runner and preserve its unique report. This validates the actual warmed/offline product path; cache provisioning alone is not V2.

Choose a fresh filename under the script's fixed report root; never overwrite an earlier receipt.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File docs\audits\evidence1-host-elevated-runner-client.ps1 `
  -ScriptPath docs\audits\evidence1-hyperv-verify-wet-gate-v2-direct.ps1 `
  -ScriptArgumentsJson '["-TargetCommit","<full-sha>","-TargetTree","<full-tree-sha>","-ReportPath","C:\\kmp-eval\\scratch\\hyperv-verify-wet-gate-v2-direct\\V2-<unique-id>.json"]'
```

If dependency resolution fails, the offline cache probe may diagnose the preserved failure. It is not a retry and cannot convert the failed V2 into a pass.

## 4. V3 — exact one-cell dry plan

Generate and validate the registered dry plans for both one-cell arms, then preserve the report/hash:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File docs\audits\evidence1-host-elevated-runner-client.ps1 `
  -ScriptPath docs\audits\evidence1-hyperv-verify-canary-dryrun-v3-direct.ps1 `
  -ScriptArgumentsJson '["-TargetCommit","<full-sha>","-TargetTree","<full-tree-sha>","-ReportPath","C:\\kmp-eval\\scratch\\hyperv-verify-canary-dryrun-v3-direct\\V3-<unique-id>.json"]'
```

Each arm's plan must resolve one scenario, one condition, one repeat, and one planned session. The live launcher later selects one of these already validated plans.

## 5. Refresh remote authentication

Open temporary auth egress only for the authentication step, complete login interactively, then run the auth verifier and reseal the network:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File docs\audits\evidence1-host-elevated-runner-client.ps1 `
  -ScriptPath docs\audits\evidence1-hyperv-open-temporary-auth-egress.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File docs\audits\evidence1-host-elevated-runner-client.ps1 `
  -ScriptPath docs\audits\evidence1-hyperv-open-claude-login-interactive-task.ps1
$evidenceRunId = 'EVIDENCE' + '1'
$remoteAuthPhrase = 'AUTORIZO UN CANARY REMOTO DE AUTENTICACION PARA ' + $evidenceRunId + ' EN ESTE ENTORNO AISLADO, SIN REPOSITORIO, SKILL NI HERRAMIENTAS'
$remoteAuthArguments = @('-RunRemoteAuthCanary', '-RemoteAuthCanaryAuthorizationPhrase', $remoteAuthPhrase) | ConvertTo-Json -Compress
powershell.exe -NoProfile -ExecutionPolicy Bypass -File docs\audits\evidence1-host-elevated-runner-client.ps1 `
  -ScriptPath docs\audits\evidence1-hyperv-verify-guest-claude-auth-direct.ps1 `
  -ScriptArgumentsJson $remoteAuthArguments
powershell.exe -NoProfile -ExecutionPolicy Bypass -File docs\audits\evidence1-host-elevated-runner-client.ps1 `
  -ScriptPath docs\audits\evidence1-hyperv-run-network-seal-direct.ps1
```

Authentication freshness is a separate gate. Never record credentials or the interactive session.

## 6. Launch exactly one authorized cell

The launcher supports a canary only when the complete parameter set is present. Supply the exact V2/V3 paths and SHA-256 values, a fresh run ID, and the authorization literal for the chosen arm:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File docs\audits\evidence1-host-elevated-runner-client.ps1 `
  -ScriptPath docs\audits\evidence1-hyperv-start-authorized-live.ps1 `
  -ScriptArgumentsJson '["-ExpectedTargetCommit","<full-sha>","-ExpectedTargetTree","<full-tree-sha>","-CanaryArm","product","-CanaryRunId","<new-guid>","-WetReportPath","<absolute-v2-report>","-DryReportPath","<absolute-v3-report>","-ExpectedWetReportSha256","<sha256>","-ExpectedDryReportSha256","<sha256>","-LiveAuthorizationPhrase","AUTORIZO 1 SESION LIVE NUEVA DEL Evidence1 CLAUDE WINDOWS CANARY product, SIN REINTENTOS, REEMPLAZOS NI RESPAWNS"]'
```

For the control, replace the arm and literal with `free-baseline`. An earlier, broader matrix authorization is not interchangeable with this one-cell contract.

## 7. Monitor without interfering

Read progress bound to the explicit run; do not select “the newest directory” and do not launch a second session because output is quiet:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File docs\audits\evidence1-host-elevated-runner-client.ps1 `
  -ScriptPath docs\audits\evidence1-hyperv-read-live-progress.ps1 `
  -ScriptArgumentsJson '["-ExpectedRunId","<run-guid>"]'
```

The launcher owns containment, timeout, cleanup, postflight, and terminal persistence. Unknown or partial terminal state requires custody review.

## 8. Copy, validate, and analyze

Copy artifacts with the expected run ID, then validate the sanitized record with its matching sidecar:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File docs\audits\evidence1-host-elevated-runner-client.ps1 `
  -ScriptPath docs\audits\evidence1-hyperv-copy-live-artifacts.ps1 `
  -ScriptArgumentsJson '["-ExpectedRunId","<run-guid>"]'
```

```sh
node tools/agentic-eval/cli.mjs validate --run <runs-dir>/<record>.json
node tools/agentic-eval/cli.mjs aggregate --runs-dir <runs-dir>
node tools/agentic-eval/cli.mjs analyze --runs-dir <runs-dir>
node tools/decouple-audit.mjs
```

Publish only sanitized records and accepted-run sidecars. Keep raw transcripts, claims, stdout/stderr custody, attestation secrets, and VM state outside the repository.

For deeper recovery rules and exact report fields, use the [post-merge validation dossier](../audits/evidence1-post-merge-validation.md) and [operations toolkit](../audits/evidence1-hyperv-ops-toolkit.md).
