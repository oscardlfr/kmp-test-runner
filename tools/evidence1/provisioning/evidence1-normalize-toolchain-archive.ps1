param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('git','node','jdk','android-sdk','claude-code','windows-adk-dism')]
  [string]$RuntimeId,
  [Parameter(Mandatory = $true)] [string]$SourceRoot,
  [Parameter(Mandatory = $true)] [string]$UpstreamArtifactPath,
  [Parameter(Mandatory = $true)] [ValidatePattern('^[0-9a-f]{64}$')] [string]$ExpectedUpstreamSha256,
  [string]$SecondaryUpstreamArtifactPath = '',
  [string]$ExpectedSecondaryUpstreamSha256 = '',
  [Parameter(Mandatory = $true)] [string]$OutputPath,
  [string]$ReceiptPath = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Import-Module (Join-Path $scriptRoot 'Evidence1.Provisioning.psm1') -Force

function Fail([string]$Code) { Write-Error "HARD STOP: $Code"; exit 1 }

$outputFull = $null
$receiptFull = $null
try {
  $receiptFull = New-E1ReceiptPath $ReceiptPath "normalize-$RuntimeId"
  $outputFull = Assert-E1PathInside $OutputPath @('C:\kmp-eval\scratch', [IO.Path]::GetTempPath()) 'normalized_output_outside_scratch'
  if (Test-Path -LiteralPath $outputFull) { throw 'normalized_output_already_exists' }
  $sourceFull = [IO.Path]::GetFullPath($SourceRoot)
  if (-not (Test-Path -LiteralPath $sourceFull -PathType Container)) { throw 'normalization_source_missing' }
  $upstreamFull = [IO.Path]::GetFullPath($UpstreamArtifactPath)
  if (-not (Test-Path -LiteralPath $upstreamFull -PathType Leaf)) { throw 'upstream_artifact_missing' }
  $upstreamItem = Get-Item -LiteralPath $upstreamFull
  $null = Get-E1FileIdentity $upstreamFull $ExpectedUpstreamSha256 ([int64]$upstreamItem.Length) 'upstream_artifact'
  $secondaryUpstreamItem = $null
  if ([string]::IsNullOrWhiteSpace($SecondaryUpstreamArtifactPath) -ne [string]::IsNullOrWhiteSpace($ExpectedSecondaryUpstreamSha256)) {
    throw 'secondary_upstream_identity_incomplete'
  }
  if (-not [string]::IsNullOrWhiteSpace($SecondaryUpstreamArtifactPath)) {
    if ($ExpectedSecondaryUpstreamSha256 -cnotmatch '^[0-9a-f]{64}$') { throw 'secondary_upstream_identity_invalid' }
    $secondaryUpstreamFull = [IO.Path]::GetFullPath($SecondaryUpstreamArtifactPath)
    if (-not (Test-Path -LiteralPath $secondaryUpstreamFull -PathType Leaf)) { throw 'secondary_upstream_artifact_missing' }
    $secondaryUpstreamItem = Get-Item -LiteralPath $secondaryUpstreamFull
    $null = Get-E1FileIdentity $secondaryUpstreamFull $ExpectedSecondaryUpstreamSha256 ([int64]$secondaryUpstreamItem.Length) 'secondary_upstream_artifact'
  }
  $discoveredFiles = @(Get-ChildItem -LiteralPath $sourceFull -Recurse -Force -File)
  if ($discoveredFiles.Count -lt 1 -or $discoveredFiles.Count -gt 200000) { throw 'normalization_file_count_invalid' }
  $fileByRelativePath = @{}
  $null = @($discoveredFiles | ForEach-Object {
    $relative = $_.FullName.Substring($sourceFull.TrimEnd('\').Length + 1).Replace('\','/')
    if ([string]::IsNullOrWhiteSpace($relative) -or $relative -match '[\x00-\x1f]' -or
        $relative.StartsWith('/') -or $relative -match '(^|/)\.\.(/|$)' -or $fileByRelativePath.ContainsKey($relative)) {
      throw 'normalization_path_invalid'
    }
    $fileByRelativePath[$relative] = $_
  })
  $files = @($discoveredFiles | Sort-Object FullName)
  $forbiddenNames = @('auth.json','.credentials.json','.claude.json','credentials.json')
  [int64]$inputBytes = 0
  foreach ($file in $files) {
    $linkType = if ($file.PSObject.Properties.Name -contains 'LinkType') { [string]$file.LinkType } else { '' }
    if (($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $linkType -eq 'HardLink') { throw 'normalization_link_forbidden' }
    if ($file.Name -cin $forbiddenNames) { throw 'normalization_auth_material_forbidden' }
    $inputBytes += [int64]$file.Length
    if ($inputBytes -gt 4294967296) { throw 'normalization_size_limit' }
  }
  $required = switch ($RuntimeId) {
    'git' { @('cmd\git.exe','bin\bash.exe') }
    'node' { @('node.exe','npm.cmd') }
    'jdk' { @('bin\java.exe') }
    'android-sdk' { @('build-tools\36.0.0\aapt2.exe','platforms\android-36\android.jar','platform-tools\adb.exe') }
    'claude-code' { @('claude.cmd') }
    'windows-adk-dism' { @('dism.exe','dismapi.dll','dismcore.dll','dismprov.dll','wimgapi.dll','wimprovider.dll','wimserv.exe') }
  }
  foreach ($relative in $required) {
    if (-not (Test-Path -LiteralPath (Join-Path $sourceFull $relative) -PathType Leaf)) { throw 'normalization_layout_invalid' }
  }
  Add-Type -AssemblyName System.IO.Compression
  $parent = Split-Path -Parent $outputFull
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  $stream = [IO.File]::Open($outputFull, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  try {
    $archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create, $true)
    try {
      foreach ($file in $files) {
        $relative = $file.FullName.Substring($sourceFull.TrimEnd('\').Length + 1).Replace('\','/')
        $entry = $archive.CreateEntry($relative, [IO.Compression.CompressionLevel]::Optimal)
        $entry.LastWriteTime = [DateTimeOffset]::new(1980,1,1,0,0,0,[TimeSpan]::Zero)
        $entryStream = $entry.Open()
        $input = [IO.File]::OpenRead($file.FullName)
        try { $input.CopyTo($entryStream) } finally { $input.Dispose(); $entryStream.Dispose() }
      }
    } finally { $archive.Dispose() }
  } finally { $stream.Dispose() }
  $normalized = Get-Item -LiteralPath $outputFull
  $normalizedSha = Get-E1Sha256 $outputFull
  $receipt = [ordered]@{
    schema = 1; verdict = 'PASS'; runtime_id = $RuntimeId
    generated_at_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    upstream_sha256 = $ExpectedUpstreamSha256; upstream_bytes = [int64]$upstreamItem.Length
    normalized_sha256 = $normalizedSha; normalized_bytes = [int64]$normalized.Length
    normalized_file_count = $files.Count; normalized_input_bytes = $inputBytes
    deterministic_entry_order = $true; deterministic_entry_timestamp = '1980-01-01T00:00:00Z'
    auth_material_read = $false; auth_material_copied = $false; private_paths_persisted = $false
    network_used = $false; inference_sessions_consumed = 0
  }
  if ($RuntimeId -ceq 'windows-adk-dism') {
    $treeDescription = [IO.MemoryStream]::new()
    try {
      foreach ($file in $files) {
        $relative = $file.FullName.Substring($sourceFull.TrimEnd('\').Length + 1).Replace('\','/')
        $line = '{0}{1}{2}{1}{3}' -f $relative, [char]0, [int64]$file.Length, (Get-E1Sha256 $file.FullName)
        $line += "`n"
        $lineBytes = [Text.UTF8Encoding]::new($false).GetBytes($line)
        $treeDescription.Write($lineBytes, 0, $lineBytes.Length)
      }
      $treeDescription.Position = 0
      $treeHasher = [Security.Cryptography.SHA256]::Create()
      try {
        $treeHashBytes = $treeHasher.ComputeHash($treeDescription)
      } finally { $treeHasher.Dispose() }
      $treeSha256 = ([BitConverter]::ToString($treeHashBytes)).Replace('-', '').ToLowerInvariant()
    } finally { $treeDescription.Dispose() }
    $executable = Get-Item -LiteralPath (Join-Path $sourceFull 'dism.exe')
    $receipt.executable_sha256 = Get-E1Sha256 $executable.FullName
    $receipt.executable_bytes = [int64]$executable.Length
    $receipt.tree_sha256 = $treeSha256
    $receipt.tree_file_count = $files.Count
    $receipt.tree_bytes = $inputBytes
    $receipt.tree_identity_format = 'evidence1-path-size-sha256-v1'
    if ($secondaryUpstreamItem) {
      $receipt.secondary_upstream_sha256 = $ExpectedSecondaryUpstreamSha256
      $receipt.secondary_upstream_bytes = [int64]$secondaryUpstreamItem.Length
    }
  }
  Write-E1ReceiptAtomically $receiptFull $receipt
  Write-Host "[evidence1-normalize-toolchain-archive] PASS: $receiptFull"
} catch {
  $reason = Get-E1ClosedReason ([string]$_.Exception.Message) @(
    'receipt_path_outside_scratch','receipt_already_exists','normalized_output_outside_scratch',
    'normalized_output_already_exists','normalization_source_missing','upstream_artifact_missing',
    'upstream_artifact_size_mismatch','upstream_artifact_hash_mismatch','normalization_file_count_invalid',
    'secondary_upstream_identity_incomplete','secondary_upstream_identity_invalid','secondary_upstream_artifact_missing',
    'secondary_upstream_artifact_size_mismatch','secondary_upstream_artifact_hash_mismatch',
    'normalization_path_invalid',
    'normalization_link_forbidden','normalization_auth_material_forbidden','normalization_size_limit','normalization_layout_invalid'
  ) 'normalization_failed'
  try {
    if ($outputFull -and (Test-Path -LiteralPath $outputFull)) { Remove-Item -LiteralPath $outputFull -Force -ErrorAction SilentlyContinue }
    $receiptFull = New-E1ReceiptPath $ReceiptPath "normalize-$RuntimeId-failed"
    Write-E1ReceiptAtomically $receiptFull ([ordered]@{
      schema = 1; verdict = 'FAIL'; runtime_id = $RuntimeId; reason_code = $reason
      generated_at_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
      auth_material_read = $false; auth_material_copied = $false; private_paths_persisted = $false
      network_used = $false; inference_sessions_consumed = 0
    })
  } catch { }
  Fail $reason
}
