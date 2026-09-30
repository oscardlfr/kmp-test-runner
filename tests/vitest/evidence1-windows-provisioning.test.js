import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

const root = resolve(import.meta.dirname, '../..');
const file = path => resolve(root, path);
// Write-E1RecoveryReceiptIfNeeded's and evidence1-bootstrap-toolchain.ps1's own scratch-boundary
// checks (evidence1-install-windows-unattended.ps1's Assert-E1PathInside) deliberately allow
// EITHER C:\kmp-eval\scratch OR the system temp directory -- a real, intentional allowance for
// crash-recovery receipts, not a bug. The 2 tests below need a path GUARANTEED outside both to
// prove the rejection path; when this repo's own checkout root is itself under the temp
// directory (this repo's local-ci Windows lane clones there), no path derived from `root` can
// ever satisfy that guarantee, so the tests cannot exercise what they're actually testing.
const isRepoUnderTempRoot = resolve(root).toLowerCase().startsWith(resolve(tmpdir()).toLowerCase());
const read = path => readFileSync(file(path), 'utf8').replaceAll('\r\n', '\n');

const profilePath = 'tools/evidence1/provisioning/evidence1-windows-hyperv-v1.json';
const schemaPath = 'tools/evidence1/provisioning/evidence1-windows-input-lock.schema.json';
const modulePath = 'tools/evidence1/provisioning/Evidence1.Provisioning.psm1';
const creatorPath = 'tools/evidence1/provisioning/evidence1-windows-vm.ps1';
const bootstrapPath = 'tools/evidence1/provisioning/evidence1-bootstrap-toolchain.ps1';
const lockBuilderPath = 'tools/evidence1/provisioning/evidence1-new-input-lock.ps1';
const checkpointPath = 'tools/evidence1/provisioning/evidence1-checkpoint-toolchain.ps1';
const postOsPath = 'tools/evidence1/provisioning/evidence1-post-os-transition.ps1';
const normalizerPath = 'tools/evidence1/provisioning/evidence1-normalize-toolchain-archive.ps1';
const approvedSchemaPath = 'tools/evidence1/provisioning/evidence1-windows-approved-inputs.schema.json';
const approvedManifestPath = 'tools/evidence1/provisioning/approved-inputs/evidence1-windows-25h2-en-gb-codex-01534-e2e-v1.json';
const approvedManifestV2Path = 'tools/evidence1/provisioning/approved-inputs/evidence1-windows-25h2-en-gb-codex-01534-e2e-v2.json';
const e2eProfilePath = 'tools/evidence1/provisioning/evidence1-windows-hyperv-e2e-v1.json';
const unattendedInstallerPath = 'tools/evidence1/provisioning/evidence1-install-windows-unattended.ps1';
const offlineApplyPath = 'tools/evidence1/provisioning/evidence1-apply-windows-offline.ps1';
const offlineApplyWrapperPath = 'docs/audits/evidence1-host-apply-canonical-windows-offline.ps1';
const retryCustodyPath = 'tools/evidence1/provisioning/evidence1-new-unattended-retry-custody.ps1';
const provisioningReadmePath = 'tools/evidence1/provisioning/README.md';
const codexLookup = process.platform === 'win32'
  ? spawnSync('where.exe', ['codex.exe'], { encoding: 'utf8', timeout: 10_000 })
  : { status: 1, stdout: '' };
const installedCodexPath = codexLookup.status === 0 ? codexLookup.stdout.split(/\r?\n/).find(Boolean) : null;
const installedCodexVersion = installedCodexPath
  ? spawnSync(installedCodexPath, ['--version'], { encoding: 'utf8', timeout: 10_000 }).stdout.trim()
  : null;

// Many tests here spawn Windows PowerShell with a 30 s budget of their own. The 5 s vitest default
// would fail them on a loaded host before that budget runs out.
describe('canonical Evidence1 Windows provisioning', { timeout: 60_000 }, () => {
  it('pins a closed Hyper-V profile and every required runtime', () => {
    const profile = JSON.parse(read(profilePath));

    expect(profile).toMatchObject({
      schema_version: 2,
      profile_id: 'evidence1-windows-hyperv-v1',
      platform: 'windows',
      hypervisor: 'hyper-v',
      vm: {
        name: 'Evidence1-Runner',
        root: 'C:\\kmp-eval\\hyperv',
        generation: 2,
        secure_boot: true,
        v_tpm: true,
        automatic_checkpoints: false,
        checkpoint_type: 'ProductionOnly',
      },
      os: { family: 'windows', architecture: 'x64', installation_boundary: 'operator' },
      checkpoint: { toolchain_name: 'Evidence1-ready-toolchain-v1', required_vm_state: 'Off' },
    });
    expect(profile.guest).toMatchObject({
      runtime_state_root: 'C:\\Evidence1RuntimeState',
      codex_home: 'C:\\Evidence1RuntimeState\\codex',
      claude_config_dir: 'C:\\Evidence1RuntimeState\\claude',
      android_sdk_root: 'C:\\Evidence1Toolchain\\android-sdk\\platform-36-build-tools-36.0.0',
    });
    expect(profile.toolchain.map(item => item.id)).toEqual(['git', 'node', 'jdk', 'android-sdk', 'claude-code', 'codex-cli']);
    expect(profile.toolchain.find(item => item.id === 'codex-cli')).toMatchObject({
      version: '0.153.4', architecture: 'x64', distribution: 'official-codex-npm-package-binary',
      artifact_format: 'raw-executable', install_handler: 'codex-single-exe',
      authenticode_subject: 'CN="OpenAI OpCo, LLC", O="OpenAI OpCo, LLC", L=San Francisco, S=California, C=US',
      auth_in_base_image: false,
    });
    expect(profile.toolchain.every(item => item.version_capture_pattern && item.distribution && item.artifact_format)).toBe(true);
    expect(profile.toolchain.find(item => item.id === 'node').secondary_commands).toEqual([
      expect.objectContaining({ id: 'npm', version_pattern: '^11\\.17\\.0$' }),
    ]);
    expect(profile.phases).toEqual([
      'validate-inputs', 'create-vm', 'operator-install-os', 'verify-and-seal-post-os', 'bootstrap-toolchain',
      'verify-offline', 'checkpoint-toolchain',
    ]);
    expect(profile.network).toEqual({ create_state: 'disconnected', bootstrap_state: 'disconnected', checkpoint_state: 'disconnected' });
    expect(profile.guest.forbidden_environment_names).toEqual(expect.arrayContaining([
      'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'GH_TOKEN', 'AWS_SESSION_TOKEN',
    ]));
  });

  it('ships a separate closed E2E profile that cannot collide with the product VM', () => {
    const product = JSON.parse(read(profilePath));
    const e2e = JSON.parse(read(e2eProfilePath));
    expect(e2e).toMatchObject({ schema_version: 2, profile_id: 'evidence1-windows-hyperv-e2e-v1' });
    expect(e2e.vm.name).not.toBe(product.vm.name);
    expect(e2e.vm.root).not.toBe(product.vm.root);
    expect(e2e.checkpoint.toolchain_name).not.toBe(product.checkpoint.toolchain_name);
    expect(product.os.installation_boundary).toBe('operator');
    expect(e2e.os.installation_boundary).toBe('offline-apply');
    expect(e2e.phases).toEqual([
      'validate-inputs', 'create-vm', 'apply-os-offline', 'verify-and-seal-post-os',
      'bootstrap-toolchain', 'verify-offline', 'checkpoint-toolchain',
    ]);
  });

  it('retains the superseded optical-install implementation for historical receipt validation', () => {
    const installer = read(unattendedInstallerPath);
    const retryCustody = read(retryCustodyPath);

    expect(installer).toContain("$RequiredProfileId = 'evidence1-windows-hyperv-e2e-v1'");
    expect(installer).toContain("throw 'unattended_install_profile_not_allowed'");
    expect(installer).toContain("$profile.os.installation_boundary -cne 'automated-unattended'");
    expect(installer).toContain("$Plan.approved_manifest.iso_image.index");
    expect(installer).toContain('<Key>/IMAGE/INDEX</Key>');
    expect(installer).toContain('<Type>EFI</Type>');
    expect(installer).toContain('<Type>MSR</Type>');
    expect(installer).toContain('<Label>Recovery</Label>');
    expect(installer).toContain(['de94bba4', '06d1', '4d40', 'a16a', 'bfd50179d6ac'].join('-'));
    expect(installer).toContain('<Group>Administrators</Group>');
    expect(installer).toContain('<PlainText>false</PlainText>');
    expect(installer).toContain('<AutoLogon>');
    expect(installer).toContain('<LogonCount>1</LogonCount>');
    expect(installer).toContain("[Text.Encoding]::Unicode.GetBytes($Password + 'Password')");
    expect(installer).toContain('[Security.Cryptography.RandomNumberGenerator]::Create()');
    expect(installer).toContain('Export-Clixml -LiteralPath $credentialFull');
    expect(installer).toContain(`New-Object -ComObject '${['Imapi', '2Fs'].join('')}.MsftFileSystemImage'`);
    expect(installer).toContain('CreateResultImage()');
    expect(installer).toContain('SHCreateStreamOnFileEx');
    expect(installer).toContain('Add-VMDvdDrive');
    expect(installer).toContain("throw 'installation_media_host_mount_conflict'");
    expect(installer).toContain('Start-VM -VM $vm');
    expect(installer.match(/Start-VM/g)).toHaveLength(1);
    expect(installer).toContain('Msvm_Keyboard');
    expect(installer).toContain('-MethodName TypeKey');
    expect(installer).toContain('$attempt -lt 16');
    expect(installer).toContain('$bootKeySuccessCount -eq 0');
    expect(installer).toContain("$RequiredRetryAuthorizationPhrase = 'authorize exactly one evidence1 e2e windows unattended retry'");
    expect(installer).toContain("$receipt.reason_code -cne 'vm_boot_key_injection_failed'");
    expect(installer).toContain('prior_failure_receipt_sha256 = $priorFailureReceiptSha');
    expect(installer).toContain('start_count = $priorStartCount + 1');
    expect(installer).toContain('Import-Clixml -LiteralPath $credentialFull');
    expect(installer).toContain("$retryMarkerPath = Join-Path $vmRoot 'custody\\unattended-retry-1.consumed.json'");
    expect(installer).toContain('[string]$PriorFailureCustodyPath');
    expect(installer).toContain("throw 'prior_failure_custody_binding_mismatch'");
    expect(installer).toContain('prior_failure_custody_sha256 = $priorFailureCustodySha');
    expect(installer).toContain('[string]$PriorRunnerRequestId');
    expect(installer).toContain('[string]$priorFailureCustody.runner_log_sha256 -cne [string]$priorRunnerLogIdentity.sha256');
    expect(retryCustody).toContain("reason_code = 'legacy_failure_custody_validated'");
    expect(retryCustody).toContain('authorization_value_copied_to_sidecar = $false');
    expect(retryCustody).toContain('raw_log_copied_to_sidecar = $false');
    expect(retryCustody).toContain('vm_mutation_performed = $false');
    expect(retryCustody).toContain("$RequiredRunnerQueueRoot = 'C:\\kmp-eval\\scratch\\host-elevated-runner-codex'");
    expect(retryCustody).toContain('Join-Path $queueRoot "done\\$RunnerRequestId.request.json"');
    expect(retryCustody).toContain("Join-Path $vmRoot 'custody\\unattended-retry-1.custody.json'");
    expect(retryCustody).toContain('Assert-E1RunnerQueueAcl $queueRoot');
    expect(retryCustody).toContain('Set-E1PrivateDirectoryAcl $runnerDirectory');
    expect(retryCustody).toContain('Set-E1PrivateFileAcl $runnerArtifact');
    expect(retryCustody).toContain('Assert-E1NoReparsePointAncestors $runnerArtifact');
    expect(retryCustody).toContain('runner_artifact_acls_hardened = $true');
    expect(retryCustody).not.toContain('[string]$CustodyPath');
    expect(retryCustody).not.toMatch(/Start-VM|Stop-VM|Connect-VMNetworkAdapter|Set-VMNetworkAdapter/);
    expect(installer).toContain("throw 'unattended_retry_already_consumed'");
    expect(installer).toContain('Write-E1RetryMarkerAtomically $retryMarkerPath');
    expect(installer).toContain('[IO.File]::Move($temp, $full)');
    expect(installer).toContain('guest_credential_sha256 = Get-E1Sha256 $credentialFull');
    expect(installer).toContain('$deadlineUtc = $operationStartedAtUtc.AddSeconds($TimeoutSeconds)');
    expect(installer.match(/\$deadlineUtc\s*=\s*\$operationStartedAtUtc\.AddSeconds\(\$TimeoutSeconds\)/g)).toHaveLength(1);
    expect(installer.indexOf('$operationStartedAtUtc = [DateTime]::UtcNow')).toBeLessThan(installer.indexOf('$plan = Get-E1ProvisioningPlan'));
    expect(installer.indexOf("if ([DateTime]::UtcNow -ge $deadlineUtc) { throw 'unattended_install_timeout' }")).toBeLessThan(installer.indexOf('Add-VMDvdDrive'));
    expect(installer).toContain('New-PSSessionOption -OpenTimeout 5000 -OperationTimeout 10000 -CancelTimeout 5000');
    expect(installer).toContain('Start-Sleep -Seconds 10');
    expect(installer).toContain("throw 'unattended_install_timeout'");
    expect(installer).toContain('oobe-complete.marker');
    expect(installer).toContain("'IMAGE_STATE_COMPLETE'");
    expect(installer).toContain("Join-Path $env:SystemRoot 'Panther'");
    expect(installer).toContain("'C:\\$Windows.~BT\\Sources\\Panther'");
    expect(installer).toContain("'DefaultPassword','DefaultUserName','DefaultDomainName','AutoLogonCount'");
    expect(installer).toContain('Remove-VMDvdDrive');
    expect(installer).toContain('Stop-VM -VM $currentVm -TurnOff -Force -AsJob');
    expect(installer.indexOf('$startPerformed = $true')).toBeLessThan(installer.indexOf('Start-VM -VM $vm'));
    expect(installer).toContain('function Invoke-E1UnattendedHostRecovery');
    expect(installer).toContain("Invoke-E1UnattendedHostRecovery 'Evidence1-Runner-E2E'");
    expect(installer.indexOf("Invoke-E1UnattendedHostRecovery 'Evidence1-Runner-E2E'")).toBeLessThan(installer.indexOf('$plan = Get-E1ProvisioningPlan'));
    expect(installer).toContain('$cursor = $Path');
    expect(installer).toContain("guest_cached_answer_state = 'unknown'");
    expect(installer).toContain('guest_credential_preserved = Test-Path -LiteralPath $CredentialPath -PathType Leaf');
    expect(installer).toContain('Get-E1FailureCleanupAttestation $startPerformed $vmStopped $answerMediaDeleted');
    expect(installer).toContain('failure_cleanup_complete = $failureCleanupComplete');
    expect(installer).toContain("[ValidateSet('', 'elevated_runner_child_timeout', 'elevated_runner_child_failure')]");
    expect(installer).toContain("receipt_source = 'elevated-runner-recovery'");
    expect(installer).toContain('if (Test-Path -LiteralPath $recoveryReceiptFull) { return $false }');
    expect(installer).toContain("mutation_telemetry_reason = 'worker_mutation_telemetry_unavailable'");
    expect(installer).toContain('private_paths_persisted = $false; mutation_performed = $null');
    expect(installer).toContain("throw 'vm_profile_drift'");
    expect(installer).toContain("throw 'vm_unexpected_checkpoint'");
    expect(installer).toContain("$expectedIso = Join-Path $vmRoot 'media\\windows.iso'");
    expect(installer).toContain("throw 'private_state_root_mismatch'");
    expect(installer).toContain("throw 'private_state_root_already_exists'");
    expect(installer).toContain("throw 'private_state_reparse_point'");
    expect(installer).toContain('answer_media_deleted = $answerMediaDeleted');
    expect(installer).toContain('Remove-Item -LiteralPath $credentialFull -Force -ErrorAction Stop');
    expect(installer).toContain('if (-not $isRetry -and -not $startPerformed -and (Get-Variable credentialFull');
    expect(installer).toContain('cached_answer_files_absent = $cachedAnswerFilesAbsent');
    expect(installer).toContain('network_used = $false');
    expect(installer).toContain('inference_sessions_consumed = 0');
    expect(installer).not.toMatch(/Windows11InstallationAssistant|VMConnect|Connect-VMNetworkAdapter|OPENAI_API_KEY|ANTHROPIC_API_KEY/i);
    expect(installer).not.toMatch(/while\s*\(\s*\$true\s*\)/i);
  });

  it.skipIf(process.platform !== 'win32')('evaluates pre-start, unknown-guest, recoverable, and residual cleanup states fail closed', () => {
    const escapedModule = file(modulePath).replaceAll("'", "''");
    const probe = `
      Import-Module '${escapedModule}' -Force
      @(
        (Get-E1FailureCleanupAttestation $false $true $true $true $false $false @()),
        (Get-E1FailureCleanupAttestation $true $true $true $true $false $true @()),
        (Get-E1FailureCleanupAttestation $true $true $true $true $true $true @()),
        (Get-E1FailureCleanupAttestation $true $true $true $true $true $true @('media_residual'))
      ) | ConvertTo-Json -Depth 5 -Compress
    `;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', probe], {
      cwd: root,
      encoding: 'utf8',
      timeout: 20_000,
    });

    expect(result.status, result.stderr).toBe(0);
    const states = JSON.parse(result.stdout);
    expect(states).toEqual([
      expect.objectContaining({ host_cleanup_complete: true, failure_cleanup_complete: true, guest_cached_answer_state: 'unknown', retry_authorized: false }),
      expect.objectContaining({ host_cleanup_complete: true, failure_cleanup_complete: false, guest_cached_answer_state: 'unknown', guest_credential_preserved: true }),
      expect.objectContaining({ host_cleanup_complete: true, failure_cleanup_complete: true, guest_cached_answer_state: 'absent', guest_credential_preserved: true }),
      expect.objectContaining({ host_cleanup_complete: false, failure_cleanup_complete: false, retry_authorized: false }),
    ]);
  });

  it('requires immutable ISO and artifact identities without accepting commands', () => {
    const schema = JSON.parse(read(schemaPath));
    const serialized = JSON.stringify(schema);

    expect(schema.required).toEqual(['schema_version', 'profile_id', 'approved_manifest', 'iso', 'artifacts']);
    expect(schema.properties.approved_manifest.required).toEqual(['path', 'sha256', 'git_commit', 'blob_oid']);
    expect(schema.properties.iso.required).toEqual(['path']);
    expect(schema.properties.artifacts.items.required).toEqual(['id', 'path']);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.artifacts.items.additionalProperties).toBe(false);
    expect(serialized).not.toMatch(/command|arguments|script|token|password|credential/i);
    const approved = JSON.parse(read(approvedSchemaPath));
    expect(approved.properties.approval_status.const).toBe('approved');
    expect(approved.properties.iso.properties.publisher.const).toBe('Microsoft');
    expect(approved.properties.iso.properties.image.required).toEqual(expect.arrayContaining(['index', 'edition_id', 'architecture', 'languages', 'version']));
    expect(approved.properties.artifacts.items.required).toEqual(expect.arrayContaining(['sources', 'verification']));
  });

  it('pins the reviewed E2E inputs without private paths or ambiguous Codex provenance', () => {
    const manifest = JSON.parse(read(approvedManifestPath));
    expect(manifest).toMatchObject({
      schema_version: 1,
      approval_status: 'approved',
      profile_id: 'evidence1-windows-hyperv-e2e-v1',
      iso: {
        sha256: '66b7b4b71763ed6f9b2ce29326ed9284544da6f5283d00329921540c01aaaeea',
        bytes: 8486862848,
        publisher: 'Microsoft',
        image: { index: 6, edition: 'Windows 11 Pro', edition_id: 'Professional', architecture: 'x64', languages: ['en-GB'], version: '10.0.26200.8037' },
      },
    });
    expect(manifest.artifacts.map(item => item.id)).toEqual(['git', 'node', 'jdk', 'android-sdk', 'claude-code', 'codex-cli']);
    expect(manifest.artifacts.every(item => item.architecture === 'x64' && item.bytes > 0 && item.sources.length > 0)).toBe(true);
    expect(manifest.artifacts.flatMap(item => item.sources).every(source => source.uri.startsWith('https://') && source.bytes > 0)).toBe(true);
    expect(manifest.artifacts.find(item => item.id === 'codex-cli')).toMatchObject({
      version: '0.153.4',
      sha256: '444a3f0008050605cae73cd9b7a2dcac61294062dfaab56dd20430fd6498518b',
      bytes: 295408944,
      sources: [{
        uri: 'https://registry.npmjs.org/@openai/codex/-/codex-0.153.4-win32-x64.tgz',
        digest_algorithm: 'sha512-sri',
        digest: 'sha512-lMkB43kJZH0VFr+hoXc11qqR7QtQIbkr07ALgj4urKL1osNyUyuy1iXd3Vzz2iCYvBUCSw7I0l/W1cEPGx9euQ==',
        bytes: 141495386,
      }],
      publisher: 'OpenAI OpCo, LLC',
      verification: { kind: 'npm-integrity', result: 'verified' },
    });
    expect(JSON.stringify(manifest)).not.toMatch(/[A-Z]:\\|credential|password|token/i);
  });

  it('models pinned host DISM independently from the guest toolchain while preserving the historical manifest', () => {
    const profile = JSON.parse(read(e2eProfilePath));
    const product = JSON.parse(read(profilePath));
    const historical = JSON.parse(read(approvedManifestPath));
    const current = JSON.parse(read(approvedManifestV2Path));

    expect(product.host_dependencies).toBeUndefined();
    expect(profile.toolchain.map(item => item.id)).not.toContain('windows-adk-dism');
    expect(profile.host_dependencies).toEqual([expect.objectContaining({
      id: 'windows-adk-dism',
      adk_release: '10.1.26100.2454',
      servicing_update: 'KB5101684',
      architecture: 'x64',
      command_relative: 'dism.exe',
      runtime_version: '10.0.26100.8972',
    })]);
    expect(historical.schema_version).toBe(1);
    expect(historical.host_dependencies).toBeUndefined();
    expect(current).toMatchObject({ schema_version: 2, profile_id: profile.profile_id });
    expect(current.artifacts).toEqual(historical.artifacts);
    expect(current.host_dependencies).toEqual([expect.objectContaining({
      id: 'windows-adk-dism',
      archive_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      executable_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      tree_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      verification: { kind: 'authenticode', result: 'verified' },
    })]);
    expect(JSON.stringify(current)).not.toMatch(/[A-Z]:\\|credential|password|token/i);
  });

  it('keeps lock v2 valid and adds a path-only v3 host dependency binding', () => {
    const lockSchema = JSON.parse(read(schemaPath));
    const manifestSchema = JSON.parse(read(approvedSchemaPath));
    const serialized = JSON.stringify({ lockSchema, manifestSchema });

    expect(lockSchema.oneOf).toHaveLength(2);
    expect(manifestSchema.oneOf).toHaveLength(2);
    expect(serialized).toContain('host_dependencies');
    expect(serialized).not.toMatch(/authorization|command_arguments|credential/i);
  });

  it('keeps create, bootstrap, and auth as separate boundaries', () => {
    const creator = read(creatorPath);
    const bootstrap = read(bootstrapPath);
    const checkpoint = read(checkpointPath);
    const module = read(modulePath);
    const postOs = read(postOsPath);

    expect(creator).toContain("[ValidateSet('Validate', 'Create', 'InspectCreated', 'InspectInstalled')]");
    expect(creator).toContain("$RequiredCreatePhrase = 'authorize create evidence1 windows vm from verified inputs'");
    expect(creator).toContain("throw 'vm_already_exists'");
    expect(creator).toContain("$sealedIsoPath = Join-Path $mediaDir 'windows.iso'");
    expect(creator).toContain('mutation_performed = $mutationPerformed');
    expect(creator).toContain('-CheckpointType $profile.vm.checkpoint_type');
    expect(creator).toContain('Inspect-WindowsIsoImage');
    expect(creator).toContain('Dismount-DiskImage -ImagePath $IsoPath -ErrorAction Stop | Out-Null');
    expect(creator).toContain('Dismount-DiskImage -ImagePath $plan.iso.source_path -ErrorAction Stop | Out-Null');
    expect(creator).toContain('$security = Get-VMSecurity -VM $existing');
    expect(creator).toContain('$security.TpmEnabled');
    expect(creator).not.toContain('Get-VMTPM');
    expect(creator).toContain("if ([string]$existing.State -cne 'Off') { $drift += 'vm_state' }");
    expect(creator).toContain("if ([string]$vhd.VhdType -cne 'Dynamic') { $drift += 'vhd_type' }");
    expect(creator).toContain("$drift += 'installation_media_path'");
    expect(creator).toContain('([uint32]$image.MajorVersion)');
    expect(creator).toContain('([uint32]$image.SPBuild)');
    expect(creator).toContain("network_state = 'disconnected'");
    expect(creator).not.toMatch(/StartAfterCreate|Start-VM|-SwitchName/);
    expect(creator).not.toMatch(/Remove-VM|Remove-VHD|login|auth\.json|OPENAI_API_KEY|ANTHROPIC_API_KEY/i);
    expect(bootstrap).toContain("[ValidateSet('Bootstrap', 'Verify')]");
    expect(bootstrap).toContain("'git-portable-zip', 'node-portable-zip', 'jdk-portable-zip', 'android-sdk-zip', 'claude-npm-zip', 'codex-single-exe'");
    expect(bootstrap).toContain('changed = $false');
    expect(bootstrap).toContain('auth_material_copied = $false');
    expect(bootstrap).toContain("throw 'installed_runtime_drift'");
    expect(bootstrap).toContain("throw 'installed_runtime_tree_drift'");
    expect(bootstrap).toContain('installed_tree_sha256=$installedTree.sha256');
    expect(bootstrap).toContain("'guest_credential_path_outside_scratch'");
    expect(bootstrap).toContain("'receipt_path_outside_scratch'");
    expect(bootstrap).toContain("[Environment]::SetEnvironmentVariable('CODEX_HOME'");
    expect(bootstrap).toContain("$Runtime.id -eq 'codex-cli'");
    expect(bootstrap).toContain("$helpOutput");
    expect(bootstrap).toContain('Get-AuthenticodeSignature -LiteralPath $CommandPath');
    expect(bootstrap).toContain("throw 'codex_publisher_signature_invalid'");
    expect(bootstrap).toContain("throw 'vm_network_not_disconnected'");
    expect(bootstrap.indexOf('$env:CODEX_HOME')).toBeLessThan(bootstrap.indexOf("$Runtime.id -eq 'codex-cli'"));
    expect(bootstrap).toContain("[Environment]::SetEnvironmentVariable('ANDROID_HOME'");
    expect(bootstrap).not.toMatch(/Invoke-Expression|Start-Process|login|auth\.json|OPENAI_API_KEY|ANTHROPIC_API_KEY/i);
    expect(checkpoint).toContain("$RequiredAuthorizationPhrase = 'authorize checkpoint verified evidence1 toolchain without auth'");
    expect(checkpoint).toContain("throw 'vm_must_be_off'");
    expect(checkpoint).toContain("throw 'vm_network_not_disconnected'");
    expect(checkpoint).toContain("throw 'auth_material_present'");
    expect(checkpoint).toContain("throw 'checkpoint_already_exists'");
    expect(checkpoint).toContain('Assert-E1ToolchainVerifyReceipt');
    expect(checkpoint).toContain('Get-MountedTreeIdentity');
    expect(checkpoint).toContain('[Parameter(Mandatory = $true)] [string]$InputLockPath');
    expect(checkpoint).not.toMatch(/Remove-VMSnapshot|Restore-VMSnapshot|Start-VM|Stop-VM|login/i);
    expect(module).toContain('function Assert-E1ToolchainVerifyReceipt');
    expect(module).toContain("throw 'toolchain_receipt_binding_mismatch'");
    expect(module).toContain("throw 'toolchain_receipt_stale'");
    expect(module).toContain("throw 'toolchain_receipt_runtime_mismatch'");
    expect(postOs).toContain("$RequiredSealPhrase = 'authorize seal evidence1 windows post-os boundary'");
    expect(postOs).toContain("throw 'guest_os_edition_mismatch'");
    expect(postOs).toContain('Set-VMDvdDrive');
    expect(postOs).not.toMatch(/Start-VM|Stop-VM|Connect-VMNetworkAdapter|login/i);
  });

  it('integrates canonical toolchain paths while retaining the historical Claude fallback', () => {
    const readiness = read('docs/audits/evidence1-hyperv-regenerate-readiness-direct.ps1');
    const live = read('docs/audits/evidence1-stageb-live-launch.ps1');
    const validation = read('docs/audits/evidence1-validation-ops.psm1');
    const codexPreflight = read('docs/audits/evidence1-hyperv-verify-guest-codex-preflight-direct.ps1');
    for (const script of [readiness, live, validation]) {
      expect(script).toContain('C:\\Evidence1Toolchain');
      expect(script).toContain('C:\\Program Files\\Git');
      expect(script).toContain('C:\\Program Files\\nodejs');
    }
    expect(codexPreflight).toContain('[bool]$RequireCanonicalToolchain = $true');
    expect(codexPreflight).toContain("throw 'codex_canonical_toolchain_required'");
    expect(codexPreflight).toContain("$codexVersion -cne 'codex-cli 0.154.0'");
    expect(codexPreflight).toContain('Get-AuthenticodeSignature -LiteralPath $canonicalCodex');
    expect(codexPreflight).toContain('canonical_toolchain = $canonicalToolchain');
  });

  it.skipIf(process.platform !== 'win32')('parses every provisioning entrypoint in Windows PowerShell 5.1', () => {
    const paths = [modulePath, creatorPath, bootstrapPath, lockBuilderPath, checkpointPath, postOsPath, normalizerPath, unattendedInstallerPath, offlineApplyPath, retryCustodyPath].map(path => file(path).replaceAll("'", "''"));
    const script = `$bad=$false; foreach($path in @('${paths.join("','")}')) { $t=$null; $e=$null; [Management.Automation.Language.Parser]::ParseFile($path,[ref]$t,[ref]$e)|Out-Null; if($e.Count){$e|% Message;$bad=$true} }; if($bad){exit 1}`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', timeout: 30_000 });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  });

  it.skipIf(process.platform !== 'win32')('creates the ephemeral answer ISO with the built-in Windows imaging API', () => {
    const fixture = mkdtempSync(resolve(tmpdir(), 'e1-answer-iso-'));
    try {
      const source = resolve(fixture, 'source');
      const iso = resolve(fixture, 'answer.iso');
      mkdirSync(source);
      writeFileSync(resolve(source, 'Autounattend.xml'), '<unattend xmlns="urn:schemas-microsoft-com:unattend"/>');
      const script = `
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($env:E1_INSTALLER,[ref]$tokens,[ref]$errors)
if($errors.Count){exit 2}
$wanted=@('Set-E1PrivateDirectoryAcl','Add-E1IsoWriterType','New-E1AnswerIso')
$definitions=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -in $wanted},$true))
if($definitions.Count -ne 3){exit 3}
. ([scriptblock]::Create(($definitions.Extent.Text -join [Environment]::NewLine)))
Set-E1PrivateDirectoryAcl $env:E1_SOURCE
New-E1AnswerIso $env:E1_SOURCE $env:E1_ISO
if(-not (Test-Path -LiteralPath $env:E1_ISO -PathType Leaf) -or (Get-Item -LiteralPath $env:E1_ISO).Length -le 0){exit 4}
`;
      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8', timeout: 30_000,
        env: { ...process.env, E1_INSTALLER: file(unattendedInstallerPath), E1_SOURCE: source, E1_ISO: iso },
      });
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      expect(readFileSync(iso).length).toBeGreaterThan(0);
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== 'win32')('retries transient Hyper-V keyboard states within a fixed boot window', () => {
    const script = String.raw`
$tokens=$null
$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($env:E1_INSTALLER,[ref]$tokens,[ref]$errors)
if($errors.Count){$errors|% Message;exit 2}
$definition=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Invoke-E1BoundedBootKey'},$true))
if($definition.Count -ne 1){exit 3}
. ([scriptblock]::Create($definition[0].Extent.Text))
$script:calls=0
function Get-CimInstance { [pscustomobject]@{ EnabledState=2 } }
function Get-CimAssociatedInstance { [pscustomobject]@{ Name='keyboard' } }
function Invoke-CimMethod {
  $script:calls++
  if($script:calls -eq 1){return [pscustomobject]@{ ReturnValue=[uint32]32775 }}
  return [pscustomobject]@{ ReturnValue=[uint32]0 }
}
function Start-Sleep {}
Invoke-E1BoundedBootKey ([pscustomobject]@{ Name='Evidence1-Runner-E2E' })
if($script:calls -ne 16){exit 4}
if($script:E1BootKeyDiagnostics.attempts -ne 16 -or $script:E1BootKeyDiagnostics.successes -ne 15 -or
   $script:E1BootKeyDiagnostics.last_return_code -ne 0 -or $script:E1BootKeyDiagnostics.exception_count -ne 0){exit 5}
`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, E1_INSTALLER: file(unattendedInstallerPath) },
    });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  });

  it.skipIf(process.platform !== 'win32')('fails the fixed boot window after sixteen nonzero returns or CIM exceptions', () => {
    const script = String.raw`
$tokens=$null
$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($env:E1_INSTALLER,[ref]$tokens,[ref]$errors)
$definition=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Invoke-E1BoundedBootKey'},$true))
. ([scriptblock]::Create($definition[0].Extent.Text))
function Get-CimInstance { [pscustomobject]@{ EnabledState=2 } }
function Get-CimAssociatedInstance { [pscustomobject]@{ Name='keyboard' } }
function Start-Sleep {}
$vm=[pscustomobject]@{ Name='Evidence1-Runner-E2E' }
foreach($mode in @('return','throw')) {
  $script:calls=0
  $script:failureMode=$mode
  function Invoke-CimMethod {
    $script:calls++
    if($script:failureMode -ceq 'throw'){throw 'transient-cim'}
    return [pscustomobject]@{ ReturnValue=[uint32]32775 }
  }
  try { Invoke-E1BoundedBootKey $vm; Write-Error "unexpected success: $mode"; exit 4 }
  catch { if($_.Exception.Message -cne 'vm_boot_key_injection_failed'){Write-Error "unexpected error: $($_.Exception.Message)";exit 5} }
  if($script:calls -ne 16){Write-Error "unexpected calls: $mode=$script:calls";exit 6}
  if($script:E1BootKeyDiagnostics.attempts -ne 16 -or $script:E1BootKeyDiagnostics.successes -ne 0){exit 7}
  if($mode -ceq 'return' -and ($script:E1BootKeyDiagnostics.last_return_code -ne 32775 -or $script:E1BootKeyDiagnostics.exception_count -ne 0)){exit 8}
  if($mode -ceq 'throw' -and ($null -ne $script:E1BootKeyDiagnostics.last_return_code -or $script:E1BootKeyDiagnostics.exception_count -ne 16)){exit 9}
}
exit 0
`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, E1_INSTALLER: file(unattendedInstallerPath) },
    });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  });

  it.skipIf(process.platform !== 'win32' || isRepoUnderTempRoot)('writes an honest recovery receipt once without leaking caller paths', () => {
    const fixture = mkdtempSync(resolve(tmpdir(), 'e1-recovery-receipt-'));
    try {
      const receipt = resolve(fixture, 'recovery.json');
      const existing = resolve(fixture, 'existing.json');
      const emptyReason = resolve(fixture, 'empty.json');
      writeFileSync(existing, 'sentinel-bytes');
      const script = String.raw`
$tokens=$null
$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($env:E1_INSTALLER,[ref]$tokens,[ref]$errors)
$definition=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Write-E1RecoveryReceiptIfNeeded'},$true))
if($errors.Count -or $definition.Count -ne 1){exit 2}
Import-Module $env:E1_MODULE -Force
. ([scriptblock]::Create($definition[0].Extent.Text))
$RequiredProfileId='evidence1-windows-hyperv-e2e-v1'
function Get-VM { throw 'unexpected_second_vm_lookup' }
function Get-E1Sha256OrNull { param($Path) if([string]::IsNullOrWhiteSpace($Path)){$null}else{'a'*64} }
$recovery=[ordered]@{vm_id='6e5848f5-37dd-4653-9f3d-df2871e6293a';vm_state='Off';answer_media_deleted=$true;guest_credential_preserved=$true}
$written=Write-E1RecoveryReceiptIfNeeded 'elevated_runner_child_timeout' $env:E1_RECEIPT 'PRIVATE_PROFILE' 'PRIVATE_LOCK' 'PRIVATE_CREDENTIAL' $false $recovery
if(-not $written){exit 3}
$raw=[IO.File]::ReadAllText($env:E1_RECEIPT)
$record=$raw|ConvertFrom-Json
if($record.verdict -cne 'FAIL' -or $record.reason_code -cne 'elevated_runner_child_timeout' -or
   $record.mutation_performed -ne $null -or $record.mutation_telemetry_reason -cne 'worker_mutation_telemetry_unavailable' -or
   $record.private_paths_persisted -ne $false -or $record.retry_authorization_consumed -ne $false -or
   $record.retry_consumption_marker_created -ne $false -or $record.receipt_source -cne 'elevated-runner-recovery'){exit 4}
if($raw -match 'PRIVATE_PROFILE|PRIVATE_LOCK|PRIVATE_CREDENTIAL|authorize exactly one'){exit 5}
$before=[IO.File]::ReadAllBytes($env:E1_EXISTING)
$second=Write-E1RecoveryReceiptIfNeeded 'elevated_runner_child_failure' $env:E1_EXISTING 'PRIVATE_PROFILE' 'PRIVATE_LOCK' 'PRIVATE_CREDENTIAL' $false $recovery
$after=[IO.File]::ReadAllBytes($env:E1_EXISTING)
if($second -or [Convert]::ToBase64String($before) -cne [Convert]::ToBase64String($after)){exit 6}
$empty=Write-E1RecoveryReceiptIfNeeded '' $env:E1_EMPTY '' '' '' $false $recovery
if($empty -or (Test-Path -LiteralPath $env:E1_EMPTY)){exit 7}
try { Write-E1RecoveryReceiptIfNeeded 'forged_reason' $env:E1_EMPTY '' '' '' $false $recovery; exit 8 }
catch { if($_.Exception.Message -cne 'recovery_reason_code_invalid'){exit 9} }
try { Write-E1RecoveryReceiptIfNeeded 'elevated_runner_child_timeout' 'outside.json' '' '' '' $false $recovery; exit 10 }
catch { if($_.Exception.Message -cne 'receipt_path_outside_scratch'){exit 11} }
exit 0
`;
      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8', timeout: 30_000,
        env: {
          ...process.env,
          E1_INSTALLER: file(unattendedInstallerPath),
          E1_MODULE: file(modulePath),
          E1_RECEIPT: receipt,
          E1_EXISTING: existing,
          E1_EMPTY: emptyReason,
        },
      });
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== 'win32')('validates and hashes retry custody from one locked byte snapshot with strict JSON types', () => {
    const fixture = mkdtempSync(resolve(tmpdir(), 'e1-retry-receipt-'));
    try {
      const receipt = resolve(fixture, 'prior.json');
      const valid = {
        schema: 1, verdict: 'FAIL', reason_code: 'vm_boot_key_injection_failed', start_count: 1,
        network_used: false, vm_state: 'Off', answer_media_deleted: true, host_cleanup_complete: true,
        guest_credential_preserved: true, retry_authorized: false, private_paths_persisted: false,
        mutation_performed: true, inference_sessions_consumed: 0, cleanup_failure_codes: [],
        guest_cached_answer_state: 'unknown',
      };
      const validBytes = JSON.stringify(valid);
      writeFileSync(receipt, validBytes);
      const expectedSha = createHash('sha256').update(validBytes).digest('hex');
      const script = String.raw`
$tokens=$null
$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($env:E1_INSTALLER,[ref]$tokens,[ref]$errors)
$wanted=@('Read-E1RetryReceiptIdentity')
$definitions=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -in $wanted},$true))
if($definitions.Count -ne 1){exit 2}
Import-Module $env:E1_MODULE -Force
. ([scriptblock]::Create(($definitions.Extent.Text -join [Environment]::NewLine)))
$identity=Read-E1RetryReceiptIdentity $env:E1_RECEIPT
if($identity.sha256 -cne $env:E1_EXPECTED_SHA){exit 3}
`;
      const run = () => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8', timeout: 30_000,
        env: { ...process.env, E1_INSTALLER: file(unattendedInstallerPath), E1_MODULE: file(modulePath), E1_RECEIPT: receipt, E1_EXPECTED_SHA: expectedSha },
      });
      const accepted = run();
      expect(accepted.status, `${accepted.stdout}${accepted.stderr}`).toBe(0);

      writeFileSync(receipt, JSON.stringify({ ...valid, network_used: 'false' }));
      const rejected = run();
      expect(rejected.status).not.toBe(0);
      expect(`${rejected.stdout}${rejected.stderr}`).toContain('prior_failure_receipt_invalid');
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== 'win32')('creates the retry-consumption marker once without overwrite', () => {
    const fixture = mkdtempSync(resolve(tmpdir(), 'e1-retry-marker-'));
    try {
      const marker = resolve(fixture, 'consumed.json');
      const script = String.raw`
$tokens=$null
$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($env:E1_INSTALLER,[ref]$tokens,[ref]$errors)
$definition=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Write-E1RetryMarkerAtomically'},$true))
. ([scriptblock]::Create($definition[0].Extent.Text))
Write-E1RetryMarkerAtomically $env:E1_MARKER ([ordered]@{ schema=1; attempt=2 })
try { Write-E1RetryMarkerAtomically $env:E1_MARKER ([ordered]@{ schema=1; attempt=3 }); exit 4 } catch {}
$saved=Get-Content -LiteralPath $env:E1_MARKER -Raw | ConvertFrom-Json
if($saved.attempt -ne 2){exit 5}
`;
      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8', timeout: 30_000,
        env: { ...process.env, E1_INSTALLER: file(unattendedInstallerPath), E1_MARKER: marker },
      });
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== 'win32')('requires retry custody to be strict, sanitized, and cryptographically bound', () => {
    const fixture = mkdtempSync(resolve(tmpdir(), 'e1-retry-custody-'));
    try {
      const custody = resolve(fixture, 'custody.json');
      const sha = 'a'.repeat(64);
      const valid = {
        schema: 1, verdict: 'PASS', reason_code: 'legacy_failure_custody_validated',
        generated_at_utc: '2026-09-11T00:00:00.000Z', profile_id: 'evidence1-windows-hyperv-e2e-v1',
        profile_sha256: sha, current_input_lock_sha256: sha, prior_input_lock_sha256: sha,
        created_inspection_receipt_sha256: sha,
        vm_id: '6e5848f5-37dd-4653-9f3d-df2871e6293a', guest_credential_sha256: sha,
        prior_failure_receipt_sha256: sha, runner_request_id: 'req-20260911-015801-9a80d6d3',
        runner_request_sha256: sha, runner_response_sha256: sha, runner_log_sha256: sha,
        attempt_number: 1, start_count: 1, vm_state: 'Off', vhd_partition_style: 'RAW',
        network_used: false, answer_media_deleted: true, retry_consumption_marker_absent: true,
        host_cleanup_complete: true, guest_credential_preserved: true,
        runner_queue_acl_hardened: true, runner_artifact_acls_hardened: true,
        authorization_value_copied_to_sidecar: false, raw_log_copied_to_sidecar: false,
        source_artifact_paths_copied_to_sidecar: false,
        vm_mutation_performed: false, custody_record_written: true,
        mutation_performed: true, inference_sessions_consumed: 0,
      };
      const script = String.raw`
$tokens=$null
$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($env:E1_INSTALLER,[ref]$tokens,[ref]$errors)
$definition=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Read-E1RetryCustodyIdentity'},$true))
if($definition.Count -ne 1){exit 2}
Import-Module $env:E1_MODULE -Force
$RequiredProfileId='evidence1-windows-hyperv-e2e-v1'
. ([scriptblock]::Create($definition[0].Extent.Text))
$null=Read-E1RetryCustodyIdentity $env:E1_CUSTODY
`;
      const run = () => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8', timeout: 30_000,
        env: { ...process.env, E1_INSTALLER: file(unattendedInstallerPath), E1_MODULE: file(modulePath), E1_CUSTODY: custody },
      });
      writeFileSync(custody, JSON.stringify(valid));
      const accepted = run();
      expect(accepted.status, `${accepted.stdout}${accepted.stderr}`).toBe(0);

      writeFileSync(custody, JSON.stringify({ ...valid, current_input_lock_sha256: 'b'.repeat(63) }));
      const badHash = run();
      expect(badHash.status).not.toBe(0);
      expect(`${badHash.stdout}${badHash.stderr}`).toContain('prior_failure_custody_invalid');

      writeFileSync(custody, JSON.stringify({ ...valid, raw_log_copied_to_sidecar: 'false' }));
      const badType = run();
      expect(badType.status).not.toBe(0);
      expect(`${badType.stdout}${badType.stderr}`).toContain('prior_failure_custody_invalid');
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== 'win32')('binds the legacy input lock to the pre-start InspectCreated receipt', () => {
    const fixture = mkdtempSync(resolve(tmpdir(), 'e1-created-inspection-'));
    try {
      const receipt = resolve(fixture, 'inspect.json');
      const sha = 'a'.repeat(64);
      const valid = {
        schema: 1, verdict: 'PASS', mode: 'InspectCreated', profile_id: 'evidence1-windows-hyperv-e2e-v1',
        profile_sha256: sha, input_lock_sha256: sha,
        vm_id: '6e5848f5-37dd-4653-9f3d-df2871e6293a', drift_fields: [],
        mutation_performed: false, inference_sessions_consumed: 0,
      };
      const script = String.raw`
$tokens=$null
$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($env:E1_CUSTODY_BUILDER,[ref]$tokens,[ref]$errors)
$definition=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Assert-E1CreatedInspectionReceipt'},$true))
if($definition.Count -ne 1){exit 2}
Import-Module $env:E1_MODULE -Force
$RequiredProfileId='evidence1-windows-hyperv-e2e-v1'
. ([scriptblock]::Create($definition[0].Extent.Text))
$receipt=Get-Content -LiteralPath $env:E1_RECEIPT -Raw | ConvertFrom-Json
$null=Assert-E1CreatedInspectionReceipt $receipt $env:E1_SHA $env:E1_SHA
`;
      const run = () => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8', timeout: 30_000,
        env: { ...process.env, E1_CUSTODY_BUILDER: file(retryCustodyPath), E1_MODULE: file(modulePath), E1_RECEIPT: receipt, E1_SHA: sha },
      });
      writeFileSync(receipt, JSON.stringify(valid));
      const accepted = run();
      expect(accepted.status, `${accepted.stdout}${accepted.stderr}`).toBe(0);
      writeFileSync(receipt, JSON.stringify({ ...valid, input_lock_sha256: 'b'.repeat(64) }));
      const rejected = run();
      expect(rejected.status).not.toBe(0);
      expect(`${rejected.stdout}${rejected.stderr}`).toContain('created_inspection_receipt_invalid');
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== 'win32')('hardens every runner queue directory and artifact ACL before accepting custody inputs', () => {
    const fixture = mkdtempSync(resolve(tmpdir(), 'e1-runner-acl-'));
    try {
      const child = resolve(fixture, 'done');
      const artifact = resolve(child, 'request.json');
      mkdirSync(child);
      writeFileSync(artifact, '{}');
      const script = String.raw`
$tokens=$null
$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($env:E1_CUSTODY_BUILDER,[ref]$tokens,[ref]$errors)
$wanted=@('Set-E1PrivateDirectoryAcl','Set-E1PrivateFileAcl','Assert-E1RunnerQueueAcl')
$definitions=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -in $wanted},$true))
if($definitions.Count -ne 3){exit 2}
. ([scriptblock]::Create(($definitions.Extent.Text -join [Environment]::NewLine)))
$broad=([Security.Principal.SecurityIdentifier]::new('S-1-5-11')).Translate([Security.Principal.NTAccount])
$directoryAcl=[IO.Directory]::GetAccessControl($env:E1_CHILD)
$directoryRule=[Security.AccessControl.FileSystemAccessRule]::new($broad,[Security.AccessControl.FileSystemRights]::Modify,[Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
$null=$directoryAcl.AddAccessRule($directoryRule)
[IO.Directory]::SetAccessControl($env:E1_CHILD,$directoryAcl)
try { Assert-E1RunnerQueueAcl $env:E1_CHILD; exit 3 } catch { if($_.Exception.Message -cne 'runner_queue_acl_invalid'){throw} }
Set-E1PrivateDirectoryAcl $env:E1_CHILD
Assert-E1RunnerQueueAcl $env:E1_CHILD
$fileAcl=[IO.File]::GetAccessControl($env:E1_ARTIFACT)
$fileRule=[Security.AccessControl.FileSystemAccessRule]::new($broad,[Security.AccessControl.FileSystemRights]::Modify,[Security.AccessControl.AccessControlType]::Allow)
$null=$fileAcl.AddAccessRule($fileRule)
[IO.File]::SetAccessControl($env:E1_ARTIFACT,$fileAcl)
try { Assert-E1RunnerQueueAcl $env:E1_ARTIFACT; exit 4 } catch { if($_.Exception.Message -cne 'runner_queue_acl_invalid'){throw} }
Set-E1PrivateFileAcl $env:E1_ARTIFACT
Assert-E1RunnerQueueAcl $env:E1_ARTIFACT
`;
      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8', timeout: 30_000,
        env: { ...process.env, E1_CUSTODY_BUILDER: file(retryCustodyPath), E1_CHILD: child, E1_ARTIFACT: artifact },
      });
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });

  it('keeps all provisioning artifacts versioned and discoverable', () => {
    for (const path of [profilePath, e2eProfilePath, schemaPath, approvedSchemaPath, modulePath, creatorPath, bootstrapPath, lockBuilderPath, checkpointPath, postOsPath, normalizerPath, unattendedInstallerPath, offlineApplyPath, offlineApplyWrapperPath, retryCustodyPath, provisioningReadmePath]) {
      expect(existsSync(file(path)), path).toBe(true);
    }
  });

  it('documents the product manual boundary and the separate offline E2E boundary', () => {
    const guide = read(provisioningReadmePath);
    expect(guide).toContain('formal manual boundary');
    expect(guide).toContain('The product profile remains manual');
    expect(guide).toContain('DPAPI');
    expect(guide).toContain('Recovery is bounded');
    expect(guide).toContain('authorize exactly one evidence1 e2e windows offline apply');
    expect(guide).toContain('It does not authorize a retry, replacement, respawn, network access, login, inference, or deletion.');
  });

  it('builds input locks without embedding credentials or executable instructions', () => {
    const builder = read(lockBuilderPath);
    expect(builder).toContain('profile_id = [string]$profile.profile_id');
    expect(builder).toContain('approved_manifest');
    expect(builder).toContain('Get-E1ProvisioningPlan');
    expect(builder).toContain('$tempLock = Join-Path ([IO.Path]::GetTempPath())');
    expect(builder).toContain('private_paths_persisted = $false');
    expect(builder).toContain("'approved_iso_image_identity_invalid'");
    expect(builder).toContain("'artifact_codex-cli_hash_mismatch'");
    expect(builder).toContain("'profile_identity_mismatch'");
    expect(builder).not.toMatch(/Invoke-Expression|Start-Process|login|auth\.json|token|password/i);
  });

  it('runs pinned DISM inspection without Start-Process exit-code ambiguity', () => {
    const creator = read(creatorPath);
    expect(creator).toContain('[Diagnostics.ProcessStartInfo]::new()');
    expect(creator).toContain('UseShellExecute = $false');
    expect(creator).toContain('CreateNoWindow = $true');
    expect(creator).not.toContain('Start-Process -FilePath $DismPath');
  });

  it.skipIf(process.platform !== 'win32')('parses the pinned English DISM image-info contract without inference', () => {
    const command = String.raw`
Import-Module $env:E1_MODULE -Force
$expected=[pscustomobject]@{index=6;name='Windows 11 Pro';edition='Windows 11 Pro';edition_id='Professional';architecture='x64';languages=@('en-GB');version='10.0.26200.8037';installation_type='Client'}
$text=@'
Deployment Image Servicing and Management tool
Version: 10.0.26100.8972

Details for image : X:\sources\install.wim

Index : 6
Name : Windows 11 Pro
Description : Windows 11 Pro
Size : 20,000,000,000 bytes
WIM Bootable : No
Architecture : x64
Hal : <undefined>
Version : 10.0.26200
ServicePack Build : 8037
ServicePack Level : 0
Edition : Professional
Installation : Client
ProductType : WinNT
ProductSuite : Terminal Server
System Root : WINDOWS
Languages :
        en-GB (Default)
The operation completed successfully.
'@
$actual=ConvertFrom-E1DismImageInfo $text $expected
if($actual.index -ne 6 -or $actual.version -cne '10.0.26200.8037' -or $actual.edition_id -cne 'Professional' -or ($actual.languages -join ',') -cne 'en-GB'){exit 4}
`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      encoding: 'utf8', timeout: 30_000, windowsHide: true,
      env: { ...process.env, E1_MODULE: file(modulePath) },
    });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  });

  it('preserves closed host-dependency reasons across provisioning stages', () => {
    const module = read(modulePath);
    expect(module).toContain('function Get-E1HostDependencyFailureCodes');
    for (const path of [bootstrapPath, checkpointPath, postOsPath, unattendedInstallerPath]) {
      expect(read(path), path).toContain('Get-E1HostDependencyFailureCodes');
    }
  });

  it('preserves the sealed-manifest identity reason in VM provisioning receipts', () => {
    const creator = read(creatorPath);
    expect(creator).toContain("'approved_manifest_sealed_identity_mismatch'");
  });

  it('makes bootstrap failure evidence closed and sanitized', () => {
    const bootstrap = read(bootstrapPath);
    expect(bootstrap).toContain("verdict = 'FAIL'");
    expect(bootstrap).toContain('reason_code = $reason');
    expect(bootstrap).toContain('private_paths_persisted = $false');
    expect(bootstrap).toContain('guest_windows_credential_value_persisted = $false');
    expect(bootstrap).not.toContain('Fail ([string]$_.Exception.Message)');
  });

  it('stages toolchain inputs with handler-compatible file extensions', () => {
    const bootstrap = read(bootstrapPath);
    expect(bootstrap).toContain("$stageExtension = if ($runtime.install_handler -ceq 'codex-single-exe') { '.exe' } else { '.zip' }");
    expect(bootstrap).toContain('$guestStage = "$($profile.guest.staging_root)\\$($runtime.id)$stageExtension"');
    expect(bootstrap).toContain('$stage = "$($Profile.guest.staging_root)\\$($runtime.id)$stageExtension"');
    expect(bootstrap).not.toContain('$($runtime.id).artifact');
  });

  it.skipIf(process.platform !== 'win32')('rejects a self-attested legacy lock without exposing source paths', () => {
    const fixture = mkdtempSync(resolve(tmpdir(), 'e1-provisioning-'));
    try {
      const make = (name, value) => {
        const path = resolve(fixture, name);
        writeFileSync(path, value);
        return { path, sha256: createHash('sha256').update(value).digest('hex'), bytes: Buffer.byteLength(value) };
      };
      const iso = make('windows.iso', 'fixture-iso');
      const ids = ['git', 'node', 'jdk', 'android-sdk', 'claude-code', 'codex-cli'];
      const artifacts = ids.map(id => ({ id, ...make(`${id}.artifact`, `fixture-${id}`) }));
      const lock = resolve(fixture, 'inputs.json');
      const receipt = resolve(fixture, 'receipt.json');
      writeFileSync(lock, JSON.stringify({ schema_version: 1, profile_id: 'evidence1-windows-hyperv-v1', iso, artifacts }));
      const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file(creatorPath), '-Mode', 'Validate', '-InputLockPath', lock, '-ReceiptPath', receipt], { encoding: 'utf8', timeout: 30_000 });
      const diagnostic = result.status === 0 ? '' : spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Import-Module $env:E1_MODULE -Force; try { Get-E1ProvisioningPlan $env:E1_PROFILE $env:E1_LOCK | Out-Null } catch { Write-Output $_.Exception.Message; exit 1 }'], {
        encoding: 'utf8', timeout: 30_000, env: { ...process.env, E1_MODULE: file(modulePath), E1_PROFILE: file(profilePath), E1_LOCK: lock },
      }).stdout;
      expect(result.status, `${result.stdout}${result.stderr}${diagnostic}`).not.toBe(0);
      const report = JSON.parse(readFileSync(receipt, 'utf8'));
      expect(report).toMatchObject({ verdict: 'FAIL', mode: 'Validate', mutation_performed: false, inference_sessions_consumed: 0 });
      expect(JSON.stringify(report)).not.toContain(fixture);
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== 'win32')('fails closed with a sanitized receipt on an input hash mismatch', () => {
    const fixture = mkdtempSync(resolve(tmpdir(), 'e1-provisioning-bad-'));
    try {
      const make = (name, value) => {
        const path = resolve(fixture, name);
        writeFileSync(path, value);
        return { path, sha256: createHash('sha256').update(value).digest('hex'), bytes: Buffer.byteLength(value) };
      };
      const iso = make('windows.iso', 'fixture-iso');
      iso.sha256 = '0'.repeat(64);
      const artifacts = ['git', 'node', 'jdk', 'android-sdk', 'claude-code', 'codex-cli'].map(id => ({ id, ...make(`${id}.artifact`, id) }));
      const lock = resolve(fixture, 'inputs.json');
      const receipt = resolve(fixture, 'receipt.json');
      writeFileSync(lock, JSON.stringify({ schema_version: 1, profile_id: 'evidence1-windows-hyperv-v1', iso, artifacts }));
      const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file(creatorPath), '-Mode', 'Validate', '-InputLockPath', lock, '-ReceiptPath', receipt], { encoding: 'utf8', timeout: 30_000 });
      expect(result.status).not.toBe(0);
      expect(JSON.parse(readFileSync(receipt, 'utf8'))).toMatchObject({ verdict: 'FAIL', reason_code: 'input_lock_missing_property', mutation_performed: false });
      expect(readFileSync(receipt, 'utf8')).not.toContain(fixture);
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== 'win32')('rejects a modified profile even when its public id is unchanged', () => {
    const fixture = mkdtempSync(resolve(tmpdir(), 'e1-provisioning-profile-'));
    try {
      const profile = JSON.parse(read(profilePath));
      profile.vm.processor_count = 2;
      const modifiedProfile = resolve(fixture, 'profile.json');
      const lock = resolve(fixture, 'inputs.json');
      const receipt = resolve(fixture, 'receipt.json');
      writeFileSync(modifiedProfile, JSON.stringify(profile));
      writeFileSync(lock, '{}');
      const result = spawnSync('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file(creatorPath),
        '-Mode', 'Validate', '-ProfilePath', modifiedProfile, '-InputLockPath', lock, '-ReceiptPath', receipt,
      ], { encoding: 'utf8', timeout: 30_000 });
      expect(result.status).not.toBe(0);
      expect(JSON.parse(readFileSync(receipt, 'utf8'))).toMatchObject({ verdict: 'FAIL', reason_code: 'profile_identity_mismatch' });
      expect(readFileSync(receipt, 'utf8')).not.toContain(fixture);
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== 'win32')('rejects an unapproved manifest outside the versioned approval root before writing a private lock', () => {
    const fixture = mkdtempSync(resolve(tmpdir(), 'e1-provisioning-lock-'));
    try {
      const make = name => {
        const path = resolve(fixture, name);
        writeFileSync(path, `fixture-${name}`);
        return path;
      };
      const output = resolve(fixture, 'input-lock.private.json');
      const receipt = resolve(fixture, 'receipt.json');
      const result = spawnSync('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file(lockBuilderPath),
        '-IsoPath', make('windows.iso'), '-GitArtifactPath', make('git.zip'),
        '-NodeArtifactPath', make('node.zip'), '-JdkArtifactPath', make('jdk.zip'),
        '-AndroidSdkArtifactPath', make('android-sdk.zip'),
        '-ClaudeArtifactPath', make('claude.zip'), '-CodexArtifactPath', make('codex.exe'),
        '-ApprovedManifestPath', make('manifest.json'),
        '-OutputPath', output, '-ReceiptPath', receipt,
      ], { encoding: 'utf8', timeout: 30_000 });
      expect(result.status).not.toBe(0);
      expect(existsSync(output)).toBe(false);
      const publicReceipt = readFileSync(receipt, 'utf8');
      expect(JSON.parse(publicReceipt)).toMatchObject({ verdict: 'FAIL', reason_code: 'approved_manifest_path_invalid', private_paths_persisted: false, inference_sessions_consumed: 0 });
      expect(publicReceipt).not.toContain(fixture);
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== 'win32' || installedCodexVersion !== 'codex-cli 0.153.4')('observes the exact installed Codex version and official Authenticode publisher', () => {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', [
      '$m=Join-Path $env:WINDIR "System32\\WindowsPowerShell\\v1.0\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1"',
      'Import-Module $m -Force',
      '$s=Get-AuthenticodeSignature -LiteralPath $env:E1_CODEX',
      '@{status=[string]$s.Status;subject=[string]$s.SignerCertificate.Subject;version=(& $env:E1_CODEX --version)}|ConvertTo-Json -Compress',
    ].join(';')], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, E1_CODEX: installedCodexPath } });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      status: 'Valid',
      subject: 'CN="OpenAI OpCo, LLC", O="OpenAI OpCo, LLC", L=San Francisco, S=California, C=US',
      version: 'codex-cli 0.153.4',
    });
  });

  it.skipIf(process.platform !== 'win32' || isRepoUnderTempRoot)('fails bootstrap before elevation when a sensitive host path is out of bounds', () => {
    const fixture = mkdtempSync(resolve(tmpdir(), 'e1-provisioning-bootstrap-'));
    try {
      const receipt = resolve(fixture, 'receipt.json');
      const result = spawnSync('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file(bootstrapPath),
        '-Mode', 'Verify', '-InputLockPath', resolve(fixture, 'missing.json'),
        '-GuestCredentialPath', file('package.json'), '-ReceiptPath', receipt,
      ], { encoding: 'utf8', timeout: 30_000 });
      expect(result.status).not.toBe(0);
      expect(JSON.parse(readFileSync(receipt, 'utf8'))).toMatchObject({
        verdict: 'FAIL', reason_code: 'guest_credential_path_outside_scratch',
        private_paths_persisted: false, guest_windows_credential_value_persisted: false,
      });
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== 'win32')('requires the exact checkpoint authorization before elevation or VM access', () => {
    const fixture = mkdtempSync(resolve(tmpdir(), 'e1-provisioning-checkpoint-'));
    try {
      const toolchainReceipt = resolve(fixture, 'toolchain.json');
      const receipt = resolve(fixture, 'receipt.json');
      writeFileSync(toolchainReceipt, '{}');
      const result = spawnSync('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file(checkpointPath),
        '-InputLockPath', resolve(fixture, 'missing-input-lock.json'),
        '-ToolchainReceiptPath', toolchainReceipt, '-ReceiptPath', receipt,
      ], { encoding: 'utf8', timeout: 30_000 });
      expect(result.status).not.toBe(0);
      expect(JSON.parse(readFileSync(receipt, 'utf8'))).toMatchObject({
        verdict: 'FAIL', reason_code: 'exact_checkpoint_authorization_required', mutation_performed: false,
      });
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== 'win32')('requires a separate exact authorization before sealing the post-OS boundary', () => {
    const fixture = mkdtempSync(resolve(tmpdir(), 'e1-provisioning-post-os-'));
    try {
      const receipt = resolve(fixture, 'receipt.json');
      const credential = resolve(fixture, 'credential.clixml');
      writeFileSync(credential, 'not-a-credential');
      const result = spawnSync('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file(postOsPath), '-Mode', 'Seal',
        '-InputLockPath', resolve(fixture, 'missing.json'), '-GuestCredentialPath', credential, '-ReceiptPath', receipt,
      ], { encoding: 'utf8', timeout: 30_000 });
      expect(result.status).not.toBe(0);
      expect(JSON.parse(readFileSync(receipt, 'utf8'))).toMatchObject({
        verdict: 'FAIL', reason_code: 'exact_post_os_seal_authorization_required', mutation_performed: false,
      });
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== 'win32')('refuses to overwrite an existing public receipt', () => {
    const fixture = mkdtempSync(resolve(tmpdir(), 'e1-provisioning-receipt-'));
    try {
      const receipt = resolve(fixture, 'receipt.json');
      writeFileSync(receipt, 'original');
      const script = 'Import-Module $env:E1_MODULE -Force; try { New-E1ReceiptPath $env:E1_RECEIPT test | Out-Null; exit 0 } catch { Write-Output $_.Exception.Message; exit 7 }';
      const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
        encoding: 'utf8', timeout: 30_000, env: { ...process.env, E1_MODULE: file(modulePath), E1_RECEIPT: receipt },
      });
      expect(result.status).toBe(7);
      expect(result.stdout.trim()).toBe('receipt_already_exists');
      expect(readFileSync(receipt, 'utf8')).toBe('original');
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== 'win32')('accepts only a clean approved manifest bound to the current Git HEAD', () => {
    const fixture = mkdtempSync(resolve(tmpdir(), 'e1-approved-manifest-'));
    try {
      const provisionDir = resolve(fixture, 'tools/evidence1/provisioning');
      const approvedDir = resolve(provisionDir, 'approved-inputs');
      const inputDir = resolve(fixture, 'inputs');
      mkdirSync(approvedDir, { recursive: true });
      mkdirSync(inputDir, { recursive: true });
      for (const source of [modulePath, profilePath, e2eProfilePath]) {
        writeFileSync(resolve(provisionDir, source.split('/').at(-1)), read(source));
      }
      const profile = JSON.parse(read(profilePath));
      const identity = value => ({ sha256: createHash('sha256').update(value).digest('hex'), bytes: Buffer.byteLength(value) });
      const isoValue = 'fixture-iso';
      const isoPath = resolve(inputDir, 'windows.iso');
      writeFileSync(isoPath, isoValue);
      const artifacts = profile.toolchain.map(runtime => {
        const value = `fixture-${runtime.id}`;
        const path = resolve(inputDir, `${runtime.id}.artifact`);
        writeFileSync(path, value);
        const id = identity(value);
        return { runtime, path, id };
      });
      const manifestPath = resolve(approvedDir, 'fixture-approved-v1.json');
      const manifest = {
        schema_version: 1,
        approval_status: 'approved',
        manifest_id: 'fixture-approved-v1',
        profile_id: profile.profile_id,
        iso: {
          ...identity(isoValue), source_uri: 'https://example.invalid/windows.iso', publisher: 'Microsoft',
          image: { index: 6, name: 'Windows 11 Pro', edition: 'Windows 11 Pro', edition_id: 'Professional', architecture: 'x64', languages: ['en-US'], version: '10.0.26100.1', installation_type: 'Client' },
        },
        artifacts: artifacts.map(({ runtime, id }) => ({
          id: runtime.id, version: runtime.version, architecture: runtime.architecture, ...id,
          sources: [{ uri: `https://example.invalid/${runtime.id}`, digest_algorithm: 'sha256', digest: id.sha256, bytes: id.bytes }],
          publisher: 'fixture-publisher', verification: { kind: 'vendor-checksum', result: 'verified' },
        })),
      };
      writeFileSync(manifestPath, JSON.stringify(manifest));
      const git = (...args) => spawnSync('git.exe', args, { cwd: fixture, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Evidence1 test', GIT_AUTHOR_EMAIL: 'e1@example.invalid', GIT_COMMITTER_NAME: 'Evidence1 test', GIT_COMMITTER_EMAIL: 'e1@example.invalid' } });
      expect(git('init').status).toBe(0);
      expect(git('add', '.').status).toBe(0);
      expect(git('commit', '-m', 'test: fixture').status).toBe(0);
      const head = git('rev-parse', 'HEAD').stdout.trim();
      const relativeManifest = 'tools/evidence1/provisioning/approved-inputs/fixture-approved-v1.json';
      const blob = git('rev-parse', `HEAD:${relativeManifest}`).stdout.trim();
      const lockPath = resolve(inputDir, 'lock.json');
      writeFileSync(lockPath, JSON.stringify({
        schema_version: 2,
        profile_id: profile.profile_id,
        approved_manifest: { path: manifestPath, sha256: createHash('sha256').update(readFileSync(manifestPath)).digest('hex'), git_commit: head, blob_oid: blob },
        iso: { path: isoPath },
        artifacts: artifacts.map(({ runtime, path }) => ({ id: runtime.id, path })),
      }));
      const check = spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Import-Module $env:E1_MODULE -Force; $p=Get-E1ProvisioningPlan $env:E1_PROFILE $env:E1_LOCK; @{id=$p.approved_manifest.manifest_id;count=@($p.artifacts).Count}|ConvertTo-Json -Compress'], {
        encoding: 'utf8', timeout: 30_000, env: { ...process.env, E1_MODULE: resolve(provisionDir, 'Evidence1.Provisioning.psm1'), E1_PROFILE: resolve(provisionDir, 'evidence1-windows-hyperv-v1.json'), E1_LOCK: lockPath },
      });
      expect(check.status, `${check.stdout}${check.stderr}`).toBe(0);
      expect(JSON.parse(check.stdout)).toEqual({ count: 6, id: 'fixture-approved-v1' });
      writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
      const dirty = spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Import-Module $env:E1_MODULE -Force; try { Get-E1ProvisioningPlan $env:E1_PROFILE $env:E1_LOCK | Out-Null } catch { Write-Output $_.Exception.Message; exit 9 }'], {
        encoding: 'utf8', timeout: 30_000, env: { ...process.env, E1_MODULE: resolve(provisionDir, 'Evidence1.Provisioning.psm1'), E1_PROFILE: resolve(provisionDir, 'evidence1-windows-hyperv-v1.json'), E1_LOCK: lockPath },
      });
      expect(dirty.status).toBe(9);
      expect(dirty.stdout.trim()).toMatch(/approved_manifest_(hash_mismatch|not_head_tracked_clean)/);
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== 'win32').each(['powershell.exe', 'pwsh.exe'])(
    'accepts a sealed approved manifest only when deployment commit, blob, and hash match under %s',
    (shell) => {
      const fixture = mkdtempSync(resolve(tmpdir(), 'e1-sealed-approved-manifest-'));
      try {
        const deployment = resolve(fixture, 'deployment');
        const runtimeRoot = resolve(deployment, 'node-runtime');
        const provisionDir = resolve(runtimeRoot, 'tools/evidence1/provisioning');
        const approvedDir = resolve(provisionDir, 'approved-inputs');
        const inputDir = resolve(fixture, 'inputs');
        mkdirSync(approvedDir, { recursive: true });
        mkdirSync(inputDir, { recursive: true });
        writeFileSync(resolve(provisionDir, 'Evidence1.Provisioning.psm1'), read(modulePath));
        writeFileSync(resolve(provisionDir, 'evidence1-windows-hyperv-e2e-v1.json'), read(e2eProfilePath));
        const profile = JSON.parse(read(e2eProfilePath));
        const identity = value => ({ sha256: createHash('sha256').update(value).digest('hex'), bytes: Buffer.byteLength(value) });
        const isoValue = 'sealed-fixture-iso'; const isoPath = resolve(inputDir, 'windows.iso'); writeFileSync(isoPath, isoValue);
        const artifacts = profile.toolchain.map(runtime => {
          const value = `sealed-fixture-${runtime.id}`; const path = resolve(inputDir, `${runtime.id}.artifact`); writeFileSync(path, value);
          return { runtime, path, id: identity(value) };
        });
        const hostValue = 'sealed-fixture-windows-adk-dism';
        const hostPath = resolve(inputDir, 'windows-adk-dism.zip');
        writeFileSync(hostPath, hostValue);
        const hostIdentity = identity(hostValue);
        const manifestLeaf = 'fixture-sealed-approved-v2.json';
        const approvedPath = resolve(approvedDir, manifestLeaf);
        const approved = {
          schema_version: 2, approval_status: 'approved', manifest_id: 'fixture-sealed-approved-v2', profile_id: profile.profile_id,
          iso: { ...identity(isoValue), source_uri: 'https://example.invalid/windows.iso', publisher: 'Microsoft', image: { index: 6, name: 'Windows 11 Pro', edition: 'Windows 11 Pro', edition_id: 'Professional', architecture: 'x64', languages: ['en-GB'], version: '10.0.26100.1', installation_type: 'Client' } },
          artifacts: artifacts.map(({ runtime, id }) => ({ id: runtime.id, version: runtime.version, architecture: runtime.architecture, ...id, sources: [{ uri: `https://example.invalid/${runtime.id}`, digest_algorithm: 'sha256', digest: id.sha256, bytes: id.bytes }], publisher: 'fixture-publisher', verification: { kind: 'vendor-checksum', result: 'verified' } })),
          host_dependencies: [{
            ...profile.host_dependencies[0], archive_sha256: hostIdentity.sha256, archive_bytes: hostIdentity.bytes,
            executable_sha256: '1'.repeat(64), executable_bytes: 10,
            tree_identity_format: 'evidence1-path-size-sha256-v1', tree_sha256: '2'.repeat(64), tree_file_count: 7, tree_bytes: 70,
            sources: [
              { uri: 'https://example.invalid/adksetup.exe', digest_algorithm: 'sha256', digest: '3'.repeat(64), bytes: 10 },
              { uri: 'https://example.invalid/adk-update.zip', digest_algorithm: 'sha256', digest: '4'.repeat(64), bytes: 10 },
            ],
            publisher: 'CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US',
            verification: { kind: 'authenticode', result: 'verified' },
          }],
        };
        writeFileSync(approvedPath, JSON.stringify(approved));
        const sourceCommit = 'a'.repeat(40); const approvedBlob = 'b'.repeat(40);
        const nodeFiles = [
          'tools/evidence1/provisioning/Evidence1.Provisioning.psm1',
          'tools/evidence1/provisioning/evidence1-windows-hyperv-e2e-v1.json',
          `tools/evidence1/provisioning/approved-inputs/${manifestLeaf}`,
        ].map(name => ({ name, sha256: createHash('sha256').update(readFileSync(resolve(runtimeRoot, ...name.split('/')))).digest('hex'), blob_oid: name.endsWith(manifestLeaf) ? approvedBlob : 'c'.repeat(40) }));
        writeFileSync(resolve(deployment, 'evidence1-host-elevated-runner-manifest.json'), JSON.stringify({ schema: 2, kind: 'evidence1-host-elevated-runner-manifest', principal_sid: 'S-1-5-21-1-2-3-4', source_git_commit: sourceCommit, runner_sha256: 'd'.repeat(64), process_module_sha256: 'e'.repeat(64), scripts: [], support_files: [], node_files: nodeFiles }));
        const lockPath = resolve(inputDir, 'lock.json');
        const writeLock = gitCommit => writeFileSync(lockPath, JSON.stringify({ schema_version: 3, profile_id: profile.profile_id, approved_manifest: { path: `C:\\canonical\\tools\\evidence1\\provisioning\\approved-inputs\\${manifestLeaf}`, sha256: createHash('sha256').update(readFileSync(approvedPath)).digest('hex'), git_commit: gitCommit, blob_oid: approvedBlob }, iso: { path: isoPath }, artifacts: artifacts.map(({ runtime, path }) => ({ id: runtime.id, path })), host_dependencies: [{ id: 'windows-adk-dism', path: hostPath }] }));
        writeLock(sourceCommit);
        const env = { ...process.env, E1_MODULE: resolve(provisionDir, 'Evidence1.Provisioning.psm1'), E1_PROFILE: resolve(provisionDir, 'evidence1-windows-hyperv-e2e-v1.json'), E1_LOCK: lockPath };
        const accepted = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', 'Import-Module $env:E1_MODULE -Force; $p=Get-E1ProvisioningPlan $env:E1_PROFILE $env:E1_LOCK; @{id=$p.approved_manifest.manifest_id;count=@($p.artifacts).Count;host_count=@($p.host_dependencies).Count}|ConvertTo-Json -Compress'], { encoding: 'utf8', timeout: 30_000, env, windowsHide: true });
        expect(accepted.status, `${accepted.stdout}${accepted.stderr}`).toBe(0);
        expect(JSON.parse(accepted.stdout)).toEqual({ count: 6, host_count: 1, id: 'fixture-sealed-approved-v2' });
        writeLock('f'.repeat(40));
        const rejected = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', 'Import-Module $env:E1_MODULE -Force; try { Get-E1ProvisioningPlan $env:E1_PROFILE $env:E1_LOCK | Out-Null } catch { Write-Output $_.Exception.Message; exit 9 }'], { encoding: 'utf8', timeout: 30_000, env, windowsHide: true });
        expect(rejected.status).toBe(9);
        expect(rejected.stdout.trim()).toBe('approved_manifest_sealed_identity_mismatch');
        const recoveryAccepted = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', 'Import-Module $env:E1_MODULE -Force; $p=Get-E1ProvisioningPlan $env:E1_PROFILE $env:E1_LOCK -AllowSealedRuntimeCommitDrift; @{locked_commit=$p.approved_manifest.git_commit;runtime_commit=$p.approved_manifest.runtime_source_git_commit;drift=$p.approved_manifest.runtime_commit_drift_accepted}|ConvertTo-Json -Compress'], { encoding: 'utf8', timeout: 30_000, env, windowsHide: true });
        expect(recoveryAccepted.status, `${recoveryAccepted.stdout}${recoveryAccepted.stderr}`).toBe(0);
        expect(JSON.parse(recoveryAccepted.stdout)).toEqual({
          drift: true,
          locked_commit: 'f'.repeat(40),
          runtime_commit: sourceCommit,
        });
      } finally { rmSync(fixture, { recursive: true, force: true }); }
    },
    60_000,
  );

  it.skipIf(process.platform !== 'win32')('normalizes the same toolchain tree to byte-identical ZIPs', () => {
    const fixture = mkdtempSync(resolve(tmpdir(), 'e1-normalize-'));
    try {
      const source = resolve(fixture, 'node-root');
      mkdirSync(source);
      writeFileSync(resolve(source, 'node.exe'), 'node-binary');
      writeFileSync(resolve(source, 'npm.cmd'), '@echo npm');
      const upstream = resolve(fixture, 'upstream.zip');
      writeFileSync(upstream, 'upstream');
      const upstreamSha = createHash('sha256').update('upstream').digest('hex');
      const outputs = [1, 2].map(index => ({ zip: resolve(fixture, `node-${index}.zip`), receipt: resolve(fixture, `receipt-${index}.json`) }));
      for (const output of outputs) {
        const result = spawnSync('powershell.exe', [
          '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file(normalizerPath), '-RuntimeId', 'node',
          '-SourceRoot', source, '-UpstreamArtifactPath', upstream, '-ExpectedUpstreamSha256', upstreamSha,
          '-OutputPath', output.zip, '-ReceiptPath', output.receipt,
        ], { encoding: 'utf8', timeout: 30_000 });
        expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
        expect(JSON.parse(readFileSync(output.receipt, 'utf8'))).toMatchObject({ verdict: 'PASS', runtime_id: 'node', private_paths_persisted: false });
        expect(readFileSync(output.receipt, 'utf8')).not.toContain(fixture);
      }
      const hashes = outputs.map(output => createHash('sha256').update(readFileSync(output.zip)).digest('hex'));
      expect(hashes[0]).toBe(hashes[1]);
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== 'win32')('rejects a forged all-verified checkpoint receipt that is not bound to the VM and input lock', () => {
    const fixture = mkdtempSync(resolve(tmpdir(), 'e1-forged-receipt-'));
    try {
      const planPath = resolve(fixture, 'plan.json');
      const receiptPath = resolve(fixture, 'receipt.json');
      const runtime = { id: 'codex-cli', version: '0.153.4', install_handler: 'codex-single-exe' };
      writeFileSync(planPath, JSON.stringify({
        profile: { profile_id: 'evidence1-windows-hyperv-v1', checkpoint: { max_verify_age_seconds: 900 }, guest: { computer_name: 'Evidence1Runner', local_user: 'Evidence1' }, toolchain: [runtime] },
        artifacts: [{ id: 'codex-cli', sha256: '1'.repeat(64), bytes: 10 }],
      }));
      const now = new Date();
      writeFileSync(receiptPath, JSON.stringify({
        schema: 2, verdict: 'PASS', mode: 'Verify', profile_id: 'evidence1-windows-hyperv-v1',
        profile_sha256: '2'.repeat(64), input_lock_sha256: '3'.repeat(64), vm_id: '00000000-0000-0000-0000-000000000000',
        generated_at_utc: now.toISOString(), valid_until_utc: new Date(now.getTime() + 600_000).toISOString(),
        auth_material_copied: false, auth_material_read: false, network_used: false, changed: false, mutation_performed: false,
        guest_identity: { computer_name: 'Evidence1Runner', local_user: 'Evidence1', user_sid: 'S-1-5-21-1-2-3-4', administrator: true },
        environment: { deterministic_path: true, codex_home_bound: true, codex_home_empty: true, claude_config_dir_bound: true, claude_config_dir_empty: true, android_sdk_environment_bound: true, credential_environment_override_count: 0 },
        runtimes: [{ ...runtime, artifact_sha256: '1'.repeat(64), artifact_bytes: 10, installed_tree_sha256: '4'.repeat(64), installed_file_count: 1, installed_bytes: 10, verified: true, changed: false, help_verified: true, publisher_verified: true }],
      }));
      const script = 'Import-Module $env:E1_MODULE -Force; $p=Get-Content $env:E1_PLAN -Raw|ConvertFrom-Json; $r=Get-Content $env:E1_RECEIPT -Raw|ConvertFrom-Json; try { Assert-E1ToolchainVerifyReceipt $r $p ("a"*64) ("b"*64) "11111111-1111-1111-1111-111111111111" | Out-Null } catch { Write-Output $_.Exception.Message; exit 11 }';
      const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
        encoding: 'utf8', timeout: 30_000, env: { ...process.env, E1_MODULE: file(modulePath), E1_PLAN: planPath, E1_RECEIPT: receiptPath },
      });
      expect(result.status).toBe(11);
      expect(result.stdout.trim()).toBe('toolchain_receipt_binding_mismatch');
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });
});
