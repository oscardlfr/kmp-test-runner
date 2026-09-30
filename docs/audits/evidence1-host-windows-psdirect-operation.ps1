param(
  [ValidateSet('Shutdown')] [string]$Mode,
  [Parameter(Mandatory = $true)] [string]$GuestCredentialPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$vmName = 'Evidence1-Runner-E2E'
$guestName = 'Evidence1E2E'
$full = [IO.Path]::GetFullPath($GuestCredentialPath)
$scratch = [IO.Path]::GetFullPath('C:\kmp-eval\scratch').TrimEnd('\') + '\'
if (-not $full.StartsWith($scratch, [StringComparison]::OrdinalIgnoreCase) -or
    -not (Test-Path -LiteralPath $full -PathType Leaf)) { throw 'guest_credential_path_outside_scratch' }
$stored = Import-Clixml -LiteralPath $full
if ([string]$stored.UserName -cne $guestName) { throw 'guest_credential_identity_mismatch' }
$credential = [pscredential]::new("$guestName\$guestName", $stored.Password)
$session = $null
try {
  $session = New-PSSession -VMName $vmName -Credential $credential -ErrorAction Stop
  Invoke-Command -Session $session -ScriptBlock {
    if ($env:COMPUTERNAME -ine 'Evidence1E2E') { throw 'guest_computer_identity_mismatch' }
    & (Join-Path $env:SystemRoot 'System32\shutdown.exe') /s /t 0 /d p:0:0 /c 'Evidence1 toolchain checkpoint boundary' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'guest_graceful_shutdown_dispatch_failed' }
  }
} finally {
  if ($session) { Remove-PSSession -Session $session -ErrorAction SilentlyContinue }
}
