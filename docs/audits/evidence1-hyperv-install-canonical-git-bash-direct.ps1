#Requires -RunAsAdministrator

param(
  [Parameter(Mandatory = $true)][string]$ProfilePath,
  [Parameter(Mandatory = $true)][string]$CreatedInspectionReceiptPath,
  [Parameter(Mandatory = $true)][string]$GuestCredentialPath,
  [Parameter(Mandatory = $true)][string]$ArtifactPath,
  [Parameter(Mandatory = $true)][string]$NormalizationReceiptPath,
  [Parameter(Mandatory = $true)][string]$ReportPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ExpectedUpstreamSha256 = '5aa8a20f6e9abb2c755f0e73c91c687701a46b309ad84a0ca6509380fa4ae290'
$ExpectedUpstreamBytes = 58960208
$ExpectedArtifactSha256 = '4259274edcab76f6fdc21ea2aac10f87dbb76171bf13568f701c6bfe247ce623'
$ExpectedArtifactBytes = 161786126
$TargetRoot = 'C:\Evidence1Toolchain\git-bash\2.55.0.windows.5'

Import-Module (Join-Path $PSScriptRoot 'evidence1-vm-identity-contract.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot 'evidence1-final-codex-host-contract.psm1') -Force -DisableNameChecking

function Get-Sha256([string]$Path) {
  $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  try {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($stream)) -replace '-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
  } finally { $stream.Dispose() }
}

function Get-TextSha256([string]$Text) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text))) -replace '-', '').ToLowerInvariant() }
  finally { $sha.Dispose() }
}

function Get-Tree([string]$Root) {
  $files = @(Get-ChildItem -LiteralPath $Root -Recurse -Force -File |
    Where-Object Name -ne '.evidence1-artifact.json' | Sort-Object FullName)
  if ($files.Count -lt 2 -or $files.Count -gt 20000) { throw 'git_bash_tree_file_count_invalid' }
  $builder = [Text.StringBuilder]::new(); [int64]$bytes = 0
  foreach ($file in $files) {
    if (($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'git_bash_tree_reparse_rejected' }
    $relative = $file.FullName.Substring($Root.Length).TrimStart('\').Replace('\','/')
    $null = $builder.Append($relative).Append("`0").Append($file.Length).Append("`0").Append((Get-Sha256 $file.FullName)).Append("`n")
    $bytes += [int64]$file.Length
  }
  return [ordered]@{sha256=Get-TextSha256 $builder.ToString();file_count=$files.Count;bytes=$bytes}
}

function Assert-InsideScratch([string]$Path,[string]$Code) {
  $full=[IO.Path]::GetFullPath($Path);$root=[IO.Path]::GetFullPath('C:\kmp-eval\scratch').TrimEnd('\')+'\'
  if(-not$full.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)){throw $Code}
  return $full
}

function Assert-ExactKeys($Value,[string[]]$Keys,[string]$Code) {
  if($null-eq$Value-or@(Compare-Object @($Value.PSObject.Properties.Name|Sort-Object) @($Keys|Sort-Object)).Count-ne0){throw $Code}
}

$artifactFull=Assert-InsideScratch $ArtifactPath 'git_bash_artifact_path_invalid'
$normalizationFull=Assert-InsideScratch $NormalizationReceiptPath 'git_bash_normalization_path_invalid'
$reportFull=Assert-InsideScratch $ReportPath 'git_bash_report_path_invalid'
if(Test-Path -LiteralPath $reportFull){throw 'git_bash_report_already_exists'}
if(-not(Test-Path -LiteralPath $artifactFull -PathType Leaf)-or-not(Test-Path -LiteralPath $normalizationFull -PathType Leaf)){throw 'git_bash_input_missing'}
$artifactItem=Get-Item -LiteralPath $artifactFull -Force
if($artifactItem.Length-ne$ExpectedArtifactBytes-or(Get-Sha256 $artifactFull)-cne$ExpectedArtifactSha256){throw 'git_bash_artifact_identity_mismatch'}
$normalization=Get-Content -LiteralPath $normalizationFull -Raw|ConvertFrom-Json -ErrorAction Stop
Assert-ExactKeys $normalization @('schema','verdict','runtime_id','generated_at_utc','upstream_sha256','upstream_bytes','normalized_sha256','normalized_bytes','normalized_file_count','normalized_input_bytes','deterministic_entry_order','deterministic_entry_timestamp','auth_material_read','auth_material_copied','private_paths_persisted','network_used','inference_sessions_consumed') 'git_bash_normalization_contract_mismatch'
if($normalization.schema-ne1-or$normalization.verdict-cne'PASS'-or$normalization.runtime_id-cne'git'-or
  $normalization.upstream_sha256-cne$ExpectedUpstreamSha256-or[long]$normalization.upstream_bytes-ne$ExpectedUpstreamBytes-or
  $normalization.normalized_sha256-cne$ExpectedArtifactSha256-or[long]$normalization.normalized_bytes-ne$ExpectedArtifactBytes-or
  $normalization.deterministic_entry_order-ne$true-or$normalization.deterministic_entry_timestamp-cne'1980-01-01T00:00:00Z'-or
  $normalization.auth_material_read-ne$false-or$normalization.auth_material_copied-ne$false-or
  $normalization.private_paths_persisted-ne$false-or$normalization.network_used-ne$false-or
  [int]$normalization.inference_sessions_consumed-ne0){throw 'git_bash_normalization_contract_mismatch'}

$vmIdentity=Get-Evidence1CanonicalE2EVmIdentity -ProfilePath $ProfilePath `
  -CreatedInspectionReceiptPath $CreatedInspectionReceiptPath -GuestCredentialPath $GuestCredentialPath
$vm=Get-VM -Id ([guid]$vmIdentity.vm_id) -ErrorAction Stop
if($vm.Name-cne$vmIdentity.vm_name-or$vm.State-ne'Off'){throw 'git_bash_install_requires_exact_vm_off'}
$adapters=@(Get-VMNetworkAdapter -VM $vm -ErrorAction Stop)
if($adapters.Count-ne1){throw 'git_bash_install_network_topology_invalid'}
$adapterAttached=-not[string]::IsNullOrWhiteSpace([string]$adapters[0].SwitchId)
$disk=(Get-VMHardDiskDrive -VM $vm|Select-Object -First 1).Path
if(-not([IO.Path]::GetFullPath($disk)).StartsWith('C:\kmp-eval\hyperv-e2e\',[StringComparison]::OrdinalIgnoreCase)){throw 'git_bash_install_vhd_scope_invalid'}

$mount=$null
try {
  $mount=Mount-VHD -Path $disk -Passthru
  $windowsRoot=Get-E1FinalMountedWindowsRoot $mount
  $target=Join-Path $windowsRoot $TargetRoot.Substring(3)
  $parent=Split-Path -Parent $target
  $stage=Join-Path $parent ('.incoming-'+[guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force -Path $parent|Out-Null
  $changed=$false
  try {
    if(Test-Path -LiteralPath $target){
      $markerPath=Join-Path $target '.evidence1-artifact.json'
      if(-not(Test-Path -LiteralPath $markerPath -PathType Leaf)){throw 'git_bash_unmanaged_destination'}
      $marker=Get-Content -LiteralPath $markerPath -Raw|ConvertFrom-Json -ErrorAction Stop
      $tree=Get-Tree $target
      if($marker.id-cne'git-bash'-or$marker.version-cne'2.55.0.windows.5'-or$marker.sha256-cne$ExpectedArtifactSha256-or
        [long]$marker.bytes-ne$ExpectedArtifactBytes-or$marker.installed_tree_sha256-cne$tree.sha256-or
        [long]$marker.installed_file_count-ne$tree.file_count-or[long]$marker.installed_bytes-ne$tree.bytes){throw 'git_bash_existing_runtime_mismatch'}
    } else {
      New-Item -ItemType Directory -Path $stage|Out-Null
      $tarOutput=@(& tar.exe -xf $artifactFull -C $stage 2>&1)
      if($LASTEXITCODE-ne0){throw "git_bash_extract_failed:$($tarOutput-join' ')"}
      foreach($relative in @('cmd\git.exe','bin\bash.exe')){if(-not(Test-Path -LiteralPath (Join-Path $stage $relative) -PathType Leaf)){throw 'git_bash_layout_invalid'}}
      # Do not execute guest binaries from an offline maintenance mount. Windows can reject
      # process creation from that volume even when the same files run normally in the guest.
      # The exact upstream and normalized hashes establish package identity here; readiness
      # executes bin\bash.exe in the guest before any provider process can be spawned.
      $tree=Get-Tree $stage
      $marker=[ordered]@{id='git-bash';version='2.55.0.windows.5';sha256=$ExpectedArtifactSha256;bytes=$ExpectedArtifactBytes;upstream_sha256=$ExpectedUpstreamSha256;upstream_bytes=$ExpectedUpstreamBytes;installed_tree_sha256=$tree.sha256;installed_file_count=$tree.file_count;installed_bytes=$tree.bytes;transaction_id=('git-bash-install-'+[guid]::NewGuid().ToString('N'))}
      [IO.File]::WriteAllText((Join-Path $stage '.evidence1-artifact.json'),($marker|ConvertTo-Json -Depth 4),[Text.UTF8Encoding]::new($false))
      [IO.Directory]::Move($stage,$target);$changed=$true
    }
    $post=Get-Tree $target
    foreach($relative in @('cmd\git.exe','bin\bash.exe')){if(-not(Test-Path -LiteralPath (Join-Path $target $relative) -PathType Leaf)){throw 'git_bash_post_install_layout_invalid'}}
  } finally {if(Test-Path -LiteralPath $stage){Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue}}
} finally {if($mount){Dismount-VHD -Path $disk -ErrorAction SilentlyContinue}}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $reportFull)|Out-Null
$report=[ordered]@{schema=1;verdict='PASS';generated_at_utc=[DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ');vm_name=$vmIdentity.vm_name;vm_id=$vmIdentity.vm_id;vm_state_during_install='Off';network_adapter_attached=$adapterAttached;runtime_id='git-bash';runtime_version='2.55.0.windows.5';canonical_root=$TargetRoot;artifact_sha256=$ExpectedArtifactSha256;artifact_bytes=$ExpectedArtifactBytes;upstream_sha256=$ExpectedUpstreamSha256;upstream_bytes=$ExpectedUpstreamBytes;installed_tree_sha256=$post.sha256;installed_file_count=$post.file_count;installed_bytes=$post.bytes;version_evidence='pinned_artifact_and_guest_readiness';changed=$changed;network_used=$false;auth_material_read=$false;auth_material_copied=$false;inference_sessions_consumed = 0}
[IO.File]::WriteAllText($reportFull,($report|ConvertTo-Json -Depth 5),[Text.UTF8Encoding]::new($false))
Write-Host "[evidence1-install-git-bash] PASS: $reportFull"
