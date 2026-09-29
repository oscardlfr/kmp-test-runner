#Requires -RunAsAdministrator
param(
    [Parameter(Mandatory)][string]$ReadinessPath,
    [Parameter(Mandatory)][string]$RemoteAuthHostReportPath,
    [Parameter(Mandatory)][string]$HarnessCommit,
    [Parameter(Mandatory)][string]$HarnessTree,
    [Parameter(Mandatory)][string]$SourceCommit,
    [Parameter(Mandatory)][string]$AttestationPath,
    [Parameter(Mandatory)][datetime]$NotBeforeUtc,
    [Parameter(Mandatory)][string]$OutPath,
    [Parameter(Mandatory)][string]$ReportPath
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'evidence1-final-codex-host-contract.psm1') -Force -DisableNameChecking
$null=Assert-E1FinalCanonicalRepository 'C:\kmp-eval\agentic-eval-codex-runtime' $HarnessCommit $HarnessTree
function Sha([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Read-JsonBytes([byte[]]$Bytes) {
    $text = [Text.UTF8Encoding]::new($false, $true).GetString($Bytes)
    if ($text.Length -gt 0 -and $text[0] -eq [char]0xFEFF) { $text = $text.Substring(1) }
    return $text | ConvertFrom-Json -ErrorAction Stop
}
foreach ($path in @($ReadinessPath, $RemoteAuthHostReportPath, $AttestationPath)) { if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'auth_blob_evidence_missing' };Assert-E1FinalNoReparseAncestors $path }
foreach ($path in @($OutPath, $ReportPath)) { if (Test-Path -LiteralPath $path) { throw 'auth_blob_destination_must_be_create_new' } }
$readinessBytes = [IO.File]::ReadAllBytes($ReadinessPath)
$hostBytes = [IO.File]::ReadAllBytes($RemoteAuthHostReportPath)
$readiness = Read-JsonBytes $readinessBytes
$hostReport = Read-JsonBytes $hostBytes
$readinessSha = Sha $ReadinessPath
$vmName=[string]$readiness.vm_name;$vmId=([string]$readiness.vm_id).ToLowerInvariant()
if([string]::IsNullOrWhiteSpace($vmName)-or$vmId-cnotmatch'^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$'-or
  [string]$hostReport.vm_name-cne$vmName-or([string]$hostReport.vm_id).ToLowerInvariant()-cne$vmId){throw 'auth_blob_vm_identity_chain_mismatch'}
Import-Module (Join-Path $PSScriptRoot 'evidence1-live-handoff-contract.psm1') -Force -DisableNameChecking
# Task 2 (centralize dual-auth report parsing): verdict discriminated FIRST,
# through the one shared parser, before any PASS-only field is ever touched.
# A FAIL report now stops here with a clear "operation failed: <reason_code>"
# rather than crashing inside Assert-Evidence1LiveHandoffEvidence's 12-key
# shape check below.
$hostVerdict = Resolve-Evidence1DualAuthHostReportVerdict -Report $hostReport -ExpectedVMName $vmName -ExpectedVMId $vmId `
    -ExpectedCodexModel 'gpt-5.6-terra' -ExpectedReadinessSha256 $readinessSha
if ($hostVerdict.verdict -cne 'PASS') { throw "operation failed: $($hostVerdict.reason_code)" }
$null = Assert-Evidence1LiveHandoffEvidence `
    -ReadinessReport $readiness -AuthReport $hostReport -ExpectedVMName $vmName `
    -ExpectedVMId $vmId -ExpectedTargetCommit $HarnessCommit `
    -ExpectedTargetTree $HarnessTree -ExpectedSourceCommit $SourceCommit -ExpectedClaudeVersion '2.1.238' `
    -ExpectedCodexVersion '0.154.0' -ExpectedCodexModel 'gpt-5.6-terra' -ExpectedReadinessSha256 $readinessSha `
    -ExpectedAttestationPath $AttestationPath -ExpectedPlannedSessions 8 -NowUtc ([datetime]::UtcNow) `
    -ReadinessMaxAgeMinutes 60 -RemoteAuthMaxAgeMinutes 30
$operation = [guid]::Empty
if (-not [guid]::TryParseExact([string]$hostReport.operation_id, 'D', [ref]$operation) -or $operation -eq [guid]::Empty) { throw 'remote_auth_operation_id_invalid' }
$authRoot='C:\kmp-eval\scratch\evidence1-final-codex-auth'
$expectedOut=Join-Path $authRoot ($operation.ToString('D')+'.json');$expectedReport=Join-Path $authRoot ($operation.ToString('D')+'.report.json')
if(-not([IO.Path]::GetFullPath($OutPath).Equals($expectedOut,[StringComparison]::OrdinalIgnoreCase))-or-not([IO.Path]::GetFullPath($ReportPath).Equals($expectedReport,[StringComparison]::OrdinalIgnoreCase))){throw 'final_report_path_not_canonical_scratch'}
if(-not(Test-Path -LiteralPath $authRoot)){New-Item -ItemType Directory -Path $authRoot -ErrorAction Stop|Out-Null}
$null=New-E1FinalOperationReservation -ReportPath $ReportPath -ReportRoot $authRoot -Kind 'evidence1-final-codex-auth-capture-reservation' -CampaignId $operation.ToString('D') -Prerequisites ([ordered]@{readiness_sha256=$readinessSha;host_report_sha256=(Sha $RemoteAuthHostReportPath)})

$vm = Get-VM -Name $vmName -ErrorAction Stop
if ($vm.State -ne 'Off' -or ([string]$vm.Id).ToLowerInvariant() -cne $vmId) { throw 'auth_blob_capture_requires_exact_vm_off' }
$disk = (Get-VMHardDiskDrive -VMName $vm.Name | Select-Object -First 1).Path
if (-not ([IO.Path]::GetFullPath($disk)).StartsWith('C:\kmp-eval\hyperv-e2e\', [StringComparison]::OrdinalIgnoreCase)) { throw 'vhd_scope_invalid' }
$mount = $null
try {
    $mount = Mount-VHD -Path $disk -ReadOnly -Passthru
    $root = Get-E1FinalMountedWindowsRoot $mount
    $guestPath = Join-Path $root "Evidence1Ops\remote-auth-canary-v2\$($operation.ToString('D'))\final.json"
    if (-not (Test-Path -LiteralPath $guestPath -PathType Leaf) -or ((Get-Item -LiteralPath $guestPath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'guest_remote_auth_blob_missing_or_reparse' }
    $guestBytes = [IO.File]::ReadAllBytes($guestPath)
    $guestCanary = Read-JsonBytes $guestBytes
    if (($hostReport.remote_auth_canary | ConvertTo-Json -Depth 30 -Compress) -cne ($guestCanary | ConvertTo-Json -Depth 30 -Compress)) { throw 'guest_remote_auth_blob_does_not_match_host_wrapper' }
    $null = Assert-Evidence1DualRemoteAuthCanary `
        -Canary $guestCanary -ExpectedClaudeVersion '2.1.238' -ExpectedCodexVersion '0.154.0' `
        -ExpectedVMName $vmName -ExpectedVMId $vmId `
        -ExpectedCodexModel 'gpt-5.6-terra' -ExpectedHostReadinessSha256 $readinessSha `
        -NotBeforeUtc $NotBeforeUtc -NowUtc ([datetime]::UtcNow) -MaxAgeMinutes 30
    $stream = [IO.File]::Open($OutPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    try { $stream.Write($guestBytes, 0, $guestBytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
    $guestSha = Sha $OutPath
    $value = [ordered]@{ schema=1; verdict='PASS'; vm_name=$vm.Name; vm_id=([string]$vm.Id).ToLowerInvariant(); operation_id=$operation.ToString('D'); host_report_sha256=Sha $RemoteAuthHostReportPath; readiness_sha256=$readinessSha; guest_blob_sha256=$guestSha; exact_guest_bytes_copied=$true; raw_content_persisted=$false }
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($value | ConvertTo-Json -Compress) + "`n")
    $reportStream = [IO.File]::Open($ReportPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    try { $reportStream.Write($bytes, 0, $bytes.Length); $reportStream.Flush($true) } finally { $reportStream.Dispose() }
} finally {
    if ($mount) { Dismount-VHD -Path $disk -ErrorAction SilentlyContinue }
}
