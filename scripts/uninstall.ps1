<#
.SYNOPSIS
    Remove kmp-test-runner from Windows.

.DESCRIPTION
    Removes the kmp-test-runner installation directory and cleans the entry
    from the current user's PATH (HKCU only).

.PARAMETER Prefix
    Installation root directory. Defaults to $env:LOCALAPPDATA\kmp-test-runner.

.EXAMPLE
    .\uninstall.ps1

.NOTES
    Requires PowerShell 5.1 or later.
    Does NOT require administrator privileges.
#>
[CmdletBinding()]
param(
    [string]$Prefix = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Package = "kmp-test-runner"
$BinName = "kmp-test"

# --------------------------------------------------------------------------
# Resolve install prefix
# --------------------------------------------------------------------------
if ([string]::IsNullOrEmpty($Prefix)) {
    $Prefix = Join-Path $env:LOCALAPPDATA $Package
}

# --------------------------------------------------------------------------
# Canonicalize: syntax normalization then reparse-point check
# --------------------------------------------------------------------------
$Prefix = [System.IO.Path]::GetFullPath($Prefix)

# For existing directories: refuse junctions/symlinks, then resolve to real path
if (Test-Path $Prefix -PathType Container) {
    $reparseAttr = [System.IO.FileAttributes]::ReparsePoint
    $attrs = (Get-Item -LiteralPath $Prefix -Force).Attributes
    if ($attrs -band $reparseAttr) {
        Write-Error "Refusing to remove a reparse point (junction/symlink): $Prefix"
        exit 1
    }
    $resolved = Resolve-Path -LiteralPath $Prefix -ErrorAction SilentlyContinue
    if ($null -ne $resolved) {
        $Prefix = $resolved.ProviderPath
    }
}

# --------------------------------------------------------------------------
# Hard guards — refuse protected paths before any filesystem mutation
# --------------------------------------------------------------------------
if ([string]::IsNullOrWhiteSpace($Prefix)) {
    Write-Error "Resolved installation prefix is empty or whitespace."
    exit 1
}

# Drive root guard: matches C:\ D:\ etc. (exactly drive letter + colon + backslash)
if ($Prefix -match '^[A-Za-z]:\\$') {
    Write-Error "Refusing to remove drive root: $Prefix"
    exit 1
}

# USERPROFILE guard
$realProfile = $env:USERPROFILE
try {
    $rp = Resolve-Path -LiteralPath $env:USERPROFILE -ErrorAction Stop
    $realProfile = $rp.ProviderPath
} catch { }
if ($Prefix.TrimEnd('\') -eq $realProfile.TrimEnd('\')) {
    Write-Error "Refusing to remove user profile directory: $realProfile"
    exit 1
}

# --------------------------------------------------------------------------
# Existence check
# --------------------------------------------------------------------------
if (-not (Test-Path $Prefix)) {
    Write-Error "$Package does not appear to be installed at $Prefix"
    exit 1
}

$BinDir = Join-Path $Prefix "bin"

# --------------------------------------------------------------------------
# Ownership validation helpers
# --------------------------------------------------------------------------
function Get-CanonicalPath {
    param([string]$Path)
    try {
        return (Get-Item -LiteralPath $Path -Force -ErrorAction Stop).FullName
    } catch {
        return [System.IO.Path]::GetFullPath($Path)
    }
}

function Test-MarkerValid {
    param([string]$MarkerPath)
    if (-not (Test-Path $MarkerPath -PathType Leaf)) { return $false }
    try {
        $json = Get-Content $MarkerPath -Raw -ErrorAction Stop | ConvertFrom-Json
        return $json.tool -eq 'kmp-test-runner'
    } catch { return $false }
}

function Test-PackageJsonValid {
    param([string]$InstallPrefix)
    $pj = Join-Path $InstallPrefix "lib\package.json"
    if (-not (Test-Path $pj)) { return $false }
    try {
        $json = Get-Content $pj -Raw -ErrorAction Stop | ConvertFrom-Json
        return $json.name -eq 'kmp-test-runner'
    } catch { return $false }
}

function Test-LauncherValid {
    param([string]$InstallPrefix, [string]$BinFileName)
    $cmd = Join-Path $InstallPrefix "bin\$BinFileName.cmd"
    if (-not (Test-Path $cmd)) { return $false }
    $content = Get-Content $cmd -Raw -ErrorAction SilentlyContinue
    if ([string]::IsNullOrEmpty($content)) { return $false }
    # Extract the quoted node target path; compare canonical forms so short paths
    # (e.g. RUNNER~1) and long paths (runneradmin) both match correctly.
    if (-not ($content -match 'node\s+"([^"]+)"')) { return $false }
    $canonActual   = Get-CanonicalPath $Matches[1]
    $canonExpected = Get-CanonicalPath (Join-Path $InstallPrefix "lib\bin\$BinFileName.js")
    return $canonActual -eq $canonExpected
}

function Test-LayoutOwnership {
    param([string]$InstallPrefix, [string]$BinFileName)
    return (Test-PackageJsonValid $InstallPrefix) -and
           (Test-Path (Join-Path $InstallPrefix "lib\bin\$BinFileName.js")) -and
           (Test-LauncherValid $InstallPrefix $BinFileName)
}

function Test-LegacyLayout {
    param([string]$InstallPrefix, [string]$BinFileName)
    $leaf = Split-Path $InstallPrefix -Leaf
    if ($leaf -ne 'kmp-test-runner') { return $false }
    return Test-LayoutOwnership $InstallPrefix $BinFileName
}

# --------------------------------------------------------------------------
# Decide whether to proceed: marker+layout (Path A) or legacy adoption (Path B)
# --------------------------------------------------------------------------
$MarkerPath = Join-Path $Prefix ".kmp-test-runner-install.json"

if ((Test-MarkerValid $MarkerPath) -and (Test-LayoutOwnership $Prefix $BinName)) {
    # marker + layout valid — proceed
}
elseif (Test-LegacyLayout $Prefix $BinName) {
    Write-Host "Legacy install detected — validating layout and adopting..."
    $MarkerContent = '{"tool":"kmp-test-runner","schema":1,"version":"legacy"}'
    Set-Content -Path $MarkerPath -Value $MarkerContent -Encoding UTF8
    Write-Host "Adopted install at $Prefix."
}
else {
    Write-Error @"
$Prefix does not contain a valid kmp-test-runner install.
  No valid install marker+layout or recognizable legacy layout found.
  Inspect the directory manually and remove it only if you are certain it is safe.
"@
    exit 1
}

# --------------------------------------------------------------------------
# Remove installation directory
# --------------------------------------------------------------------------
Write-Host "Removing $Package from $Prefix ..."
Remove-Item -Recurse -Force $Prefix
Write-Host "Removed directory: $Prefix"

# --------------------------------------------------------------------------
# Remove from user PATH (HKCU only)
# --------------------------------------------------------------------------
$CurrentPath = [Environment]::GetEnvironmentVariable("PATH", "User")
if (-not [string]::IsNullOrEmpty($CurrentPath)) {
    $PathParts  = $CurrentPath -split ";"
    $Filtered   = @()
    foreach ($Part in $PathParts) {
        if ($Part.TrimEnd("\") -ne $BinDir.TrimEnd("\")) {
            $Filtered += $Part
        }
    }
    $NewPath = $Filtered -join ";"
    [Environment]::SetEnvironmentVariable("PATH", $NewPath, "User")
    Write-Host "Removed $BinDir from user PATH."
}

# --------------------------------------------------------------------------
# Done
# --------------------------------------------------------------------------
Write-Host ""
Write-Host "$Package uninstalled successfully."
