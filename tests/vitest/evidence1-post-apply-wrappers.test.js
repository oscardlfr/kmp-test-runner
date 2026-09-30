import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const read = path => readFileSync(resolve(root, path), 'utf8').replaceAll('\r\n', '\n');
const runner = read('docs/audits/evidence1-host-elevated-runner.ps1');
const postOs = read('docs/audits/evidence1-host-post-os-canonical-windows.ps1');
const bootstrap = read('docs/audits/evidence1-host-bootstrap-canonical-windows-toolchain.ps1');
const checkpoint = read('docs/audits/evidence1-host-checkpoint-canonical-windows-toolchain.ps1');
const diagnose = read('docs/audits/evidence1-host-diagnose-windows-first-boot.ps1');
const chain = read('docs/audits/evidence1-host-windows-provisioning-chain.psm1');
const psDirect = read('docs/audits/evidence1-host-windows-psdirect-operation.ps1');
const postOsCore = read('tools/evidence1/provisioning/evidence1-post-os-transition.ps1');
const bootstrapCore = read('tools/evidence1/provisioning/evidence1-bootstrap-toolchain.ps1');
const checkpointCore = read('tools/evidence1/provisioning/evidence1-checkpoint-toolchain.ps1');
const provisioning = read('tools/evidence1/provisioning/Evidence1.Provisioning.psm1');

function literalArray(source, start, end) {
  const block = source.slice(source.indexOf(`$${start} = @(`), end ? source.indexOf(`$${end} = @(`) : undefined);
  return [...block.matchAll(/^\s*'([^']+)'[,]?$/gm)].map(match => match[1]);
}

describe('Evidence1 canonical post-apply runner path', () => {
  it('exposes only the three reviewed direct-child wrappers and keeps core provisioning in node-runtime', () => {
    const allowed = literalArray(runner, 'AllowedScripts', 'TrustedSupportFiles');
    const support = literalArray(runner, 'TrustedSupportFiles', 'TrustedNodeFiles');
    const node = literalArray(runner, 'TrustedNodeFiles');
    const wrappers = [
      'evidence1-host-post-os-canonical-windows.ps1',
      'evidence1-host-diagnose-windows-first-boot.ps1',
      'evidence1-host-bootstrap-canonical-windows-toolchain.ps1',
      'evidence1-host-checkpoint-canonical-windows-toolchain.ps1',
    ];
    const core = [
      'tools/evidence1/provisioning/evidence1-post-os-transition.ps1',
      'tools/evidence1/provisioning/evidence1-bootstrap-toolchain.ps1',
      'tools/evidence1/provisioning/evidence1-checkpoint-toolchain.ps1',
    ];

    expect(allowed).toEqual(expect.arrayContaining(wrappers));
    expect(support).toContain('evidence1-host-windows-provisioning-chain.psm1');
    expect(node).toEqual(expect.arrayContaining(core));
    for (const path of core) expect(allowed).not.toContain(path.split('/').at(-1));
  });

  it('binds every stage to the fixed collision-safe E2E profile and scratch-only custody', () => {
    for (const script of [postOs, bootstrap, checkpoint]) {
      expect(script).toContain("$RequiredProfileId = 'evidence1-windows-hyperv-e2e-v1'");
      expect(script).toContain("$RequiredVmName = 'Evidence1-Runner-E2E'");
      expect(script).toContain('evidence1-windows-hyperv-e2e-v1.json');
      expect(script).toContain('Assert-E1WindowsProvisioningScratchPath $InputLockPath');
      expect(script).toContain('Assert-E1CanonicalE2EProfile $profilePath');
      expect(script).toContain('Read-E1WindowsProvisioningReceipt');
      expect(script).toContain('Write-E1WindowsProvisioningChainedReceipt');
      expect(script).not.toMatch(/Evidence1-Runner(?!-E2E)/);
      expect(script).not.toMatch(/Connect-VMNetworkAdapter|Set-VMNetworkAdapter|OPENAI_API_KEY|ANTHROPIC_API_KEY/i);
    }
    expect(chain).toContain("[IO.Path]::GetFullPath('C:\\kmp-eval\\scratch')");
    expect(chain).toContain("throw 'receipt_chain_binding_mismatch'");
    expect(chain).toContain('prior_receipt_sha256 = $prior.sha256');
    expect(chain).toContain('core_receipt_sha256 = $core.sha256');
    expect(chain).toContain('Assert-E1WindowsProvisioningReceiptChain $written.document $Operation $prior.sha256 $core.sha256');
  });

  it('diagnoses a recovered first boot read-only without credentials or inference', () => {
    expect(diagnose).toContain("Mount-VHD -Path $vhdPath -ReadOnly");
    expect(diagnose).toContain(".StartsWith('\\\\?\\Volume{'");
    expect(diagnose).toContain("authorize diagnose evidence1 recovered first boot without auth");
    expect(diagnose).toContain('auth_material_read = $false');
    expect(diagnose).toContain('inference_sessions_consumed = 0');
    expect(diagnose).not.toMatch(/GuestCredentialPath|Import-Clixml|New-PSSession|Start-VM/);
  });

  it('checks exact authorization before each mutation and keeps Verify read-only', () => {
    expect(postOs).toContain("$RequiredStartPhrase = 'authorize start evidence1 e2e post-os verification'");
    expect(postOs).toContain("$RequiredSealPhrase = 'authorize seal evidence1 windows post-os boundary'");
    expect(postOs.indexOf('exact_post_os_start_authorization_required')).toBeLessThan(postOs.indexOf('Start-VM -VM $vm'));
    expect(postOs.indexOf('exact_post_os_seal_authorization_required')).toBeLessThan(postOs.indexOf("$coreMode = 'Seal'"));
    expect(bootstrap).toContain("$RequiredBootstrapPhrase = 'authorize bootstrap evidence1 e2e windows toolchain without auth'");
    expect(bootstrap.indexOf('exact_toolchain_bootstrap_authorization_required')).toBeLessThan(bootstrap.indexOf('Invoke-E1WindowsProvisioningCore'));
    expect(bootstrap).toContain("throw 'toolchain_verify_authorization_must_be_empty'");
    expect(checkpoint).toContain("$RequiredCheckpointPhrase = 'authorize checkpoint verified evidence1 toolchain without auth'");
    expect(checkpoint.indexOf('exact_checkpoint_authorization_required')).toBeLessThan(checkpoint.indexOf('evidence1-host-windows-psdirect-operation.ps1'));
    expect(postOs).toContain("$priorFailure.document.reason_code -cne 'guest_computer_identity_mismatch'");
    expect(postOs).toContain('$priorFailure.document.receipt_chain.prior_receipt_sha256 -cne $prior.sha256');
    expect(postOs).toContain("if ([string]$vm.State -ceq 'Off')");
    expect(postOs).toContain("elseif ([string]$vm.State -ceq 'Running')");
  });

  it('enforces Apply to Verify to Seal to Bootstrap to Verify to Checkpoint receipt custody', () => {
    expect(postOs).toContain('Assert-E1CanonicalApplyReceipt $prior.document');
    expect(postOs).toContain("Assert-E1CanonicalPostOsReceipt $prior.document 'Verify'");
    expect(bootstrap).toContain("Assert-E1CanonicalPostOsReceipt $prior.document 'Seal'");
    expect(bootstrap).toContain("Assert-E1CanonicalToolchainReceipt $prior.document 'Bootstrap'");
    expect(checkpoint).toContain("Assert-E1CanonicalToolchainReceipt $prior.document 'Verify'");
    expect(checkpoint).toContain('$core.document.toolchain_receipt_sha256 -cne $prior.sha256');
    expect(chain).toContain('[string]$ExpectedPriorSha256');
    expect(chain).toContain('$chain.prior_receipt_sha256 -cne $ExpectedPriorSha256');
  });

  it('uses only a bounded graceful guest shutdown and records zero network, auth, and inference', () => {
    expect(checkpoint).toContain('[ValidateRange(30,300)] [int]$ShutdownTimeoutSeconds = 120');
    expect(psDirect).toContain('shutdown.exe');
    expect(psDirect).toContain('New-PSSession -VMName $vmName -Credential $credential');
    expect(psDirect).not.toContain('SessionOption');
    expect(checkpoint).toContain('$deadline = [DateTime]::UtcNow.AddSeconds($ShutdownTimeoutSeconds)');
    expect(checkpoint).toContain("throw 'guest_graceful_shutdown_timeout'");
    expect(chain).toContain('$value.hard_power_fallback_used = $false');
    expect(checkpoint).not.toMatch(/Stop-VM|-TurnOff|while\s*\(\s*\$true\s*\)/i);
    for (const field of ['network_used = $false', 'auth_material_read = $false', 'auth_material_copied = $false', 'inference_sessions_consumed = 0']) {
      expect(chain).toContain(field);
    }
    expect(chain).toContain('Get-Command powershell.exe');
    expect(chain).toContain('Invoke-E1OwnedProcess');
    for (const script of [postOs, bootstrap, checkpoint]) {
      expect(script.indexOf('Write-E1WindowsProvisioningChainedReceipt')).toBeLessThan(script.indexOf('Remove-Item -LiteralPath $childReceipt'));
    }
  });

  it('treats the Windows computer name as case-insensitive at runtime boundaries', () => {
    expect(postOsCore).toContain("$env:COMPUTERNAME -ine [string]$Profile.guest.computer_name");
    expect(bootstrapCore).toContain("$env:COMPUTERNAME -ine [string]$Profile.guest.computer_name");
    expect(psDirect).toContain("$env:COMPUTERNAME -ine 'Evidence1E2E'");
    expect(provisioning).toContain('$guest.computer_name -ine $Plan.profile.guest.computer_name');
    for (const core of [postOsCore, bootstrapCore, read('tools/evidence1/provisioning/evidence1-checkpoint-toolchain.ps1')]) {
      expect(core).toContain('Get-E1ProvisioningPlan $ProfilePath $InputLockPath -AllowSealedRuntimeCommitDrift');
    }
  });

  it('treats both no DVD device and one empty DVD device as sealed media state', () => {
    expect(postOsCore).toContain("if ($dvdDrives.Count -ne 1 -or [string]::IsNullOrWhiteSpace([string]$dvdDrives[0].Path)) { throw 'installation_media_missing' }");
    expect(postOsCore).toContain("if ($dvdDrives.Count -gt 1) { throw 'vm_dvd_contract_mismatch' }");
    expect(postOsCore).toContain("if ($afterDvd.Count -gt 1 -or @($afterDvd | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_.Path) }).Count -ne 0)");
    expect(chain).toContain("($Mode -ceq 'Verify' -and $Receipt.mutation_performed -ne $false)");
    expect(chain).toContain("($Mode -ceq 'Seal' -and $Receipt.mutation_performed -isnot [bool])");
  });

  it('recovers only receipt-bound unauthenticated probe state and isolates CLI probes', () => {
    expect(bootstrap).toContain('[string]$PriorFailureReceiptPath =');
    expect(bootstrap).toContain("$priorFailure.document.reason_code -cne 'codex_home_not_empty'");
    expect(bootstrap).toContain('$priorFailure.document.receipt_chain.prior_receipt_sha256 -cne $prior.sha256');
    expect(bootstrap).toContain("'-RecoverUnauthenticatedProbeState','true'");
    expect(runner).toContain("'-PriorFailureReceiptPath'");
    expect(bootstrapCore).toContain("[ValidateSet('true','false')] [string]$RecoverUnauthenticatedProbeState = 'false'");
    expect(bootstrapCore).toContain("$recoverProbeState = $RecoverUnauthenticatedProbeState -ceq 'true'");
    expect(bootstrapCore).toContain("'Evidence1CliProbe-'");
    expect(bootstrapCore).toContain("New-Item -ItemType Directory -Path $env:CODEX_HOME,$env:CLAUDE_CONFIG_DIR");
    expect(bootstrapCore).toContain('Remove-Item -LiteralPath $probeRoot -Recurse -Force');
    expect(bootstrapCore).toContain("if (Test-Path -LiteralPath $runtimeRoot) { throw 'auth_state_recovery_toolchain_present' }");
    expect(bootstrapCore).toContain('if (-not $RecoverUnauthenticatedProbeState) { throw \'auth_state_not_empty\' }');
  });

  it('reads the offline Windows volume by GUID when no drive letter is assigned', () => {
    expect(checkpointCore).toContain(".StartsWith('\\\\?\\Volume{'");
    expect(checkpointCore).toContain("Join-Path $accessPath 'Windows\\System32\\Config\\SYSTEM'");
    expect(checkpointCore).not.toContain('$_.DriveLetter -and (Test-Path -LiteralPath');
    expect(checkpoint).toContain("$priorFailure.document.reason_code -cne 'guest_windows_volume_missing'");
    expect(checkpoint).toContain("elseif ([string]$vm.State -ceq 'Off')");
    expect(runner).toContain("'-PriorFailureReceiptPath'");
  });
});
