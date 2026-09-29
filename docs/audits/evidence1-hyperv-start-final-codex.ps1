#Requires -RunAsAdministrator
param(
    [Parameter(Mandatory)][string]$PlacementReportPath,
    [Parameter(Mandatory)][string]$PlacementReportSha256,
    [Parameter(Mandatory)][string]$BindingPath,
    [Parameter(Mandatory)][string]$BindingSha256,
    [Parameter(Mandatory)][string]$ReadinessPath,
    [Parameter(Mandatory)][string]$RemoteAuthHostReportPath,
    [Parameter(Mandatory)][string]$GuestRemoteAuthBlobPath,
    [Parameter(Mandatory)][string]$GuestRemoteAuthBlobSha256,
    [Parameter(Mandatory)][string]$CanonicalRepositoryRoot,
    [Parameter(Mandatory)][string]$HarnessTree,
    [Parameter(Mandatory)][string]$AttestationPath,
    [string]$ReadinessAttestationPath='C:\kmp-eval\measurement-scopes\evidence1-claude-windows-isolation-attestation-stageb-v1.json',
    [Parameter(Mandatory)][datetime]$NotBeforeUtc,
    [Parameter(Mandatory)][string]$ReportPath,
    [Parameter(Mandatory)][string]$TerminalReportPath,
    [Parameter(Mandatory)][string]$PrivateOutDir,
    [Parameter(Mandatory)][string]$PublicOutDir,
    [Parameter(Mandatory)][string]$CopyReportPath,
    [Parameter(Mandatory)][string]$CopyCompletionReportPath,
    [Parameter(Mandatory)][string]$CopyJournalPath,
    [string]$PrivatePatternsFile='',
    [switch]$DirectTrigger,
    [string]$GuestCredentialPath='',
    [string]$DirectTriggerReportPath='',
    [ValidateRange(30,7200)][int]$ShutdownWaitSeconds=7200
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'evidence1-final-codex-host-contract.psm1') -Force -DisableNameChecking
function Sha([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Read-Json([string]$Path) {
    $bytes = [IO.File]::ReadAllBytes($Path)
    $text = [Text.UTF8Encoding]::new($false, $true).GetString($bytes)
    if ($text.Length -gt 0 -and $text[0] -eq [char]0xFEFF) { $text = $text.Substring(1) }
    return $text | ConvertFrom-Json -ErrorAction Stop
}
foreach ($path in @($PlacementReportPath, $BindingPath, $ReadinessPath, $RemoteAuthHostReportPath, $GuestRemoteAuthBlobPath, $AttestationPath)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'start_evidence_missing' }
    Assert-E1FinalNoReparseAncestors $path
}
if ((Sha $PlacementReportPath) -cne $PlacementReportSha256 -or (Sha $BindingPath) -cne $BindingSha256 -or (Sha $GuestRemoteAuthBlobPath) -cne $GuestRemoteAuthBlobSha256) { throw 'start_evidence_hash_mismatch' }
$placement = Read-Json $PlacementReportPath
$binding = Read-Json $BindingPath
$repositoryRoot = Assert-E1FinalCanonicalRepository $CanonicalRepositoryRoot $binding.harness_commit $binding.harness_tree
$readiness = Read-Json $ReadinessPath
$hostAuth = Read-Json $RemoteAuthHostReportPath
$guestCanary = Read-Json $GuestRemoteAuthBlobPath
$readinessSha = Sha $ReadinessPath
$vmName=[string]$binding.vm_name;$vmId=([string]$binding.vm_id).ToLowerInvariant()
if([string]::IsNullOrWhiteSpace($vmName)-or$vmId-cnotmatch'^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$'-or
   [string]$readiness.vm_name-cne$vmName-or([string]$readiness.vm_id).ToLowerInvariant()-cne$vmId-or
   [string]$hostAuth.vm_name-cne$vmName-or([string]$hostAuth.vm_id).ToLowerInvariant()-cne$vmId-or
   [string]$guestCanary.context.vm_name-cne$vmName-or([string]$guestCanary.context.vm_id).ToLowerInvariant()-cne$vmId){throw 'start_vm_identity_chain_mismatch'}
$placementKeys=@('schema','kind','verdict','campaign_id','vm_name','vm_id','binding_sha256','authorization_claim_sha256','global_authorization_claim_sha256','remote_auth_blob_sha256','node_runtime_manifest_sha256','script_sha256','startup_create_new','window_style','retry_count','replacement_authorized','respawn_authorized')
if ($placement.PSObject.Properties.Name -ccontains 'resumed_from_exact_partial_state') {
    if ($placement.resumed_from_exact_partial_state -ne $true) { throw 'placement_binding_invalid' }
    $placementKeys += 'resumed_from_exact_partial_state'
}
if(@(Compare-Object @($placement.PSObject.Properties.Name|Sort-Object) @($placementKeys|Sort-Object)).Count-ne 0 -or
    $placement.kind -cne 'evidence1-final-codex-placement-report' -or $placement.verdict -cne 'PASS' -or $placement.vm_name -cne $vmName -or ([string]$placement.vm_id).ToLowerInvariant() -cne $vmId -or
    $placement.binding_sha256 -cne $BindingSha256 -or $placement.remote_auth_blob_sha256 -cne $GuestRemoteAuthBlobSha256 -or$placement.node_runtime_manifest_sha256-cnotmatch'^[0-9a-f]{64}$'-or
    $binding.remote_auth_sha256 -cne $GuestRemoteAuthBlobSha256 -or $binding.harness_tree-cne$HarnessTree -or [int]$placement.retry_count-ne 0 -or
    $placement.replacement_authorized-ne$false -or $placement.respawn_authorized-ne$false -or
    (($placement.script_sha256|ConvertTo-Json -Compress)-cne($binding.script_sha256|ConvertTo-Json -Compress))) { throw 'placement_binding_invalid' }

Import-Module (Join-Path $PSScriptRoot 'evidence1-live-handoff-contract.psm1') -Force -DisableNameChecking
# Task 2 (centralize dual-auth report parsing): verdict is discriminated
# FIRST, through the one shared parser, before any PASS-only field
# (vm_state/remote_auth_canary) is ever touched. A FAIL report now stops
# here with a clear "operation failed: <reason_code>", never reaching the
# 12-key PASS-shape check below at all -- previously a FAIL report reached
# Assert-Evidence1LiveHandoffEvidence directly and crashed with the opaque
# "dual auth host report has an invalid shape" from deep inside its
# Assert-Evidence1ExactKeys call.
$hostVerdict = Resolve-Evidence1DualAuthHostReportVerdict -Report $hostAuth -ExpectedVMName $vmName -ExpectedVMId $vmId `
    -ExpectedCodexModel 'gpt-5.6-terra' -ExpectedReadinessSha256 $readinessSha
if ($hostVerdict.verdict -cne 'PASS') { throw "operation failed: $($hostVerdict.reason_code)" }
# The host report is schema 2 (overnight work order item A: this call always
# supplies -ExpectedCodexVersion below, so the contract's dual-auth,
# Codex-expected branch applies, which requires schema 2). The canonical API
# validates and unwraps its remote_auth_canary member; it is never passed as
# a guest canary directly.
$null = Assert-Evidence1LiveHandoffEvidence `
    -ReadinessReport $readiness -AuthReport $hostAuth -ExpectedVMName $vmName `
    -ExpectedVMId $vmId -ExpectedTargetCommit $binding.harness_commit `
    -ExpectedTargetTree $HarnessTree -ExpectedSourceCommit $binding.source_commit -ExpectedClaudeVersion '2.1.238' `
    -ExpectedCodexVersion '0.154.0' -ExpectedCodexModel 'gpt-5.6-terra' -ExpectedReadinessSha256 $readinessSha `
    -ExpectedAttestationPath $ReadinessAttestationPath -ExpectedPlannedSessions 8 -NowUtc ([datetime]::UtcNow) `
    -ReadinessMaxAgeMinutes 60 -RemoteAuthMaxAgeMinutes 30
$embedded = $hostAuth.remote_auth_canary
if (($embedded | ConvertTo-Json -Depth 30 -Compress) -cne ($guestCanary | ConvertTo-Json -Depth 30 -Compress)) { throw 'guest_remote_auth_blob_does_not_match_host_wrapper' }
$null = Assert-Evidence1DualRemoteAuthCanary `
    -Canary $guestCanary -ExpectedClaudeVersion '2.1.238' -ExpectedCodexVersion '0.154.0' `
    -ExpectedVMName $vmName -ExpectedVMId $vmId `
    -ExpectedCodexModel 'gpt-5.6-terra' -ExpectedHostReadinessSha256 $readinessSha `
    -NotBeforeUtc $NotBeforeUtc -NowUtc ([datetime]::UtcNow) -MaxAgeMinutes 30

$startRoot='C:\kmp-eval\scratch\evidence1-final-codex-start'
$expectedReport=Join-Path $startRoot ($placement.campaign_id+'.reserved.json')
$expectedTerminal=Join-Path $startRoot ($placement.campaign_id+'.terminal.json')
if(-not([IO.Path]::GetFullPath($ReportPath).Equals($expectedReport,[StringComparison]::OrdinalIgnoreCase))-or
   -not([IO.Path]::GetFullPath($TerminalReportPath).Equals($expectedTerminal,[StringComparison]::OrdinalIgnoreCase))){throw 'final_report_path_not_canonical_scratch'}
$downstream=[ordered]@{
 private=@($PrivateOutDir,("C:\kmp-eval\scratch\evidence1-final-codex-private\"+$placement.campaign_id))
 public=@($PublicOutDir,("C:\kmp-eval\agentic-eval-codex-runtime\tools\runs\evidence1-codex-pilot-"+$placement.campaign_id))
 copy_report=@($CopyReportPath,("C:\kmp-eval\scratch\evidence1-final-codex-copy-reports\"+$placement.campaign_id+'.reserved.json'))
 copy_terminal=@($CopyCompletionReportPath,("C:\kmp-eval\scratch\evidence1-final-codex-copy-reports\"+$placement.campaign_id+'.terminal.json'))
 copy_journal=@($CopyJournalPath,("C:\kmp-eval\scratch\evidence1-final-codex-copy-journals\"+$placement.campaign_id))
}
foreach($axis in $downstream.Keys){if(-not([IO.Path]::GetFullPath($downstream[$axis][0]).Equals([IO.Path]::GetFullPath($downstream[$axis][1]),[StringComparison]::OrdinalIgnoreCase))){throw 'final_copy_flow_not_canonical'}}
$reservation=[ordered]@{schema=1;kind='evidence1-final-codex-start-reservation';campaign_id=$placement.campaign_id;placement_report_sha256=$PlacementReportSha256;binding_sha256=$BindingSha256;readiness_sha256=$readinessSha;remote_auth_host_report_sha256=(Sha $RemoteAuthHostReportPath);remote_auth_blob_sha256=$GuestRemoteAuthBlobSha256;retry_count=0;replacement_authorized=$false;respawn_authorized=$false;reserved_at_utc=[datetime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')}
if(Test-Path -LiteralPath $TerminalReportPath){throw 'final_operation_report_already_exists'}
Write-E1FinalCreateNewJson $ReportPath $reservation
$null=New-E1FinalOperationReservation -ReportPath $TerminalReportPath -ReportRoot $startRoot -Kind 'evidence1-final-codex-start-terminal-reservation' -CampaignId $placement.campaign_id -Prerequisites ([ordered]@{start_reservation_sha256=(Sha $ReportPath);placement_report_sha256=$PlacementReportSha256})
# Detect replacement of the immutable placement record between validation and release.
if((Sha $PlacementReportPath)-cne$PlacementReportSha256){throw 'placement_report_changed_before_start'}

$vm = Get-VM -Name $vmName -ErrorAction Stop
if ($vm.State -ne 'Off' -or ([string]$vm.Id).ToLowerInvariant() -cne $placement.vm_id) { throw 'exact_e2e_vm_not_startable' }
Start-VM -Name $vm.Name | Out-Null
$value = [ordered]@{
    schema=1; kind='evidence1-final-codex-start-terminal'; verdict='PASS'; campaign_id=$placement.campaign_id; vm_name=$vm.Name
    placement_report_sha256=$PlacementReportSha256; start_reservation_sha256=Sha $ReportPath
    binding_sha256=$BindingSha256; readiness_sha256=$readinessSha
    remote_auth_host_report_sha256=Sha $RemoteAuthHostReportPath
    remote_auth_blob_sha256=$GuestRemoteAuthBlobSha256
    not_before_utc=$NotBeforeUtc.ToUniversalTime().ToString('o'); retry_count=0
}
$bytes = [Text.UTF8Encoding]::new($false).GetBytes(($value | ConvertTo-Json -Compress) + "`n")
$stream = [IO.File]::Open($TerminalReportPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }

if ($DirectTrigger) {
    $expectedDirectReport = "C:\kmp-eval\scratch\evidence1-final-codex-direct-trigger\$($placement.campaign_id).json"
    if (-not (Test-Path -LiteralPath $GuestCredentialPath -PathType Leaf) -or
        -not ([IO.Path]::GetFullPath($DirectTriggerReportPath).Equals($expectedDirectReport,[StringComparison]::OrdinalIgnoreCase))) {
        throw 'direct_trigger_inputs_invalid'
    }
    & (Join-Path $PSScriptRoot 'evidence1-hyperv-trigger-final-codex-direct.ps1') `
      -CampaignId $placement.campaign_id -BindingSha256 $BindingSha256 `
      -AuthorizationClaimSha256 ([string]$placement.authorization_claim_sha256) `
      -GlobalAuthorizationClaimSha256 ([string]$placement.global_authorization_claim_sha256) `
      -RemoteAuthCanarySha256 $GuestRemoteAuthBlobSha256 `
      -NodeRuntimeManifestSha256 ([string]$placement.node_runtime_manifest_sha256) `
      -VMName $vmName -ExpectedVMId $vmId -GuestComputerName 'Evidence1E2E' `
      -GuestCredentialPath $GuestCredentialPath -ReportPath $DirectTriggerReportPath `
      -TimeoutSeconds $ShutdownWaitSeconds
    if ($LASTEXITCODE -ne 0) { throw 'direct_trigger_failed' }
}

# The guest terminal is flushed before it asks Windows for graceful shutdown.
# Never use a hard-power fallback: timeout burns the campaign and copy is not run.
$deadline=[datetime]::UtcNow.AddSeconds($ShutdownWaitSeconds)
do{$state=(Get-VM -Name $vmName -ErrorAction Stop).State;if($state-eq'Off'){break};Start-Sleep -Seconds 5}while([datetime]::UtcNow-lt$deadline)
if($state-ne'Off'){throw 'final_codex_graceful_shutdown_timeout_no_copy'}
$copyArgs=@{
 CampaignId=$placement.campaign_id;PrivateOutDir=$PrivateOutDir;PublicOutDir=$PublicOutDir
 ReportPath=$CopyReportPath;CompletionReportPath=$CopyCompletionReportPath;JournalPath=$CopyJournalPath
 HarnessCommit=$binding.harness_commit;HarnessTree=$binding.harness_tree;BindingPath=$BindingPath;BindingSha256=$BindingSha256;CanonicalRepositoryRoot=$repositoryRoot
}
if($PrivatePatternsFile){$copyArgs.PrivatePatternsFile=$PrivatePatternsFile}
& (Join-Path $PSScriptRoot 'evidence1-hyperv-copy-final-codex.ps1') @copyArgs
