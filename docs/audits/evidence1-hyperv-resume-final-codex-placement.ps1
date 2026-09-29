#Requires -RunAsAdministrator

param(
  [Parameter(Mandatory)][string]$BindingPath,
  [Parameter(Mandatory)][string]$BindingSha256,
  [Parameter(Mandatory)][string]$AuthorizationClaimPath,
  [Parameter(Mandatory)][string]$AuthorizationClaimSha256,
  [Parameter(Mandatory)][string]$GlobalAuthorizationClaimPath,
  [Parameter(Mandatory)][string]$GlobalAuthorizationClaimSha256,
  [Parameter(Mandatory)][string]$RemoteAuthCanaryPath,
  [Parameter(Mandatory)][string]$RemoteAuthCanarySha256,
  [Parameter(Mandatory)][string]$CanonicalRepositoryRoot,
  [Parameter(Mandatory)][string]$ReportPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'evidence1-final-codex-host-contract.psm1') -Force -DisableNameChecking

function Assert-ExactKeys($Value, [string[]]$Expected, [string]$Code) {
  $actual = @($Value.PSObject.Properties.Name | Sort-Object)
  if (@(Compare-Object $actual @($Expected | Sort-Object)).Count -ne 0) { throw $Code }
}

function Assert-Hash([string]$Path, [string]$Expected, [string]$Code) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf) -or
      (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Expected) {
    throw $Code
  }
}

$bindingRoot = [IO.Path]::GetFullPath((Split-Path -Parent $BindingPath)).TrimEnd('\')
$canonicalGlobalRoot = 'C:\kmp-eval\scratch\evidence1-final-codex-authorization-claims'
if (-not ([IO.Path]::GetFullPath($AuthorizationClaimPath)).Equals((Join-Path $bindingRoot 'authorization.claim.json'), [StringComparison]::OrdinalIgnoreCase) -or
    -not ([IO.Path]::GetFullPath($RemoteAuthCanaryPath)).Equals((Join-Path $bindingRoot 'remote-auth-canary.json'), [StringComparison]::OrdinalIgnoreCase) -or
    -not ([IO.Path]::GetFullPath((Split-Path -Parent $GlobalAuthorizationClaimPath))).TrimEnd('\').Equals($canonicalGlobalRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'final_campaign_input_path_binding_invalid'
}
foreach ($path in @($BindingPath, $AuthorizationClaimPath, $GlobalAuthorizationClaimPath, $RemoteAuthCanaryPath)) {
  Assert-E1FinalNoReparseAncestors $path
}
Assert-Hash $BindingPath $BindingSha256 'binding_hash_mismatch'
Assert-Hash $AuthorizationClaimPath $AuthorizationClaimSha256 'binding_hash_mismatch'
Assert-Hash $GlobalAuthorizationClaimPath $GlobalAuthorizationClaimSha256 'binding_hash_mismatch'
Assert-Hash $RemoteAuthCanaryPath $RemoteAuthCanarySha256 'binding_hash_mismatch'

$binding = Get-Content -LiteralPath $BindingPath -Raw | ConvertFrom-Json
$repositoryRoot = Assert-E1FinalCanonicalRepository $CanonicalRepositoryRoot $binding.harness_commit $binding.harness_tree
$claim = Get-Content -LiteralPath $AuthorizationClaimPath -Raw | ConvertFrom-Json
$globalClaim = Get-Content -LiteralPath $GlobalAuthorizationClaimPath -Raw | ConvertFrom-Json
if ($binding.runtime_id -cne 'codex-cli' -or $binding.cli_version -cne '0.154.0' -or
    $binding.model_requested -cne 'gpt-5.6-terra' -or $binding.model_resolved -cne 'gpt-5.6-terra' -or
    [int]$binding.authorized_sessions -ne 6 -or $binding.harness_tree -cnotmatch '^[0-9a-f]{40}$' -or
    $binding.remote_auth_sha256 -cne $RemoteAuthCanarySha256 -or
    $binding.global_authorization_claim_sha256 -cne $GlobalAuthorizationClaimSha256) { throw 'binding_contract_invalid' }
if ($claim.binding_sha256 -cne $BindingSha256 -or
    $claim.global_authorization_claim_sha256 -cne $GlobalAuthorizationClaimSha256 -or
    [int]$claim.retry_count -ne 0 -or $claim.replacement_authorized -ne $false -or $claim.respawn_authorized -ne $false) {
  throw 'authorization_claim_contract_invalid'
}
if ($globalClaim.remote_auth_sha256 -cne $RemoteAuthCanarySha256 -or
    $globalClaim.readiness_sha256 -cne $binding.readiness_sha256 -or
    [string]$globalClaim.vm_name -cne [string]$binding.vm_name -or
    ([string]$globalClaim.vm_id).ToLowerInvariant() -cne ([string]$binding.vm_id).ToLowerInvariant() -or
    [int]$globalClaim.authorized_sessions -ne 6 -or
    $globalClaim.authorization_scope -cne 'exactly-six-codex-sessions' -or
    [int]$globalClaim.retry_count -ne 0 -or $globalClaim.replacement_authorized -ne $false -or $globalClaim.respawn_authorized -ne $false) {
  throw 'global_authorization_claim_contract_invalid'
}

$vm = Get-VM -Name ([string]$binding.vm_name) -ErrorAction Stop
if (([string]$vm.Id).ToLowerInvariant() -cne ([string]$binding.vm_id).ToLowerInvariant() -or $vm.State -ne 'Off') {
  throw 'exact_e2e_vm_must_be_off'
}

$scriptMap = [ordered]@{
  launcher = 'docs/audits/evidence1-codex-live-launch.ps1'
  wrapper = 'docs/audits/evidence1-final-codex-guest-wrapper.ps1'
  validation_helper = 'docs/audits/evidence1-validation-ops.psm1'
  campaign_control = 'tools/agentic-eval/final-campaign-control.mjs'
  pilot_describe = 'docs/audits/evidence1-codex-pilot-describe.mjs'
  publication_scan = 'docs/audits/evidence1-codex-publication-scan.mjs'
}
if (@($binding.script_sha256.PSObject.Properties.Name).Count -ne 6) { throw 'bound_script_map_invalid' }
foreach ($name in $scriptMap.Keys) {
  if (-not ($binding.script_sha256.PSObject.Properties.Name -ccontains $name)) { throw 'bound_script_map_invalid' }
  Assert-Hash (Join-Path $repositoryRoot $scriptMap[$name]) $binding.script_sha256.$name 'bound_script_hash_mismatch'
}

$snapshotManifestPath = Join-Path $PSScriptRoot 'evidence1-host-elevated-runner-manifest.json'
$snapshotNodeRoot = Join-Path $PSScriptRoot 'node-runtime'
Assert-E1FinalNoReparseAncestors $snapshotManifestPath
$snapshotManifest = Get-Content -LiteralPath $snapshotManifestPath -Raw | ConvertFrom-Json
$snapshotManifestSha256 = (Get-FileHash -LiteralPath $snapshotManifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
$null = Assert-E1FinalRunnerManifest $snapshotManifest $binding.harness_commit
$snapshotNodeMap = Assert-E1FinalNodeSnapshotBinding $snapshotManifest $snapshotNodeRoot $repositoryRoot
foreach ($pair in @(
    @('docs/audits/evidence1-codex-pilot-describe.mjs', 'pilot_describe'),
    @('docs/audits/evidence1-codex-publication-scan.mjs', 'publication_scan'))) {
  if (-not $snapshotNodeMap.ContainsKey($pair[0]) -or $snapshotNodeMap[$pair[0]] -cne $binding.script_sha256.($pair[1])) {
    throw 'snapshot_bound_node_hash_mismatch'
  }
}

$reportRoot = 'C:\kmp-eval\scratch\evidence1-final-codex-place'
$expectedReport = Join-Path $reportRoot ($binding.campaign_id + '.json')
if (-not ([IO.Path]::GetFullPath($ReportPath).Equals($expectedReport, [StringComparison]::OrdinalIgnoreCase))) {
  throw 'final_report_path_not_canonical_scratch'
}
if (Test-Path -LiteralPath $ReportPath) { throw 'final_operation_report_already_exists' }
$reservationPath = $ReportPath + '.claim.json'
Assert-E1FinalNoReparseAncestors $reservationPath
if (-not (Test-Path -LiteralPath $reservationPath -PathType Leaf)) { throw 'placement_reservation_missing' }
$reservation = Get-Content -LiteralPath $reservationPath -Raw | ConvertFrom-Json
Assert-ExactKeys $reservation @('schema','kind','campaign_id','report_path_sha256','prerequisites','reserved_at_utc') 'placement_reservation_invalid'
Assert-ExactKeys $reservation.prerequisites @('binding_sha256','global_authorization_claim_sha256','remote_auth_sha256','script_sha256') 'placement_reservation_invalid'
if ([int]$reservation.schema -ne 1 -or $reservation.kind -cne 'evidence1-final-codex-place-reservation' -or
    $reservation.campaign_id -cne $binding.campaign_id -or
    $reservation.report_path_sha256 -cne (Get-E1TextSha256 ([IO.Path]::GetFullPath($ReportPath))) -or
    $reservation.prerequisites.binding_sha256 -cne $BindingSha256 -or
    $reservation.prerequisites.global_authorization_claim_sha256 -cne $GlobalAuthorizationClaimSha256 -or
    $reservation.prerequisites.remote_auth_sha256 -cne $RemoteAuthCanarySha256) { throw 'placement_reservation_invalid' }
foreach ($name in $scriptMap.Keys) {
  if ($reservation.prerequisites.script_sha256.$name -cne $binding.script_sha256.$name) { throw 'placement_reservation_invalid' }
}

$disk = (Get-VMHardDiskDrive -VMName $vm.Name | Select-Object -First 1).Path
if (-not $disk.StartsWith('C:\kmp-eval\hyperv-e2e\', [StringComparison]::OrdinalIgnoreCase)) { throw 'vhd_scope_invalid' }
$mount = $null
try {
  $mount = Mount-VHD -Path $disk -Passthru
  $root = Get-E1FinalMountedWindowsRoot $mount
  $runId = [string]$binding.campaign_id
  $runDir = Join-Path $root "Evidence1Ops\final-codex\$runId"
  $runtimeDir = Join-Path $root "ProgramData\KmpEval\Evidence1FinalCodexRuntime\$runId"
  Assert-E1FinalNoReparseAncestors $runDir
  Assert-E1FinalNoReparseAncestors $runtimeDir
  if (-not (Test-Path -LiteralPath $runDir -PathType Container) -or
      -not (Test-Path -LiteralPath $runtimeDir -PathType Container)) { throw 'partial_placement_state_missing' }

  $expectedBlobs = [ordered]@{
    'binding.json' = $BindingSha256
    'authorization.claim.json' = $AuthorizationClaimSha256
    'global.authorization.claim.json' = $GlobalAuthorizationClaimSha256
    'remote-auth-canary.json' = $RemoteAuthCanarySha256
  }
  $actualRunFiles = @(Get-ChildItem -LiteralPath $runDir -File -Force | Select-Object -ExpandProperty Name | Sort-Object)
  if (@(Get-ChildItem -LiteralPath $runDir -Directory -Force).Count -ne 0 -or
      @(Compare-Object $actualRunFiles @($expectedBlobs.Keys | Sort-Object)).Count -ne 0) { throw 'partial_run_closed_set_invalid' }
  foreach ($entry in $expectedBlobs.GetEnumerator()) { Assert-Hash (Join-Path $runDir $entry.Key) $entry.Value 'staged_blob_hash_mismatch' }

  foreach ($name in @('launcher','wrapper','validation_helper')) {
    $leaf = Split-Path -Leaf $scriptMap[$name]
    Assert-Hash (Join-Path $runtimeDir $leaf) $binding.script_sha256.$name 'protected_guest_script_hash_mismatch'
  }
  Assert-Hash (Join-Path $runtimeDir 'node-runtime.manifest.json') $snapshotManifestSha256 'protected_guest_node_manifest_hash_mismatch'
  $guestNodeRoot = Join-Path $runtimeDir 'node-runtime'
  $expectedFiles = @{}
  $expectedDirs = @{}
  foreach ($entry in @($snapshotManifest.node_files)) {
    $relative = [string]$entry.name
    $path = Join-Path $guestNodeRoot $relative.Replace('/','\')
    Assert-E1FinalNoReparseAncestors $path
    Assert-Hash $path ([string]$entry.sha256) 'protected_guest_node_hash_mismatch'
    $expectedFiles[$relative] = $true
    $parent = Split-Path -Parent $relative.Replace('/','\')
    while ($parent) {
      $expectedDirs[$parent.Replace('\','/')] = $true
      $next = Split-Path -Parent $parent
      if ($next -ceq $parent) { break }
      $parent = $next
    }
  }
  $actualFiles = @(Get-ChildItem -LiteralPath $guestNodeRoot -File -Force -Recurse | ForEach-Object { $_.FullName.Substring($guestNodeRoot.Length + 1).Replace('\','/') } | Sort-Object)
  $actualDirs = @(Get-ChildItem -LiteralPath $guestNodeRoot -Directory -Force -Recurse | ForEach-Object {
      if (($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'staged_node_reparse_rejected' }
      $_.FullName.Substring($guestNodeRoot.Length + 1).Replace('\','/')
    } | Sort-Object)
  if (@(Compare-Object $actualFiles @($expectedFiles.Keys | Sort-Object)).Count -ne 0 -or
      @(Compare-Object $actualDirs @($expectedDirs.Keys | Sort-Object)).Count -ne 0) { throw 'staged_node_closed_set_invalid' }
  $topExpected = @('evidence1-codex-live-launch.ps1','evidence1-final-codex-guest-wrapper.ps1','evidence1-validation-ops.psm1','node-runtime.manifest.json')
  $topActual = @(Get-ChildItem -LiteralPath $runtimeDir -File -Force | Select-Object -ExpandProperty Name | Sort-Object)
  $dirActual = @(Get-ChildItem -LiteralPath $runtimeDir -Directory -Force | Select-Object -ExpandProperty Name | Sort-Object)
  if (@(Compare-Object $topActual @($topExpected | Sort-Object)).Count -ne 0 -or
      @(Compare-Object $dirActual @('node-runtime')).Count -ne 0) { throw 'partial_runtime_closed_set_invalid' }
  foreach ($directory in @((Get-Item -LiteralPath $runtimeDir -Force)) + @(Get-ChildItem -LiteralPath $runtimeDir -Directory -Force -Recurse)) {
    Assert-E1FinalGuestRuntimeAcl $directory.FullName $true
  }
  foreach ($file in @(Get-ChildItem -LiteralPath $runtimeDir -File -Force -Recurse)) {
    Assert-E1FinalGuestRuntimeAcl $file.FullName $false
  }

  $guestControl = Join-Path $root 'kmp-eval\agentic-eval-codex-runtime\tools\agentic-eval\final-campaign-control.mjs'
  Assert-Hash $guestControl $binding.script_sha256.campaign_control 'guest_campaign_control_hash_mismatch'
  $startup = Join-Path $root 'Users\Evidence1E2E\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\Evidence1FinalCodex.vbs'
  if (Test-Path -LiteralPath $startup) { throw 'existing_final_campaign_no_replacement' }
  $startupText = "Set fso = CreateObject(`"Scripting.FileSystemObject`")`r`nself = WScript.ScriptFullName`r`nfso.DeleteFile self, True`r`nIf fso.FileExists(self) Then WScript.Quit 91`r`nCreateObject(`"WScript.Shell`").Run `"powershell.exe -WindowStyle Hidden -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\ProgramData\KmpEval\Evidence1FinalCodexRuntime\$runId\evidence1-final-codex-guest-wrapper.ps1 -RunId $runId -BindingPath C:\Evidence1Ops\final-codex\$runId\binding.json -BindingSha256 $BindingSha256 -AuthorizationClaimPath C:\Evidence1Ops\final-codex\$runId\authorization.claim.json -AuthorizationClaimSha256 $AuthorizationClaimSha256 -GlobalAuthorizationClaimPath C:\Evidence1Ops\final-codex\$runId\global.authorization.claim.json -GlobalAuthorizationClaimSha256 $GlobalAuthorizationClaimSha256 -RemoteAuthCanaryPath C:\Evidence1Ops\final-codex\$runId\remote-auth-canary.json -RemoteAuthCanarySha256 $RemoteAuthCanarySha256 -NodeRuntimeManifestPath C:\ProgramData\KmpEval\Evidence1FinalCodexRuntime\$runId\node-runtime.manifest.json -NodeRuntimeManifestSha256 $snapshotManifestSha256`", 0, False`r`n"
  $startupBytes = [Text.Encoding]::ASCII.GetBytes($startupText)
  $startupStream = [IO.File]::Open($startup, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
  try { $startupStream.Write($startupBytes, 0, $startupBytes.Length); $startupStream.Flush($true) } finally { $startupStream.Dispose() }

  $reportValue = [ordered]@{
    schema = 1; kind = 'evidence1-final-codex-placement-report'; verdict = 'PASS'; campaign_id = $runId
    vm_name = $vm.Name; vm_id = ([string]$vm.Id).ToLowerInvariant(); binding_sha256 = $BindingSha256
    authorization_claim_sha256 = $AuthorizationClaimSha256; global_authorization_claim_sha256 = $GlobalAuthorizationClaimSha256
    remote_auth_blob_sha256 = $RemoteAuthCanarySha256; node_runtime_manifest_sha256 = $snapshotManifestSha256
    script_sha256 = $binding.script_sha256; startup_create_new = $true; window_style = 'hidden'
    retry_count = 0; replacement_authorized = $false; respawn_authorized = $false; resumed_from_exact_partial_state = $true
  }
  $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($reportValue | ConvertTo-Json -Depth 10) + "`n")
  $stream = [IO.File]::Open($ReportPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
  try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
  Write-Host "[evidence1-final-codex-resume-placement] PASS: $ReportPath"
} finally {
  if ($mount) { Dismount-VHD -Path $disk -ErrorAction SilentlyContinue }
}
