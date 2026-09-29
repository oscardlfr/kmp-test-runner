param(
  [ValidateSet('Verify', 'Seal')]
  [string]$Mode = 'Verify',
  [string]$ProfilePath = '',
  [Parameter(Mandatory = $true)] [string]$InputLockPath,
  [Parameter(Mandatory = $true)] [string]$GuestCredentialPath,
  [string]$ReceiptPath = '',
  [string]$AuthorizationPhrase = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$RequiredSealPhrase = 'authorize seal evidence1 windows post-os boundary'
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrWhiteSpace($ProfilePath)) { $ProfilePath = Join-Path $scriptRoot 'evidence1-windows-hyperv-v1.json' }
Import-Module (Join-Path $scriptRoot 'Evidence1.Provisioning.psm1') -Force

function Fail([string]$Code) { Write-Error "HARD STOP: $Code"; exit 1 }

$session = $null
$mutationPerformed = $false
try {
  $receiptFull = New-E1ReceiptPath $ReceiptPath ("post-os-" + $Mode.ToLowerInvariant())
  $credentialFull = Assert-E1PathInside $GuestCredentialPath @('C:\kmp-eval\scratch', [IO.Path]::GetTempPath()) 'guest_credential_path_outside_scratch'
  if ($Mode -ceq 'Seal' -and $AuthorizationPhrase -cne $RequiredSealPhrase) { throw 'exact_post_os_seal_authorization_required' }
  $plan = Get-E1ProvisioningPlan $ProfilePath $InputLockPath -AllowSealedRuntimeCommitDrift
  $profile = $plan.profile
  Assert-E1Administrator
  if (-not (Test-Path -LiteralPath $credentialFull -PathType Leaf)) { throw 'guest_credential_missing' }
  Import-Module Hyper-V -ErrorAction Stop
  $vm = Get-VM -Name $profile.vm.name -ErrorAction SilentlyContinue
  if (-not $vm) { throw 'vm_missing' }
  if ([string]$vm.State -cne 'Running') { throw 'vm_must_be_running' }
  $adapters = @(Get-VMNetworkAdapter -VM $vm)
  if ($adapters.Count -ne 1 -or -not [string]::IsNullOrWhiteSpace([string]$adapters[0].SwitchName)) {
    throw 'vm_network_not_disconnected'
  }
  $stored = Import-Clixml -LiteralPath $credentialFull
  if ([string]$stored.UserName -cne [string]$profile.guest.local_user) { throw 'guest_credential_identity_mismatch' }
  $credential = [pscredential]::new("$($profile.guest.computer_name)\$($stored.UserName)", $stored.Password)
  $session = New-PSSession -VMName $profile.vm.name -Credential $credential -ErrorAction Stop
  $guest = Invoke-Command -Session $session -ScriptBlock {
    param($Profile)
    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'
    if ($env:COMPUTERNAME -ine [string]$Profile.guest.computer_name) { throw 'guest_computer_identity_mismatch' }
    if ($env:PROCESSOR_ARCHITECTURE -cne 'AMD64') { throw 'guest_os_architecture_mismatch' }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    if ($identity.Name.Split('\')[-1] -cne [string]$Profile.guest.local_user) { throw 'guest_user_identity_mismatch' }
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'guest_administrator_required' }
    $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
    $caption = [string]$os.Caption
    if ($caption -notmatch '^Microsoft Windows 11 Pro$') { throw 'guest_os_edition_mismatch' }
    [ordered]@{
      computer_name = [string]$env:COMPUTERNAME
      local_user = [string]$Profile.guest.local_user
      user_sid = [string]$identity.User.Value
      os_caption = $caption
      os_version = [string]$os.Version
      os_build = [string]$os.BuildNumber
      architecture = 'x64'
      administrator = $true
      powershell_direct = $true
    }
  } -ArgumentList $profile

  $dvdDrives = @(Get-VMDvdDrive -VM $vm)
  if ($Mode -ceq 'Verify') {
    if ($dvdDrives.Count -ne 1 -or [string]::IsNullOrWhiteSpace([string]$dvdDrives[0].Path)) { throw 'installation_media_missing' }
  } else {
    if ($dvdDrives.Count -gt 1) { throw 'vm_dvd_contract_mismatch' }
    if ($dvdDrives.Count -eq 1 -and -not [string]::IsNullOrWhiteSpace([string]$dvdDrives[0].Path)) {
      $dvdDrives[0] | Set-VMDvdDrive -Path $null
      $mutationPerformed = $true
    }
    $afterDvd = @(Get-VMDvdDrive -VM $vm)
    if ($afterDvd.Count -gt 1 -or @($afterDvd | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_.Path) }).Count -ne 0) {
      throw 'installation_media_eject_failed'
    }
  }
  Write-E1ReceiptAtomically $receiptFull ([ordered]@{
    schema = 1; verdict = 'PASS'; mode = $Mode; profile_id = $profile.profile_id
    profile_sha256 = Get-E1Sha256 $ProfilePath; input_lock_sha256 = Get-E1Sha256 $InputLockPath
    vm_id = ([string]$vm.Id).ToLowerInvariant(); guest_identity = $guest
    generated_at_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    network_state = 'disconnected'; installation_media_ejected = ($Mode -ceq 'Seal')
    mutation_performed = $mutationPerformed; auth_material_copied = $false; auth_material_read = $false
    private_paths_persisted = $false; guest_windows_credential_value_persisted = $false
    inference_sessions_consumed = 0; next_phase = if ($Mode -ceq 'Seal') { 'bootstrap-toolchain' } else { 'seal-post-os' }
  })
  Write-Host "[evidence1-post-os-transition] $Mode PASS: $receiptFull"
} catch {
  $reason = Get-E1ClosedReason ([string]$_.Exception.Message) (@(
    'receipt_path_outside_scratch','receipt_already_exists','guest_credential_path_outside_scratch',
    'exact_post_os_seal_authorization_required','profile_missing','profile_invalid_json','profile_identity_mismatch',
    'profile_contract_mismatch','input_lock_missing','input_lock_invalid_json','input_lock_contract_mismatch',
    'iso_missing','iso_size_mismatch','iso_hash_mismatch','artifact_cardinality_mismatch','artifact_identity_mismatch',
    'administrator_required','guest_credential_missing','guest_credential_identity_mismatch','vm_missing',
    'vm_must_be_running','vm_network_not_disconnected','guest_computer_identity_mismatch',
    'guest_os_architecture_mismatch','guest_user_identity_mismatch','guest_administrator_required',
    'guest_os_edition_mismatch','vm_dvd_contract_mismatch','installation_media_missing','installation_media_eject_failed'
  ) + @(Get-E1HostDependencyFailureCodes)) 'post_os_transition_failed'
  try {
    $receiptFull = New-E1ReceiptPath $ReceiptPath ("post-os-" + $Mode.ToLowerInvariant() + '-failed')
    Write-E1ReceiptAtomically $receiptFull ([ordered]@{
      schema = 1; verdict = 'FAIL'; mode = $Mode; reason_code = $reason
      generated_at_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
      mutation_performed = $mutationPerformed; auth_material_copied = $false; auth_material_read = $false
      private_paths_persisted = $false; guest_windows_credential_value_persisted = $false
      inference_sessions_consumed = 0
    })
  } catch { }
  Fail $reason
} finally {
  if ($session) { Remove-PSSession -Session $session -ErrorAction SilentlyContinue }
}
