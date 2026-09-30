#Requires -RunAsAdministrator

param(
  [Parameter(Mandatory)][string]$BindingPath,
  [Parameter(Mandatory)][string]$BindingSha256,
  [Parameter(Mandatory)][string]$PlacementReportPath,
  [Parameter(Mandatory)][string]$PlacementReportSha256,
  [Parameter(Mandatory)][string]$GlobalAuthorizationClaimPath,
  [Parameter(Mandatory)][string]$GlobalAuthorizationClaimSha256,
  [ValidateSet(
    'host_power_loss_before_guest_execution_boundary',
    'guest_interactive_logon_never_observed_before_guest_execution_boundary'
  )][string]$FailureReasonCode = 'host_power_loss_before_guest_execution_boundary',
  [Parameter(Mandatory)][string]$ReportPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'evidence1-final-codex-host-contract.psm1') -Force -DisableNameChecking

function Assert-Hash([string]$Path, [string]$Expected, [string]$Code) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf) -or
      (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Expected) { throw $Code }
}

Assert-Hash $BindingPath $BindingSha256 'binding_hash_mismatch'
Assert-Hash $PlacementReportPath $PlacementReportSha256 'placement_report_hash_mismatch'
Assert-Hash $GlobalAuthorizationClaimPath $GlobalAuthorizationClaimSha256 'global_authorization_claim_hash_mismatch'
$binding = Get-Content -LiteralPath $BindingPath -Raw | ConvertFrom-Json
$placement = Get-Content -LiteralPath $PlacementReportPath -Raw | ConvertFrom-Json
$global = Get-Content -LiteralPath $GlobalAuthorizationClaimPath -Raw | ConvertFrom-Json
$campaignId = [string]$binding.campaign_id
if ($campaignId -cnotmatch '^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$' -or
    $placement.campaign_id -cne $campaignId -or $placement.verdict -cne 'PASS' -or
    $placement.binding_sha256 -cne $BindingSha256 -or
    $binding.global_authorization_claim_sha256 -cne $GlobalAuthorizationClaimSha256 -or
    $global.remote_auth_sha256 -cne $binding.remote_auth_sha256 -or
    [int]$binding.authorized_sessions -ne 6) { throw 'retire_identity_chain_invalid' }

$expectedGlobalRoot = [IO.Path]::GetFullPath('C:\kmp-eval\scratch\evidence1-final-codex-authorization-claims').TrimEnd('\')
if (-not ([IO.Path]::GetFullPath((Split-Path -Parent $GlobalAuthorizationClaimPath))).TrimEnd('\').Equals($expectedGlobalRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'global_claim_path_not_canonical'
}
$reportRoot = 'C:\kmp-eval\scratch\evidence1-final-codex-abandoned'
$expectedReport = Join-Path $reportRoot ($campaignId + '.unexecuted.json')
if (-not ([IO.Path]::GetFullPath($ReportPath).Equals($expectedReport, [StringComparison]::OrdinalIgnoreCase))) { throw 'retire_report_path_not_canonical' }
if (Test-Path -LiteralPath $ReportPath) { throw 'retire_report_must_be_create_new' }

# The start reservation and start-terminal receipt are written by the Start script
# immediately after it validates everything and calls Start-VM. Their presence proves
# the campaign crossed the start boundary (unlike the never-reserved "unstarted" case).
# This retirement covers every known cause of "started but the guest never ran
# anything" -- a host power loss and a guest that boots but never completes an
# interactive logon look identical from the host's evidence, so FailureReasonCode
# records which one actually happened without duplicating this script per cause.
$requiredHostStartPaths = @(
  "C:\kmp-eval\scratch\evidence1-final-codex-start\$campaignId.reserved.json",
  "C:\kmp-eval\scratch\evidence1-final-codex-start\$campaignId.terminal.json"
)
foreach ($path in $requiredHostStartPaths) { if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'expected_host_start_evidence_missing' } }

# The copy pipeline only ever runs after a campaign completes inside the guest. Its
# presence would mean the guest did execute and finish, which contradicts this
# retirement's whole premise -- so it must be completely absent.
$forbiddenHostCopyPaths = @(
  "C:\kmp-eval\scratch\evidence1-final-codex-copy-reports\$campaignId.reserved.json",
  "C:\kmp-eval\scratch\evidence1-final-codex-copy-reports\$campaignId.terminal.json",
  "C:\kmp-eval\scratch\evidence1-final-codex-copy-journals\$campaignId",
  "C:\kmp-eval\scratch\evidence1-final-codex-private\$campaignId",
  "C:\kmp-eval\agentic-eval-codex-runtime\tools\runs\evidence1-codex-pilot-$campaignId"
)
foreach ($path in $forbiddenHostCopyPaths) { if (Test-Path -LiteralPath $path) { throw 'campaign_copy_evidence_exists' } }

$vm = Get-VM -Name ([string]$binding.vm_name) -ErrorAction Stop
if (([string]$vm.Id).ToLowerInvariant() -cne ([string]$binding.vm_id).ToLowerInvariant() -or $vm.State -ne 'Off') { throw 'exact_e2e_vm_must_be_off' }
$disk = (Get-VMHardDiskDrive -VMName $vm.Name | Select-Object -First 1).Path
if (-not $disk.StartsWith('C:\kmp-eval\hyperv-e2e\', [StringComparison]::OrdinalIgnoreCase)) { throw 'vhd_scope_invalid' }

$mount = $null
$guestArchive = $null
try {
  $mount = Mount-VHD -Path $disk -Passthru
  $root = Get-E1FinalMountedWindowsRoot $mount
  $startup = Join-Path $root 'Users\Evidence1E2E\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\Evidence1FinalCodex.vbs'
  $runDir = Join-Path $root "Evidence1Ops\final-codex\$campaignId"
  $runtimeDir = Join-Path $root "ProgramData\KmpEval\Evidence1FinalCodexRuntime\$campaignId"
  $archiveSuffix = "$campaignId-unexecuted"
  $runArchive = Join-Path (Split-Path -Parent $runDir) $archiveSuffix
  $runtimeArchive = Join-Path (Split-Path -Parent $runtimeDir) $archiveSuffix
  if ((Test-Path -LiteralPath $runArchive) -or (Test-Path -LiteralPath $runtimeArchive)) { throw 'guest_campaign_archive_already_exists' }
  foreach ($path in @($runDir, $runtimeDir)) { if (-not (Test-Path -LiteralPath $path)) { throw 'partial_placement_state_missing' } }

  # Positive proof that the guest never crossed into execution: none of these are
  # written until the guest wrapper actually starts running (its very first acts are
  # claiming the terminal and, inside the launcher, creating the custody directory).
  foreach ($path in @(
      (Join-Path $root "Evidence1Ops\final-codex\$campaignId.terminal.claim.json"),
      (Join-Path $root "Evidence1Ops\final-codex\$campaignId.terminal.json"),
      (Join-Path $root "Evidence1Ops\final-codex\$campaignId.stdout.log"),
      (Join-Path $root "Evidence1Ops\final-codex\$campaignId.stderr.log"),
      (Join-Path $root "Evidence1Custody\$campaignId"),
      (Join-Path $runDir 'group.claim.json'),
      (Join-Path $runDir 'slots'))) {
    if (Test-Path -LiteralPath $path) { throw 'guest_execution_boundary_evidence_exists' }
  }

  $archiveBase = Join-Path $root "Evidence1Ops\abandoned-final-codex\$archiveSuffix"
  $startupArchive = Join-Path $archiveBase 'Evidence1FinalCodex.vbs'
  if (-not (Test-Path -LiteralPath $archiveBase)) { New-Item -ItemType Directory -Path $archiveBase -ErrorAction Stop | Out-Null }
  if (Test-Path -LiteralPath $startup) {
    if (Test-Path -LiteralPath $startupArchive) { throw 'guest_startup_archive_already_exists' }
    Move-Item -LiteralPath $startup -Destination $startupArchive -ErrorAction Stop
  } elseif (-not (Test-Path -LiteralPath $startupArchive -PathType Leaf)) {
    throw 'partial_placement_startup_state_missing'
  }
  Rename-Item -LiteralPath $runDir -NewName $archiveSuffix -ErrorAction Stop
  Rename-Item -LiteralPath $runtimeDir -NewName $archiveSuffix -ErrorAction Stop
  $guestArchive = "C:\Evidence1Ops\abandoned-final-codex\$archiveSuffix; C:\Evidence1Ops\final-codex\$archiveSuffix; C:\ProgramData\KmpEval\Evidence1FinalCodexRuntime\$archiveSuffix"
} finally {
  if ($mount) { Dismount-VHD -Path $disk -ErrorAction SilentlyContinue }
}

$hostArchiveDir = Join-Path $reportRoot $campaignId
if (Test-Path -LiteralPath $hostArchiveDir) { throw 'host_abandonment_archive_must_be_create_new' }
New-Item -ItemType Directory -Path $hostArchiveDir -ErrorAction Stop | Out-Null
$archivedGlobalClaim = Join-Path $hostArchiveDir 'global.authorization.claim.json'
Move-Item -LiteralPath $GlobalAuthorizationClaimPath -Destination $archivedGlobalClaim -ErrorAction Stop
Assert-Hash $archivedGlobalClaim $GlobalAuthorizationClaimSha256 'archived_global_claim_hash_mismatch'

$value = [ordered]@{
  schema = 1
  kind = 'evidence1-final-codex-unexecuted-campaign-retirement'
  verdict = 'PASS'
  campaign_id = $campaignId
  binding_sha256 = $BindingSha256
  placement_report_sha256 = $PlacementReportSha256
  global_authorization_claim_sha256 = $GlobalAuthorizationClaimSha256
  provider_sessions_consumed = 0
  provider_spawn_boundary_crossed = $false
  start_reservation_present = $true
  guest_execution_boundary_crossed = $false
  terminal_claim_present = $false
  guest_archive = $guestArchive
  archived_global_claim_path = $archivedGlobalClaim
  reason_code = $FailureReasonCode
  retired_at_utc = [datetime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
}
New-Item -ItemType Directory -Path $reportRoot -Force | Out-Null
$bytes = [Text.UTF8Encoding]::new($false).GetBytes(($value | ConvertTo-Json -Depth 8 -Compress) + "`n")
$stream = [IO.File]::Open($ReportPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
Write-Host "[evidence1-final-codex-retire-unexecuted] PASS: $ReportPath"
