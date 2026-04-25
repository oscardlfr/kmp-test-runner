<#
.SYNOPSIS
    Install kmp-test-runner on Windows.

.DESCRIPTION
    Downloads the kmp-test-runner Windows zip from GitHub Releases, extracts it
    to $env:LOCALAPPDATA\kmp-test-runner, and adds the bin directory to the
    current user's PATH (HKCU only — never machine-wide).

.PARAMETER Version
    Specific version to install (e.g. "0.3.0"). Defaults to latest release.

.PARAMETER Prefix
    Installation root directory. Defaults to $env:LOCALAPPDATA\kmp-test-runner.

.EXAMPLE
    .\install.ps1

.EXAMPLE
    .\install.ps1 -Version 0.3.0

.NOTES
    Requires PowerShell 5.1 or later.
    Does NOT require administrator privileges.
#>
[CmdletBinding()]
param(
    [string]$Version      = "",
    [string]$Prefix       = "",
    [string]$LocalArchive = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Repo       = "oscardlfr/kmp-test-runner"
$Package    = "kmp-test-runner"
$BinName    = "kmp-test"

# --------------------------------------------------------------------------
# Usage / help is handled by standard PowerShell Get-Help
# --------------------------------------------------------------------------

# --------------------------------------------------------------------------
# Resolve install prefix
# --------------------------------------------------------------------------
if ([string]::IsNullOrEmpty($Prefix)) {
    $Prefix = Join-Path $env:LOCALAPPDATA $Package
}
$InstallDir = Join-Path $Prefix "lib"
$BinDir     = Join-Path $Prefix "bin"

# --------------------------------------------------------------------------
# Resolve version
# --------------------------------------------------------------------------
function Resolve-LatestVersion {
    # Primary: follow redirect URL — avoids 60/hr API rate limit
    $RedirectUrl = "https://github.com/$Repo/releases/latest"
    try {
        $Response = Invoke-WebRequest -Uri $RedirectUrl -UseBasicParsing -MaximumRedirection 0 -ErrorAction SilentlyContinue
        # 301/302 Location header contains the tag
        $Location = $Response.Headers["Location"]
        if (-not [string]::IsNullOrEmpty($Location)) {
            $Tag = Split-Path $Location -Leaf
            return $Tag.TrimStart("v")
        }
    }
    catch {
        # Redirect throws on non-2xx; extract from exception's Response
        $Ex = $_.Exception
        if ($null -ne $Ex.Response) {
            $Location = $Ex.Response.Headers["Location"]
            if (-not [string]::IsNullOrEmpty($Location)) {
                $Tag = Split-Path $Location -Leaf
                return $Tag.TrimStart("v")
            }
        }
    }

    # Fallback: GitHub REST API
    Write-Host "Redirect resolution failed; querying GitHub API..."
    $ApiUrl  = "https://api.github.com/repos/$Repo/releases/latest"
    $Release = Invoke-RestMethod -Uri $ApiUrl -UseBasicParsing
    $Tag     = $Release.tag_name
    return $Tag.TrimStart("v")
}

if ([string]::IsNullOrEmpty($Version)) {
    Write-Host "Resolving latest version..."
    $Version = Resolve-LatestVersion
}

Write-Host "Installing $Package v$Version (windows)..."

# --------------------------------------------------------------------------
# Download
# --------------------------------------------------------------------------
$ArchiveName   = "$Package-$Version-windows.zip"
$PrimaryUrl    = "https://github.com/$Repo/releases/latest/download/$ArchiveName"
$VersionedUrl  = "https://github.com/$Repo/releases/download/v$Version/$ArchiveName"

$TempDir     = [System.IO.Path]::GetTempPath()
$TempFolder  = Join-Path $TempDir ([System.IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Path $TempFolder | Out-Null
$ArchivePath = Join-Path $TempFolder $ArchiveName

function Download-Archive {
    param([string]$Url, [string]$Dest)
    Write-Host "Downloading from $Url ..."
    try {
        Invoke-WebRequest -Uri $Url -OutFile $Dest -UseBasicParsing
        return $true
    }
    catch {
        return $false
    }
}

if ($LocalArchive -ne "") {
    Copy-Item -Path $LocalArchive -Destination $ArchivePath
}
else {
    $Downloaded = Download-Archive -Url $PrimaryUrl -Dest $ArchivePath
    if (-not $Downloaded) {
        Write-Host "Primary URL failed, trying versioned URL..."
        $Downloaded = Download-Archive -Url $VersionedUrl -Dest $ArchivePath
    }
    if (-not $Downloaded) {
        Write-Error "Download failed. Check your network or try -Version."
        exit 1
    }
}

# --------------------------------------------------------------------------
# Extract and install
# --------------------------------------------------------------------------
if (-not (Test-Path $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir | Out-Null
}
if (-not (Test-Path $BinDir)) {
    New-Item -ItemType Directory -Path $BinDir | Out-Null
}

Write-Host "Extracting to $InstallDir ..."
Expand-Archive -LiteralPath $ArchivePath -DestinationPath $TempFolder -Force

# Move extracted contents (strip top-level dir if present)
$Extracted = Get-ChildItem -Path $TempFolder -Directory | Select-Object -First 1
if ($null -ne $Extracted) {
    $SourceDir = $Extracted.FullName
}
else {
    $SourceDir = $TempFolder
}

$Items = Get-ChildItem -Path $SourceDir
foreach ($Item in $Items) {
    $Dest = Join-Path $InstallDir $Item.Name
    if (Test-Path $Dest) {
        Remove-Item -Recurse -Force $Dest
    }
    Move-Item -Path $Item.FullName -Destination $Dest
}

# Create wrapper batch file in BinDir for kmp-test
$WrapperPath = Join-Path $BinDir "$BinName.cmd"
$NodeBin     = Join-Path $InstallDir "bin\$BinName.js"
$WrapperContent = "@echo off`r`nnode `"$NodeBin`" %*"
Set-Content -Path $WrapperPath -Value $WrapperContent -Encoding ASCII

# Clean up temp
Remove-Item -Recurse -Force $TempFolder -ErrorAction SilentlyContinue

# --------------------------------------------------------------------------
# PATH setup — HKCU only, never Machine
# --------------------------------------------------------------------------
$CurrentPath = [Environment]::GetEnvironmentVariable("PATH", "User")
if ([string]::IsNullOrEmpty($CurrentPath)) {
    $CurrentPath = ""
}

$PathParts = $CurrentPath -split ";"
$AlreadyInPath = $false
foreach ($Part in $PathParts) {
    if ($Part.TrimEnd("\") -eq $BinDir.TrimEnd("\")) {
        $AlreadyInPath = $true
        break
    }
}

if (-not $AlreadyInPath) {
    $NewPath = ($CurrentPath.TrimEnd(";") + ";" + $BinDir).TrimStart(";")
    [Environment]::SetEnvironmentVariable("PATH", $NewPath, "User")
    Write-Host "Added $BinDir to user PATH."
}
else {
    Write-Host "$BinDir is already in user PATH."
}

# Also update current session PATH so kmp-test is immediately usable
$env:PATH = $BinDir + ";" + $env:PATH

# --------------------------------------------------------------------------
# Done
# --------------------------------------------------------------------------
Write-Host ""
Write-Host "$Package v$Version installed successfully."
Write-Host "  Wrapper : $WrapperPath"
Write-Host "  Runtime : $InstallDir"
Write-Host ""
Write-Host "Restart your shell to pick up the PATH change, then verify with:"
Write-Host "  kmp-test --version"
