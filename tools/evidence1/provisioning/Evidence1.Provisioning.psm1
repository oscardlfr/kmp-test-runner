Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Read-E1Json([string]$Path, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "${Label}_missing" }
  try { return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -ErrorAction Stop }
  catch { throw "${Label}_invalid_json" }
}

function Assert-E1ExactProperties($Object, [string[]]$Allowed, [string]$Label) {
  $actual = @($Object.PSObject.Properties.Name)
  if (@($actual | Where-Object { $_ -notin $Allowed }).Count -gt 0) { throw "${Label}_unknown_property" }
}

function Assert-E1RequiredProperties($Object, [string[]]$Required, [string]$Label) {
  $actual = @($Object.PSObject.Properties.Name)
  if (@($Required | Where-Object { $_ -notin $actual }).Count -gt 0) { throw "${Label}_missing_property" }
}

function Test-E1HexSha([string]$Value) { return $Value -cmatch '^[0-9a-f]{64}$' }

function Test-E1StrictJsonInteger($Value, [int64]$Expected) {
  if ($null -eq $Value) { return $false }
  $integerTypes = @(
    [byte], [sbyte], [int16], [uint16], [int32], [uint32], [int64], [uint64]
  )
  return $Value.GetType() -in $integerTypes -and [int64]$Value -eq $Expected
}

function Read-E1LockedJsonSnapshot([string]$Path, [string]$Label, [int64]$MaximumBytes = 1MB) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "${Label}_missing" }
  $stream = $null
  try {
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    if ($stream.Length -lt 2 -or $stream.Length -gt $MaximumBytes) { throw "${Label}_invalid_json" }
    $bytes = New-Object byte[] ([int]$stream.Length)
    $offset = 0
    while ($offset -lt $bytes.Length) {
      $read = $stream.Read($bytes, $offset, $bytes.Length - $offset)
      if ($read -le 0) { throw "${Label}_invalid_json" }
      $offset += $read
    }
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { $sha = ([BitConverter]::ToString($hasher.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $hasher.Dispose() }
    try {
      $text = [Text.UTF8Encoding]::new($false, $true).GetString($bytes)
      if ($text.Length -gt 0 -and [int]$text[0] -eq 0xFEFF) { $text = $text.Substring(1) }
      $document = $text | ConvertFrom-Json -ErrorAction Stop
    } catch { throw "${Label}_invalid_json" }
    return [ordered]@{ document = $document; sha256 = $sha; bytes = [int64]$bytes.Length }
  } finally {
    if ($stream) { $stream.Dispose() }
  }
}

function Read-E1LockedTextSnapshot([string]$Path, [string]$Label, [int64]$MaximumBytes = 4MB) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "${Label}_missing" }
  $stream = $null
  try {
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    if ($stream.Length -lt 1 -or $stream.Length -gt $MaximumBytes) { throw "${Label}_invalid" }
    $bytes = New-Object byte[] ([int]$stream.Length)
    $offset = 0
    while ($offset -lt $bytes.Length) {
      $read = $stream.Read($bytes, $offset, $bytes.Length - $offset)
      if ($read -le 0) { throw "${Label}_invalid" }
      $offset += $read
    }
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { $sha = ([BitConverter]::ToString($hasher.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $hasher.Dispose() }
    try { $text = [Text.UTF8Encoding]::new($false, $true).GetString($bytes) }
    catch { throw "${Label}_invalid" }
    if ($text.Length -gt 0 -and [int]$text[0] -eq 0xFEFF) { $text = $text.Substring(1) }
    return [ordered]@{ text = $text; sha256 = $sha; bytes = [int64]$bytes.Length }
  } finally {
    if ($stream) { $stream.Dispose() }
  }
}

function Get-E1Sha256([string]$Path) {
  $stream = [IO.File]::OpenRead($Path)
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try {
    $bytes = $algorithm.ComputeHash($stream)
    return ([BitConverter]::ToString($bytes) -replace '-', '').ToLowerInvariant()
  } finally {
    $algorithm.Dispose()
    $stream.Dispose()
  }
}

function Get-E1FileIdentity([string]$Path, [string]$ExpectedSha, [int64]$ExpectedBytes, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "${Label}_missing" }
  $item = Get-Item -LiteralPath $Path
  if ($item.Length -ne $ExpectedBytes) { throw "${Label}_size_mismatch" }
  $sha = Get-E1Sha256 $Path
  if ($sha -cne $ExpectedSha) { throw "${Label}_hash_mismatch" }
  return [ordered]@{ sha256 = $sha; bytes = [int64]$item.Length }
}

function Get-E1TreeIdentity([string]$Root) {
  $fullRoot = [IO.Path]::GetFullPath($Root).TrimEnd('\')
  if (-not (Test-Path -LiteralPath $fullRoot -PathType Container)) { throw 'host_dependency_tree_missing' }
  $files = @(Get-ChildItem -LiteralPath $fullRoot -Recurse -Force -File | Sort-Object FullName)
  $builder = [Text.StringBuilder]::new()
  [int64]$totalBytes = 0
  foreach ($file in $files) {
    if (($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'host_dependency_reparse_rejected' }
    $relative = $file.FullName.Substring($fullRoot.Length).TrimStart('\').Replace('\','/')
    $null = $builder.Append($relative).Append("`0").Append($file.Length).Append("`0").Append((Get-E1Sha256 $file.FullName)).Append("`n")
    $totalBytes += [int64]$file.Length
  }
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try { $digest = $algorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($builder.ToString())) }
  finally { $algorithm.Dispose() }
  return [ordered]@{
    sha256 = ([BitConverter]::ToString($digest) -replace '-', '').ToLowerInvariant()
    file_count = $files.Count
    bytes = $totalBytes
  }
}

function Get-E1PeMachine([string]$Path) {
  $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  $reader = [IO.BinaryReader]::new($stream)
  try {
    if ($stream.Length -lt 256 -or $reader.ReadUInt16() -ne 0x5A4D) { throw 'host_dependency_architecture_invalid' }
    $stream.Position = 0x3C
    $peOffset = $reader.ReadInt32()
    if ($peOffset -lt 64 -or $peOffset + 6 -gt $stream.Length) { throw 'host_dependency_architecture_invalid' }
    $stream.Position = $peOffset
    if ($reader.ReadUInt32() -ne 0x00004550) { throw 'host_dependency_architecture_invalid' }
    return $reader.ReadUInt16()
  } finally {
    $reader.Dispose()
    $stream.Dispose()
  }
}

function Get-E1SignedFileSubject([string]$Path) {
  try {
    $certificate = [Security.Cryptography.X509Certificates.X509Certificate]::CreateFromSignedFile($Path)
    $certificate2 = [Security.Cryptography.X509Certificates.X509Certificate2]::new($certificate)
    try { return [string]$certificate2.Subject }
    finally { $certificate2.Dispose() }
  } catch { throw 'host_dependency_signature_invalid' }
}

function Assert-E1AuthenticodeSignature([string]$Path) {
  if (-not ('Evidence1WinTrust' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class Evidence1WinTrust {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct WINTRUST_FILE_INFO {
    public uint cbStruct;
    [MarshalAs(UnmanagedType.LPWStr)] public string pcwszFilePath;
    public IntPtr hFile;
    public IntPtr pgKnownSubject;
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct WINTRUST_DATA {
    public uint cbStruct;
    public IntPtr pPolicyCallbackData;
    public IntPtr pSIPClientData;
    public uint dwUIChoice;
    public uint fdwRevocationChecks;
    public uint dwUnionChoice;
    public IntPtr pFile;
    public uint dwStateAction;
    public IntPtr hWVTStateData;
    [MarshalAs(UnmanagedType.LPWStr)] public string pwszURLReference;
    public uint dwProvFlags;
    public uint dwUIContext;
  }

  [DllImport("wintrust.dll", ExactSpelling = true, SetLastError = true, CharSet = CharSet.Unicode)]
  private static extern int WinVerifyTrust(IntPtr hwnd, [MarshalAs(UnmanagedType.LPStruct)] Guid actionId, IntPtr trustData);

  public static int VerifyEmbeddedSignature(string path) {
    var action = new Guid("00AAC56B-CD44-11d0-8CC2-00C04FC295EE");
    var file = new WINTRUST_FILE_INFO {
      cbStruct = (uint)Marshal.SizeOf(typeof(WINTRUST_FILE_INFO)), pcwszFilePath = path,
      hFile = IntPtr.Zero, pgKnownSubject = IntPtr.Zero
    };
    IntPtr filePointer = Marshal.AllocCoTaskMem(Marshal.SizeOf(typeof(WINTRUST_FILE_INFO)));
    IntPtr dataPointer = IntPtr.Zero;
    try {
      Marshal.StructureToPtr(file, filePointer, false);
      var data = new WINTRUST_DATA {
        cbStruct = (uint)Marshal.SizeOf(typeof(WINTRUST_DATA)), pPolicyCallbackData = IntPtr.Zero,
        pSIPClientData = IntPtr.Zero, dwUIChoice = 2, fdwRevocationChecks = 0, dwUnionChoice = 1,
        pFile = filePointer, dwStateAction = 1, hWVTStateData = IntPtr.Zero,
        pwszURLReference = null, dwProvFlags = 0x00001000, dwUIContext = 0
      };
      dataPointer = Marshal.AllocCoTaskMem(Marshal.SizeOf(typeof(WINTRUST_DATA)));
      Marshal.StructureToPtr(data, dataPointer, false);
      int result = WinVerifyTrust(new IntPtr(-1), action, dataPointer);
      data = (WINTRUST_DATA)Marshal.PtrToStructure(dataPointer, typeof(WINTRUST_DATA));
      data.dwStateAction = 2;
      Marshal.StructureToPtr(data, dataPointer, true);
      WinVerifyTrust(new IntPtr(-1), action, dataPointer);
      return result;
    } finally {
      if (dataPointer != IntPtr.Zero) Marshal.FreeCoTaskMem(dataPointer);
      Marshal.FreeCoTaskMem(filePointer);
    }
  }
}
'@
  }
  if ([Evidence1WinTrust]::VerifyEmbeddedSignature($Path) -ne 0) { throw 'host_dependency_signature_invalid' }
}

function ConvertFrom-E1DismImageInfo([string]$Text, $ExpectedImage) {
  if ([string]::IsNullOrWhiteSpace($Text) -or $Text.Length -gt 1MB) { throw 'iso_image_metadata_invalid' }
  Assert-E1ExactProperties $ExpectedImage @('index','name','edition','edition_id','architecture','languages','version','installation_type') 'approved_iso_image'
  Assert-E1RequiredProperties $ExpectedImage @('index','name','edition','edition_id','architecture','languages','version','installation_type') 'approved_iso_image'
  function Get-Field([string]$Name) {
    $matches = [regex]::Matches($Text, "(?im)^\s*$([regex]::Escape($Name))\s*:\s*(?<value>.*?)\s*$")
    if ($matches.Count -lt 1) { throw 'iso_image_metadata_invalid' }
    return [string]$matches[$matches.Count - 1].Groups['value'].Value
  }
  $indexText = Get-Field 'Index'
  $name = Get-Field 'Name'
  $edition = Get-Field 'Edition'
  $architecture = (Get-Field 'Architecture').ToLowerInvariant()
  $installationType = Get-Field 'Installation'
  $versions = [regex]::Matches($Text, '(?im)^\s*Version\s*:\s*(?<value>[0-9]+\.[0-9]+\.[0-9]+(?:\.[0-9]+)?)\s*$')
  if ($versions.Count -lt 2) { throw 'iso_image_metadata_invalid' }
  $imageVersion = [string]$versions[$versions.Count - 1].Groups['value'].Value
  $servicePackBuild = Get-Field 'ServicePack Build'
  $versionParts = @($imageVersion.Split('.'))
  if ($versionParts.Count -ne 3 -or $servicePackBuild -cnotmatch '^[0-9]+$') { throw 'iso_image_metadata_invalid' }
  $version = "$imageVersion.$servicePackBuild"
  $languages = @([regex]::Matches($Text, '(?m)^\s+(?<locale>[a-z]{2,3}-[A-Z]{2})(?:\s+\(Default\))?\s*$') | ForEach-Object {
    [string]$_.Groups['locale'].Value
  } | Sort-Object -Unique)
  $expectedLanguages = @($ExpectedImage.languages | ForEach-Object { [string]$_ } | Sort-Object)
  [int]$index = 0
  if (-not [int]::TryParse($indexText, [ref]$index) -or $index -ne [int]$ExpectedImage.index -or
      $name -cne [string]$ExpectedImage.name -or $edition -cne [string]$ExpectedImage.edition_id -or
      $architecture -notin @('x64','amd64') -or [string]$ExpectedImage.architecture -cne 'x64' -or
      $installationType -cne [string]$ExpectedImage.installation_type -or $version -cne [string]$ExpectedImage.version -or
      (($languages -join "`n") -cne ($expectedLanguages -join "`n"))) {
    throw 'iso_image_metadata_mismatch'
  }
  return [ordered]@{
    index = $index; name = $name; edition_id = $edition; architecture = 'x64'
    languages = $languages; version = $version; installation_type = $installationType
  }
}

function Assert-E1ExpandedHostDependency($Dependency, [string]$Root) {
  $fullRoot = [IO.Path]::GetFullPath($Root).TrimEnd('\')
  if ([string]$Dependency.tree_identity_format -cne 'evidence1-path-size-sha256-v1') { throw 'host_dependency_tree_format_invalid' }
  Assert-E1ProvisioningNoReparse $fullRoot
  $tree = Get-E1TreeIdentity $fullRoot
  if ($tree.sha256 -cne [string]$Dependency.tree_sha256 -or
      $tree.file_count -ne [int]$Dependency.tree_file_count -or $tree.bytes -ne [int64]$Dependency.tree_bytes) {
    throw 'host_dependency_tree_mismatch'
  }
  $executable = Assert-E1PathInside (Join-Path $fullRoot ([string]$Dependency.command_relative)) @($fullRoot) 'host_dependency_command_path_invalid'
  $null = Get-E1FileIdentity $executable $Dependency.executable_sha256 ([int64]$Dependency.executable_bytes) 'host_dependency_executable'
  $item = Get-Item -LiteralPath $executable -ErrorAction Stop
  if ([string]$item.VersionInfo.ProductVersion -cne [string]$Dependency.runtime_version) { throw 'host_dependency_version_mismatch' }
  if ((Get-E1PeMachine $executable) -ne 0x8664 -or [string]$Dependency.architecture -cne 'x64') { throw 'host_dependency_architecture_invalid' }
  Assert-E1AuthenticodeSignature $executable
  if ((Get-E1SignedFileSubject $executable) -cne [string]$Dependency.publisher) { throw 'host_dependency_publisher_mismatch' }
  return [ordered]@{
    id = [string]$Dependency.id; root_path = $fullRoot; executable_path = $executable
    runtime_version = [string]$Dependency.runtime_version; archive_sha256 = [string]$Dependency.archive_sha256
    executable_sha256 = [string]$Dependency.executable_sha256; tree_sha256 = [string]$Dependency.tree_sha256
    tree_file_count = [int]$tree.file_count; tree_bytes = [int64]$tree.bytes
  }
}

function Expand-E1VerifiedHostDependency($Dependency, [string]$DestinationRoot) {
  if (-not $Dependency -or [string]$Dependency.id -cne 'windows-adk-dism') { throw 'host_dependency_missing' }
  $destination = [IO.Path]::GetFullPath($DestinationRoot).TrimEnd('\')
  if (Test-Path -LiteralPath $destination) { throw 'host_dependency_destination_exists' }
  $parent = Split-Path -Parent $destination
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  New-Item -ItemType Directory -Path $destination | Out-Null
  try {
    $null = Get-E1FileIdentity $Dependency.source_path $Dependency.archive_sha256 ([int64]$Dependency.archive_bytes) 'host_dependency_archive'
    Add-Type -AssemblyName System.IO.Compression
    $archiveStream = [IO.File]::Open($Dependency.source_path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
      $archive = [IO.Compression.ZipArchive]::new($archiveStream, [IO.Compression.ZipArchiveMode]::Read, $false)
      try {
        $entries = @($archive.Entries)
        if ($entries.Count -lt 1 -or $entries.Count -gt 512) { throw 'host_dependency_archive_bounds_invalid' }
        [int64]$expandedBytes = 0
        foreach ($entry in $entries) {
          $entryName = [string]$entry.FullName
          if ([string]::IsNullOrWhiteSpace($entryName) -or $entryName.Contains('\') -or $entryName.StartsWith('/') -or
              $entryName -match '(^|/)\.\.(/|$)' -or $entryName -match '^[A-Za-z]:') {
            throw 'host_dependency_archive_path_invalid'
          }
          $target = [IO.Path]::GetFullPath((Join-Path $destination $entryName.Replace('/','\')))
          if (-not $target.StartsWith($destination + '\', [StringComparison]::OrdinalIgnoreCase)) {
            throw 'host_dependency_archive_path_invalid'
          }
          if ([string]::IsNullOrEmpty($entry.Name)) {
            New-Item -ItemType Directory -Force -Path $target | Out-Null
            continue
          }
          $expandedBytes += [int64]$entry.Length
          if ($expandedBytes -gt 512MB) { throw 'host_dependency_archive_bounds_invalid' }
          New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
          $input = $entry.Open()
          $output = [IO.File]::Open($target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
          try { $input.CopyTo($output) } finally { $output.Dispose(); $input.Dispose() }
        }
      } finally { $archive.Dispose() }
    } finally { $archiveStream.Dispose() }
    $null = Get-E1FileIdentity $Dependency.source_path $Dependency.archive_sha256 ([int64]$Dependency.archive_bytes) 'host_dependency_archive'
    return Assert-E1ExpandedHostDependency $Dependency $destination
  } catch {
    Remove-Item -LiteralPath $destination -Recurse -Force -ErrorAction SilentlyContinue
    throw
  }
}

function Read-E1CanonicalProfile([string]$ProfilePath) {
  if (-not (Test-Path -LiteralPath $ProfilePath -PathType Leaf)) { throw 'profile_missing' }
  $candidateSha = Get-E1Sha256 $ProfilePath
  $canonicalPaths = @(
    (Join-Path $PSScriptRoot 'evidence1-windows-hyperv-v1.json'),
    (Join-Path $PSScriptRoot 'evidence1-windows-hyperv-e2e-v1.json')
  )
  $matchedPath = @($canonicalPaths | Where-Object {
    (Test-Path -LiteralPath $_ -PathType Leaf) -and (Get-E1Sha256 $_) -ceq $candidateSha
  })
  if ($matchedPath.Count -ne 1) { throw 'profile_identity_mismatch' }
  $profile = Read-E1Json $ProfilePath 'profile'
  $canonical = Read-E1Json $matchedPath[0] 'profile'
  if ($profile.profile_id -cne $canonical.profile_id) { throw 'profile_identity_mismatch' }
  return $profile
}

function Get-E1ProfileSha256([string]$ProfilePath) {
  $null = Read-E1CanonicalProfile $ProfilePath
  return Get-E1Sha256 $ProfilePath
}

function New-E1ReceiptPath([string]$RequestedPath, [string]$Operation) {
  $roots = @('C:\kmp-eval\scratch', [IO.Path]::GetTempPath())
  if ([string]::IsNullOrWhiteSpace($RequestedPath)) {
    $stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')
    $RequestedPath = "C:\kmp-eval\scratch\evidence1-windows-provisioning\receipts\$Operation-$stamp-$([guid]::NewGuid().ToString('N')).json"
  }
  $full = Assert-E1PathInside $RequestedPath $roots 'receipt_path_outside_scratch'
  if (Test-Path -LiteralPath $full) { throw 'receipt_already_exists' }
  return $full
}

function Write-E1ReceiptAtomically([string]$Path, $Value) {
  if (Test-Path -LiteralPath $Path) { throw 'receipt_already_exists' }
  $full = [IO.Path]::GetFullPath($Path)
  $parent = Split-Path -Parent $full
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  $temp = "$full.$([guid]::NewGuid().ToString('N')).tmp"
  try {
    [IO.File]::WriteAllText($temp, ($Value | ConvertTo-Json -Depth 16), [Text.UTF8Encoding]::new($false))
    [IO.File]::Move($temp, $full)
  } finally {
    Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue
  }
}

function Assert-E1ProvisioningNoReparse([string]$Path) {
  $cursor = [IO.Path]::GetFullPath($Path)
  while ($cursor) {
    if (Test-Path -LiteralPath $cursor) {
      $item = Get-Item -LiteralPath $cursor -Force
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'sealed_provisioning_reparse_rejected'
      }
    }
    $parent = Split-Path -Parent $cursor
    if (-not $parent -or $parent -ceq $cursor) { break }
    $cursor = $parent
  }
}

function Get-E1SealedProvisioningContext {
  $runtimeRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
  if ((Split-Path -Leaf $runtimeRoot) -cne 'node-runtime') { return $null }
  $deploymentRoot = Split-Path -Parent $runtimeRoot
  $manifestPath = Join-Path $deploymentRoot 'evidence1-host-elevated-runner-manifest.json'
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'sealed_provisioning_manifest_missing' }
  Assert-E1ProvisioningNoReparse $runtimeRoot
  Assert-E1ProvisioningNoReparse $manifestPath
  try {
    $bytes = [IO.File]::ReadAllBytes($manifestPath)
    $deployment = [Text.UTF8Encoding]::new($false, $true).GetString($bytes) | ConvertFrom-Json -ErrorAction Stop
  } catch { throw 'sealed_provisioning_manifest_invalid' }
  Assert-E1ExactProperties $deployment @('schema','kind','principal_sid','source_git_commit','runner_sha256','process_module_sha256','scripts','support_files','node_files') 'sealed_provisioning_manifest'
  if ($deployment.schema -ne 2 -or $deployment.kind -cne 'evidence1-host-elevated-runner-manifest' -or
      [string]$deployment.source_git_commit -cnotmatch '^[0-9a-f]{40,64}$') {
    throw 'sealed_provisioning_manifest_invalid'
  }
  $moduleRelative = 'tools/evidence1/provisioning/Evidence1.Provisioning.psm1'
  $moduleEntries = @($deployment.node_files | Where-Object { [string]$_.name -ceq $moduleRelative })
  if ($moduleEntries.Count -ne 1) { throw 'sealed_provisioning_module_identity_invalid' }
  Assert-E1ExactProperties $moduleEntries[0] @('name','sha256','blob_oid') 'sealed_provisioning_module_entry'
  if ([string]$moduleEntries[0].sha256 -cnotmatch '^[0-9a-f]{64}$' -or
      [string]$moduleEntries[0].blob_oid -cnotmatch '^[0-9a-f]{40,64}$' -or
      (Get-E1Sha256 $PSCommandPath) -cne [string]$moduleEntries[0].sha256) {
    throw 'sealed_provisioning_module_identity_invalid'
  }
  return [pscustomobject]@{
    RuntimeRoot = $runtimeRoot
    ManifestPath = $manifestPath
    Manifest = $deployment
  }
}

function Get-E1ProvisioningPlan(
  [string]$ProfilePath,
  [string]$InputLockPath,
  [switch]$SkipHostDependencyFileIdentity,
  [switch]$AllowSealedRuntimeCommitDrift
) {
  $profile = Read-E1CanonicalProfile $ProfilePath
  $lock = Read-E1Json $InputLockPath 'input_lock'
  Assert-E1RequiredProperties $lock @('schema_version','profile_id','approved_manifest','iso','artifacts') 'input_lock'
  if ($lock.schema_version -eq 2) {
    Assert-E1ExactProperties $lock @('schema_version','profile_id','approved_manifest','iso','artifacts') 'input_lock'
  } elseif ($lock.schema_version -eq 3) {
    Assert-E1ExactProperties $lock @('schema_version','profile_id','approved_manifest','iso','artifacts','host_dependencies') 'input_lock'
    Assert-E1RequiredProperties $lock @('schema_version','profile_id','approved_manifest','iso','artifacts','host_dependencies') 'input_lock'
  } else { throw 'input_lock_contract_mismatch' }
  if ($profile.schema_version -ne 2 -or $profile.profile_id -cnotmatch '^evidence1-windows-hyperv(?:-e2e)?-v1$') { throw 'profile_contract_mismatch' }
  if ($lock.profile_id -cne $profile.profile_id) { throw 'input_lock_contract_mismatch' }
  $profileHostDependencies = @()
  if ($profile.PSObject.Properties.Name -contains 'host_dependencies') { $profileHostDependencies = @($profile.host_dependencies) }
  if (($profileHostDependencies.Count -eq 0 -and $lock.schema_version -ne 2) -or
      ($profileHostDependencies.Count -gt 0 -and $lock.schema_version -ne 3)) { throw 'host_dependency_contract_mismatch' }
  Assert-E1ExactProperties $lock.approved_manifest @('path','sha256','git_commit','blob_oid') 'approved_manifest'
  Assert-E1RequiredProperties $lock.approved_manifest @('path','sha256','git_commit','blob_oid') 'approved_manifest'
  if (-not (Test-E1HexSha ([string]$lock.approved_manifest.sha256)) -or
      [string]$lock.approved_manifest.git_commit -cnotmatch '^[0-9a-f]{40,64}$' -or
      [string]$lock.approved_manifest.blob_oid -cnotmatch '^[0-9a-f]{40,64}$') { throw 'approved_manifest_identity_invalid' }
  $sealed = Get-E1SealedProvisioningContext
  if ($AllowSealedRuntimeCommitDrift -and -not $sealed) {
    throw 'approved_manifest_recovery_requires_sealed_runtime'
  }
  $runtimeSourceGitCommit = $null
  $runtimeCommitDriftAccepted = $false
  if ($sealed) {
    $lockedManifestPath = [IO.Path]::GetFullPath([string]$lock.approved_manifest.path)
    $manifestLeaf = Split-Path -Leaf $lockedManifestPath
    if ($manifestLeaf -cnotmatch '^[A-Za-z0-9_.-]+\.json$') { throw 'approved_manifest_path_invalid' }
    $relativeManifest = "tools/evidence1/provisioning/approved-inputs/$manifestLeaf"
    $expectedSuffix = '\' + $relativeManifest.Replace('/', '\')
    if (-not $lockedManifestPath.EndsWith($expectedSuffix, [StringComparison]::OrdinalIgnoreCase)) {
      throw 'approved_manifest_path_invalid'
    }
    $sealedEntries = @($sealed.Manifest.node_files | Where-Object { [string]$_.name -ceq $relativeManifest })
    if ($sealedEntries.Count -ne 1) { throw 'approved_manifest_sealed_identity_mismatch' }
    Assert-E1ExactProperties $sealedEntries[0] @('name','sha256','blob_oid') 'sealed_approved_manifest_entry'
    $runtimeSourceGitCommit = [string]$sealed.Manifest.source_git_commit
    $runtimeCommitDrift = $runtimeSourceGitCommit -cne [string]$lock.approved_manifest.git_commit
    if (($runtimeCommitDrift -and -not $AllowSealedRuntimeCommitDrift) -or
        [string]$sealedEntries[0].sha256 -cne [string]$lock.approved_manifest.sha256 -or
        [string]$sealedEntries[0].blob_oid -cne [string]$lock.approved_manifest.blob_oid) {
      throw 'approved_manifest_sealed_identity_mismatch'
    }
    $runtimeCommitDriftAccepted = [bool]$runtimeCommitDrift
    $head = [string]$lock.approved_manifest.git_commit
    $blob = [string]$sealedEntries[0].blob_oid
    $manifestPath = Assert-E1PathInside (Join-Path $sealed.RuntimeRoot ($relativeManifest.Replace('/', '\'))) @($sealed.RuntimeRoot) 'approved_manifest_path_invalid'
    Assert-E1ProvisioningNoReparse $manifestPath
    $manifestIdentity = Get-E1FileIdentity $manifestPath ([string]$lock.approved_manifest.sha256) ((Get-Item -LiteralPath $manifestPath).Length) 'approved_manifest'
  } else {
    $manifestPath = Assert-E1PathInside ([string]$lock.approved_manifest.path) @((Join-Path $PSScriptRoot 'approved-inputs')) 'approved_manifest_path_invalid'
    $manifestIdentity = Get-E1FileIdentity $manifestPath ([string]$lock.approved_manifest.sha256) ((Get-Item -LiteralPath $manifestPath).Length) 'approved_manifest'
    $git = Get-Command git.exe -ErrorAction SilentlyContinue
    if (-not $git) { $git = Get-Command git -ErrorAction SilentlyContinue }
    if (-not $git) { throw 'approved_manifest_git_unavailable' }
    $repoRootOutput = @(& $git.Source -C $PSScriptRoot rev-parse --show-toplevel 2>$null)
    $repoRootExit = $LASTEXITCODE
    if ($repoRootExit -ne 0 -or $repoRootOutput.Count -ne 1 -or [string]::IsNullOrWhiteSpace([string]$repoRootOutput[0])) { throw 'approved_manifest_git_unavailable' }
    $repoRoot = [IO.Path]::GetFullPath([string]$repoRootOutput[0])
    $relativeManifest = [IO.Path]::GetFullPath($manifestPath).Substring($repoRoot.TrimEnd('\').Length + 1).Replace('\','/')
    $headOutput = @(& $git.Source -C $repoRoot rev-parse HEAD 2>$null)
    $headExit = $LASTEXITCODE
    $blobOutput = @(& $git.Source -C $repoRoot rev-parse "HEAD:$relativeManifest" 2>$null)
    $blobExit = $LASTEXITCODE
    $head = if ($headOutput.Count -eq 1) { [string]$headOutput[0] } else { '' }
    $blob = if ($blobOutput.Count -eq 1) { [string]$blobOutput[0] } else { '' }
    $status = @(& $git.Source -C $repoRoot status --porcelain=v1 --untracked-files=all -- $relativeManifest 2>$null)
    $statusExit = $LASTEXITCODE
    if ($headExit -ne 0 -or $blobExit -ne 0 -or $statusExit -ne 0 -or [string]$head -cne [string]$lock.approved_manifest.git_commit -or
        [string]$blob -cne [string]$lock.approved_manifest.blob_oid -or $status.Count -ne 0) {
      throw 'approved_manifest_not_head_tracked_clean'
    }
    $runtimeSourceGitCommit = $head
  }
  $manifest = Read-E1Json $manifestPath 'approved_manifest'
  if ($manifest.schema_version -eq 1) {
    Assert-E1ExactProperties $manifest @('schema_version','approval_status','manifest_id','profile_id','iso','artifacts') 'approved_manifest'
    Assert-E1RequiredProperties $manifest @('schema_version','approval_status','manifest_id','profile_id','iso','artifacts') 'approved_manifest'
  } elseif ($manifest.schema_version -eq 2) {
    Assert-E1ExactProperties $manifest @('schema_version','approval_status','manifest_id','profile_id','iso','artifacts','host_dependencies') 'approved_manifest'
    Assert-E1RequiredProperties $manifest @('schema_version','approval_status','manifest_id','profile_id','iso','artifacts','host_dependencies') 'approved_manifest'
  } else { throw 'approved_manifest_contract_mismatch' }
  if (($lock.schema_version -eq 2 -and $manifest.schema_version -ne 1) -or
      ($lock.schema_version -eq 3 -and $manifest.schema_version -ne 2)) { throw 'host_dependency_contract_mismatch' }
  if ($manifest.approval_status -cne 'approved' -or
      $manifest.profile_id -cne $profile.profile_id -or [string]$manifest.manifest_id -cnotmatch '^[a-z0-9][a-z0-9-]{2,79}$') {
    throw 'approved_manifest_contract_mismatch'
  }
  Assert-E1ExactProperties $manifest.iso @('sha256','bytes','source_uri','publisher','image') 'approved_iso'
  Assert-E1RequiredProperties $manifest.iso @('sha256','bytes','source_uri','publisher','image') 'approved_iso'
  if (-not (Test-E1HexSha ([string]$manifest.iso.sha256)) -or $manifest.iso.bytes -lt 1 -or
      [string]$manifest.iso.source_uri -cnotmatch '^https://' -or [string]$manifest.iso.publisher -cne 'Microsoft') {
    throw 'approved_iso_identity_invalid'
  }
  Assert-E1ExactProperties $manifest.iso.image @('index','name','edition','edition_id','architecture','languages','version','installation_type') 'approved_iso_image'
  Assert-E1RequiredProperties $manifest.iso.image @('index','name','edition','edition_id','architecture','languages','version','installation_type') 'approved_iso_image'
  if ($manifest.iso.image.index -lt 1 -or [string]$manifest.iso.image.name -eq '' -or
      $manifest.iso.image.edition -cne $profile.os.edition -or $manifest.iso.image.edition_id -cne 'Professional' -or
      $manifest.iso.image.architecture -cne $profile.os.architecture -or @($manifest.iso.image.languages).Count -lt 1 -or
      [string]$manifest.iso.image.version -cnotmatch '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' -or
      $manifest.iso.image.installation_type -cne 'Client') { throw 'approved_iso_image_identity_invalid' }
  Assert-E1ExactProperties $lock.iso @('path') 'iso'
  Assert-E1RequiredProperties $lock.iso @('path') 'iso'
  if ([string]::IsNullOrWhiteSpace([string]$lock.iso.path)) { throw 'iso_identity_invalid' }
  $iso = Get-E1FileIdentity $lock.iso.path $manifest.iso.sha256 ([int64]$manifest.iso.bytes) 'iso'
  $requiredIds = @($profile.toolchain | ForEach-Object { [string]$_.id })
  $artifacts = @($lock.artifacts)
  $approvedArtifacts = @($manifest.artifacts)
  if ($artifacts.Count -ne $requiredIds.Count) { throw 'artifact_cardinality_mismatch' }
  if ($approvedArtifacts.Count -ne $requiredIds.Count) { throw 'approved_artifact_cardinality_mismatch' }
  $seen = @{}
  $safeArtifacts = @()
  foreach ($artifact in $artifacts) {
    Assert-E1ExactProperties $artifact @('id','path') 'artifact'
    Assert-E1RequiredProperties $artifact @('id','path') 'artifact'
    $id = [string]$artifact.id
    if ($id -notin $requiredIds -or $seen.ContainsKey($id)) { throw 'artifact_identity_mismatch' }
    if ([string]::IsNullOrWhiteSpace([string]$artifact.path)) { throw 'artifact_identity_invalid' }
    $approved = @($approvedArtifacts | Where-Object { $_.id -ceq $id })
    $runtime = @($profile.toolchain | Where-Object { $_.id -ceq $id })
    if ($approved.Count -ne 1 -or $runtime.Count -ne 1) { throw 'approved_artifact_identity_mismatch' }
    Assert-E1ExactProperties $approved[0] @('id','version','architecture','sha256','bytes','sources','publisher','verification') 'approved_artifact'
    Assert-E1RequiredProperties $approved[0] @('id','version','architecture','sha256','bytes','sources','publisher','verification') 'approved_artifact'
    Assert-E1ExactProperties $approved[0].verification @('kind','result') 'approved_artifact_verification'
    Assert-E1RequiredProperties $approved[0].verification @('kind','result') 'approved_artifact_verification'
    if ($approved[0].version -cne $runtime[0].version -or $approved[0].architecture -cne $runtime[0].architecture -or
        -not (Test-E1HexSha ([string]$approved[0].sha256)) -or $approved[0].bytes -lt 1 -or
        @($approved[0].sources).Count -lt 1 -or @($approved[0].sources).Count -gt 8 -or
        [string]::IsNullOrWhiteSpace([string]$approved[0].publisher) -or
        [string]$approved[0].verification.kind -notin @('vendor-checksum','authenticode','npm-integrity','vendor-signature') -or
        [string]$approved[0].verification.result -cne 'verified') { throw 'approved_artifact_identity_mismatch' }
    foreach ($source in @($approved[0].sources)) {
      Assert-E1ExactProperties $source @('uri','digest_algorithm','digest','bytes') 'approved_artifact_source'
      Assert-E1RequiredProperties $source @('uri','digest_algorithm','digest','bytes') 'approved_artifact_source'
      $digestOk = switch ([string]$source.digest_algorithm) {
        'sha1' { [string]$source.digest -cmatch '^[0-9a-f]{40}$' }
        'sha256' { [string]$source.digest -cmatch '^[0-9a-f]{64}$' }
        'sha512-sri' { [string]$source.digest -cmatch '^sha512-[A-Za-z0-9+/]+={0,2}$' }
        default { $false }
      }
      if ([string]$source.uri -cnotmatch '^https://' -or -not $digestOk -or $source.bytes -lt 1) {
        throw 'approved_artifact_source_identity_invalid'
      }
    }
    $seen[$id] = $true
    $identity = Get-E1FileIdentity $artifact.path $approved[0].sha256 ([int64]$approved[0].bytes) "artifact_$id"
    $safeArtifacts += [ordered]@{ id = $id; sha256 = $identity.sha256; bytes = $identity.bytes; source_path = [IO.Path]::GetFullPath($artifact.path) }
  }
  if (@($requiredIds | Where-Object { -not $seen.ContainsKey($_) }).Count -gt 0) { throw 'artifact_identity_mismatch' }
  $safeHostDependencies = @()
  if ($profileHostDependencies.Count -gt 0) {
    $lockedHostDependencies = @($lock.host_dependencies)
    $approvedHostDependencies = @($manifest.host_dependencies)
    if ($profileHostDependencies.Count -ne 1 -or $lockedHostDependencies.Count -ne 1 -or $approvedHostDependencies.Count -ne 1) {
      throw 'host_dependency_cardinality_mismatch'
    }
    $runtime = $profileHostDependencies[0]
    Assert-E1ExactProperties $runtime @('id','adk_release','servicing_update','architecture','command_relative','runtime_version') 'profile_host_dependency'
    Assert-E1RequiredProperties $runtime @('id','adk_release','servicing_update','architecture','command_relative','runtime_version') 'profile_host_dependency'
    if ([string]$runtime.id -cne 'windows-adk-dism' -or [string]$runtime.architecture -cne 'x64' -or
        [string]$runtime.command_relative -cne 'dism.exe' -or [string]$runtime.adk_release -cnotmatch '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' -or
        [string]$runtime.servicing_update -cnotmatch '^KB[0-9]{7}$' -or [string]$runtime.runtime_version -cnotmatch '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$') {
      throw 'host_dependency_contract_mismatch'
    }
    $locked = $lockedHostDependencies[0]
    Assert-E1ExactProperties $locked @('id','path') 'host_dependency_lock'
    Assert-E1RequiredProperties $locked @('id','path') 'host_dependency_lock'
    if ([string]$locked.id -cne [string]$runtime.id -or [string]::IsNullOrWhiteSpace([string]$locked.path)) { throw 'host_dependency_identity_mismatch' }
    $approved = $approvedHostDependencies[0]
    Assert-E1ExactProperties $approved @('id','adk_release','servicing_update','runtime_version','architecture','command_relative','archive_sha256','archive_bytes','executable_sha256','executable_bytes','tree_identity_format','tree_sha256','tree_file_count','tree_bytes','sources','publisher','verification') 'approved_host_dependency'
    Assert-E1RequiredProperties $approved @('id','adk_release','servicing_update','runtime_version','architecture','command_relative','archive_sha256','archive_bytes','executable_sha256','executable_bytes','tree_identity_format','tree_sha256','tree_file_count','tree_bytes','sources','publisher','verification') 'approved_host_dependency'
    Assert-E1ExactProperties $approved.verification @('kind','result') 'approved_host_dependency_verification'
    Assert-E1RequiredProperties $approved.verification @('kind','result') 'approved_host_dependency_verification'
    if ([string]$approved.id -cne [string]$runtime.id -or [string]$approved.adk_release -cne [string]$runtime.adk_release -or
        [string]$approved.servicing_update -cne [string]$runtime.servicing_update -or
        [string]$approved.runtime_version -cne [string]$runtime.runtime_version -or
        [string]$approved.architecture -cne [string]$runtime.architecture -or
        [string]$approved.command_relative -cne [string]$runtime.command_relative -or
        -not (Test-E1HexSha ([string]$approved.archive_sha256)) -or [int64]$approved.archive_bytes -lt 1 -or
        -not (Test-E1HexSha ([string]$approved.executable_sha256)) -or [int64]$approved.executable_bytes -lt 1 -or
        [string]$approved.tree_identity_format -cne 'evidence1-path-size-sha256-v1' -or
        -not (Test-E1HexSha ([string]$approved.tree_sha256)) -or [int]$approved.tree_file_count -lt 1 -or
        [int64]$approved.tree_bytes -lt 1 -or @($approved.sources).Count -lt 2 -or @($approved.sources).Count -gt 8 -or
        [string]$approved.publisher -cne 'CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US' -or
        [string]$approved.verification.kind -cne 'authenticode' -or [string]$approved.verification.result -cne 'verified') {
      throw 'approved_host_dependency_identity_mismatch'
    }
    foreach ($source in @($approved.sources)) {
      Assert-E1ExactProperties $source @('uri','digest_algorithm','digest','bytes') 'approved_host_dependency_source'
      Assert-E1RequiredProperties $source @('uri','digest_algorithm','digest','bytes') 'approved_host_dependency_source'
      if ([string]$source.uri -cnotmatch '^https://' -or [string]$source.digest_algorithm -cne 'sha256' -or
          -not (Test-E1HexSha ([string]$source.digest)) -or [int64]$source.bytes -lt 1) {
        throw 'approved_host_dependency_source_identity_invalid'
      }
    }
    $archiveIdentity = if ($SkipHostDependencyFileIdentity) {
      [ordered]@{ sha256 = [string]$approved.archive_sha256; bytes = [int64]$approved.archive_bytes }
    } else {
      Get-E1FileIdentity $locked.path $approved.archive_sha256 ([int64]$approved.archive_bytes) 'host_dependency_archive'
    }
    $safeHostDependencies += [ordered]@{
      id = [string]$approved.id; adk_release = [string]$approved.adk_release
      servicing_update = [string]$approved.servicing_update; runtime_version = [string]$approved.runtime_version
      architecture = [string]$approved.architecture; command_relative = [string]$approved.command_relative
      archive_sha256 = $archiveIdentity.sha256; archive_bytes = $archiveIdentity.bytes
      executable_sha256 = [string]$approved.executable_sha256; executable_bytes = [int64]$approved.executable_bytes
      tree_identity_format = [string]$approved.tree_identity_format; tree_sha256 = [string]$approved.tree_sha256
      tree_file_count = [int]$approved.tree_file_count; tree_bytes = [int64]$approved.tree_bytes
      publisher = [string]$approved.publisher; source_path = [IO.Path]::GetFullPath([string]$locked.path)
    }
  }
  return [ordered]@{
    profile = $profile
    input_lock = $lock
    approved_manifest = [ordered]@{
      manifest_id = [string]$manifest.manifest_id; sha256 = $manifestIdentity.sha256
      git_commit = [string]$head; blob_oid = [string]$blob; iso_image = $manifest.iso.image
      runtime_source_git_commit = [string]$runtimeSourceGitCommit
      runtime_commit_drift_accepted = [bool]$runtimeCommitDriftAccepted
    }
    iso = [ordered]@{ sha256 = $iso.sha256; bytes = $iso.bytes; source_path = [IO.Path]::GetFullPath($lock.iso.path) }
    artifacts = @($safeArtifacts | Sort-Object { [array]::IndexOf($requiredIds, $_.id) })
    host_dependencies = $safeHostDependencies
  }
}

function Write-E1JsonAtomically([string]$Path, $Value) {
  $full = [IO.Path]::GetFullPath($Path)
  $parent = Split-Path -Parent $full
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  $temp = "$full.$([guid]::NewGuid().ToString('N')).tmp"
  try { [IO.File]::WriteAllText($temp, ($Value | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false)); Move-Item -LiteralPath $temp -Destination $full -Force }
  finally { Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue }
}

function Assert-E1Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'administrator_required' }
}

function Assert-E1PathInside([string]$Candidate, [string[]]$Roots, [string]$ReasonCode) {
  $full = [IO.Path]::GetFullPath($Candidate)
  foreach ($root in $Roots) {
    $base = ([IO.Path]::GetFullPath($root)).TrimEnd('\')
    if ($full -eq $base -or $full.StartsWith($base + '\', [StringComparison]::OrdinalIgnoreCase)) { return $full }
  }
  throw $ReasonCode
}

function Get-E1ClosedReason([string]$Candidate, [string[]]$Allowed, [string]$Fallback) {
  if ($Candidate -cin $Allowed) { return $Candidate }
  return $Fallback
}

function Get-E1HostDependencyFailureCodes {
  return @(
    'host_dependency_contract_mismatch','host_dependency_cardinality_mismatch','host_dependency_identity_mismatch',
    'profile_host_dependency_unknown_property','profile_host_dependency_missing_property',
    'host_dependency_lock_unknown_property','host_dependency_lock_missing_property',
    'approved_host_dependency_unknown_property','approved_host_dependency_missing_property',
    'approved_host_dependency_identity_mismatch','approved_host_dependency_verification_unknown_property',
    'approved_host_dependency_verification_missing_property','approved_host_dependency_source_unknown_property',
    'approved_host_dependency_source_missing_property','approved_host_dependency_source_identity_invalid',
    'host_dependency_missing','host_dependency_archive_missing','host_dependency_archive_size_mismatch',
    'host_dependency_archive_hash_mismatch','host_dependency_destination_exists','host_dependency_archive_bounds_invalid',
    'host_dependency_archive_path_invalid','host_dependency_tree_missing','host_dependency_tree_format_invalid',
    'host_dependency_tree_mismatch','host_dependency_reparse_rejected','host_dependency_command_path_invalid',
    'host_dependency_executable_missing','host_dependency_executable_size_mismatch','host_dependency_executable_hash_mismatch',
    'host_dependency_version_mismatch','host_dependency_architecture_invalid','host_dependency_signature_invalid',
    'host_dependency_publisher_mismatch'
  )
}

function Assert-E1ToolchainVerifyReceipt($Receipt, $Plan, [string]$ProfileSha, [string]$InputLockSha, [string]$VmId) {
  if ($Receipt.schema -ne 2 -or $Receipt.verdict -cne 'PASS' -or $Receipt.mode -cne 'Verify') {
    throw 'toolchain_receipt_not_verify_pass'
  }
  if ($Receipt.profile_id -cne $Plan.profile.profile_id -or $Receipt.profile_sha256 -cne $ProfileSha -or
      $Receipt.input_lock_sha256 -cne $InputLockSha -or ([string]$Receipt.vm_id).ToLowerInvariant() -cne $VmId.ToLowerInvariant()) {
    throw 'toolchain_receipt_binding_mismatch'
  }
  if ($Receipt.auth_material_copied -ne $false -or $Receipt.auth_material_read -ne $false -or
      $Receipt.network_used -ne $false -or $Receipt.changed -ne $false -or $Receipt.mutation_performed -ne $false) {
    throw 'toolchain_receipt_invariant_failed'
  }
  $now = [DateTime]::UtcNow
  try {
    $generated = [DateTime]::Parse([string]$Receipt.generated_at_utc).ToUniversalTime()
    $validUntil = [DateTime]::Parse([string]$Receipt.valid_until_utc).ToUniversalTime()
  } catch { throw 'toolchain_receipt_time_invalid' }
  if ($generated -gt $now.AddMinutes(1) -or $validUntil -lt $now -or
      ($validUntil - $generated).TotalSeconds -gt [int]$Plan.profile.checkpoint.max_verify_age_seconds) {
    throw 'toolchain_receipt_stale'
  }
  $guest = $Receipt.guest_identity
  if (-not $guest -or $guest.computer_name -ine $Plan.profile.guest.computer_name -or
      $guest.local_user -cne $Plan.profile.guest.local_user -or $guest.administrator -ne $true -or
      [string]$guest.user_sid -cnotmatch '^S-1-5-21-(?:[0-9]+-){3}[0-9]+$') {
    throw 'toolchain_receipt_guest_identity_invalid'
  }
  $environment = $Receipt.environment
  foreach ($field in @('deterministic_path','codex_home_bound','codex_home_empty','claude_config_dir_bound','claude_config_dir_empty','android_sdk_environment_bound')) {
    if (-not $environment -or $environment.$field -ne $true) { throw 'toolchain_receipt_environment_invalid' }
  }
  if ($environment.credential_environment_override_count -ne 0) { throw 'toolchain_receipt_environment_invalid' }
  $rows = @($Receipt.runtimes)
  if ($rows.Count -ne @($Plan.profile.toolchain).Count) { throw 'toolchain_receipt_runtime_incomplete' }
  foreach ($runtime in @($Plan.profile.toolchain)) {
    $row = @($rows | Where-Object { $_.id -ceq $runtime.id })
    $artifact = @($Plan.artifacts | Where-Object { $_.id -ceq $runtime.id })
    if ($row.Count -ne 1 -or $artifact.Count -ne 1 -or $row[0].verified -ne $true -or $row[0].changed -ne $false -or
        $row[0].version -cne $runtime.version -or $row[0].install_handler -cne $runtime.install_handler -or
        $row[0].artifact_sha256 -cne $artifact[0].sha256 -or $row[0].artifact_bytes -ne $artifact[0].bytes -or
        [string]$row[0].installed_tree_sha256 -cnotmatch '^[0-9a-f]{64}$' -or
        $row[0].installed_file_count -lt 1 -or $row[0].installed_bytes -lt 1) {
      throw 'toolchain_receipt_runtime_mismatch'
    }
    if ($runtime.id -ceq 'codex-cli' -and ($row[0].help_verified -ne $true -or $row[0].publisher_verified -ne $true)) {
      throw 'toolchain_receipt_runtime_mismatch'
    }
  }
  return $rows
}

function Get-E1FailureCleanupAttestation(
  [bool]$StartAttempted,
  [bool]$VmStopped,
  [bool]$AnswerMediaDeleted,
  [bool]$WorkDirectoryDeleted,
  [bool]$CachedAnswerFilesAbsent,
  [bool]$GuestCredentialPreserved,
  [string[]]$CleanupFailureCodes
) {
  $failures = @($CleanupFailureCodes)
  $hostCleanupComplete = $VmStopped -and $AnswerMediaDeleted -and $WorkDirectoryDeleted -and $failures.Count -eq 0
  $failureCleanupComplete = $hostCleanupComplete -and
    (-not $StartAttempted -or ($CachedAnswerFilesAbsent -and $GuestCredentialPreserved))
  return [ordered]@{
    host_cleanup_complete = [bool]$hostCleanupComplete
    failure_cleanup_complete = [bool]$failureCleanupComplete
    guest_cached_answer_state = if ($CachedAnswerFilesAbsent) { 'absent' } else { 'unknown' }
    guest_credential_preserved = [bool]$GuestCredentialPreserved
    retry_authorized = $false
  }
}

Export-ModuleMember -Function Read-E1Json,Read-E1LockedJsonSnapshot,Read-E1LockedTextSnapshot,Test-E1StrictJsonInteger,Assert-E1ExactProperties,Assert-E1RequiredProperties,Read-E1CanonicalProfile,Get-E1ProfileSha256,Get-E1Sha256,Get-E1FileIdentity,Get-E1TreeIdentity,ConvertFrom-E1DismImageInfo,Assert-E1ExpandedHostDependency,Expand-E1VerifiedHostDependency,Get-E1ProvisioningPlan,Write-E1JsonAtomically,New-E1ReceiptPath,Write-E1ReceiptAtomically,Assert-E1Administrator,Assert-E1PathInside,Get-E1ClosedReason,Get-E1HostDependencyFailureCodes,Assert-E1ToolchainVerifyReceipt,Get-E1FailureCleanupAttestation
