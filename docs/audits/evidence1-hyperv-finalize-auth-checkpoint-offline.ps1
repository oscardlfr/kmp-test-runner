#Requires -RunAsAdministrator

param(
  [string]$VMName = 'Evidence1-Runner',
  [string]$GuestUserName = 'Evidence1',
  [string]$ToolingCheckpointName = 'Evidence1-ready-tools-claude-2.1.238',
  [switch]$ReplaceExistingCheckpoint,
  [string]$ReportPath = 'C:\kmp-eval\scratch\hyperv-finalize-auth-checkpoint-offline\HYPERV-FINALIZE-AUTH-CHECKPOINT-OFFLINE.json'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Fail($Message) {
  Write-Error "HARD STOP: $Message"
  exit 1
}

function Resolve-FullPath([string]$Path) {
  return [System.IO.Path]::GetFullPath($Path)
}

function Assert-PathInside([string]$Candidate, [string]$Root, [string]$Label) {
  $candidateFull = Resolve-FullPath $Candidate
  $rootFull = (Resolve-FullPath $Root).TrimEnd('\') + '\'
  if (-not $candidateFull.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase)) {
    Fail "$Label path is outside expected root: $candidateFull"
  }
}

function File-Fact([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) {
    return [ordered]@{ exists = $false }
  }
  $item = Get-Item -LiteralPath $Path
  return [ordered]@{
    exists = $true
    length = $item.Length
    last_write_time_utc = $item.LastWriteTimeUtc.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  }
}

function Directory-Facts([string]$Path, [int]$MaxFiles = 0) {
  if (-not (Test-Path -LiteralPath $Path)) {
    return [ordered]@{
      exists = $false
      file_count = 0
      non_empty_file_count = 0
      files = @()
    }
  }

  $files = @(Get-ChildItem -LiteralPath $Path -Recurse -Force -File -ErrorAction SilentlyContinue |
    Sort-Object FullName)
  return [ordered]@{
    exists = $true
    file_count = $files.Count
    non_empty_file_count = @($files | Where-Object Length -gt 0).Count
    files = if ($MaxFiles -gt 0) {
      @($files | Select-Object -First $MaxFiles | ForEach-Object {
        [ordered]@{
          relative_path = $_.FullName.Substring($Path.Length).TrimStart('\')
          length = $_.Length
          last_write_time_utc = $_.LastWriteTimeUtc.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
        }
      })
    } else {
      @()
    }
  }
}

Assert-PathInside $ReportPath 'C:\kmp-eval\scratch\' 'report'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ReportPath) | Out-Null

$vm = Get-VM -Name $VMName -ErrorAction Stop
if ($vm.State -ne 'Off') {
  Write-Host "[hyperv-finalize-auth-offline] turning off $VMName from state $($vm.State)"
  Stop-VM -Name $VMName -TurnOff -Force
}

$activeDisk = Get-VMHardDiskDrive -VMName $VMName | Select-Object -First 1
if (-not $activeDisk -or -not $activeDisk.Path) {
  Fail "could not resolve active VM disk for $VMName"
}
$vhdPath = Resolve-FullPath $activeDisk.Path
Assert-PathInside $vhdPath 'C:\kmp-eval\hyperv\' 'active VHD'

$mount = $null
try {
  $mount = Mount-VHD -Path $vhdPath -Passthru
  $disk = $mount | Get-Disk
  $volume = $disk | Get-Partition | Get-Volume | Where-Object {
    $_.DriveLetter -and (Test-Path "$($_.DriveLetter):\Windows")
  } | Select-Object -First 1
  if (-not $volume) {
    Fail 'could not find mounted Windows volume in VHD'
  }

  $driveRoot = "$($volume.DriveLetter):\"
  $userRoot = Join-Path $driveRoot "Users\$GuestUserName"
  if (-not (Test-Path -LiteralPath $userRoot)) {
    Fail "guest user profile not found: $userRoot"
  }

  $startupVerifier = Join-Path $userRoot 'AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\Evidence1AuthVerify.cmd'
  $guestVerifierDir = Join-Path $driveRoot 'kmp-eval\scratch\guest-auth-verify'
  Remove-Item -LiteralPath $startupVerifier -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $guestVerifierDir -Recurse -Force -ErrorAction SilentlyContinue

  $candidateDirs = @(
    (Join-Path $userRoot '.claude'),
    (Join-Path $userRoot '.claude.json'),
    (Join-Path $userRoot 'AppData\Roaming\Claude'),
    (Join-Path $userRoot 'AppData\Roaming\claude'),
    (Join-Path $userRoot 'AppData\Local\Claude'),
    (Join-Path $userRoot 'AppData\Local\claude')
  )

  $candidateFacts = @()
  foreach ($candidate in $candidateDirs) {
    if (Test-Path -LiteralPath $candidate -PathType Container) {
      $candidateFacts += [ordered]@{
        path_kind = 'directory'
        relative_path = $candidate.Substring($driveRoot.Length)
        facts = Directory-Facts $candidate
      }
    } elseif (Test-Path -LiteralPath $candidate -PathType Leaf) {
      $candidateFacts += [ordered]@{
        path_kind = 'file'
        relative_path = $candidate.Substring($driveRoot.Length)
        facts = File-Fact $candidate
      }
    } else {
      $candidateFacts += [ordered]@{
        path_kind = 'missing'
        relative_path = $candidate.Substring($driveRoot.Length)
        facts = [ordered]@{ exists = $false }
      }
    }
  }

  $claudeDesktopLauncher = Join-Path $userRoot 'Desktop\Claude Login.cmd'
  $nonEmptyAuthArtifacts = 0
  foreach ($fact in $candidateFacts) {
    if ($fact.path_kind -eq 'directory' -and $fact.facts.non_empty_file_count -gt 0) {
      $nonEmptyAuthArtifacts += $fact.facts.non_empty_file_count
    }
    if ($fact.path_kind -eq 'file' -and $fact.facts.exists -and $fact.facts.length -gt 0) {
      $nonEmptyAuthArtifacts += 1
    }
  }

  if ($nonEmptyAuthArtifacts -lt 1) {
    $partial = [ordered]@{
      verdict = 'FAIL'
      generated_at_utc = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
      vm_name = $VMName
      vhd_path = $vhdPath
      password_values_logged = $false
      file_contents_read = $false
      claude_auth_artifacts = $candidateFacts
      claude_desktop_launcher = File-Fact $claudeDesktopLauncher
      guest_verifier_dir = Directory-Facts $guestVerifierDir
    }
    $partial | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $ReportPath -Encoding UTF8
    Fail "no non-empty Claude auth artifact found; see $ReportPath"
  }

  $inspection = [ordered]@{
    password_values_logged = $false
    file_contents_read = $false
    non_empty_auth_artifact_count = $nonEmptyAuthArtifacts
    claude_auth_artifacts = $candidateFacts
    claude_desktop_launcher = File-Fact $claudeDesktopLauncher
    guest_verifier_dir = Directory-Facts $guestVerifierDir
  }
} finally {
  if ($mount) {
    Dismount-VHD -Path $vhdPath -ErrorAction SilentlyContinue
  }
}

$existing = $null
try {
  $existing = Get-VMSnapshot -VMName $VMName -Name $ToolingCheckpointName -ErrorAction Stop
} catch [Microsoft.HyperV.PowerShell.VirtualizationException] {
  $existing = $null
}
if ($existing) {
  if (-not $ReplaceExistingCheckpoint) {
    Fail "checkpoint already exists: $ToolingCheckpointName. Pass -ReplaceExistingCheckpoint after confirming replacement."
  }
  Remove-VMSnapshot -VMSnapshot $existing
}

$checkpoint = Checkpoint-VM -Name $VMName -SnapshotName $ToolingCheckpointName -Passthru

$report = [ordered]@{
  verdict = 'PASS'
  generated_at_utc = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  vm_name = $VMName
  vm_state_at_checkpoint = [string](Get-VM -Name $VMName).State
  tooling_checkpoint = $ToolingCheckpointName
  checkpoint_creation_time = $checkpoint.CreationTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  vhd_path = $vhdPath
  auth_verification_method = 'operator-confirmed interactive Claude login plus offline auth-artifact presence only; this does not prove that the remote service accepts the credential'
  inspection = $inspection
  next_action = 'After every checkpoint restore, run the separately authorized remote auth canary, then regenerate readiness. A fresh successful canary is required before a separately authorized Stage B live run.'
}
$report | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $ReportPath -Encoding UTF8
Write-Host "[hyperv-finalize-auth-offline] PASS: $ReportPath"
