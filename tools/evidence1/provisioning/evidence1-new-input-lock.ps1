param(
  [Parameter(Mandatory = $true)] [string]$IsoPath,
  [Parameter(Mandatory = $true)] [string]$GitArtifactPath,
  [Parameter(Mandatory = $true)] [string]$NodeArtifactPath,
  [Parameter(Mandatory = $true)] [string]$JdkArtifactPath,
  [Parameter(Mandatory = $true)] [string]$AndroidSdkArtifactPath,
  [Parameter(Mandatory = $true)] [string]$ClaudeArtifactPath,
  [Parameter(Mandatory = $true)] [string]$CodexArtifactPath,
  [Parameter(Mandatory = $true)] [string]$ApprovedManifestPath,
  [string]$WindowsAdkDismArtifactPath = '',
  [string]$ProfilePath = '',
  [string]$OutputPath = 'C:\kmp-eval\scratch\evidence1-windows-provisioning\INPUT-LOCK.private.json',
  [string]$ReceiptPath = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Import-Module (Join-Path $scriptRoot 'Evidence1.Provisioning.psm1') -Force
if ([string]::IsNullOrWhiteSpace($ProfilePath)) { $ProfilePath = Join-Path $scriptRoot 'evidence1-windows-hyperv-v1.json' }

function New-PrivateArtifactPath([string]$Id, [string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "artifact_${Id}_missing" }
  return [ordered]@{ id = $Id; path = [IO.Path]::GetFullPath($Path) }
}

try {
  $scratchRoots = @('C:\kmp-eval\scratch', [IO.Path]::GetTempPath())
  $lockFull = Assert-E1PathInside $OutputPath $scratchRoots 'input_lock_path_outside_scratch'
  $receiptFull = New-E1ReceiptPath $ReceiptPath 'input-lock'
  if (Test-Path -LiteralPath $lockFull) { throw 'input_lock_already_exists' }
  if (-not (Test-Path -LiteralPath $IsoPath -PathType Leaf)) { throw 'iso_missing' }
  $isoFull = [IO.Path]::GetFullPath($IsoPath)
  $artifacts = @(
    New-PrivateArtifactPath 'git' $GitArtifactPath
    New-PrivateArtifactPath 'node' $NodeArtifactPath
    New-PrivateArtifactPath 'jdk' $JdkArtifactPath
    New-PrivateArtifactPath 'android-sdk' $AndroidSdkArtifactPath
    New-PrivateArtifactPath 'claude-code' $ClaudeArtifactPath
    New-PrivateArtifactPath 'codex-cli' $CodexArtifactPath
  )
  $profile = Read-E1CanonicalProfile $ProfilePath
  $profileHostDependencies = @()
  if ($profile.PSObject.Properties.Name -contains 'host_dependencies') {
    $profileHostDependencies = @($profile.host_dependencies)
  }
  $hostDependencies = @()
  if ($profileHostDependencies.Count -eq 0) {
    if (-not [string]::IsNullOrWhiteSpace($WindowsAdkDismArtifactPath)) { throw 'host_dependency_path_unexpected' }
  } else {
    if ($profileHostDependencies.Count -ne 1 -or [string]$profileHostDependencies[0].id -cne 'windows-adk-dism') {
      throw 'host_dependency_profile_invalid'
    }
    if ([string]::IsNullOrWhiteSpace($WindowsAdkDismArtifactPath)) { throw 'artifact_windows-adk-dism_missing' }
    $hostDependencies = @(New-PrivateArtifactPath 'windows-adk-dism' $WindowsAdkDismArtifactPath)
  }
  $manifestFull = Assert-E1PathInside $ApprovedManifestPath @((Join-Path $scriptRoot 'approved-inputs')) 'approved_manifest_path_invalid'
  if (-not (Test-Path -LiteralPath $manifestFull -PathType Leaf)) { throw 'approved_manifest_missing' }
  $git = Get-Command git.exe -ErrorAction SilentlyContinue
  if (-not $git) { $git = Get-Command git -ErrorAction SilentlyContinue }
  if (-not $git) { throw 'approved_manifest_git_unavailable' }
  $repoRootOutput = @(& $git.Source -C $scriptRoot rev-parse --show-toplevel 2>$null)
  $repoRootExit = $LASTEXITCODE
  if ($repoRootExit -ne 0 -or $repoRootOutput.Count -ne 1 -or [string]::IsNullOrWhiteSpace([string]$repoRootOutput[0])) { throw 'approved_manifest_git_unavailable' }
  $repoRoot = [IO.Path]::GetFullPath([string]$repoRootOutput[0])
  $relativeManifest = [IO.Path]::GetFullPath($manifestFull).Substring($repoRoot.TrimEnd('\').Length + 1).Replace('\','/')
  $headOutput = @(& $git.Source -C $repoRoot rev-parse HEAD 2>$null)
  $headExit = $LASTEXITCODE
  $blobOutput = @(& $git.Source -C $repoRoot rev-parse "HEAD:$relativeManifest" 2>$null)
  $blobExit = $LASTEXITCODE
  if ($headExit -ne 0 -or $blobExit -ne 0 -or $headOutput.Count -ne 1 -or $blobOutput.Count -ne 1) { throw 'approved_manifest_not_head_tracked_clean' }
  $head = [string]$headOutput[0]
  $blob = [string]$blobOutput[0]
  $lockSchemaVersion = if ($hostDependencies.Count -gt 0) { 3 } else { 2 }
  $lock = [ordered]@{
    schema_version = $lockSchemaVersion
    profile_id = [string]$profile.profile_id
    approved_manifest = [ordered]@{
      path = $manifestFull; sha256 = Get-E1Sha256 $manifestFull
      git_commit = [string]$head; blob_oid = [string]$blob
    }
    iso = [ordered]@{ path = $isoFull }
    artifacts = $artifacts
  }
  if ($lockSchemaVersion -eq 3) { $lock['host_dependencies'] = $hostDependencies }
  $tempLock = Join-Path ([IO.Path]::GetTempPath()) "evidence1-input-lock-$([guid]::NewGuid().ToString('N')).validation.tmp"
  try {
    [IO.File]::WriteAllText($tempLock, ($lock | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
    $plan = Get-E1ProvisioningPlan $ProfilePath $tempLock
  } finally {
    Remove-Item -LiteralPath $tempLock -Force -ErrorAction SilentlyContinue
  }
  $codexRuntime = @($profile.toolchain | Where-Object id -eq 'codex-cli')
  $codexArtifact = @($plan.artifacts | Where-Object id -eq 'codex-cli')
  if ($codexRuntime.Count -ne 1 -or $codexArtifact.Count -ne 1) { throw 'codex_contract_missing' }
  try {
    $securityModule = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1'
    Import-Module $securityModule -Force -ErrorAction Stop
    $signature = Get-AuthenticodeSignature -LiteralPath $codexArtifact[0].source_path -ErrorAction Stop
    if ([string]$signature.Status -cne 'Valid' -or -not $signature.SignerCertificate -or
        [string]$signature.SignerCertificate.Subject -cne [string]$codexRuntime[0].authenticode_subject) {
      throw 'codex_publisher_signature_invalid'
    }
    $prior = $ErrorActionPreference
    try {
      $ErrorActionPreference = 'Continue'
      $versionOutput = @(& $codexArtifact[0].source_path --version 2>&1)
      $versionExit = $LASTEXITCODE
      $helpOutput = @(& $codexArtifact[0].source_path --help 2>&1)
      $helpExit = $LASTEXITCODE
    } finally { $ErrorActionPreference = $prior }
    if ($versionExit -ne 0 -or ($versionOutput -join "`n").Trim() -notmatch $codexRuntime[0].version_pattern) {
      throw 'codex_version_mismatch'
    }
    if ($helpExit -ne 0 -or $helpOutput.Count -lt 1) { throw 'codex_help_probe_failed' }
  } catch {
    if ([string]$_.Exception.Message -cin @('codex_publisher_signature_invalid','codex_version_mismatch','codex_help_probe_failed')) { throw }
    throw 'codex_publisher_signature_invalid'
  }
  Write-E1ReceiptAtomically $lockFull $lock
  $hostDependencyReceipt = @($hostDependencies | ForEach-Object {
    $item = Get-Item -LiteralPath $_.path
    [ordered]@{ id = $_.id; sha256 = Get-E1Sha256 $_.path; bytes = [int64]$item.Length }
  })
  $receipt = [ordered]@{
    schema = $lockSchemaVersion
    verdict = 'PASS'
    profile_id = [string]$profile.profile_id
    profile_sha256 = Get-E1Sha256 $ProfilePath
    generated_at_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    approved_manifest = [ordered]@{
      manifest_id = [string]$plan.approved_manifest.manifest_id
      sha256 = [string]$plan.approved_manifest.sha256
      git_commit = [string]$plan.approved_manifest.git_commit
      blob_oid = [string]$plan.approved_manifest.blob_oid
    }
    iso = [ordered]@{ sha256 = $plan.iso.sha256; bytes = $plan.iso.bytes }
    artifacts = @($plan.artifacts | ForEach-Object { [ordered]@{ id = $_.id; sha256 = $_.sha256; bytes = $_.bytes } })
    input_lock_contains_private_paths = $true
    private_paths_persisted = $false
    codex_publisher_verified = $true
    codex_version_verified = $true
    codex_help_verified = $true
    inference_sessions_consumed = 0
  }
  if ($lockSchemaVersion -eq 3) { $receipt['host_dependencies'] = $hostDependencyReceipt }
  Write-E1ReceiptAtomically $receiptFull $receipt
  Write-Host "[evidence1-new-input-lock] PASS: $receiptFull"
} catch {
  $reason = Get-E1ClosedReason ([string]$_.Exception.Message) @(
    'input_lock_path_outside_scratch','input_lock_already_exists','receipt_path_outside_scratch','receipt_already_exists','iso_missing',
    'host_dependency_path_unexpected','host_dependency_profile_invalid','artifact_windows-adk-dism_missing',
    'profile_missing','profile_identity_mismatch','profile_contract_mismatch','input_lock_contract_mismatch',
    'approved_manifest_path_invalid','approved_manifest_missing','approved_manifest_git_unavailable',
    'approved_manifest_not_head_tracked_clean','approved_manifest_identity_invalid','approved_manifest_contract_mismatch',
    'approved_manifest_unknown_property','approved_manifest_missing_property',
    'approved_iso_unknown_property','approved_iso_missing_property','approved_iso_identity_invalid',
    'approved_iso_image_unknown_property','approved_iso_image_missing_property','approved_iso_image_identity_invalid',
    'iso_size_mismatch','iso_hash_mismatch','iso_identity_invalid','artifact_cardinality_mismatch','artifact_identity_mismatch','artifact_identity_invalid',
    'approved_artifact_unknown_property','approved_artifact_missing_property',
    'approved_artifact_cardinality_mismatch','approved_artifact_identity_mismatch',
    'approved_artifact_source_unknown_property','approved_artifact_source_missing_property',
    'approved_artifact_source_identity_invalid','approved_artifact_verification_unknown_property',
    'approved_artifact_verification_missing_property',
    'artifact_git_missing','artifact_git_size_mismatch','artifact_git_hash_mismatch',
    'artifact_node_missing','artifact_node_size_mismatch','artifact_node_hash_mismatch',
    'artifact_jdk_missing','artifact_jdk_size_mismatch','artifact_jdk_hash_mismatch',
    'artifact_android-sdk_missing','artifact_android-sdk_size_mismatch','artifact_android-sdk_hash_mismatch',
    'artifact_claude-code_missing','artifact_claude-code_size_mismatch','artifact_claude-code_hash_mismatch',
    'artifact_codex-cli_missing','artifact_codex-cli_size_mismatch','artifact_codex-cli_hash_mismatch','codex_contract_missing',
    'host_dependency_contract_mismatch','host_dependency_cardinality_mismatch','host_dependency_identity_mismatch',
    'profile_host_dependency_unknown_property','profile_host_dependency_missing_property',
    'host_dependency_lock_unknown_property','host_dependency_lock_missing_property',
    'approved_host_dependency_unknown_property','approved_host_dependency_missing_property',
    'approved_host_dependency_verification_unknown_property','approved_host_dependency_verification_missing_property',
    'approved_host_dependency_identity_mismatch','approved_host_dependency_source_unknown_property',
    'approved_host_dependency_source_missing_property','approved_host_dependency_source_identity_invalid',
    'host_dependency_archive_missing','host_dependency_archive_size_mismatch','host_dependency_archive_hash_mismatch',
    'codex_publisher_signature_invalid','codex_version_mismatch','codex_help_probe_failed'
  ) 'input_lock_creation_failed'
  try {
    $receiptFull = New-E1ReceiptPath $ReceiptPath 'input-lock-failed'
    Write-E1ReceiptAtomically $receiptFull ([ordered]@{
      schema = 1; verdict = 'FAIL'; reason_code = $reason
      generated_at_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
      private_paths_persisted = $false; inference_sessions_consumed = 0
    })
  } catch { }
  Write-Error "HARD STOP: $reason"
  exit 1
}
