#Requires -RunAsAdministrator

param(
  [Parameter(Mandatory)][string]$ProfilePath,
  [Parameter(Mandatory)][string]$CreatedInspectionReceiptPath,
  [Parameter(Mandatory)][string]$GuestCredentialPath,
  [Parameter(Mandatory)][string]$ArtifactPath,
  [Parameter(Mandatory)][string]$ExpectedArtifactSha256,
  [Parameter(Mandatory)][long]$ExpectedArtifactBytes,
  [Parameter(Mandatory)][string]$ExpectedCodexVersion,
  [Parameter(Mandatory)][string]$ReportPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ExpectedPublisher = 'CN="OpenAI OpCo, LLC", O="OpenAI OpCo, LLC", L=San Francisco, S=California, C=US'
$requiredRelativeFiles = [string[]]@(
  'codex-package.json',
  'bin\codex-code-mode-host.exe',
  'bin\codex.exe',
  'codex-path\rg.exe',
  'codex-resources\codex-command-runner.exe',
  'codex-resources\codex-windows-sandbox-setup.exe'
)
$publisherSignedRelativeFiles = [string[]]@(
  'bin\codex-code-mode-host.exe',
  'bin\codex.exe',
  'codex-resources\codex-command-runner.exe',
  'codex-resources\codex-windows-sandbox-setup.exe'
)
$priorRoot = 'C:\Evidence1Toolchain\codex-cli\0.153.4'
$targetRoot = Join-Path 'C:\Evidence1Toolchain\codex-cli' $ExpectedCodexVersion

Import-Module (Join-Path $PSScriptRoot 'evidence1-vm-identity-contract.psm1') -Force -DisableNameChecking

function Fail([string]$Message) { Write-Error "HARD STOP: $Message"; exit 1 }

function Get-Sha256([string]$Path) {
  $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  try {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($stream)) -replace '-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
  } finally { $stream.Dispose() }
}

function Assert-PathInside([string]$Candidate, [string]$Root, [string]$Code) {
  $full = [IO.Path]::GetFullPath($Candidate)
  $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd('\')
  if (-not $full.StartsWith($rootFull + '\', [StringComparison]::OrdinalIgnoreCase)) { throw $Code }
  return $full
}

function Assert-OfficialCodexLayout([string]$Root) {
  $actual = @(Get-ChildItem -LiteralPath $Root -Recurse -File -Force | ForEach-Object {
    $_.FullName.Substring($Root.Length).TrimStart('\')
  } | Sort-Object)
  $expected = @($requiredRelativeFiles | Sort-Object)
  if (@(Compare-Object $actual $expected -CaseSensitive).Count -ne 0) { throw 'codex_upgrade_archive_layout_mismatch' }
  foreach ($relative in $requiredRelativeFiles) {
    $path = Join-Path $Root $relative
    $item = Get-Item -LiteralPath $path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'codex_upgrade_archive_reparse_rejected' }
    if ($publisherSignedRelativeFiles -ccontains $relative) {
      $signature = Get-AuthenticodeSignature -LiteralPath $path -ErrorAction Stop
      if ([string]$signature.Status -cne 'Valid' -or -not $signature.SignerCertificate -or
          [string]$signature.SignerCertificate.Subject -cne $ExpectedPublisher) {
        throw 'codex_upgrade_publisher_signature_invalid'
      }
    }
  }
  $priorHome = $env:CODEX_HOME
  $probeHome = Join-Path (Split-Path -Parent $Root) ('Evidence1CodexHostProbe-' + [guid]::NewGuid().ToString('N'))
  try {
    New-Item -ItemType Directory -Path $probeHome | Out-Null
    $env:CODEX_HOME = $probeHome
    $version = [string](& (Join-Path $Root 'bin\codex.exe') --version 2>$null | Select-Object -First 1)
    $exitCode = $LASTEXITCODE
  } finally {
    $env:CODEX_HOME = $priorHome
    if (Test-Path -LiteralPath $probeHome) { Remove-Item -LiteralPath $probeHome -Recurse -Force }
  }
  if ($exitCode -ne 0 -or $version.Trim() -cne "codex-cli $ExpectedCodexVersion") { throw 'codex_upgrade_version_mismatch' }
}

try {
  if ($ExpectedArtifactSha256 -cnotmatch '^[0-9a-f]{64}$' -or $ExpectedArtifactBytes -lt 1 -or
      $ExpectedCodexVersion -cnotmatch '^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$') {
    throw 'codex_upgrade_expected_identity_invalid'
  }
  $artifactFull = Assert-PathInside $ArtifactPath 'C:\kmp-eval\scratch' 'codex_upgrade_artifact_path_invalid'
  $reportFull = Assert-PathInside $ReportPath 'C:\kmp-eval\scratch' 'codex_upgrade_report_path_invalid'
  if (-not (Test-Path -LiteralPath $artifactFull -PathType Leaf)) { throw 'codex_upgrade_artifact_missing' }
  $artifact = Get-Item -LiteralPath $artifactFull -Force
  $artifactSha = Get-Sha256 $artifactFull
  if ($artifact.Length -ne $ExpectedArtifactBytes -or $artifactSha -cne $ExpectedArtifactSha256) {
    throw 'codex_upgrade_artifact_identity_mismatch'
  }

  $hostExtract = Join-Path (Split-Path -Parent $artifactFull) ('.codex-verify-' + [guid]::NewGuid().ToString('N'))
  try {
    Expand-Archive -LiteralPath $artifactFull -DestinationPath $hostExtract -ErrorAction Stop
    Assert-OfficialCodexLayout $hostExtract
  } finally {
    if (Test-Path -LiteralPath $hostExtract) { Remove-Item -LiteralPath $hostExtract -Recurse -Force }
  }

  $vmIdentity = Get-Evidence1CanonicalE2EVmIdentity -ProfilePath $ProfilePath `
    -CreatedInspectionReceiptPath $CreatedInspectionReceiptPath -GuestCredentialPath $GuestCredentialPath
  $vm = Get-VM -Id ([guid]$vmIdentity.vm_id) -ErrorAction Stop
  if ($vm.Name -cne $vmIdentity.vm_name -or $vm.State -ne 'Running') { throw 'codex_upgrade_vm_not_running' }

  $storedCredential = Import-Clixml -LiteralPath $GuestCredentialPath
  $credential = [pscredential]::new("$($vmIdentity.guest_computer_name)\$($vmIdentity.guest_user)", $storedCredential.Password)
  $session = New-PSSession -VMId ([guid]$vmIdentity.vm_id) -Credential $credential -ErrorAction Stop
  try {
    $guestStage = "C:\Evidence1Provisioning\staging\codex-cli-$ExpectedCodexVersion-$([guid]::NewGuid().ToString('N')).zip"
    Copy-Item -LiteralPath $artifactFull -Destination $guestStage -ToSession $session -ErrorAction Stop
    $guest = Invoke-Command -Session $session -ScriptBlock {
      param($GuestStage,$ExpectedVersion,$ExpectedSha,$ExpectedBytes,$ExpectedPublisher,$RequiredRelativeFiles,$PublisherSignedRelativeFiles,$PriorRoot,$TargetRoot)
      Set-StrictMode -Version Latest
      $ErrorActionPreference = 'Stop'

      function Get-GuestSha256([string]$Path) {
        $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        try {
          $sha = [Security.Cryptography.SHA256]::Create()
          try { return ([BitConverter]::ToString($sha.ComputeHash($stream)) -replace '-', '').ToLowerInvariant() }
          finally { $sha.Dispose() }
        } finally { $stream.Dispose() }
      }
      function Assert-GuestLayout([string]$Root) {
        $actual = @(Get-ChildItem -LiteralPath $Root -Recurse -File -Force | Where-Object Name -ne '.evidence1-artifact.json' | ForEach-Object {
          $_.FullName.Substring($Root.Length).TrimStart('\')
        } | Sort-Object)
        $expected = @($RequiredRelativeFiles | Sort-Object)
        if (@(Compare-Object $actual $expected -CaseSensitive).Count -ne 0) { throw 'codex_upgrade_guest_archive_layout_mismatch' }
        foreach ($relative in $RequiredRelativeFiles) {
          $path = Join-Path $Root $relative
          $item = Get-Item -LiteralPath $path -Force
          if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'codex_upgrade_guest_reparse_rejected' }
          if ($PublisherSignedRelativeFiles -ccontains $relative) {
            $signature = Get-AuthenticodeSignature -LiteralPath $path -ErrorAction Stop
            if ([string]$signature.Status -cne 'Valid' -or -not $signature.SignerCertificate -or
                [string]$signature.SignerCertificate.Subject -cne $ExpectedPublisher) {
              throw 'codex_upgrade_guest_publisher_signature_invalid'
            }
          }
        }
        $priorHome = $env:CODEX_HOME
        $probeHome = Join-Path (Split-Path -Parent $Root) ('Evidence1CodexGuestProbe-' + [guid]::NewGuid().ToString('N'))
        try {
          New-Item -ItemType Directory -Path $probeHome | Out-Null
          $env:CODEX_HOME = $probeHome
          $version = [string](& (Join-Path $Root 'bin\codex.exe') --version 2>$null | Select-Object -First 1)
          $exitCode = $LASTEXITCODE
        } finally {
          $env:CODEX_HOME = $priorHome
          if (Test-Path -LiteralPath $probeHome) { Remove-Item -LiteralPath $probeHome -Recurse -Force }
        }
        if ($exitCode -ne 0 -or $version.Trim() -cne "codex-cli $ExpectedVersion") { throw 'codex_upgrade_guest_version_mismatch' }
      }
      function Get-GuestTreeIdentity([string]$Root) {
        $files = @(Get-ChildItem -LiteralPath $Root -Recurse -File -Force | Where-Object Name -ne '.evidence1-artifact.json' | Sort-Object FullName)
        $builder = [Text.StringBuilder]::new(); [int64]$bytes = 0
        foreach ($file in $files) {
          $relative = $file.FullName.Substring($Root.Length).TrimStart('\').Replace('\','/')
          $null = $builder.Append($relative).Append("`0").Append($file.Length).Append("`0").Append((Get-GuestSha256 $file.FullName)).Append("`n")
          $bytes += $file.Length
        }
        $sha = [Security.Cryptography.SHA256]::Create()
        try { $digest = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($builder.ToString()))) -replace '-', '').ToLowerInvariant() }
        finally { $sha.Dispose() }
        return [ordered]@{ sha256=$digest; file_count=$files.Count; bytes=$bytes }
      }

      $incoming = $null; $backup = $null
      try {
        if ((Get-Item -LiteralPath $GuestStage).Length -ne $ExpectedBytes -or (Get-GuestSha256 $GuestStage) -cne $ExpectedSha) {
          throw 'codex_upgrade_guest_artifact_identity_mismatch'
        }
        $parent = Split-Path -Parent $TargetRoot
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
        $incoming = Join-Path $parent ('.incoming-' + [guid]::NewGuid().ToString('N'))
        Expand-Archive -LiteralPath $GuestStage -DestinationPath $incoming -ErrorAction Stop
        Assert-GuestLayout $incoming
        $tree = Get-GuestTreeIdentity $incoming
        [IO.File]::WriteAllText((Join-Path $incoming '.evidence1-artifact.json'), (@{
          id='codex-cli'; version=$ExpectedVersion; sha256=$ExpectedSha; bytes=$ExpectedBytes
          installed_tree_sha256=$tree.sha256; installed_file_count=$tree.file_count; installed_bytes=$tree.bytes
          transaction_id=('runtime-upgrade-' + [guid]::NewGuid().ToString('N'))
        } | ConvertTo-Json), [Text.UTF8Encoding]::new($false))

        $changed = $true
        if (Test-Path -LiteralPath $TargetRoot) {
          $markerPath = Join-Path $TargetRoot '.evidence1-artifact.json'
          if (Test-Path -LiteralPath $markerPath -PathType Leaf) {
            $marker = Get-Content -Raw -LiteralPath $markerPath | ConvertFrom-Json
            if ($marker.version -ceq $ExpectedVersion -and $marker.sha256 -ceq $ExpectedSha -and [int64]$marker.bytes -eq $ExpectedBytes) {
              Assert-GuestLayout $TargetRoot
              $changed = $false
            }
          }
        }
        if ($changed) {
          if (Test-Path -LiteralPath $TargetRoot) {
            $backup = "$TargetRoot.backup-$([guid]::NewGuid().ToString('N'))"
            Move-Item -LiteralPath $TargetRoot -Destination $backup
          }
          try {
            Move-Item -LiteralPath $incoming -Destination $TargetRoot
            $incoming = $null
            Assert-GuestLayout $TargetRoot
            if ($backup) { Remove-Item -LiteralPath $backup -Recurse -Force; $backup = $null }
          } catch {
            if (Test-Path -LiteralPath $TargetRoot) { Remove-Item -LiteralPath $TargetRoot -Recurse -Force }
            if ($backup -and (Test-Path -LiteralPath $backup)) { Move-Item -LiteralPath $backup -Destination $TargetRoot; $backup = $null }
            throw
          }
        }

        $targetBin = Join-Path $TargetRoot 'bin'
        $userPath = [string][Environment]::GetEnvironmentVariable('Path', 'User')
        $parts = @($userPath.Split(';') | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
        $next = @($targetBin) + @($parts | Where-Object {
          -not $_.Equals($PriorRoot, [StringComparison]::OrdinalIgnoreCase) -and
          -not $_.Equals($TargetRoot, [StringComparison]::OrdinalIgnoreCase) -and
          -not $_.Equals($targetBin, [StringComparison]::OrdinalIgnoreCase)
        })
        [Environment]::SetEnvironmentVariable('Path', ($next -join ';'), 'User')

        [ordered]@{
          verdict='PASS'; changed=$changed; cli_version="codex-cli $ExpectedVersion"
          artifact_sha256=$ExpectedSha; artifact_bytes=$ExpectedBytes
          canonical_root=$TargetRoot; command_path=(Join-Path $targetBin 'codex.exe')
          installed_file_count=$tree.file_count; installed_bytes=$tree.bytes
          prior_runtime_retained=(Test-Path -LiteralPath $PriorRoot); user_path_updated=$true
          companion_binaries_present=$true
        }
      } finally {
        Remove-Item -LiteralPath $GuestStage -Force -ErrorAction SilentlyContinue
        if ($incoming -and (Test-Path -LiteralPath $incoming)) { Remove-Item -LiteralPath $incoming -Recurse -Force }
        if ($backup -and (Test-Path -LiteralPath $backup) -and -not (Test-Path -LiteralPath $TargetRoot)) { Move-Item -LiteralPath $backup -Destination $TargetRoot }
      }
    } -ArgumentList $guestStage,$ExpectedCodexVersion,$ExpectedArtifactSha256,$ExpectedArtifactBytes,$ExpectedPublisher,$requiredRelativeFiles,$publisherSignedRelativeFiles,$priorRoot,$targetRoot -ErrorAction Stop
  } finally {
    if ($session) { Remove-PSSession -Session $session -ErrorAction SilentlyContinue }
  }

  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $reportFull) | Out-Null
  $report = [ordered]@{
    schema=2; verdict='PASS'; generated_at_utc=[DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    vm_name=$vmIdentity.vm_name; vm_id=$vmIdentity.vm_id; to_version=$ExpectedCodexVersion
    artifact_sha256=$artifactSha; artifact_bytes=[int64]$artifact.Length
    changed=[bool]$guest.changed; canonical_root=$targetRoot; command_path=[string]$guest.command_path
    installed_file_count=[int]$guest.installed_file_count; installed_bytes=[int64]$guest.installed_bytes
    companion_binaries_present=[bool]$guest.companion_binaries_present
    prior_runtime_retained=[bool]$guest.prior_runtime_retained; user_path_updated=[bool]$guest.user_path_updated
    auth_material_read=$false; auth_material_copied=$false; network_used=$false
    guest_credential_value_persisted=$false; private_artifact_path_persisted=$false
    inference_sessions_consumed=0
  }
  [IO.File]::WriteAllText($reportFull, ($report | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
  Write-Host "[evidence1-hyperv-upgrade-canonical-codex-cli-direct] PASS: $reportFull"
} catch { Fail ([string]$_.Exception.Message) }
