# Evidence1 live canary

This runbook executes one registered Evidence1 session after deterministic
validation. It is intentionally fail-closed: a failed or interrupted attempt is
preserved, not retried, replaced, or respawned automatically.

Use the lower-level [post-merge validation contract](../audits/evidence1-post-merge-validation.md)
and [Hyper-V operations toolkit](../audits/evidence1-hyperv-ops-toolkit.md)
when a report is rejected or custody is uncertain. This page provides the
normal path, not every forensic recovery branch.

## Scope

The registered Claude one-cell designs are:

| Arm | Campaign design | Condition | Product access | Sessions |
| --- | --- | --- | --- | ---: |
| Product | `claude-product-canary-v1` | `current-skill` | `product-assisted` | 1 |
| FreeBaseline | `claude-free-baseline-canary-v1` | `no-skill` | `free-baseline-no-product` | 1 |

Both use `sandboxed-unrestricted-v1` and the
`coverage-threshold-failure-v2` scenario. The Codex runtime is under separate
validation and is not supported by this Claude-specific runbook.

## Before starting

Require all of the following:

- the environment passes the [Evidence1 setup checklist](evidence1-windows-setup.md);
- the host operational checkout is clean and at the reviewed commit/tree;
- the public target source is pinned to the scenario commit;
- the constrained elevated runner points at that exact operational checkout;
- the VM has no active agent, Node, Java, Gradle, or prior autorun process;
- every earlier live handoff has terminal custody for its exact run ID;
- the operator has approved the intended live session count and budget.

Define local variables in the operator shell. Values stay local and are not
copied into documentation:

```powershell
$opsRoot = (Resolve-Path 'docs\audits').Path
$client = Join-Path $opsRoot 'evidence1-host-elevated-runner-client.ps1'
$sourceRepo = (Resolve-Path '.').Path
$targetCommit = (git rev-parse HEAD).Trim()
$targetTree = (git rev-parse 'HEAD^{tree}').Trim()

function Invoke-Evidence1Operation {
  param(
    [Parameter(Mandatory)][string]$ScriptName,
    [string[]]$Arguments = @(),
    [int]$TimeoutMinutes = 30
  )

  & $client `
    -AllowedRoot $opsRoot `
    -ScriptPath (Join-Path $opsRoot $ScriptName) `
    -ScriptArguments $Arguments `
    -TimeoutMinutes $TimeoutMinutes

  if ($LASTEXITCODE -ne 0) {
    throw "HARD STOP: $ScriptName failed"
  }
}
```

The operational scripts additionally enforce their audited deployment roots
and fixed identities. The variables above do not make the backend generic.

## V1 — deploy and regenerate readiness

Deploy the exact reviewed harness bundle:

```powershell
Invoke-Evidence1Operation `
  -ScriptName 'evidence1-hyperv-update-harness-from-bundle.ps1' `
  -Arguments @(
    '-SourceRepoDir', $sourceRepo,
    '-TargetCommit', $targetCommit,
    '-TargetTree', $targetTree
  )
```

Then regenerate readiness against the same anchors:

```powershell
Invoke-Evidence1Operation `
  -ScriptName 'evidence1-hyperv-regenerate-readiness-direct.ps1' `
  -Arguments @(
    '-SourceRepoDir', $sourceRepo,
    '-TargetCommit', $targetCommit,
    '-TargetTree', $targetTree
  )
```

Inspect the bounded terminal reports and require `PASS`. V1 must establish the
guest harness/source anchors, clean source inventory, runtime/toolchain probes,
fresh attestation, restricted network, and absence of unresolved prior custody.
Readiness alone does not authorize live execution.

## Authentication gate

First require the local runtime-auth check. If the stored login is stale, use
the manual recovery flow in [Evidence1 Windows setup](evidence1-windows-setup.md#6-perform-interactive-runtime-authentication),
then reseal the network and regenerate V1.

A remote auth canary is one live runtime request, although it has no repository,
skill, or tools. It therefore requires an exact, separately recorded operator
authorization. Keep that phrase in the private operation record; do not commit it
to the repository.

```text
<exact remote-auth canary authorization phrase approved by the operator>
```

After that authorization has been recorded, run:

```powershell
Invoke-Evidence1Operation `
  -ScriptName 'evidence1-hyperv-verify-guest-claude-auth-direct.ps1' `
  -Arguments @(
    '-RunRemoteAuthCanary',
    '-RemoteAuthCanaryAuthorizationPhrase',
    '<exact phrase from the private operator record>'
  )
```

Require a fresh passing report. The current contract treats remote-auth
freshness separately from V1/V2/V3; a historical live success is not a
substitute.

## V2 — deterministic product wet gate

V2 runs no agent. It invokes the product from the checked harness against the
pinned target project and proves the scenario's authoritative result:

```text
kmp-test parallel --json --project-root . --module-filter ":core:domain" --min-missed-lines 15
```

Run the validator with a unique report filename inside its approved local
report root so a prior failed report is never overwritten:

```powershell
$wetReport = '<approved-local-v2-report-root>\V2-<attempt-id>.json'

Invoke-Evidence1Operation `
  -ScriptName 'evidence1-hyperv-verify-wet-gate-v2-direct.ps1' `
  -Arguments @(
    '-TargetCommit', $targetCommit,
    '-TargetTree', $targetTree,
    '-ReportPath', $wetReport
  )
```

Require the exact contract: one passing aggregate test outcome, four individual
tests, one contributing module, 23 missed lines against a threshold of 15, one
`coverage_threshold_exceeded` error, and product/envelope exit code 1. Those
numbers are scenario ground truth at the pinned public project commit, not a
general product benchmark.

If V2 fails, stop. Preserve the report and its SHA-256. Use the hash-bound
forensic or offline-cache diagnostic described in the lower-level runbook; do
not overwrite the report or rerun the consumed V2 attempt blindly.

## V3 — independent one-cell dry plans

V3 constructs and validates both one-session plans without spawning an agent:

```powershell
$dryReport = '<approved-local-v3-report-root>\V3-<attempt-id>.json'

Invoke-Evidence1Operation `
  -ScriptName 'evidence1-hyperv-verify-canary-dryrun-v3-direct.ps1' `
  -Arguments @(
    '-TargetCommit', $targetCommit,
    '-TargetTree', $targetTree,
    '-ReportPath', $dryReport
  )
```

Require `PASS`, zero live records, and exactly one planned session for each
registered design. Product must resolve to `current-skill` plus
`product-assisted`; FreeBaseline must resolve to `no-skill` plus
`free-baseline-no-product`. Both must retain the attested external-sandbox
profile.

## Live authorization and one-use handoff

Only after V1, fresh remote auth, V2, and V3 pass may one arm consume one live
authorization. These are the stable operator phrases:

```text
AUTORIZO 1 SESION LIVE NUEVA DEL Evidence1 CLAUDE WINDOWS CANARY product, SIN REINTENTOS, REEMPLAZOS NI RESPAWNS
AUTORIZO 1 SESION LIVE NUEVA DEL Evidence1 CLAUDE WINDOWS CANARY free-baseline, SIN REINTENTOS, REEMPLAZOS NI RESPAWNS
```

Each authorization event covers one new session of the named arm. A paired
round consumes one Product and one FreeBaseline authorization. Three paired
rounds are six independent sessions and require authorization covering all six;
the first pair does not authorize the next two. An authorization granted in
advance may be consumed after the gates pass when its scope is explicit; do not
request it again solely because validation finished later.

Generate a fresh run ID, bind the exact V2/V3 bytes, and submit the selected arm:

```powershell
$arm = '<product-or-free-baseline>'
$runId = [guid]::NewGuid().ToString('D')
$wetHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $wetReport).Hash.ToLowerInvariant()
$dryHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $dryReport).Hash.ToLowerInvariant()
$authorization = '<exact-authorized-phrase-for-this-arm>'

Invoke-Evidence1Operation `
  -ScriptName 'evidence1-hyperv-start-authorized-live.ps1' `
  -Arguments @(
    '-ExpectedTargetCommit', $targetCommit,
    '-ExpectedTargetTree', $targetTree,
    '-CanaryArm', $arm,
    '-CanaryRunId', $runId,
    '-WetReportPath', $wetReport,
    '-DryReportPath', $dryReport,
    '-ExpectedWetReportSha256', $wetHash,
    '-ExpectedDryReportSha256', $dryHash,
    '-LiveAuthorizationPhrase', $authorization
  )
```

The expected transition is `Running + verified -> Off -> Armed -> Running`.
Require the handoff state `started`. Any other state is a hard stop. Do not
delete claim files, reuse the run ID, or submit the same authorization again.

## Privacy-safe progress

Read progress bound to the exact run ID:

```powershell
Invoke-Evidence1Operation `
  -ScriptName 'evidence1-hyperv-read-live-progress.ps1' `
  -Arguments @('-ExpectedRunId', $runId)
```

If the closed summary is insufficient, use the bounded operational-tail reader:

```powershell
Invoke-Evidence1Operation `
  -ScriptName 'evidence1-hyperv-read-live-operational-tail.ps1'
```

These readers must never select “the newest run,” read raw transcript content,
or turn a process exit into terminal success. Avoid direct guest log inspection
during a live attempt.

## Terminal custody

After the guest has stopped, copy only the sanitized terminal artifacts for the
same run:

```powershell
Invoke-Evidence1Operation `
  -ScriptName 'evidence1-hyperv-copy-live-artifacts.ps1' `
  -Arguments @('-ExpectedRunId', $runId)
```

The copy operation verifies the mounted staged modules, binding, claims,
handoff, arm, and terminal record. It excludes raw transcripts and per-cell
stderr. Require a passing custody report before starting any later session.

If a host restart left the VM running after a terminal record was produced,
consult the lower-level runbook before using the narrowly guarded
`-GracefulShutdown` recovery. Never use a hard power-off as a convenience and
never treat an incomplete custody report as permission to rerun.

## Validate, aggregate, and publish

For each copied accepted run:

```bash
node tools/agentic-eval/cli.mjs validate --run <sanitized-run-record.json>
```

After all intended cells validate:

```bash
node tools/agentic-eval/cli.mjs aggregate --runs-dir <sanitized-runs-directory>
node tools/agentic-eval/cli.mjs analyze --runs-dir <sanitized-runs-directory>
```

Publish only reviewed, sanitized records, their validated sidecars, and the
aggregate analysis. Do not publish raw captures, prompts, responses, stderr,
credentials, machine paths, VHDs, checkpoints, or auth/attestation secrets.

Report Product versus FreeBaseline as a descriptive within-partition contrast.
State `n`, order, runtime/model/version, scenario and project pins, profile,
cache policy, success, evidence quality, medians/ranges, and any outliers. A
three-round canary is useful operational evidence, not a statistically powered
causal effect estimate.

## Hard-stop conditions

Stop without retrying when any of these occurs:

- unknown or active prior run state;
- dirty or mismatched harness/source anchors;
- stale/mismatched isolation attestation or auth report;
- V1, V2, or V3 rejection;
- plan count other than exactly one for the selected canary;
- authorization mismatch or already-consumed authorization;
- unexpected network state, process, file, link, or custody artifact;
- transcript/accounting/schema/privacy/sidecar failure;
- interrupted shutdown, unknown transport result, or missing terminal record.

Preserve the original reports and use the hash-bound forensic readers. A new
run ID, another checkout, or a new session does not repair or erase the failed
attempt.
