Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:E1CanonicalProfileId = 'evidence1-windows-hyperv-e2e-v1'
$script:E1CanonicalVmName = 'Evidence1-Runner-E2E'

function Get-E1WindowsProvisioningSha256([string]$Path) {
  $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  try {
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($hasher.ComputeHash($stream)) -replace '-', '').ToLowerInvariant() }
    finally { $hasher.Dispose() }
  } finally { $stream.Dispose() }
}

function Assert-E1WindowsProvisioningScratchPath([string]$Path, [string]$Code, [switch]$MustExist) {
  if ([string]::IsNullOrWhiteSpace($Path)) { throw $Code }
  $full = [IO.Path]::GetFullPath($Path)
  $root = [IO.Path]::GetFullPath('C:\kmp-eval\scratch').TrimEnd('\') + '\'
  if (-not $full.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { throw $Code }
  $cursor = if (Test-Path -LiteralPath $full) { $full } else { Split-Path -Parent $full }
  while ($cursor) {
    if (Test-Path -LiteralPath $cursor) {
      $item = Get-Item -LiteralPath $cursor -Force
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw $Code }
    }
    $parent = Split-Path -Parent $cursor
    if (-not $parent -or $parent -ceq $cursor) { break }
    $cursor = $parent
  }
  if ($MustExist -and -not (Test-Path -LiteralPath $full -PathType Leaf)) { throw $Code }
  return $full
}

function Read-E1WindowsProvisioningReceipt([string]$Path, [string]$Label) {
  $full = Assert-E1WindowsProvisioningScratchPath $Path "${Label}_path_outside_scratch" -MustExist
  $stream = $null
  try {
    $stream = [IO.File]::Open($full, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    if ($stream.Length -lt 2 -or $stream.Length -gt 1MB) { throw "${Label}_invalid_json" }
    $bytes = New-Object byte[] ([int]$stream.Length)
    $offset = 0
    while ($offset -lt $bytes.Length) {
      $read = $stream.Read($bytes, $offset, $bytes.Length - $offset)
      if ($read -le 0) { throw "${Label}_invalid_json" }
      $offset += $read
    }
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { $sha = ([BitConverter]::ToString($hasher.ComputeHash($bytes)) -replace '-', '').ToLowerInvariant() }
    finally { $hasher.Dispose() }
    try {
      $text = [Text.UTF8Encoding]::new($false, $true).GetString($bytes)
      if ($text.Length -gt 0 -and [int]$text[0] -eq 0xFEFF) { $text = $text.Substring(1) }
      $document = $text | ConvertFrom-Json -ErrorAction Stop
    } catch { throw "${Label}_invalid_json" }
    return [pscustomobject]@{ path = $full; sha256 = $sha; document = $document }
  } finally {
    if ($stream) { $stream.Dispose() }
  }
}

function Assert-E1WindowsProvisioningZeroInference($Receipt, [string]$Code) {
  if ($null -eq $Receipt.inference_sessions_consumed -or
      $Receipt.inference_sessions_consumed.GetType() -notin @([byte],[sbyte],[int16],[uint16],[int32],[uint32],[int64],[uint64]) -or
      [int64]$Receipt.inference_sessions_consumed -ne 0) { throw $Code }
}

function Assert-E1CanonicalE2EProfile([string]$ProfilePath) {
  try { $profile = Get-Content -LiteralPath $ProfilePath -Raw | ConvertFrom-Json -ErrorAction Stop }
  catch { throw 'canonical_e2e_profile_invalid' }
  if ($profile.schema_version -ne 2 -or $profile.profile_id -cne $script:E1CanonicalProfileId -or
      $profile.vm.name -cne $script:E1CanonicalVmName -or $profile.vm.root -cne 'C:\kmp-eval\hyperv-e2e' -or
      $profile.guest.computer_name -cne 'Evidence1E2E' -or $profile.guest.local_user -cne 'Evidence1E2E' -or
      $profile.os.installation_boundary -cne 'offline-apply' -or
      $profile.network.create_state -cne 'disconnected' -or
      $profile.network.bootstrap_state -cne 'disconnected' -or
      $profile.network.checkpoint_state -cne 'disconnected') { throw 'canonical_e2e_profile_invalid' }
  return $true
}

function Assert-E1WindowsProvisioningBinding($Receipt, [string]$ProfileSha256, [string]$InputLockSha256,
    [string]$VmId, [string]$Code) {
  if ($Receipt.verdict -cne 'PASS' -or $Receipt.profile_id -cne $script:E1CanonicalProfileId -or
      [string]$Receipt.profile_sha256 -cne $ProfileSha256 -or [string]$Receipt.input_lock_sha256 -cne $InputLockSha256 -or
      [string]$Receipt.vm_id -cnotmatch '^[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$' -or
      ([string]$Receipt.vm_id).ToLowerInvariant() -cne $VmId.ToLowerInvariant()) { throw $Code }
  Assert-E1WindowsProvisioningZeroInference $Receipt $Code
}

function Assert-E1WindowsProvisioningReceiptChain($Receipt, [string]$ExpectedOperation,
    [string]$ExpectedPriorSha256, [string]$ExpectedCoreSha256 = '') {
  $chain = $Receipt.receipt_chain
  if ($ExpectedPriorSha256 -cnotmatch '^[0-9a-f]{64}$' -or
      (-not [string]::IsNullOrEmpty($ExpectedCoreSha256) -and $ExpectedCoreSha256 -cnotmatch '^[0-9a-f]{64}$') -or
      -not $chain -or $chain.schema -ne 1 -or $chain.operation -cne $ExpectedOperation -or
      [string]$chain.prior_receipt_sha256 -cne $ExpectedPriorSha256 -or
      [string]$chain.core_receipt_sha256 -cnotmatch '^[0-9a-f]{64}$' -or
      (-not [string]::IsNullOrEmpty($ExpectedCoreSha256) -and
        [string]$chain.core_receipt_sha256 -cne $ExpectedCoreSha256)) {
    throw 'receipt_chain_binding_mismatch'
  }
  return $true
}

function Assert-E1CanonicalApplyReceipt($Receipt, [string]$ProfileSha256, [string]$InputLockSha256, [string]$VmId) {
  $code = 'apply_receipt_binding_mismatch'
  Assert-E1WindowsProvisioningBinding $Receipt $ProfileSha256 $InputLockSha256 $VmId $code
  if ($Receipt.schema -ne 1 -or $Receipt.mode -cne 'Apply' -or $Receipt.reason_code -ne $null -or
      $Receipt.vm_state -cne 'Off' -or $Receipt.network_used -ne $false -or $Receipt.network_state -cne 'disconnected' -or
      $Receipt.powershell_direct_ready -ne $true -or $Receipt.answer_files_absent -ne $true -or
      $Receipt.autologon_values_absent -ne $true -or $Receipt.auth_material_read -ne $false -or
      $Receipt.auth_material_copied -ne $false -or $Receipt.private_paths_persisted -ne $false -or
      $Receipt.next_phase -cne 'verify-and-seal-post-os') { throw $code }
  return $true
}

function Assert-E1CanonicalPostOsCoreReceipt($Receipt, [ValidateSet('Verify','Seal')] [string]$Mode,
    [string]$ProfileSha256, [string]$InputLockSha256, [string]$VmId) {
  $code = 'post_os_receipt_binding_mismatch'
  Assert-E1WindowsProvisioningBinding $Receipt $ProfileSha256 $InputLockSha256 $VmId $code
  $expectedEjected = $Mode -ceq 'Seal'
  $expectedNext = if ($Mode -ceq 'Seal') { 'bootstrap-toolchain' } else { 'seal-post-os' }
  if ($Receipt.schema -ne 1 -or $Receipt.mode -cne $Mode -or $Receipt.network_state -cne 'disconnected' -or
      $Receipt.installation_media_ejected -ne $expectedEjected -or
      ($Mode -ceq 'Verify' -and $Receipt.mutation_performed -ne $false) -or
      ($Mode -ceq 'Seal' -and $Receipt.mutation_performed -isnot [bool]) -or
      $Receipt.auth_material_copied -ne $false -or $Receipt.auth_material_read -ne $false -or
      $Receipt.private_paths_persisted -ne $false -or $Receipt.guest_windows_credential_value_persisted -ne $false -or
      $Receipt.next_phase -cne $expectedNext) { throw $code }
  return $true
}

function Assert-E1CanonicalPostOsReceipt($Receipt, [ValidateSet('Verify','Seal')] [string]$Mode,
    [string]$ProfileSha256, [string]$InputLockSha256, [string]$VmId, [string]$ExpectedPriorSha256) {
  $null = Assert-E1CanonicalPostOsCoreReceipt $Receipt $Mode $ProfileSha256 $InputLockSha256 $VmId
  $null = Assert-E1WindowsProvisioningReceiptChain $Receipt ("post-os-" + $Mode.ToLowerInvariant()) $ExpectedPriorSha256
  return $true
}

function Assert-E1CanonicalToolchainCoreReceipt($Receipt, [ValidateSet('Bootstrap','Verify')] [string]$Mode,
    [string]$ProfileSha256, [string]$InputLockSha256, [string]$VmId) {
  $code = 'toolchain_chain_receipt_binding_mismatch'
  Assert-E1WindowsProvisioningBinding $Receipt $ProfileSha256 $InputLockSha256 $VmId $code
  $expectedChanged = $Mode -ceq 'Bootstrap'
  if ($Receipt.schema -ne 2 -or $Receipt.mode -cne $Mode -or $Receipt.network_used -ne $false -or
      $Receipt.changed -ne $expectedChanged -or $Receipt.mutation_performed -ne $expectedChanged -or
      $Receipt.auth_material_copied -ne $false -or $Receipt.auth_material_read -ne $false -or
      $Receipt.private_paths_persisted -ne $false -or $Receipt.guest_windows_credential_value_persisted -ne $false -or
      $Receipt.next_phase -cne 'verify-offline') { throw $code }
  return $true
}

function Assert-E1CanonicalToolchainReceipt($Receipt, [ValidateSet('Bootstrap','Verify')] [string]$Mode,
    [string]$ProfileSha256, [string]$InputLockSha256, [string]$VmId, [string]$ExpectedPriorSha256) {
  $null = Assert-E1CanonicalToolchainCoreReceipt $Receipt $Mode $ProfileSha256 $InputLockSha256 $VmId
  $null = Assert-E1WindowsProvisioningReceiptChain $Receipt ("toolchain-" + $Mode.ToLowerInvariant()) $ExpectedPriorSha256
  return $true
}

function New-E1WindowsProvisioningChildReceiptPath([string]$ReceiptPath, [string]$Operation) {
  $final = Assert-E1WindowsProvisioningScratchPath $ReceiptPath 'receipt_path_outside_scratch'
  if (Test-Path -LiteralPath $final) { throw 'receipt_already_exists' }
  $parent = Split-Path -Parent $final
  New-Item -ItemType Directory -Path $parent -Force | Out-Null
  return Join-Path $parent ('.' + $Operation + '-core-' + [guid]::NewGuid().ToString('N') + '.json')
}

function Write-E1WindowsProvisioningChainedReceipt([string]$ReceiptPath, [string]$CoreReceiptPath,
    [string]$PriorReceiptPath, [string]$Operation) {
  $final = Assert-E1WindowsProvisioningScratchPath $ReceiptPath 'receipt_path_outside_scratch'
  if (Test-Path -LiteralPath $final) { throw 'receipt_already_exists' }
  $core = Read-E1WindowsProvisioningReceipt $CoreReceiptPath 'core_receipt'
  $prior = Read-E1WindowsProvisioningReceipt $PriorReceiptPath 'prior_receipt'
  $value = [ordered]@{}
  foreach ($property in @($core.document.PSObject.Properties)) { $value[[string]$property.Name] = $property.Value }
  $value.network_used = $false
  $value.auth_material_read = $false
  $value.auth_material_copied = $false
  $value.private_paths_persisted = $false
  $value.inference_sessions_consumed = 0
  if ($Operation -ceq 'checkpoint-toolchain') {
    $value.graceful_shutdown_intent_recorded = $true
    $value.graceful_shutdown_requested = $true
    $value.graceful_shutdown_completed = $true
    $value.hard_power_fallback_used = $false
    $value.network_state = 'disconnected'
  }
  $value.receipt_chain = [ordered]@{
    schema = 1; operation = $Operation; prior_receipt_sha256 = $prior.sha256
    core_receipt_sha256 = $core.sha256
  }
  $parent = Split-Path -Parent $final
  New-Item -ItemType Directory -Path $parent -Force | Out-Null
  $temp = "$final.$([guid]::NewGuid().ToString('N')).tmp"
  try {
    [IO.File]::WriteAllText($temp, ($value | ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
    [IO.File]::Move($temp, $final)
  } finally { Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue }
  $written = Read-E1WindowsProvisioningReceipt $final 'chained_receipt'
  $null = Assert-E1WindowsProvisioningReceiptChain $written.document $Operation $prior.sha256 $core.sha256
  return $written
}

function Invoke-E1WindowsProvisioningCore([string]$CorePath, [string[]]$Arguments,
    [ValidateRange(30,7200)] [int]$TimeoutSeconds) {
  if (-not (Test-Path -LiteralPath $CorePath -PathType Leaf)) { throw 'canonical_core_script_missing' }
  $command = Get-Command powershell.exe -ErrorAction SilentlyContinue
  if (-not $command -or -not (Test-Path -LiteralPath $command.Source -PathType Leaf)) { throw 'canonical_powershell_missing' }
  if (-not (Get-Command Invoke-E1OwnedProcess -ErrorAction SilentlyContinue)) { throw 'canonical_process_containment_missing' }
  $processRoot = 'C:\kmp-eval\scratch\evidence1-windows-provisioning\process'
  New-Item -ItemType Directory -Path $processRoot -Force | Out-Null
  $id = [guid]::NewGuid().ToString('N')
  $stdout = Join-Path $processRoot "$id.stdout.log"
  $stderr = Join-Path $processRoot "$id.stderr.log"
  try {
    $result = Invoke-E1OwnedProcess -Executable $command.Source `
      -Arguments (@('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$CorePath) + @($Arguments)) `
      -WorkingDirectory (Split-Path -Parent $CorePath) -Stdout $stdout -Stderr $stderr -Seconds $TimeoutSeconds
    if ([bool]$result.TimedOut) { throw 'canonical_core_process_timeout' }
    if (-not [bool]$result.CleanupOk) { throw 'canonical_core_process_containment_failed' }
    return [int]$result.ExitCode
  } finally {
    Remove-Item -LiteralPath $stdout,$stderr -Force -ErrorAction SilentlyContinue
  }
}

Export-ModuleMember -Function Get-E1WindowsProvisioningSha256,Assert-E1WindowsProvisioningScratchPath,Read-E1WindowsProvisioningReceipt,Assert-E1WindowsProvisioningReceiptChain,Assert-E1CanonicalE2EProfile,Assert-E1CanonicalApplyReceipt,Assert-E1CanonicalPostOsCoreReceipt,Assert-E1CanonicalPostOsReceipt,Assert-E1CanonicalToolchainCoreReceipt,Assert-E1CanonicalToolchainReceipt,New-E1WindowsProvisioningChildReceiptPath,Write-E1WindowsProvisioningChainedReceipt,Invoke-E1WindowsProvisioningCore
