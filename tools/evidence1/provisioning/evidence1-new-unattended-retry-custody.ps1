#Requires -RunAsAdministrator

param(
  [string]$ProfilePath = '',
  [Parameter(Mandatory = $true)] [string]$InputLockPath,
  [Parameter(Mandatory = $true)] [string]$PriorInputLockPath,
  [Parameter(Mandatory = $true)] [string]$PriorFailureReceiptPath,
  [Parameter(Mandatory = $true)] [string]$CreatedInspectionReceiptPath,
  [Parameter(Mandatory = $true)] [string]$RunnerRequestId,
  [Parameter(Mandatory = $true)] [string]$GuestCredentialPath,
  [Parameter(Mandatory = $true)] [string]$PriorAnswerMediaPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$RequiredProfileId = 'evidence1-windows-hyperv-e2e-v1'
$RequiredAuthorizationPhrase = 'authorize install evidence1 e2e windows unattended offline'
$RequiredWrapperName = 'evidence1-host-install-canonical-windows-unattended.ps1'
$RequiredRunnerQueueRoot = 'C:\kmp-eval\scratch\host-elevated-runner-codex'
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrWhiteSpace($ProfilePath)) {
  $ProfilePath = Join-Path $scriptRoot 'evidence1-windows-hyperv-e2e-v1.json'
}
Import-Module (Join-Path $scriptRoot 'Evidence1.Provisioning.psm1') -Force

function Assert-E1NoReparsePointAncestors([string]$Path) {
  $cursor = [IO.Path]::GetFullPath($Path)
  while ($cursor) {
    if (Test-Path -LiteralPath $cursor) {
      $item = Get-Item -LiteralPath $cursor -Force
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'custody_path_reparse_point' }
    }
    $parent = Split-Path -Parent $cursor
    if ([string]::IsNullOrWhiteSpace($parent) -or $parent -ceq $cursor) { break }
    $cursor = $parent
  }
}

function Set-E1PrivateDirectoryAcl([string]$Path) {
  $acl = [Security.AccessControl.DirectorySecurity]::new()
  $acl.SetAccessRuleProtection($true, $false)
  $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  foreach ($sidValue in @($currentSid, 'S-1-5-18', 'S-1-5-32-544') | Select-Object -Unique) {
    $principal = ([Security.Principal.SecurityIdentifier]::new($sidValue)).Translate([Security.Principal.NTAccount])
    $rule = [Security.AccessControl.FileSystemAccessRule]::new(
      $principal,
      [Security.AccessControl.FileSystemRights]::FullControl,
      [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',
      [Security.AccessControl.PropagationFlags]::None,
      [Security.AccessControl.AccessControlType]::Allow
    )
    $null = $acl.AddAccessRule($rule)
  }
  [IO.Directory]::SetAccessControl([IO.Path]::GetFullPath($Path), $acl)
}

function Set-E1PrivateFileAcl([string]$Path) {
  $acl = [Security.AccessControl.FileSecurity]::new()
  $acl.SetAccessRuleProtection($true, $false)
  $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  foreach ($sidValue in @($currentSid, 'S-1-5-18', 'S-1-5-32-544') | Select-Object -Unique) {
    $principal = ([Security.Principal.SecurityIdentifier]::new($sidValue)).Translate([Security.Principal.NTAccount])
    $rule = [Security.AccessControl.FileSystemAccessRule]::new(
      $principal,
      [Security.AccessControl.FileSystemRights]::FullControl,
      [Security.AccessControl.AccessControlType]::Allow
    )
    $null = $acl.AddAccessRule($rule)
  }
  [IO.File]::SetAccessControl([IO.Path]::GetFullPath($Path), $acl)
}

function Assert-E1RunnerQueueAcl([string]$Path) {
  $full = [IO.Path]::GetFullPath($Path)
  $item = Get-Item -LiteralPath $full -Force -ErrorAction Stop
  $acl = if ($item.PSIsContainer) {
    [IO.Directory]::GetAccessControl($full)
  } else {
    [IO.File]::GetAccessControl($full)
  }
  $owner = ([Security.Principal.NTAccount]::new([string]$acl.Owner)).Translate([Security.Principal.SecurityIdentifier]).Value
  $currentOwner = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  if ($owner -notin @($currentOwner, 'S-1-5-18', 'S-1-5-32-544')) { throw 'runner_queue_owner_invalid' }
  $broadSids = @('S-1-1-0', 'S-1-5-11', 'S-1-5-32-545')
  foreach ($rule in @($acl.Access)) {
    $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    $writeMask = [Security.AccessControl.FileSystemRights]'Write, Modify, FullControl'
    if ($sid -in $broadSids -and $rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
        ($rule.FileSystemRights -band $writeMask) -ne 0) { throw 'runner_queue_acl_invalid' }
  }
}

function Assert-E1LegacyFailureReceipt($Receipt) {
  $required = @(
    'schema','verdict','reason_code','start_count','network_used','vm_state','answer_media_deleted',
    'host_cleanup_complete','guest_credential_preserved','retry_authorized','private_paths_persisted',
    'mutation_performed','inference_sessions_consumed','cleanup_failure_codes','guest_cached_answer_state'
  )
  Assert-E1RequiredProperties $Receipt $required 'prior_failure_receipt'
  if (-not (Test-E1StrictJsonInteger $Receipt.schema 1) -or $Receipt.verdict -isnot [string] -or
      $Receipt.verdict -cne 'FAIL' -or $Receipt.reason_code -isnot [string] -or
      $Receipt.reason_code -cne 'vm_boot_key_injection_failed' -or
      -not (Test-E1StrictJsonInteger $Receipt.start_count 1) -or $Receipt.network_used -isnot [bool] -or
      $Receipt.network_used -ne $false -or $Receipt.vm_state -isnot [string] -or $Receipt.vm_state -cne 'Off' -or
      $Receipt.answer_media_deleted -isnot [bool] -or $Receipt.answer_media_deleted -ne $true -or
      $Receipt.host_cleanup_complete -isnot [bool] -or $Receipt.host_cleanup_complete -ne $true -or
      $Receipt.guest_credential_preserved -isnot [bool] -or $Receipt.guest_credential_preserved -ne $true -or
      $Receipt.retry_authorized -isnot [bool] -or $Receipt.retry_authorized -ne $false -or
      $Receipt.private_paths_persisted -isnot [bool] -or $Receipt.private_paths_persisted -ne $false -or
      $Receipt.mutation_performed -isnot [bool] -or $Receipt.mutation_performed -ne $true -or
      -not (Test-E1StrictJsonInteger $Receipt.inference_sessions_consumed 0) -or
      $Receipt.cleanup_failure_codes -isnot [array] -or @($Receipt.cleanup_failure_codes).Count -ne 0 -or
      $Receipt.guest_cached_answer_state -isnot [string] -or $Receipt.guest_cached_answer_state -cne 'unknown') {
    throw 'prior_failure_receipt_invalid'
  }
}

function Assert-E1RunnerRequest($Request, [string]$RequestPath, [string]$ExpectedWrapperPath,
    [string]$PriorLockPath, [string]$CredentialPath, [string]$AnswerPath, [string]$FailurePath) {
  Assert-E1ExactProperties $Request @('id','created_at_utc','script_path','arguments') 'runner_request'
  Assert-E1RequiredProperties $Request @('id','created_at_utc','script_path','arguments') 'runner_request'
  if ($Request.id -isnot [string] -or $Request.id -cnotmatch '^req-[A-Za-z0-9-]+$' -or
      $Request.created_at_utc -isnot [string] -or [string]$Request.created_at_utc -cnotmatch 'Z$' -or
      $Request.script_path -isnot [string] -or
      [IO.Path]::GetFullPath([string]$Request.script_path) -cne [IO.Path]::GetFullPath($ExpectedWrapperPath) -or
      $Request.arguments -isnot [array]) { throw 'runner_request_invalid' }
  $expected = @(
    '-InputLockPath', $PriorLockPath,
    '-GuestCredentialPath', $CredentialPath,
    '-AnswerMediaPath', $answerPath,
    '-ReceiptPath', $FailurePath,
    '-TimeoutSeconds', '5400',
    '-AuthorizationPhrase', $RequiredAuthorizationPhrase
  )
  $actual = @($Request.arguments)
  if ($actual.Count -ne $expected.Count) { throw 'runner_request_invalid' }
  for ($index = 0; $index -lt $expected.Count; $index++) {
    if ([string]$actual[$index] -cne [string]$expected[$index]) { throw 'runner_request_invalid' }
  }
  $expectedFile = "$($Request.id).request.json"
  if ((Split-Path -Leaf $RequestPath) -cne $expectedFile) { throw 'runner_request_invalid' }
}

function Assert-E1RunnerResponse($Response, [string]$RequestId, [string]$LogPath) {
  Assert-E1ExactProperties $Response @('id','generated_at_utc','exit_code','log_path','error') 'runner_response'
  Assert-E1RequiredProperties $Response @('id','generated_at_utc','exit_code','log_path','error') 'runner_response'
  if ($Response.id -isnot [string] -or $Response.id -cne $RequestId -or
      $Response.generated_at_utc -isnot [string] -or [string]$Response.generated_at_utc -cnotmatch 'Z$' -or
      -not (Test-E1StrictJsonInteger $Response.exit_code 1) -or
      $Response.log_path -isnot [string] -or
      [IO.Path]::GetFullPath([string]$Response.log_path) -cne [IO.Path]::GetFullPath($LogPath) -or
      $Response.error -isnot [string] -or $Response.error -cne 'unattended_nonpass_recovery_pass') {
    throw 'runner_response_invalid'
  }
}

function Assert-E1CreatedInspectionReceipt($Receipt, [string]$ProfileSha, [string]$PriorLockSha) {
  $required = @(
    'schema','verdict','mode','profile_id','profile_sha256','input_lock_sha256','vm_id',
    'drift_fields','mutation_performed','inference_sessions_consumed'
  )
  Assert-E1RequiredProperties $Receipt $required 'created_inspection_receipt'
  if (-not (Test-E1StrictJsonInteger $Receipt.schema 1) -or $Receipt.verdict -isnot [string] -or
      $Receipt.verdict -cne 'PASS' -or $Receipt.mode -isnot [string] -or $Receipt.mode -cne 'InspectCreated' -or
      $Receipt.profile_id -isnot [string] -or $Receipt.profile_id -cne $RequiredProfileId -or
      $Receipt.profile_sha256 -isnot [string] -or $Receipt.profile_sha256 -cne $ProfileSha -or
      $Receipt.input_lock_sha256 -isnot [string] -or $Receipt.input_lock_sha256 -cne $PriorLockSha -or
      $Receipt.vm_id -isnot [string] -or $Receipt.vm_id -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' -or
      $Receipt.drift_fields -isnot [array] -or @($Receipt.drift_fields).Count -ne 0 -or
      $Receipt.mutation_performed -isnot [bool] -or $Receipt.mutation_performed -ne $false -or
      -not (Test-E1StrictJsonInteger $Receipt.inference_sessions_consumed 0)) {
    throw 'created_inspection_receipt_invalid'
  }
  return ([string]$Receipt.vm_id).ToLowerInvariant()
}

$mountedVhd = $null
try {
  Assert-E1Administrator
  $scratchRoot = 'C:\kmp-eval\scratch'
  $currentLockFull = Assert-E1PathInside $InputLockPath @($scratchRoot) 'input_lock_path_outside_scratch'
  $priorLockFull = Assert-E1PathInside $PriorInputLockPath @($scratchRoot) 'prior_input_lock_path_outside_scratch'
  $failureFull = Assert-E1PathInside $PriorFailureReceiptPath @($scratchRoot) 'prior_failure_receipt_path_outside_scratch'
  $inspectionFull = Assert-E1PathInside $CreatedInspectionReceiptPath @($scratchRoot) 'created_inspection_receipt_path_outside_scratch'
  $credentialFull = Assert-E1PathInside $GuestCredentialPath @($scratchRoot) 'guest_credential_path_outside_scratch'
  $answerFull = Assert-E1PathInside $PriorAnswerMediaPath @($scratchRoot) 'answer_media_path_outside_scratch'
  if ($RunnerRequestId -cnotmatch '^req-[A-Za-z0-9-]+$') { throw 'runner_request_id_invalid' }
  $queueRoot = [IO.Path]::GetFullPath($RequiredRunnerQueueRoot)
  Assert-E1NoReparsePointAncestors $queueRoot
  Set-E1PrivateDirectoryAcl $queueRoot
  Assert-E1NoReparsePointAncestors $queueRoot
  Assert-E1RunnerQueueAcl $queueRoot
  $requestFull = Join-Path $queueRoot "done\$RunnerRequestId.request.json"
  $responseFull = Join-Path $queueRoot "responses\$RunnerRequestId.response.json"
  $logFull = Join-Path $queueRoot "logs\$RunnerRequestId.log"
  foreach ($runnerDirectory in @(
    (Join-Path $queueRoot 'done'),
    (Join-Path $queueRoot 'responses'),
    (Join-Path $queueRoot 'logs')
  )) {
    Assert-E1NoReparsePointAncestors $runnerDirectory
    if (-not (Test-Path -LiteralPath $runnerDirectory -PathType Container)) { throw 'runner_artifact_directory_missing' }
    Set-E1PrivateDirectoryAcl $runnerDirectory
    Assert-E1NoReparsePointAncestors $runnerDirectory
    Assert-E1RunnerQueueAcl $runnerDirectory
  }
  foreach ($runnerArtifact in @($requestFull, $responseFull, $logFull)) {
    Assert-E1NoReparsePointAncestors $runnerArtifact
    if (-not (Test-Path -LiteralPath $runnerArtifact -PathType Leaf)) { throw 'runner_artifact_missing' }
    Set-E1PrivateFileAcl $runnerArtifact
    Assert-E1NoReparsePointAncestors $runnerArtifact
    Assert-E1RunnerQueueAcl $runnerArtifact
  }
  if (Test-Path -LiteralPath $answerFull) { throw 'answer_media_not_deleted' }

  $plan = Get-E1ProvisioningPlan $ProfilePath $currentLockFull
  if ([string]$plan.profile.profile_id -cne $RequiredProfileId) { throw 'profile_contract_mismatch' }
  $profileSha = Get-E1Sha256 $ProfilePath
  $currentLockSha = Get-E1Sha256 $currentLockFull
  $priorLockSnapshot = Read-E1LockedJsonSnapshot $priorLockFull 'prior_input_lock'
  if (-not (Test-E1StrictJsonInteger $priorLockSnapshot.document.schema_version 2) -or
      $priorLockSnapshot.document.profile_id -cne $RequiredProfileId) { throw 'prior_input_lock_invalid' }
  $inspectionSnapshot = Read-E1LockedJsonSnapshot $inspectionFull 'created_inspection_receipt'
  $inspectedVmId = Assert-E1CreatedInspectionReceipt $inspectionSnapshot.document $profileSha ([string]$priorLockSnapshot.sha256)

  $failureSnapshot = Read-E1LockedJsonSnapshot $failureFull 'prior_failure_receipt'
  Assert-E1LegacyFailureReceipt $failureSnapshot.document
  $requestSnapshot = Read-E1LockedJsonSnapshot $requestFull 'runner_request'
  $repoRoot = [IO.Path]::GetFullPath((Join-Path $scriptRoot '..\..\..'))
  $expectedWrapper = Join-Path $repoRoot "docs\audits\$RequiredWrapperName"
  Assert-E1RunnerRequest $requestSnapshot.document $requestFull $expectedWrapper $priorLockFull $credentialFull $answerFull $failureFull
  $responseSnapshot = Read-E1LockedJsonSnapshot $responseFull 'runner_response'
  Assert-E1RunnerResponse $responseSnapshot.document ([string]$requestSnapshot.document.id) $logFull
  if ((Split-Path -Leaf $responseFull) -cne "$($requestSnapshot.document.id).response.json" -or
      (Split-Path -Leaf $logFull) -cne "$($requestSnapshot.document.id).log") { throw 'runner_artifact_identity_invalid' }

  $logSnapshot = Read-E1LockedTextSnapshot $logFull 'runner_log'
  $logText = [string]$logSnapshot.text
  foreach ($marker in @(
    'HARD STOP: vm_boot_key_injection_failed',
    'RECOVERY PASS: vm_state=Off; answer_media_deleted=True; guest_cached_answer_state=unknown; retry_authorized=false',
    'EXITCODE:1'
  )) {
    if ($logText.IndexOf($marker, [StringComparison]::Ordinal) -lt 0) { throw 'runner_log_invalid' }
  }
  $logSha = [string]$logSnapshot.sha256

  if (-not (Test-Path -LiteralPath $credentialFull -PathType Leaf)) { throw 'guest_credential_missing' }
  $credential = Import-Clixml -LiteralPath $credentialFull
  if ($credential -isnot [Management.Automation.PSCredential] -or
      $credential.UserName -cne [string]$plan.profile.guest.local_user) { throw 'guest_credential_invalid' }
  $credentialSha = Get-E1Sha256 $credentialFull

  Import-Module Hyper-V -ErrorAction Stop
  $vm = Get-VM -Name $plan.profile.vm.name -ErrorAction Stop
  if ([string]$vm.State -cne 'Off' -or $vm.Generation -ne $plan.profile.vm.generation -or
      @((Get-VMSnapshot -VM $vm -ErrorAction Stop)).Count -ne 0) { throw 'vm_state_invalid' }
  if (([string]$vm.Id).ToLowerInvariant() -cne $inspectedVmId) { throw 'created_inspection_receipt_binding_mismatch' }
  $network = @(Get-VMNetworkAdapter -VM $vm)
  if ($network.Count -ne 1 -or -not [string]::IsNullOrWhiteSpace([string]$network[0].SwitchName)) {
    throw 'vm_network_not_disconnected'
  }
  $vmRoot = Join-Path ([IO.Path]::GetFullPath([string]$plan.profile.vm.root)) ([string]$plan.profile.vm.name)
  $custodyFull = Join-Path $vmRoot 'custody\unattended-retry-1.custody.json'
  $retryMarkerPath = Join-Path $vmRoot 'custody\unattended-retry-1.consumed.json'
  Assert-E1NoReparsePointAncestors $custodyFull
  if (Test-Path -LiteralPath $custodyFull) { throw 'custody_already_exists' }
  if (Test-Path -LiteralPath $retryMarkerPath) { throw 'unattended_retry_already_consumed' }
  $expectedVhd = Join-Path $vmRoot "$($plan.profile.vm.name).vhdx"
  $disks = @(Get-VMHardDiskDrive -VM $vm)
  if ($disks.Count -ne 1 -or [IO.Path]::GetFullPath([string]$disks[0].Path) -cne [IO.Path]::GetFullPath($expectedVhd)) {
    throw 'vm_disk_contract_mismatch'
  }
  $mountedVhd = Mount-VHD -Path $expectedVhd -ReadOnly -Passthru -ErrorAction Stop
  if ([string]($mountedVhd | Get-Disk).PartitionStyle -cne 'RAW') { throw 'vm_disk_not_blank' }
  Dismount-VHD -Path $expectedVhd -ErrorAction Stop
  $mountedVhd = $null
  $dvd = @(Get-VMDvdDrive -VM $vm)
  $expectedIso = Join-Path $vmRoot 'media\windows.iso'
  if ($dvd.Count -ne 1 -or [IO.Path]::GetFullPath([string]$dvd[0].Path) -cne [IO.Path]::GetFullPath($expectedIso) -or
      (Get-E1Sha256 $expectedIso) -cne [string]$plan.iso.sha256) { throw 'installation_media_contract_mismatch' }

  $custodyParent = Split-Path -Parent $custodyFull
  Assert-E1NoReparsePointAncestors $custodyFull
  New-Item -ItemType Directory -Force -Path $custodyParent | Out-Null
  Assert-E1NoReparsePointAncestors $custodyFull
  Set-E1PrivateDirectoryAcl $custodyParent
  Assert-E1NoReparsePointAncestors $custodyFull
  Write-E1ReceiptAtomically $custodyFull ([ordered]@{
    schema = 1; verdict = 'PASS'; reason_code = 'legacy_failure_custody_validated'
    generated_at_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    profile_id = $RequiredProfileId; profile_sha256 = $profileSha
    current_input_lock_sha256 = $currentLockSha; prior_input_lock_sha256 = [string]$priorLockSnapshot.sha256
    created_inspection_receipt_sha256 = [string]$inspectionSnapshot.sha256
    vm_id = ([string]$vm.Id).ToLowerInvariant(); guest_credential_sha256 = $credentialSha
    prior_failure_receipt_sha256 = [string]$failureSnapshot.sha256
    runner_request_id = [string]$requestSnapshot.document.id
    runner_request_sha256 = [string]$requestSnapshot.sha256
    runner_response_sha256 = [string]$responseSnapshot.sha256; runner_log_sha256 = $logSha
    attempt_number = 1; start_count = 1; vm_state = 'Off'; vhd_partition_style = 'RAW'
    network_used = $false; answer_media_deleted = $true; retry_consumption_marker_absent = $true
    host_cleanup_complete = $true; guest_credential_preserved = $true
    runner_queue_acl_hardened = $true
    runner_artifact_acls_hardened = $true
    authorization_value_copied_to_sidecar = $false; raw_log_copied_to_sidecar = $false
    source_artifact_paths_copied_to_sidecar = $false
    vm_mutation_performed = $false; custody_record_written = $true
    mutation_performed = $true; inference_sessions_consumed = 0
  })
  Write-Host "[evidence1-new-unattended-retry-custody] PASS: $custodyFull"
} catch {
  Write-Error "HARD STOP: $($_.Exception.Message)"
  exit 1
} finally {
  if ($mountedVhd) { Dismount-VHD -Path $mountedVhd.Path -ErrorAction SilentlyContinue }
}
