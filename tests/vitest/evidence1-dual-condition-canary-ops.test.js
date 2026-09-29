import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (name) => readFileSync(join(process.cwd(), 'docs', 'audits', name), 'utf8');
const readRoot = (name) => readFileSync(join(process.cwd(), name), 'utf8');

describe('Evidence1 dual-condition operational canaries', () => {
  it('dispatches exactly two provider slots in the immutable binding order', () => {
    const source = read('evidence1-dual-condition-canary-launch.ps1');
    expect(source).toContain('for ($ordinal=0; $ordinal -lt 2; $ordinal++)');
    expect(source).toContain('$slot = @($binding.slots)[$ordinal]');
    expect(source).toContain('New-Evidence1DualConditionCanarySlotClaim $OperationRoot $ordinal');
    expect(source).toContain('New-Evidence1DualConditionCanaryPlanClaim $OperationRoot $ordinal');
    expect(source).toContain('New-Evidence1DualConditionCanaryPairArmClaim $OperationRoot');
    expect(source).toContain('Assert-Evidence1DualConditionCanaryPair -OperationRoot $OperationRoot');
    expect(source).toContain('New-Evidence1DualConditionCanaryDispatchStarted $OperationRoot $ordinal');
    expect(source).toContain('New-Evidence1DualConditionCanaryCopyTransaction');
    expect(source).toContain('Invoke-Evidence1DualConditionCanaryCopyRecovery');
    const claimBoundary = source.lastIndexOf('New-Evidence1DualConditionCanaryPlanClaim $OperationRoot $ordinal');
    expect(claimBoundary).toBeLessThan(source.indexOf("if ($Mode -ceq 'FakeRuntime')", claimBoundary));
    expect(source).not.toMatch(/retry|respawn/i);
  });

  it('uses distinct clones, run roots and provider-specific budgets', () => {
    const source = read('evidence1-dual-condition-canary-launch.ps1');
    expect(source).toContain('"source-$ordinal"');
    expect(source).toContain('"runs-$ordinal"');
    expect(source).toContain("if ($slot.runtime_id -ceq 'claude-code') { $args += @('--max-budget-usd','2') }");
    expect(source).toContain('runtime_does_not_support_session_budget');
    expect(source).toContain("'--runtime',$slot.runtime_id,'--model',$slot.model_requested");
    expect(source).toContain("'--campaign-design',$slot.campaign_design_id");
    expect(source).not.toContain('$planHash -cne $slot.plan_sha256');
  });

  it('validates mutable prerequisites semantically without digest gates', () => {
    const launch = read('evidence1-dual-condition-canary-launch.ps1');
    const start = read('evidence1-hyperv-start-dual-condition-canary.ps1');
    const copy = read('evidence1-hyperv-copy-dual-condition-canary.ps1');
    expect(launch).toContain('Assert-E1FreshPrerequisites $binding');
    expect(launch).toContain('Assert-E1AttestationPresent $boundSlot');
    expect(launch).not.toContain('dual_condition_attestation_hash_mismatch');
    expect(launch).not.toContain('dual_condition_readiness_hash_mismatch');
    expect(launch).not.toContain('dual_condition_remote_auth_hash_mismatch');
    expect(launch).not.toContain('dual_condition_harness_identity');
    expect(launch).not.toContain('dual_condition_source_identity');
    expect(start).not.toContain('dual_condition_readiness_hash_mismatch');
    expect(start).not.toContain('dual_condition_remote_auth_hash_mismatch');
    expect(copy).not.toContain('ExpectedBindingSha256');
  });

  it('continues only from the contract integrity decision and never aggregates runtimes', () => {
    const source = read('evidence1-dual-condition-canary-launch.ps1');
    expect(source).toContain('New-Evidence1DualConditionInterSlotIntegrity');
    expect(source).toContain('if (-not $integrity.value.dispatch_next_slot)');
    expect(source).toContain('New-Evidence1DualConditionCanaryGroupCustody');
    expect(source).not.toMatch(/'aggregate'|"aggregate"/);
  });

  it('pins host mutation to the authorized E2E VM and avoids visible terminals', () => {
    for (const name of [
      'evidence1-hyperv-place-dual-condition-canary.ps1',
      'evidence1-hyperv-start-dual-condition-canary.ps1',
      'evidence1-hyperv-copy-dual-condition-canary.ps1',
    ]) {
      const source = read(name);
      expect(source).toContain('Get-Evidence1CanonicalE2EVmIdentity');
      expect(source).toContain('$VMName=$vmIdentity.vm_name');
      expect(source).not.toContain('6e5848f5-37dd-4653-9f3d-df2871e6293a');
      expect(source).not.toMatch(/VMConnect|Start-Process/);
    }
    const place = read('evidence1-hyperv-place-dual-condition-canary.ps1');
    expect(place).toContain('$VMRoot=$vmIdentity.vm_root');
    expect(place).toContain("Windows\\System32\\Config\\SYSTEM");
    expect(place).toContain("StartsWith('\\\\?\\Volume{'");
    expect(place).not.toContain('$_.DriveLetter -and (Test-Path');
    expect(place).toContain("[IO.FileMode]::CreateNew");
    expect(place).toContain('authorization_phrase_persisted_in_guest=$false');
    expect(place).toContain("$evidenceId='Evidence'+'1'");
    expect(place).not.toContain("$evidenceId='EVIDENCE'+'1'");
    expect(place).not.toMatch(/Copy-Item[^\n]*-Recurse/);
    expect(place).not.toContain('dual_condition_staged_binding_mismatch');
    const start = read('evidence1-hyperv-start-dual-condition-canary.ps1');
    expect(start).toContain("state_transition=@('Running','Off','Armed','Running')");
    expect(start).not.toContain('-ExpectedReadinessSha256 $hostReadinessHash');
    expect(start).not.toContain('-ExpectedHostReadinessSha256');
    expect(start).not.toContain('-ExpectedGuestReadinessSha256');
    expect(start).toContain("'dual_condition_readiness_path'");
    expect(start).toContain('Assert-E1Inside $HostBundleDir');
    expect(start).not.toContain('-TurnOff');
  });

  it('copies only a closed sanitized pair and uses a read-only VHD mount', () => {
    const source = read('evidence1-hyperv-copy-dual-condition-canary.ps1');
    expect(source).toContain('Mount-VHD -Path $drive.Path -ReadOnly -Passthru');
    expect(source).toContain("Windows\\System32\\Config\\SYSTEM");
    expect(source).toContain("StartsWith('\\\\?\\Volume{'");
    expect(source).not.toContain('$_.DriveLetter -and (Test-Path');
    expect(source).toContain("$custody.state-cnotin@('closed_pass','closed_failed','closed_incomplete_safety_stop')");
    expect(source).toContain("$copyState=$(if($custody.state-ceq'closed_pass'){'passed'}elseif($custody.state-ceq'closed_failed'){'failed'}else{'diagnostic_safety_incomplete'})");
    expect(source).toContain('custody_state=$custody.state');
    expect(source).toContain("if($validated.privacy_validated-ne$true){throw 'dual_condition_privacy_validation_failed'}");
    expect(source).toContain("$destinationRoot=$DiagnosticOutDir;$destinationTier='diagnostic'");
    expect(source).toContain('public_evidence_copied=[bool]$publishable');
    expect(source).toContain("$custodySlot.record_status-cne'valid'-or$custodySlot.sidecar_status-cne'valid'");
    expect(source).toContain('$custody.aggregated_across_runtimes -ne $false');
    expect(source).toContain("$record.benchmark_eligible-ne$false");
    expect(source).toContain("'dual_condition_copy_raw_forbidden'");
    expect(source).toContain('Assert-Evidence1DualConditionCanaryOperation $source');
    expect(source).toContain("'^slots/[01]/copy\\.(transaction|recovery)\\.json$'");
    expect(source).toContain('Publish-Evidence1DualConditionArtifactSet');
    expect(source).toContain('-TrustedRoot $destinationTrustedRoot');
    expect(source).toContain('Write-Evidence1DualConditionAtomicJson -Path $ReportPath');
    expect(source).not.toContain('ExpectedBindingSha256');
    expect(source).not.toContain('function Write-E1CreateNew');
    expect(source).toContain('$journalHashes[$artifact.relative_path]=$artifact.sha256');
    expect(source).toContain("throw 'dual_condition_copy_transaction_hash'");
    expect(source).toContain("$CanonicalHarnessDir='C:\\kmp-eval\\agentic-eval-codex-runtime'");
    expect(source).toContain("'dual_condition_harness_path'");
    expect(source).toContain("$deployedValidatorRoot=Join-Path $PSScriptRoot 'node-runtime'");
    expect(source).toContain('$moduleRoot=$PSScriptRoot');
    expect(source).toContain('$validatorRoot=$deployedValidatorRoot');
    expect(source).toContain('$env:E1_DUAL_VALIDATOR_ROOT=$validatorRoot');
    expect(source).toContain("$env:E1_DUAL_CANONICAL_LEDGER_ROOT='C:\\Evidence1Ops\\dual-condition-ledger'");
    expect(source).toContain('Remove-Item Env:E1_DUAL_CANONICAL_LEDGER_ROOT');
    expect(source).not.toMatch(/Copy-Item[^\n]*-Recurse/);
  });

  it('publishes through a resumable sibling stage and atomic directory rename', () => {
    const contract = read('evidence1-dual-condition-canary-contract.psm1');
    expect(contract).toContain('$stage="$destination.staging"');
    expect(contract).toContain('$transactionPath="$destination.publication.transaction.json"');
    expect(contract).toContain('$readyPath="$destination.publication.ready.json"');
    expect(contract).toContain('[IO.Directory]::Move($stage,$destination)');
    expect(contract).toContain('Assert-E1PublishedTree $destination $expected.files $false');
    expect(contract).toContain('Assert-Evidence1DualConditionTrustedPath $candidate $TrustedRoot');
    expect(contract).toContain('[IO.FileOptions]::WriteThrough');
    expect(contract).toContain('$pending="$final.pending"');
    expect(contract).toContain('[Diagnostics.Process]::GetCurrentProcess().Kill()');
  });

  it('refreshes one stable validator location without snapshot-hash routing', () => {
    const place = read('evidence1-hyperv-place-dual-condition-canary.ps1');
    const launcher = read('evidence1-dual-condition-canary-launch.ps1');
    const start = read('evidence1-hyperv-start-dual-condition-canary.ps1');
    expect(place).toContain('Get-Evidence1DualConditionValidatorBundleManifest');
    expect(place).toContain("$deployedHarnessRoot=Join-Path $PSScriptRoot 'node-runtime'");
    expect(place).toContain("Join-Path $deployedHarnessRoot 'package.json'");
    expect(place).toContain("$validatorRoot=Join-Path $ops 'dual-condition-validator\\current'");
    expect(place).toContain('[IO.FileMode]::Create');
    expect(launcher).toContain('$env:E1_DUAL_VALIDATOR_ROOT=$validatorRoot');
    expect(launcher).toContain("Join-Path 'C:\\Evidence1Ops\\dual-condition-validator' 'current'");
    expect(launcher).not.toContain('Assert-Evidence1DualConditionValidatorBundle $validatorRoot');
    expect(launcher).toContain("$script:E1ToolchainRoot = 'C:\\Evidence1Toolchain'");
    expect(launcher).toContain("$script:E1NodeCommand = Join-Path $script:E1ToolchainRoot 'node\\24.19.0\\node.exe'");
    expect(launcher).toContain("$script:E1ClaudeCommand = Join-Path $script:E1ToolchainRoot 'claude-code\\2.1.238\\claude.cmd'");
    expect(launcher).toContain("$script:E1CodexCommand = Join-Path $script:E1ToolchainRoot 'codex-cli\\0.154.0\\bin\\codex.exe'");
    expect(launcher).toContain('$slotEnvironment.KMP_EVAL_RUNS_ROOT=$runsRoot');
    expect(launcher).toContain('KMP_EVAL_BASH_PATH=$script:E1GitBashCommand');
    expect(launcher).toContain('CLAUDE_CODE_GIT_BASH_PATH=$script:E1GitBashCommand');
    expect(launcher).toContain("CLAUDE_CODE_USE_POWERSHELL_TOOL='0'");
    expect(launcher).toContain('KMP_EVAL_CODEX_HOME=$script:E1CodexHome');
    expect(launcher).toContain('JAVA_HOME=$script:E1JdkRoot');
    expect(launcher).toContain('ANDROID_HOME=$script:E1AndroidRoot');
    expect(launcher).toContain("$preflightArguments=@(Get-E1SlotArguments $binding $preflightOrdinal $preflightClone)+'--dry-run'");
    expect(launcher).toContain('Get-E1SanitizedProcessFailureReason');
    expect(launcher).toContain("Invoke-E1Git $CloneRoot @('remote','set-url','origin',$sourceOrigin)");
    expect(launcher).toContain("'dual_condition_source_origin_mismatch'");
    expect(launcher).not.toContain("-FileName 'node.exe'");
    for (const source of [place, launcher, start]) expect(source).not.toContain('Get-FileHash');
  });

  it('keeps wrapper output non-raw and process-tree bounded', () => {
    const source = read('evidence1-dual-condition-canary-wrapper.ps1');
    expect(source).toContain('Start-E1OwnedProcess');
    expect(source).toContain('Wait-E1OwnedProcess');
    expect(source).toContain('Stop-E1OwnedProcess');
    expect(source).toContain('process_tree_cleanup_confirmed');
    expect(source).toContain('raw_content_persisted=$false');
    expect(source).toContain("'C:\\Evidence1Ops\\dual-condition-control'");
    expect(source).toContain('dual_condition_wrapper_replay');
    expect(source).not.toMatch(/Get-Content[^\n]*(stdout|stderr)/i);
  });

  it('updates the installed broker without a failure drill or hash readiness gate', () => {
    const installer = readRoot('evidence1-install.ps1');
    const runner = readRoot('evidence1-run.ps1');
    expect(installer).toContain('[switch]$UpdateBroker');
    expect(installer).toContain('Invoke-E1BootstrapSelfUpdate $after');
    expect(installer).toContain("'broker_manifest_hashes_not_verified'");
    expect(runner).toContain('$status.task_exists -and $status.readable -and $status.self_update_capable');
    expect(runner).not.toContain("$reasonCode = 'broker_hashes_invalid'");
    expect(runner).not.toContain("$reasonCode = 'broker_acl_invalid'");
  });

  it('does not bind mutable OAuth or readiness digests into a campaign', () => {
    const contract = read('evidence1-dual-condition-canary-contract.psm1');
    const place = read('evidence1-hyperv-place-dual-condition-canary.ps1');
    const launch = read('evidence1-dual-condition-canary-launch.ps1');
    expect(contract).not.toContain("'remote_auth_report_sha256','readiness_sha256'");
    expect(contract).not.toContain('[string]$RemoteAuthReportSha256');
    expect(contract).not.toContain('[string]$ReadinessSha256');
    expect(place).not.toContain('[string]$RemoteAuthReportSha256');
    expect(place).not.toContain('[string]$ReadinessSha256');
    expect(launch).not.toContain('-ExpectedGuestReadinessSha256');
  });

  it('injects one current-input object instead of individual mutable digests', () => {
    const place = read('evidence1-hyperv-place-dual-condition-canary.ps1');
    expect(place).toContain('[string]$CurrentInputsJson');
    expect(place).toContain('$currentInputs = Get-E1CurrentInputs $CurrentInputsJson');
    for (const parameter of [
      '$HarnessCommit', '$HarnessTree', '$SourceCommit', '$SourceTree',
      '$SkillSnapshotSha256', '$ClaudePlanSha256', '$CodexPlanSha256',
      '$ClaudeAttestationSha256', '$CodexAttestationSha256',
    ]) {
      expect(place.slice(0, place.indexOf('Set-StrictMode'))).not.toContain(parameter);
    }
  });
});
