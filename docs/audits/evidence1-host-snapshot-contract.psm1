Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-E1HostSnapshotSha256([string]$Path) {
  $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  try {
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($hasher.ComputeHash($stream)) -replace '-', '').ToLowerInvariant() }
    finally { $hasher.Dispose() }
  } finally { $stream.Dispose() }
}

function Assert-E1HostSnapshotNoReparse([string]$Path) {
  $cursor = [IO.Path]::GetFullPath($Path)
  while ($cursor) {
    if (Test-Path -LiteralPath $cursor) {
      $item = Get-Item -LiteralPath $cursor -Force
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'canonical_host_snapshot_reparse_rejected'
      }
    }
    $parent = Split-Path -Parent $cursor
    if (-not $parent -or $parent -ceq $cursor) { break }
    $cursor = $parent
  }
}

function Convert-E1HostSnapshotRelativePath([string]$RelativePath) {
  if ([string]::IsNullOrWhiteSpace($RelativePath) -or $RelativePath.Contains('\') -or
      $RelativePath.StartsWith('/') -or $RelativePath -cmatch '(^|/)(\.|\.\.)(/|$)' -or
      $RelativePath -cmatch ':') {
    throw 'canonical_host_snapshot_relative_path_invalid'
  }
  return $RelativePath.Replace('/', [IO.Path]::DirectorySeparatorChar)
}

function Test-E1HostSnapshotExactKeys($Value, [string[]]$Keys) {
  return $null -ne $Value -and
    @(Compare-Object @($Value.PSObject.Properties.Name | Sort-Object) @($Keys | Sort-Object)).Count -eq 0
}

function Assert-E1HostSnapshotDirectFile([string]$Path, [string]$ExpectedPath, [string]$Code) {
  $full = [IO.Path]::GetFullPath($Path)
  $expected = [IO.Path]::GetFullPath($ExpectedPath)
  if (-not $full.Equals($expected, [StringComparison]::OrdinalIgnoreCase)) { throw $Code }
  Assert-E1HostSnapshotNoReparse $full
  if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { throw $Code }
  $item = Get-Item -LiteralPath $full -Force
  if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw $Code }
  return $full
}

function Resolve-E1HostTrustedRuntime {
  param(
    [Parameter(Mandatory = $true)] [string]$ScriptRoot,
    [Parameter(Mandatory = $true)] [string]$EntrypointName,
    [Parameter(Mandatory = $true)] [string[]]$TrustedRuntimeFiles
  )

  if ($EntrypointName -cnotmatch '^[A-Za-z0-9_.-]+\.ps1$') {
    throw 'canonical_host_snapshot_entrypoint_invalid'
  }
  $scriptRootFull = [IO.Path]::GetFullPath($ScriptRoot)
  $manifestCandidate = Join-Path $scriptRootFull 'evidence1-host-elevated-runner-manifest.json'
  $nodeCandidate = Join-Path $scriptRootFull 'node-runtime'
  $deploymentMode = (Test-Path -LiteralPath $manifestCandidate) -or (Test-Path -LiteralPath $nodeCandidate)

  if ($deploymentMode) {
    $manifestPath = Assert-E1HostSnapshotDirectFile $manifestCandidate $manifestCandidate 'canonical_host_snapshot_manifest_invalid'
    try {
      $manifestBytes = [IO.File]::ReadAllBytes($manifestPath)
      $manifest = [Text.UTF8Encoding]::new($false, $true).GetString($manifestBytes) | ConvertFrom-Json -ErrorAction Stop
    } catch { throw 'canonical_host_snapshot_manifest_invalid' }
    if (-not (Test-E1HostSnapshotExactKeys $manifest @('schema','kind','principal_sid','source_git_commit','runner_sha256','process_module_sha256','scripts','support_files','node_files')) -or
        $manifest.schema -ne 2 -or $manifest.kind -cne 'evidence1-host-elevated-runner-manifest' -or
        [string]$manifest.source_git_commit -cnotmatch '^[0-9a-f]{40,64}$') {
      throw 'canonical_host_snapshot_manifest_invalid'
    }

    $scriptEntries = @($manifest.scripts | Where-Object { [string]$_.name -ceq $EntrypointName })
    if ($scriptEntries.Count -ne 1 -or
        -not (Test-E1HostSnapshotExactKeys $scriptEntries[0] @('name','sha256')) -or
        [string]$scriptEntries[0].sha256 -cnotmatch '^[0-9a-f]{64}$') {
      throw 'canonical_host_snapshot_entrypoint_invalid'
    }
    $entrypoint = Assert-E1HostSnapshotDirectFile (Join-Path $scriptRootFull $EntrypointName) (Join-Path $scriptRootFull $EntrypointName) 'canonical_host_snapshot_entrypoint_invalid'
    if ((Get-E1HostSnapshotSha256 $entrypoint) -cne [string]$scriptEntries[0].sha256) {
      throw 'canonical_host_snapshot_entrypoint_hash_mismatch'
    }

    $contractName = 'evidence1-host-snapshot-contract.psm1'
    $contractEntries = @($manifest.support_files | Where-Object { [string]$_.name -ceq $contractName })
    if ($contractEntries.Count -ne 1 -or
        -not (Test-E1HostSnapshotExactKeys $contractEntries[0] @('name','sha256')) -or
        [string]$contractEntries[0].sha256 -cnotmatch '^[0-9a-f]{64}$') {
      throw 'canonical_host_snapshot_contract_invalid'
    }
    $contractPath = Assert-E1HostSnapshotDirectFile $PSCommandPath (Join-Path $scriptRootFull $contractName) 'canonical_host_snapshot_contract_invalid'
    if ((Get-E1HostSnapshotSha256 $contractPath) -cne [string]$contractEntries[0].sha256) {
      throw 'canonical_host_snapshot_contract_hash_mismatch'
    }

    $runtimeRoot = [IO.Path]::GetFullPath($nodeCandidate)
    Assert-E1HostSnapshotNoReparse $runtimeRoot
    if (-not (Test-Path -LiteralPath $runtimeRoot -PathType Container)) { throw 'canonical_host_snapshot_runtime_missing' }
    foreach ($relative in $TrustedRuntimeFiles) {
      $native = Convert-E1HostSnapshotRelativePath $relative
      $entries = @($manifest.node_files | Where-Object { [string]$_.name -ceq $relative })
      if ($entries.Count -ne 1 -or
          -not (Test-E1HostSnapshotExactKeys $entries[0] @('name','sha256','blob_oid')) -or
          [string]$entries[0].sha256 -cnotmatch '^[0-9a-f]{64}$' -or
          [string]$entries[0].blob_oid -cnotmatch '^[0-9a-f]{40,64}$') {
        throw 'canonical_host_snapshot_runtime_manifest_mismatch'
      }
      $path = [IO.Path]::GetFullPath((Join-Path $runtimeRoot $native))
      $prefix = $runtimeRoot.TrimEnd('\') + '\'
      if (-not $path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'canonical_host_snapshot_runtime_escape' }
      $null = Assert-E1HostSnapshotDirectFile $path $path 'canonical_host_snapshot_runtime_file_invalid'
      if ((Get-E1HostSnapshotSha256 $path) -cne [string]$entries[0].sha256) {
        throw 'canonical_host_snapshot_runtime_hash_mismatch'
      }
    }
    return [pscustomobject]@{ Root = $runtimeRoot; Mode = 'sealed-snapshot'; ManifestPath = $manifestPath }
  }

  $repoRoot = [IO.Path]::GetFullPath((Join-Path $scriptRootFull '..\..'))
  $expectedScriptRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot 'docs\audits'))
  if (-not $scriptRootFull.Equals($expectedScriptRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'canonical_host_source_root_invalid'
  }
  Assert-E1HostSnapshotNoReparse $repoRoot
  $trustedSourceFiles = @(
    "docs/audits/$EntrypointName",
    'docs/audits/evidence1-host-snapshot-contract.psm1'
  ) + @($TrustedRuntimeFiles)
  foreach ($relative in $trustedSourceFiles) {
    $native = Convert-E1HostSnapshotRelativePath $relative
    $full = [IO.Path]::GetFullPath((Join-Path $repoRoot $native))
    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { throw 'canonical_host_source_trusted_file_missing' }
    Assert-E1HostSnapshotNoReparse $full
  }
  $git = Get-Command git.exe -ErrorAction SilentlyContinue
  if (-not $git) { $git = Get-Command git -ErrorAction SilentlyContinue }
  if (-not $git) { throw 'canonical_host_source_git_unavailable' }
  foreach ($relative in $trustedSourceFiles) {
    & $git.Source -C $repoRoot cat-file -e "HEAD:$relative" 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'canonical_host_source_trusted_file_untracked' }
  }
  & $git.Source -C $repoRoot diff --quiet HEAD -- @trustedSourceFiles
  if ($LASTEXITCODE -ne 0) { throw 'canonical_host_source_trusted_file_dirty' }
  return [pscustomobject]@{ Root = $repoRoot; Mode = 'source-git'; ManifestPath = $null }
}

Export-ModuleMember -Function Resolve-E1HostTrustedRuntime
