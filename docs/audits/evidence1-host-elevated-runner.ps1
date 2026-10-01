#Requires -RunAsAdministrator

param(
  [string]$QueueRoot = 'C:\kmp-eval\scratch\host-elevated-runner',
  [string]$AllowedRoot = '',
  [switch]$TestMode,
  [switch]$Once
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$AllowedScripts = @(
  'evidence1-host-elevated-runner-install.ps1',
  # ADR-S1 typed capability-dispatch entrypoint (this round): ONE new
  # allowlisted script that internally routes a closed, schema-validated
  # request naming one of 7 capabilities to the already-built real/hyperv
  # function that capability maps to
  # (evidence1-broker-capability-contract.psm1, see Get-E1BrokerCapabilityRegistry
  # there). Added ONCE here -- a NEW capability is a change to that closed registry
  # plus routing in evidence1-broker-capability-dispatch-core.psm1, never a
  # new entry in this array. This is the alternative ADR-S1 asks for instead
  # of continuing to add one allowlisted script per operation (the pattern
  # that produced every other entry below it, and the reason this whole
  # stabilization effort exists).
  'evidence1-host-broker-capability-dispatch.ps1',
  'evidence1-hyperv-copy-live-artifacts.ps1',
  'evidence1-hyperv-place-dual-condition-canary.ps1',
  'evidence1-hyperv-start-dual-condition-canary.ps1',
  'evidence1-hyperv-copy-dual-condition-canary.ps1',
  'evidence1-hyperv-copy-dual-auth-canary-diagnostic.ps1',
  'evidence1-hyperv-install-guest-codex-cli-direct.ps1',
  'evidence1-hyperv-upgrade-canonical-codex-cli-direct.ps1',
  'evidence1-hyperv-install-canonical-git-bash-direct.ps1',
  'evidence1-hyperv-open-codex-auth-window-direct.ps1',
  'evidence1-hyperv-inspect-final-codex-live-state.ps1',
  'evidence1-hyperv-inspect-guest-interactive-logon-diagnostic.ps1',
  'evidence1-hyperv-enable-guest-auto-logon.ps1',
  'evidence1-hyperv-seal-final-codex-network.ps1',
  'evidence1-hyperv-trigger-final-codex-direct.ps1',
  'evidence1-hyperv-copy-final-codex-preflight-diagnostic.ps1',
  'evidence1-hyperv-recover-readonly-diagnostic-mount.ps1',
  'evidence1-hyperv-verify-guest-account-mapping-direct.ps1',
  'evidence1-hyperv-inspect-vm-boot-state.ps1',
  'evidence1-hyperv-verify-account-mapping-offline.ps1',
  'evidence1-hyperv-sync-final-codex-source.ps1',
  'evidence1-hyperv-retire-preflight-failed-final-codex.ps1',
  'evidence1-hyperv-inspect-final-codex-closed-state.ps1',
  'evidence1-hyperv-copy-final-codex-failure-diagnostic.ps1',
  'evidence1-hyperv-create-final-codex-attestation.ps1',
  'evidence1-hyperv-rotate-final-codex-attestation.ps1',
  'evidence1-hyperv-run-codex-device-auth-direct.ps1',
  'evidence1-hyperv-run-claude-auth-direct.ps1',
  'evidence1-hyperv-warm-canonical-gradle-cache-direct.ps1',
  'evidence1-hyperv-read-live-operational-tail.ps1',
  'evidence1-hyperv-read-live-progress.ps1',
  'evidence1-hyperv-regenerate-readiness-direct.ps1',
  'evidence1-hyperv-stop-for-final-codex-auth-capture.ps1',
  'evidence1-hyperv-copy-final-codex-attestation.ps1',
  'evidence1-hyperv-inspect-final-codex-binding-inputs.ps1',
  'evidence1-hyperv-restore-canonical-android-sdk.ps1',
  'evidence1-hyperv-capture-final-codex-auth-blob.ps1',
  'evidence1-hyperv-start-authorized-live.ps1',
  'evidence1-hyperv-verify-guest-claude-auth-direct.ps1',
  'evidence1-hyperv-verify-guest-dual-auth-direct.ps1',
  'evidence1-hyperv-verify-guest-codex-preflight-direct.ps1',
  'evidence1-hyperv-update-harness-from-bundle.ps1',
  'evidence1-hyperv-verify-wet-gate-v2-direct.ps1',
  'evidence1-hyperv-verify-canary-dryrun-v3-direct.ps1',
  'evidence1-hyperv-read-wet-forensics-direct.ps1',
  'evidence1-hyperv-read-source-inventory-direct.ps1',
  'evidence1-hyperv-probe-gradle-offline-direct.ps1',
  'evidence1-hyperv-provision-gradle-cache-direct.ps1',
  'evidence1-hyperv-open-temporary-auth-egress.ps1',
  'evidence1-hyperv-open-claude-login-interactive-task.ps1',
  'evidence1-hyperv-open-vmconnect.ps1',
  'evidence1-hyperv-run-network-seal-direct.ps1',
  'evidence1-hyperv-place-final-codex.ps1',
  'evidence1-hyperv-resume-final-codex-placement.ps1',
  'evidence1-hyperv-retire-unstarted-final-codex.ps1',
  'evidence1-hyperv-retire-unexecuted-final-codex.ps1',
  'evidence1-hyperv-start-final-codex.ps1',
  'evidence1-hyperv-copy-final-codex.ps1',
  'evidence1-host-inspect-windows-iso.ps1',
  'evidence1-host-delete-failed-canonical-windows-vm.ps1',
  'evidence1-host-create-canonical-windows-vm.ps1',
  'evidence1-host-install-canonical-windows-unattended.ps1',
  'evidence1-host-apply-canonical-windows-offline.ps1',
  'evidence1-host-new-unattended-retry-custody.ps1',
  'evidence1-host-diagnose-windows-first-boot.ps1',
  'evidence1-host-post-os-canonical-windows.ps1',
  'evidence1-host-bootstrap-canonical-windows-toolchain.ps1',
  'evidence1-host-checkpoint-canonical-windows-toolchain.ps1',
  # E2E VM startup-memory override (Amendment A5 round 2): host-only
  # Get-VM/Set-VMMemory, no guest credential, closed VMName/ExpectedVMId and
  # a ValidateSet StartupMemoryGiB -- same shape as
  # evidence1-hyperv-stop-for-final-codex-auth-capture.ps1, requires VM Off
  # and fails closed on read-back mismatch.
  'evidence1-hyperv-set-vm-memory-direct.ps1',
  # E2E VHD/AVHDX chain inspection (Amendment A6 follow-up): host-only,
  # read-only Get-VHD walk of the currently-attached disk's full parent
  # chain, closed VMName/ExpectedVMId, no guest credential, never mutates
  # anything -- answers the host-disk-headroom question with evidence
  # instead of an assumed number.
  'evidence1-hyperv-inspect-vhd-chain-direct.ps1',
  # Content-free LastWriteTimeUtc/Length for the Claude OAuth
  # credential file only (fixed guest path, never a parameter) -- Get-Item
  # only, never Get-Content, structurally never reads the file's content.
  'evidence1-hyperv-stat-guest-file-direct.ps1'
)

# Hash-bound support files are readable/importable by allowlisted entrypoints but
# can never be selected as the elevated request target.
$TrustedSupportFiles = @(
  # Capability-dispatch protocol (this round): the pure contract + routing
  # modules evidence1-host-broker-capability-dispatch.ps1 imports, plus the
  # full closure of already-reviewed capability modules it routes to for the
  # 7 registered capabilities. None of these 13 files were previously
  # registered here -- see docs/audits/evidence1-phase3c-architecture-note.md
  # section 9.4 item 6 and open question 6 for why that was a real gap, not
  # an oversight this round silently inherits: these modules were built
  # (Phase 2/3a/3b) but had no allowlisted elevated caller until the new
  # dispatcher added in this round existed to import them.
  'evidence1-broker-capability-contract.psm1',
  'evidence1-broker-capability-dispatch-core.psm1',
  'evidence1-broker-status-contract.psm1',
  'evidence1-broker-status-real.psm1',
  'evidence1-vm-state-contract.psm1',
  'evidence1-vm-state-hyperv.psm1',
  'evidence1-network-backend-contract.psm1',
  'evidence1-network-backend-hyperv.psm1',
  'evidence1-guest-bundle-contract.psm1',
  'evidence1-guest-bundle-hyperv.psm1',
  'evidence1-artifact-copy-contract.psm1',
  'evidence1-artifact-copy-hyperv.psm1',
  'evidence1-trusted-root-config.psm1',
  'evidence1-stageb-network-seal.ps1',
  'evidence1-live-run-contract.psm1',
  'evidence1-provider-runtime-contract.psm1',
  'evidence1-dual-condition-canary-contract.psm1',
  'evidence1-dual-condition-canary-launch.ps1',
  'evidence1-dual-condition-canary-wrapper.ps1',
  'evidence1-hyperv-place-live-autorun.ps1',
  'evidence1-guest-dual-auth-canary.ps1',
  'evidence1-validation-forensics.psm1',
  'evidence1-gradle-offline-probe.psm1',
  'evidence1-gradle-cache-provision.psm1',
  'evidence1-cache-provision-host.psm1',
  'evidence1-stageb-live-launch.ps1',
  'evidence1-stageb-live-wrapper.ps1',
  'evidence1-final-codex-host-contract.psm1',
  'evidence1-live-handoff-contract.psm1',
  'evidence1-final-codex-copy-contract.psm1',
  'evidence1-host-snapshot-contract.psm1',
  'evidence1-codex-live-launch.ps1',
  'evidence1-final-codex-guest-wrapper.ps1',
  'evidence1-host-windows-provisioning-chain.psm1',
  'evidence1-host-windows-psdirect-operation.ps1',
  'evidence1-vm-identity-contract.psm1'
)

# Complete repo-relative runtime closure used by privileged entrypoints. Layout
# is preserved below node-runtime so ESM imports and provisioning-local module
# references resolve exactly as they do in the reviewed repository.
$TrustedNodeFiles = @(
  'package.json',
  'docs/audits/evidence1-codex-pilot-describe.mjs',
  'docs/audits/evidence1-codex-publication-scan.mjs',
  'lib/envelope/exit-codes.js',
  'lib/orchestrators/module-filter.js',
  'tools/agentic-eval/accepted-run-audit.mjs',
  'tools/agentic-eval/canonical-json.mjs',
  'tools/agentic-eval/command-classify.mjs',
  'tools/agentic-eval/coverage-gate-observability.mjs',
  'tools/agentic-eval/dispatch-accounting.mjs',
  'tools/agentic-eval/evidence-io.mjs',
  'tools/agentic-eval/grading-contract.mjs',
  'tools/agentic-eval/junit-evidence-io.mjs',
  'tools/agentic-eval/materialize.mjs',
  'tools/agentic-eval/outcome-assessment-contract.mjs',
  'tools/agentic-eval/policy-hook.mjs',
  'tools/agentic-eval/privacy.mjs',
  'tools/agentic-eval/product-access.mjs',
  'tools/agentic-eval/resolve-bash.mjs',
  'tools/agentic-eval/runtimes/contract.mjs',
  'tools/agentic-eval/schemas.mjs',
  'tools/lib/redact.mjs',
  'tools/evidence1/provisioning/evidence1-apply-windows-offline.ps1',
  'tools/evidence1/provisioning/evidence1-install-windows-unattended.ps1',
  'tools/evidence1/provisioning/evidence1-new-unattended-retry-custody.ps1',
  'tools/evidence1/provisioning/evidence1-post-os-transition.ps1',
  'tools/evidence1/provisioning/evidence1-bootstrap-toolchain.ps1',
  'tools/evidence1/provisioning/evidence1-checkpoint-toolchain.ps1',
  'tools/evidence1/provisioning/evidence1-windows-vm.ps1',
  'tools/evidence1/provisioning/Evidence1.Provisioning.psm1',
  'tools/evidence1/provisioning/evidence1-windows-hyperv-e2e-v1.json',
  'tools/evidence1/provisioning/evidence1-windows-input-lock.schema.json',
  'tools/evidence1/provisioning/evidence1-windows-approved-inputs.schema.json',
  'tools/evidence1/provisioning/approved-inputs/evidence1-windows-25h2-en-gb-codex-01534-e2e-v1.json',
  'tools/evidence1/provisioning/approved-inputs/evidence1-windows-25h2-en-gb-codex-01534-e2e-v2.json',
  'docs/audits/evidence1-dual-condition-canary-contract.psm1',
  'docs/audits/evidence1-dual-condition-canary-launch.ps1',
  'docs/audits/evidence1-dual-condition-canary-wrapper.ps1',
  'docs/audits/evidence1-live-handoff-contract.psm1',
  'docs/audits/evidence1-provider-runtime-contract.psm1',
  'docs/audits/evidence1-validation-ops.psm1',
  'docs/audits/evidence1-validation-forensics.psm1',
  'docs/audits/evidence1-gradle-offline-probe.psm1',
  'lib/android-sdk-catalogue.js',
  'lib/cli.js',
  'lib/commands/android.js',
  'lib/commands/benchmark.js',
  'lib/commands/changed.js',
  'lib/commands/clean.js',
  'lib/commands/coverage.js',
  'lib/commands/describe.js',
  'lib/commands/doctor.js',
  'lib/commands/info.js',
  'lib/commands/parallel.js',
  'lib/commands/update.js',
  'lib/envelope/builder.js',
  'lib/envelope/dry-run-blocks.js',
  'lib/envelope/error-codes.js',
  'lib/jdk-catalogue.js',
  'lib/orchestrators/android-capture.js',
  'lib/orchestrators/android-orchestrator.js',
  'lib/orchestrators/benchmark-orchestrator.js',
  'lib/orchestrators/changed-orchestrator.js',
  'lib/orchestrators/coverage-orchestrator.js',
  'lib/orchestrators/describe-orchestrator.js',
  'lib/orchestrators/info-orchestrator.js',
  'lib/orchestrators/orchestrator-utils.js',
  'lib/orchestrators/parallel-orchestrator.js',
  'lib/orchestrators/parallel/cascade-retry.js',
  'lib/orchestrators/parallel/dispatch.js',
  'lib/orchestrators/parallel/result-rollup.js',
  'lib/orchestrators/update-orchestrator.js',
  'lib/parsers/argv-constants.js',
  'lib/parsers/argv.js',
  'lib/parsers/coverage-xml.js',
  'lib/parsers/junit-xml.js',
  'lib/parsers/script-output.js',
  'lib/parsers/test-filter.js',
  'lib/project-config.js',
  'lib/project-model.js',
  'lib/project/analyze-module.js',
  'lib/project/artifact-sweep.js',
  'lib/project/cache.js',
  'lib/project/jdk-preflight.js',
  'lib/project/jdk-signals.js',
  'lib/project/kotlin-dsl.js',
  'lib/runner.js',
  'lib/runners/console-mode.js',
  'lib/runners/lockfile.js',
  'lib/runners/script-dispatcher.js',
  'lib/runners/shell-runner.js',
  'lib/user-config.js',
  'tools/agentic-eval/agent-state.mjs',
  'tools/agentic-eval/aggregate.mjs',
  'tools/agentic-eval/analysis.mjs',
  'tools/agentic-eval/auth-preflight.mjs',
  'tools/agentic-eval/cell-integrity.mjs',
  'tools/agentic-eval/cli.mjs',
  'tools/agentic-eval/codex-jsonl-parser.mjs',
  'tools/agentic-eval/codex-offline-preflight.mjs',
  'tools/agentic-eval/condition-launcher.mjs',
  'tools/agentic-eval/corpus/scenarios/changed-module-verification.json',
  'tools/agentic-eval/corpus/scenarios/coverage-threshold-failure-v2.json',
  'tools/agentic-eval/corpus/scenarios/coverage-threshold-failure.json',
  'tools/agentic-eval/corpus/scenarios/deterministic-unit-test-failure.json',
  'tools/agentic-eval/corpus/scenarios/kampkit-android-host-test-discovery.json',
  'tools/agentic-eval/corpus/scenarios/kampkit-no-applicable-tests.json',
  'tools/agentic-eval/corpus/scenarios/nowinandroid-core-common.json',
  'tools/agentic-eval/corpus/trigger-queries.json',
  'tools/agentic-eval/correlation-observability.mjs',
  'tools/agentic-eval/durable-journal.mjs',
  'tools/agentic-eval/env-builder.mjs',
  'tools/agentic-eval/execution-profiles/isolation-attestation.mjs',
  'tools/agentic-eval/execution-profiles/registry.json',
  'tools/agentic-eval/final-campaign-control.mjs',
  'tools/agentic-eval/graders-multi-module.mjs',
  'tools/agentic-eval/graders.mjs',
  'tools/agentic-eval/incident-diagnostics.mjs',
  'tools/agentic-eval/input-artifacts.mjs',
  'tools/agentic-eval/junit-evidence-hook.mjs',
  'tools/agentic-eval/junit-evidence.mjs',
  'tools/agentic-eval/matrix-runner.mjs',
  'tools/agentic-eval/measurement-scope.mjs',
  'tools/agentic-eval/models/registry.json',
  'tools/agentic-eval/path-shim.mjs',
  'tools/agentic-eval/policy-config.mjs',
  'tools/agentic-eval/print-skill-snapshot.mjs',
  'tools/agentic-eval/product-access-preflight.mjs',
  'tools/agentic-eval/randomizer.mjs',
  'tools/agentic-eval/registries.mjs',
  'tools/agentic-eval/rejection-diagnostics.mjs',
  'tools/agentic-eval/run-record-loader.mjs',
  'tools/agentic-eval/run-record-view.mjs',
  'tools/agentic-eval/runtimes/claude-code.mjs',
  'tools/agentic-eval/runtimes/codex-cli.mjs',
  'tools/agentic-eval/runtimes/registry.json',
  'tools/agentic-eval/scenario-campaign-plan.mjs',
  'tools/agentic-eval/stream-parser.mjs'
)

function Resolve-FullPath([string]$Path) {
  return [System.IO.Path]::GetFullPath($Path)
}

function Convert-E1RunnerNodeRelativePath([string]$RelativePath) {
  if([string]::IsNullOrWhiteSpace($RelativePath)-or$RelativePath.Contains('\')-or$RelativePath.StartsWith('/')-or$RelativePath-cmatch'(^|/)(\.|\.\.)(/|$)'-or$RelativePath-cmatch':'){throw 'node_runtime_relative_path_invalid'}
  return $RelativePath.Replace('/',[IO.Path]::DirectorySeparatorChar)
}

function Get-E1RunnerSha256([string]$Path) {
  $stream=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
  try{$hasher=[Security.Cryptography.SHA256]::Create();try{return([BitConverter]::ToString($hasher.ComputeHash($stream))-replace'-','').ToLowerInvariant()}finally{$hasher.Dispose()}}finally{$stream.Dispose()}
}

function Import-E1RunnerSecurityModule {
  $modulePath=Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1'
  if(-not(Test-Path -LiteralPath $modulePath -PathType Leaf)){throw 'elevated_runner_security_module_unavailable'}
  try{Import-Module -Name $modulePath -Force -ErrorAction Stop}
  catch{throw 'elevated_runner_security_module_unavailable'}
}

function Assert-E1RunnerNoReparse([string]$Path) {
  $cursor=Resolve-FullPath $Path
  while($cursor){if(Test-Path -LiteralPath $cursor){$item=Get-Item -LiteralPath $cursor -Force;if(($item.Attributes-band[IO.FileAttributes]::ReparsePoint)-ne 0){throw 'elevated_runner_reparse_rejected'}};$parent=Split-Path -Parent $cursor;if(-not$parent-or$parent-ceq$cursor){break};$cursor=$parent}
}

function Assert-E1RunnerDirectFile([string]$Path,[string]$Root,[string]$Leaf,[string]$Code) {
  $full=Resolve-FullPath $Path;$expected=Resolve-FullPath (Join-Path $Root $Leaf)
  if(-not$full.Equals($expected,[StringComparison]::OrdinalIgnoreCase)){throw $Code}
  Assert-E1RunnerNoReparse $Root;Assert-E1RunnerNoReparse $full
  if(-not(Test-Path -LiteralPath $full -PathType Leaf)){throw $Code}
  $item=Get-Item -LiteralPath $full -Force
  if($item.PSIsContainer-or($item.Attributes-band[IO.FileAttributes]::ReparsePoint)-ne 0){throw $Code}
  return $full
}

function Test-E1RunnerExactKeys($Value,[string[]]$Keys){return $null-ne$Value-and@(Compare-Object @($Value.PSObject.Properties.Name|Sort-Object) @($Keys|Sort-Object)).Count-eq 0}

function Assert-E1RunnerProtectedAcl([string]$Path,[string]$PrincipalSid,[bool]$Directory) {
  $acl=Get-Acl -LiteralPath $Path;if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value-cne'S-1-5-32-544'-or-not$acl.AreAccessRulesProtected){throw 'elevated_runner_deployment_acl_invalid'}
  $rules=@($acl.GetAccessRules($true,$false,[Security.Principal.SecurityIdentifier]));if($rules.Count-ne 3){throw 'elevated_runner_deployment_acl_invalid'}
  $readExecute=[int]([Security.AccessControl.FileSystemRights]::ReadAndExecute-bor[Security.AccessControl.FileSystemRights]::Synchronize)
  $expected=@{'S-1-5-18'=[int][Security.AccessControl.FileSystemRights]::FullControl;'S-1-5-32-544'=[int][Security.AccessControl.FileSystemRights]::FullControl;$PrincipalSid=$readExecute}
  foreach($rule in $rules){$sid=$rule.IdentityReference.Value;$inherit=if($Directory){[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'}else{[Security.AccessControl.InheritanceFlags]::None};if(-not$expected.ContainsKey($sid)-or$rule.AccessControlType-ne[Security.AccessControl.AccessControlType]::Allow-or[int]$rule.FileSystemRights-ne$expected[$sid]-or$rule.InheritanceFlags-ne$inherit-or$rule.PropagationFlags-ne[Security.AccessControl.PropagationFlags]::None){throw 'elevated_runner_deployment_acl_invalid'}}
}

function Assert-PathInside([string]$Candidate, [string]$Root, [string]$Label) {
  $candidateFull = Resolve-FullPath $Candidate
  $rootFull = (Resolve-FullPath $Root).TrimEnd('\') + '\'
  if (-not $candidateFull.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label path is outside expected root: $candidateFull"
  }
}

function Write-Response($Request, [int]$ExitCode, [string]$LogPath, [string]$ErrorMessage) {
  $responsePath = Join-Path $script:ResponseDir "$($Request.id).response.json"
  $response = [ordered]@{
    id = $Request.id
    generated_at_utc = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    exit_code = $ExitCode
    log_path = $LogPath
    error = $ErrorMessage
  }
  ($response | ConvertTo-Json -Depth 5) | Set-Content -LiteralPath $responsePath -Encoding UTF8
}

function Quote-ProcessArgument([string]$Argument) {
  if ($Argument -notmatch '[\s"]') {
    return $Argument
  }
  return '"' + ($Argument -replace '"', '\"') + '"'
}

function Assert-E1UnattendedRunnerArguments([string]$ScriptName, [string[]]$Arguments) {
  if ($ScriptName -cne 'evidence1-host-install-canonical-windows-unattended.ps1') { return }
  foreach ($arg in $Arguments) {
    $argumentName = (([string]$arg).Split(':', 2)[0]).TrimStart('-', '/')
    if ($argumentName.Length -gt 0 -and
        'RecoveryReasonCode'.StartsWith($argumentName, [StringComparison]::OrdinalIgnoreCase)) {
      throw 'reserved unattended recovery argument'
    }
  }
}

function Assert-E1WindowsProvisioningRunnerArguments([string]$ScriptName, [string[]]$Arguments) {
  if ($ScriptName -ceq 'evidence1-host-install-canonical-windows-unattended.ps1') {
    Assert-E1UnattendedRunnerArguments $ScriptName $Arguments
    return
  }
  if ($ScriptName -cne 'evidence1-host-apply-canonical-windows-offline.ps1') { return }
  foreach ($arg in $Arguments) {
    $argumentName = (([string]$arg).Split(':', 2)[0]).TrimStart('-', '/')
    if ($argumentName.Length -gt 0 -and
        'RecoveryReasonCode'.StartsWith($argumentName, [StringComparison]::OrdinalIgnoreCase)) {
      throw 'reserved unattended recovery argument'
    }
  }
}

function Get-E1ExactNamedArguments([string[]]$Arguments, [string[]]$AllowedNames) {
  if ($Arguments.Count % 2 -ne 0) { throw 'canonical post-apply argv must use exact name/value pairs' }
  $values = @{}
  for ($index = 0; $index -lt $Arguments.Count; $index += 2) {
    $name = [string]$Arguments[$index]
    if ($name -cnotmatch '^-[A-Za-z][A-Za-z0-9]*$' -or $name -cnotin $AllowedNames -or $values.ContainsKey($name)) {
      throw 'canonical post-apply argv contains unknown, abbreviated, duplicate, or positional arguments'
    }
    $values[$name] = [string]$Arguments[$index + 1]
  }
  return $values
}

function Assert-E1CanonicalPostApplyRunnerArguments([string]$ScriptName, [string[]]$Arguments) {
  if ($ScriptName -notin @(
      'evidence1-host-diagnose-windows-first-boot.ps1',
      'evidence1-host-post-os-canonical-windows.ps1',
      'evidence1-host-bootstrap-canonical-windows-toolchain.ps1',
      'evidence1-host-checkpoint-canonical-windows-toolchain.ps1')) { return }
  if ($ScriptName -ceq 'evidence1-host-diagnose-windows-first-boot.ps1') {
    $values = Get-E1ExactNamedArguments $Arguments @('-InputLockPath','-RecoveryReceiptPath','-ReceiptPath','-AuthorizationPhrase')
    foreach ($required in @('-InputLockPath','-RecoveryReceiptPath','-ReceiptPath','-AuthorizationPhrase')) {
      if (-not $values.ContainsKey($required)) { throw 'canonical post-apply argv missing required argument' }
    }
    if ($values['-AuthorizationPhrase'] -cne 'authorize diagnose evidence1 recovered first boot without auth') {
      throw 'canonical post-apply argv invalid'
    }
    return
  }
  if ($ScriptName -ceq 'evidence1-host-post-os-canonical-windows.ps1') {
    $values = Get-E1ExactNamedArguments $Arguments @('-Mode','-InputLockPath','-GuestCredentialPath','-PriorReceiptPath','-PriorParentReceiptPath','-PriorFailureReceiptPath','-ReceiptPath','-AuthorizationPhrase')
    foreach ($required in @('-Mode','-InputLockPath','-GuestCredentialPath','-PriorReceiptPath','-ReceiptPath','-AuthorizationPhrase')) {
      if (-not $values.ContainsKey($required)) { throw 'canonical post-apply argv missing required argument' }
    }
    if ($values['-Mode'] -ceq 'StartAndVerify') {
      if ($values.ContainsKey('-PriorParentReceiptPath') -or $values['-AuthorizationPhrase'] -cne 'authorize start evidence1 e2e post-os verification') { throw 'canonical post-apply argv invalid' }
    } elseif ($values['-Mode'] -ceq 'Seal') {
      if (-not $values.ContainsKey('-PriorParentReceiptPath') -or $values.ContainsKey('-PriorFailureReceiptPath') -or $values['-AuthorizationPhrase'] -cne 'authorize seal evidence1 windows post-os boundary') { throw 'canonical post-apply argv invalid' }
    } else { throw 'canonical post-apply argv invalid' }
    return
  }
  if ($ScriptName -ceq 'evidence1-host-bootstrap-canonical-windows-toolchain.ps1') {
    $values = Get-E1ExactNamedArguments $Arguments @('-Mode','-InputLockPath','-GuestCredentialPath','-PriorReceiptPath','-PriorParentReceiptPath','-PriorFailureReceiptPath','-ReceiptPath','-AuthorizationPhrase')
    foreach ($required in @('-Mode','-InputLockPath','-GuestCredentialPath','-PriorReceiptPath','-PriorParentReceiptPath','-ReceiptPath')) {
      if (-not $values.ContainsKey($required)) { throw 'canonical post-apply argv missing required argument' }
    }
    if ($values['-Mode'] -ceq 'Bootstrap') {
      if (-not $values.ContainsKey('-AuthorizationPhrase') -or $values['-AuthorizationPhrase'] -cne 'authorize bootstrap evidence1 e2e windows toolchain without auth') { throw 'canonical post-apply argv invalid' }
    } elseif ($values['-Mode'] -ceq 'Verify') {
      if ($values.ContainsKey('-AuthorizationPhrase') -or $values.ContainsKey('-PriorFailureReceiptPath')) { throw 'canonical post-apply argv invalid' }
    } else { throw 'canonical post-apply argv invalid' }
    return
  }
  $values = Get-E1ExactNamedArguments $Arguments @('-InputLockPath','-GuestCredentialPath','-ToolchainReceiptPath','-PriorParentReceiptPath','-PriorFailureReceiptPath','-ReceiptPath','-ShutdownTimeoutSeconds','-AuthorizationPhrase')
  foreach ($required in @('-InputLockPath','-GuestCredentialPath','-ToolchainReceiptPath','-PriorParentReceiptPath','-ReceiptPath','-AuthorizationPhrase')) {
    if (-not $values.ContainsKey($required)) { throw 'canonical post-apply argv missing required argument' }
  }
  if ($values['-AuthorizationPhrase'] -cne 'authorize checkpoint verified evidence1 toolchain without auth') { throw 'canonical post-apply argv invalid' }
  if ($values.ContainsKey('-ShutdownTimeoutSeconds')) {
    [int]$seconds = 0
    if (-not [int]::TryParse($values['-ShutdownTimeoutSeconds'], [ref]$seconds) -or $seconds -lt 30 -or $seconds -gt 300) { throw 'canonical post-apply argv invalid' }
  }
}

# The installer derives its own "canonical source" from whatever -AllowedRoot it is
# given, rather than checking it against one fixed path -- reasonable when a human
# types the command, not reasonable once this queue can trigger it unattended. This
# pins every argument to the one true deployment identity so the self-install path
# can never be redirected at a different repository, task, or execution mode.
function Assert-E1SelfInstallRunnerArguments([string]$ScriptName, [string[]]$Arguments) {
  if ($ScriptName -cne 'evidence1-host-elevated-runner-install.ps1') { return }
  $canonicalAudits = 'C:\kmp-eval\agentic-eval-codex-runtime\docs\audits'
  $values = Get-E1ExactNamedArguments $Arguments @('-TaskName','-RunnerPath','-QueueRoot','-AllowedRoot','-ExecutionIdentity','-ReportPath')
  foreach ($required in @('-TaskName','-RunnerPath','-QueueRoot','-AllowedRoot','-ExecutionIdentity','-ReportPath')) {
    if (-not $values.ContainsKey($required)) { throw 'canonical self-install argv missing required argument' }
  }
  if ($values['-TaskName'] -cne 'Evidence1CodexElevatedRunner') { throw 'canonical self-install argv invalid' }
  if (([IO.Path]::GetFullPath($values['-AllowedRoot'])).TrimEnd('\') -cne $canonicalAudits) { throw 'canonical self-install argv invalid' }
  if (([IO.Path]::GetFullPath($values['-RunnerPath'])).TrimEnd('\') -cne (Join-Path $canonicalAudits 'evidence1-host-elevated-runner.ps1')) { throw 'canonical self-install argv invalid' }
  if (([IO.Path]::GetFullPath($values['-QueueRoot'])).TrimEnd('\') -cne 'C:\kmp-eval\scratch\host-elevated-runner-codex') { throw 'canonical self-install argv invalid' }
  if ($values['-ExecutionIdentity'] -cne 'InteractiveUser') { throw 'canonical self-install argv invalid' }
  if (-not (([IO.Path]::GetFullPath($values['-ReportPath'])).StartsWith('C:\kmp-eval\scratch\host-elevated-runner-codex\install-', [StringComparison]::OrdinalIgnoreCase))) { throw 'canonical self-install argv invalid' }
}

function Get-E1RedactedDisplayArguments([string[]]$Arguments) {
  $display = @()
  $redactNext = $false
  foreach ($argument in $Arguments) {
    $value = [string]$argument
    if ($redactNext) {
      $display += '[REDACTED_AUTHORIZATION]'
      $redactNext = $false
      continue
    }
    if ($value -match '(?i)(^|[:=])\s*(authorize|autorizo)\s') {
      $display += '[REDACTED_AUTHORIZATION]'
      continue
    }
    if ($value -match '^(?<option>[-/](?<name>[A-Za-z0-9]+))(?<separator>[:=]).*$' -and
        @('AuthorizationPhrase','CreateAuthorizationPhrase','RetryAuthorizationPhrase','LiveAuthorizationPhrase','RemoteAuthCanaryAuthorizationPhrase' | Where-Object { $_.StartsWith($Matches.name, [StringComparison]::OrdinalIgnoreCase) }).Count -gt 0) {
      $display += ($Matches.option + $Matches.separator + '[REDACTED_AUTHORIZATION]')
      continue
    }
    if ($value -match '^[-/](?<name>[A-Za-z0-9]+)$' -and
        @('AuthorizationPhrase','CreateAuthorizationPhrase','RetryAuthorizationPhrase','LiveAuthorizationPhrase','RemoteAuthCanaryAuthorizationPhrase' | Where-Object { $_.StartsWith($Matches.name, [StringComparison]::OrdinalIgnoreCase) }).Count -gt 0) {
      $display += $value
      $redactNext = $true
      continue
    }
    $display += $value
  }
  return $display
}

function Invoke-UnattendedRecovery([string]$ScriptPath, [string[]]$Arguments, [string]$WorkingDirectory,
    [string]$LogDirectory, [string]$RequestId, [string]$ReasonCode) {
  $recoveryStdout = Join-Path $LogDirectory "$RequestId.recovery.stdout.tmp.log"
  $recoveryStderr = Join-Path $LogDirectory "$RequestId.recovery.stderr.tmp.log"
  $recoveryArguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $ScriptPath, '-RecoveryOnly',
    '-RecoveryReasonCode', $ReasonCode) + $Arguments
  $recoveryTimeoutSeconds = if ([IO.Path]::GetFileName($ScriptPath) -ceq 'evidence1-host-apply-canonical-windows-offline.ps1') { 900 } else { 300 }
  $result = Invoke-E1OwnedProcess -Executable $script:PowerShellExecutable -Arguments $recoveryArguments `
    -WorkingDirectory $WorkingDirectory -Stdout $recoveryStdout -Stderr $recoveryStderr -Seconds $recoveryTimeoutSeconds
  return [pscustomobject]@{
    Result = $result
    Streams = @(
      @{ Label = 'recovery-stdout'; Path = $recoveryStdout },
      @{ Label = 'recovery-stderr'; Path = $recoveryStderr }
    )
  }
}

Import-E1RunnerSecurityModule
$QueueRoot = Resolve-FullPath $QueueRoot
$AllowedRoot = if ([string]::IsNullOrWhiteSpace($AllowedRoot)) {
  Resolve-FullPath $PSScriptRoot
} else {
  Resolve-FullPath $AllowedRoot
}
Assert-PathInside $QueueRoot 'C:\kmp-eval\scratch\' 'queue'
$deploymentBase=Resolve-FullPath (Join-Path $env:ProgramData 'KmpEval\Evidence1ElevatedRunner')
if(-not$TestMode){Assert-PathInside $AllowedRoot $deploymentBase 'deployed allowed root'}
Assert-E1RunnerNoReparse $AllowedRoot
$manifestPath=Assert-E1RunnerDirectFile (Join-Path $AllowedRoot 'evidence1-host-elevated-runner-manifest.json') $AllowedRoot 'evidence1-host-elevated-runner-manifest.json' 'elevated_runner_manifest_invalid'
try{$manifestBytes=[IO.File]::ReadAllBytes($manifestPath);$manifest=[Text.UTF8Encoding]::new($false,$true).GetString($manifestBytes)|ConvertFrom-Json -ErrorAction Stop}catch{throw 'elevated_runner_manifest_invalid'}
if(-not(Test-E1RunnerExactKeys $manifest @('schema','kind','principal_sid','source_git_commit','runner_sha256','process_module_sha256','scripts','support_files','node_files'))-or$manifest.schema-ne 2-or$manifest.kind-cne'evidence1-host-elevated-runner-manifest'-or$manifest.principal_sid-cnotmatch'^S-1-5-21-(\d+-){3}\d+$'-or$manifest.source_git_commit-cnotmatch'^[0-9a-f]{40,64}$'-or$manifest.runner_sha256-cnotmatch'^[0-9a-f]{64}$'-or$manifest.process_module_sha256-cnotmatch'^[0-9a-f]{64}$'-or@($manifest.scripts).Count-ne$AllowedScripts.Count-or@($manifest.support_files).Count-ne$TrustedSupportFiles.Count-or@($manifest.node_files).Count-ne$TrustedNodeFiles.Count){throw 'elevated_runner_manifest_invalid'}
$manifestMap=@{};foreach($entry in @($manifest.scripts)){if(-not(Test-E1RunnerExactKeys $entry @('name','sha256'))-or$entry.name-cnotin$AllowedScripts-or$entry.sha256-cnotmatch'^[0-9a-f]{64}$'-or$manifestMap.ContainsKey([string]$entry.name)){throw 'elevated_runner_manifest_invalid'};$manifestMap[[string]$entry.name]=[string]$entry.sha256}
if($manifestMap.Count-ne$AllowedScripts.Count-or@($AllowedScripts|Where-Object{-not$manifestMap.ContainsKey($_)}).Count-ne 0){throw 'elevated_runner_manifest_invalid'}
$supportMap=@{};foreach($entry in @($manifest.support_files)){if(-not(Test-E1RunnerExactKeys $entry @('name','sha256'))-or$entry.name-cnotin$TrustedSupportFiles-or$entry.sha256-cnotmatch'^[0-9a-f]{64}$'-or$supportMap.ContainsKey([string]$entry.name)){throw 'elevated_runner_manifest_invalid'};$supportMap[[string]$entry.name]=[string]$entry.sha256}
if($supportMap.Count-ne$TrustedSupportFiles.Count-or@($TrustedSupportFiles|Where-Object{-not$supportMap.ContainsKey($_)}).Count-ne 0){throw 'elevated_runner_manifest_invalid'}
$nodeMap=@{};foreach($entry in @($manifest.node_files)){if(-not(Test-E1RunnerExactKeys $entry @('name','sha256','blob_oid'))-or$entry.name-cnotin$TrustedNodeFiles-or$entry.sha256-cnotmatch'^[0-9a-f]{64}$'-or$entry.blob_oid-cnotmatch'^[0-9a-f]{40,64}$'-or$nodeMap.ContainsKey([string]$entry.name)){throw 'elevated_runner_manifest_invalid'};$null=Convert-E1RunnerNodeRelativePath ([string]$entry.name);$nodeMap[[string]$entry.name]=[string]$entry.sha256}
if($nodeMap.Count-ne$TrustedNodeFiles.Count-or@($TrustedNodeFiles|Where-Object{-not$nodeMap.ContainsKey($_)}).Count-ne 0){throw 'elevated_runner_manifest_invalid'}
$expectedLeaves=@('evidence1-host-elevated-runner.ps1','evidence1-validation-ops.psm1','evidence1-host-elevated-runner-manifest.json')+@($AllowedScripts)+@($TrustedSupportFiles)
$actualTopFiles=@(Get-ChildItem -LiteralPath $AllowedRoot -File -Force|ForEach-Object{$_.Name}|Sort-Object);$actualTopDirs=@(Get-ChildItem -LiteralPath $AllowedRoot -Directory -Force|ForEach-Object{$_.Name}|Sort-Object)
if(@(Compare-Object $actualTopFiles @($expectedLeaves|Sort-Object)).Count-ne 0-or@(Compare-Object $actualTopDirs @('node-runtime')).Count-ne 0){throw 'elevated_runner_deployment_closed_set_invalid'}
$nodeRoot=Resolve-FullPath (Join-Path $AllowedRoot 'node-runtime');Assert-E1RunnerNoReparse $nodeRoot
$actualNodeFiles=@(Get-ChildItem -LiteralPath $nodeRoot -File -Force -Recurse|ForEach-Object{$_.FullName.Substring($nodeRoot.Length+1).Replace('\','/')}|Sort-Object)
$expectedNodeDirs=@{};foreach($name in $TrustedNodeFiles){$parent=Split-Path -Parent (Convert-E1RunnerNodeRelativePath $name);while($parent){$expectedNodeDirs[$parent.Replace('\','/')]=$true;$next=Split-Path -Parent $parent;if($next-ceq$parent){break};$parent=$next}}
$actualNodeDirs=@(Get-ChildItem -LiteralPath $nodeRoot -Directory -Force -Recurse|ForEach-Object{if(($_.Attributes-band[IO.FileAttributes]::ReparsePoint)-ne 0){throw 'elevated_runner_deployment_closed_set_invalid'};$_.FullName.Substring($nodeRoot.Length+1).Replace('\','/')}|Sort-Object)
if(@(Compare-Object $actualNodeFiles @($TrustedNodeFiles|Sort-Object)).Count-ne 0-or@(Compare-Object $actualNodeDirs @($expectedNodeDirs.Keys|Sort-Object)).Count-ne 0){throw 'elevated_runner_deployment_closed_set_invalid'}
$runnerPath=Assert-E1RunnerDirectFile $PSCommandPath $AllowedRoot 'evidence1-host-elevated-runner.ps1' 'elevated_runner_identity_invalid'
if((Get-E1RunnerSha256 $runnerPath)-cne$manifest.runner_sha256){throw 'elevated_runner_identity_invalid'}
$processModulePath = Assert-E1RunnerDirectFile (Join-Path $AllowedRoot 'evidence1-validation-ops.psm1') $AllowedRoot 'evidence1-validation-ops.psm1' 'elevated_runner_process_module_invalid'
if((Get-E1RunnerSha256 $processModulePath)-cne$manifest.process_module_sha256){throw 'elevated_runner_process_module_invalid'}
foreach($name in $AllowedScripts){$path=Assert-E1RunnerDirectFile (Join-Path $AllowedRoot $name) $AllowedRoot $name 'allowlisted_script_identity_invalid';if((Get-E1RunnerSha256 $path)-cne$manifestMap[$name]){throw 'allowlisted_script_hash_mismatch'}}
foreach($name in $TrustedSupportFiles){$path=Assert-E1RunnerDirectFile (Join-Path $AllowedRoot $name) $AllowedRoot $name 'support_file_identity_invalid';if((Get-E1RunnerSha256 $path)-cne$supportMap[$name]){throw 'support_file_hash_mismatch'}}
foreach($name in $TrustedNodeFiles){$path=Resolve-FullPath (Join-Path $nodeRoot (Convert-E1RunnerNodeRelativePath $name));Assert-E1RunnerNoReparse $path;if(-not(Test-Path -LiteralPath $path -PathType Leaf)-or(Get-Item -LiteralPath $path -Force).PSIsContainer-or(Get-E1RunnerSha256 $path)-cne$nodeMap[$name]){throw 'node_runtime_file_invalid'}}
if(-not$TestMode){$runnerSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;if($runnerSid-cne$manifest.principal_sid-and$runnerSid-cne'S-1-5-18'){throw 'elevated_runner_principal_mismatch'};Assert-E1RunnerProtectedAcl $AllowedRoot $manifest.principal_sid $true;foreach($directoryPath in @($nodeRoot)+@(Get-ChildItem -LiteralPath $nodeRoot -Directory -Force -Recurse | ForEach-Object { $_.FullName })) { Assert-E1RunnerProtectedAcl $directoryPath $manifest.principal_sid $true };foreach($path in @($manifestPath,$runnerPath,$processModulePath)+@($AllowedScripts|ForEach-Object{Join-Path $AllowedRoot $_})+@($TrustedSupportFiles|ForEach-Object{Join-Path $AllowedRoot $_})+@($TrustedNodeFiles|ForEach-Object{Join-Path $nodeRoot (Convert-E1RunnerNodeRelativePath $_)})){Assert-E1RunnerProtectedAcl $path $manifest.principal_sid $false}}
Import-Module $processModulePath -Force -ErrorAction Stop
$script:PowerShellExecutable = (Get-Command powershell.exe -ErrorAction Stop).Source
$RequestDir = Join-Path $QueueRoot 'requests'
$script:ResponseDir = Join-Path $QueueRoot 'responses'
$LogDir = Join-Path $QueueRoot 'logs'
$DoneDir = Join-Path $QueueRoot 'done'
$InProgressDir = Join-Path $QueueRoot 'in-progress'
New-Item -ItemType Directory -Force -Path $RequestDir,$script:ResponseDir,$LogDir,$DoneDir,$InProgressDir | Out-Null
$RunnerTracePath = Join-Path $QueueRoot 'RUNNER-TRACE.log'

function Add-RunnerTrace([string]$Message) {
  $timestamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  "[$timestamp] $Message" | Add-Content -LiteralPath $RunnerTracePath -Encoding UTF8
}

trap {
  Add-RunnerTrace ("UNHANDLED: " + ($_ | Out-String))
  throw
}

do {
  $requestFile = Get-ChildItem -LiteralPath $RequestDir -Filter '*.request.json' -File |
    Sort-Object CreationTimeUtc |
    Select-Object -First 1

  if (-not $requestFile) {
    if ($Once) { break }
    Start-Sleep -Seconds 2
    continue
  }

  $request = $null
  $logPath = $null
  $activeRequestPath = $null
  try {
    $activeRequestPath = Join-Path $InProgressDir $requestFile.Name
    Move-Item -LiteralPath $requestFile.FullName -Destination $activeRequestPath -Force
    $request = Get-Content -LiteralPath $activeRequestPath -Raw | ConvertFrom-Json
    if ($request.id -notmatch '^[A-Za-z0-9_.-]+$') {
      throw "invalid request id: $($request.id)"
    }

    $requestedScriptPath = Resolve-FullPath ([string]$request.script_path)
    $scriptName = Split-Path -Leaf $requestedScriptPath
    if ($AllowedScripts -notcontains $scriptName) {
      throw "script is not allowlisted for Evidence1 elevated runner: $scriptName"
    }
    $scriptPath=Assert-E1RunnerDirectFile $requestedScriptPath $AllowedRoot $scriptName 'allowlisted_script_must_be_exact_direct_regular_file'
    if((Get-E1RunnerSha256 $scriptPath)-cne$manifestMap[$scriptName]){throw 'allowlisted_script_hash_mismatch'}

    $arguments = @()
    if ($null -ne $request.arguments) {
      foreach ($arg in @($request.arguments)) {
        if ($null -eq $arg) {
          throw 'null argument is not allowed'
        }
        $arguments += [string]$arg
      }
    }
    Assert-E1WindowsProvisioningRunnerArguments $scriptName $arguments
    Assert-E1CanonicalPostApplyRunnerArguments $scriptName $arguments
    Assert-E1SelfInstallRunnerArguments $scriptName $arguments
    $childTimeoutSeconds = 7500
    if ($request.PSObject.Properties.Name -contains 'timeout_seconds' -and $null -ne $request.timeout_seconds) {
      $childTimeoutSeconds = [int]$request.timeout_seconds
    }
    if ($childTimeoutSeconds -lt 30 -or $childTimeoutSeconds -gt 7500) {
      throw 'request timeout_seconds must be between 30 and 7500'
    }

    $logPath = Join-Path $LogDir "$($request.id).log"
    $displayArguments = @(Get-E1RedactedDisplayArguments $arguments | ForEach-Object { Quote-ProcessArgument $_ })
    "COMMAND: powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`" $($displayArguments -join ' ')" |
      Set-Content -LiteralPath $logPath -Encoding UTF8
    Add-RunnerTrace "processing request $($request.id) script=$scriptName"

    $stdoutPath = Join-Path $LogDir "$($request.id).stdout.tmp.log"
    $stderrPath = Join-Path $LogDir "$($request.id).stderr.tmp.log"
    $responseError = $null
    $recoveryStreams = @()
    try {
      $childArguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $scriptPath) + $arguments
      Add-RunnerTrace "starting child for $($request.id)"
      $processResult = Invoke-E1OwnedProcess -Executable $script:PowerShellExecutable -Arguments $childArguments `
        -WorkingDirectory $AllowedRoot -Stdout $stdoutPath -Stderr $stderrPath -Seconds $childTimeoutSeconds
      $exitCode = [int]$processResult.ExitCode
      $isUnattended = $scriptName -in @(
          'evidence1-host-install-canonical-windows-unattended.ps1',
          'evidence1-host-apply-canonical-windows-offline.ps1') -and
        $arguments -notcontains '-RecoveryOnly'
      if ($isUnattended -and ($exitCode -ne 0 -or [bool]$processResult.TimedOut -or -not [bool]$processResult.CleanupOk)) {
        Add-RunnerTrace "unattended child requires recovery for $($request.id)"
        $originalExitCode = $exitCode
        $recoveryReasonCode = if ([bool]$processResult.TimedOut) {
          'elevated_runner_child_timeout'
        } else {
          'elevated_runner_child_failure'
        }
        $recovery = Invoke-UnattendedRecovery $scriptPath $arguments $AllowedRoot $LogDir `
          ([string]$request.id) $recoveryReasonCode
        $recoveryStreams = @($recovery.Streams)
        if ($recovery.Result.ExitCode -eq 0 -and -not $recovery.Result.TimedOut -and $recovery.Result.CleanupOk) {
          $responseError = 'unattended_nonpass_recovery_pass'
          $exitCode = if ($originalExitCode -eq 0) { 998 } else { $originalExitCode }
        } else {
          $responseError = 'unattended_nonpass_recovery_failed'
          $exitCode = 125
        }
      } elseif ([bool]$processResult.TimedOut -or -not [bool]$processResult.CleanupOk) {
        $responseError = 'child_process_containment_failed'
        if (-not $processResult.TimedOut) { $exitCode = 998 }
      }
      Add-RunnerTrace "child exited code=$exitCode for $($request.id)"
    } catch {
      Add-RunnerTrace ("child launch/capture failed for $($request.id): " + ($_ | Out-String))
      $_ | Out-String | Add-Content -LiteralPath $logPath -Encoding UTF8
      $exitCode = 997
      if ($scriptName -in @(
          'evidence1-host-install-canonical-windows-unattended.ps1',
          'evidence1-host-apply-canonical-windows-offline.ps1') -and
          $arguments -notcontains '-RecoveryOnly') {
        try {
          $recovery = Invoke-UnattendedRecovery $scriptPath $arguments $AllowedRoot $LogDir `
            ([string]$request.id) 'elevated_runner_child_failure'
          $recoveryStreams = @($recovery.Streams)
          if ($recovery.Result.ExitCode -eq 0 -and -not $recovery.Result.TimedOut -and $recovery.Result.CleanupOk) {
            $responseError = 'unattended_runner_error_recovery_pass'
          } else {
            $responseError = 'unattended_runner_error_recovery_failed'
            $exitCode = 125
          }
        } catch {
          $responseError = 'unattended_runner_error_recovery_failed'
          $exitCode = 125
        }
      }
    }

    foreach ($stream in @(
      @{ Label = 'stdout'; Path = $stdoutPath },
      @{ Label = 'stderr'; Path = $stderrPath }
    ) + $recoveryStreams) {
      if (Test-Path -LiteralPath $stream.Path) {
        "--- child $($stream.Label): $($stream.Path) ---" | Add-Content -LiteralPath $logPath -Encoding UTF8
        Get-Content -LiteralPath $stream.Path -ErrorAction SilentlyContinue |
          Add-Content -LiteralPath $logPath -Encoding UTF8
      }
    }

    "EXITCODE:$exitCode" | Add-Content -LiteralPath $logPath -Encoding UTF8
    Write-Response $request $exitCode $logPath $responseError
    Add-RunnerTrace "wrote response for $($request.id) exit=$exitCode"
  } catch {
    Add-RunnerTrace ("request failed: " + ($_ | Out-String))
    if (-not $request) {
      $request = [pscustomobject]@{ id = [System.IO.Path]::GetFileNameWithoutExtension($requestFile.Name) }
    }
    if (-not $logPath) {
      $logPath = Join-Path $LogDir "$($request.id).log"
    }
    $_ | Out-String | Set-Content -LiteralPath $logPath -Encoding UTF8
    Write-Response $request 1 $logPath $_.Exception.Message
  } finally {
    if ($activeRequestPath -and (Test-Path -LiteralPath $activeRequestPath)) {
      $donePath = Join-Path $DoneDir $requestFile.Name
      Move-Item -LiteralPath $activeRequestPath -Destination $donePath -Force -ErrorAction SilentlyContinue
    }
  }
} while (-not $Once)
