<#
.SYNOPSIS
    Install kmp-test-runner on Windows.

.DESCRIPTION
    Downloads the kmp-test-runner Windows zip from GitHub Releases, verifies its
    SHA-256 checksum, extracts it atomically to $env:LOCALAPPDATA\kmp-test-runner,
    and adds the bin directory to the current user's PATH (HKCU only - never
    machine-wide). Failed installs roll back previous components or remove empty
    directories created by this run.

.PARAMETER Version
    Specific version to install (e.g. "0.3.0"). Defaults to latest release.

.PARAMETER Prefix
    Installation root directory. Defaults to $env:LOCALAPPDATA\kmp-test-runner.

.PARAMETER LocalArchive
    Path to a local zip archive to install instead of downloading from GitHub.
    Checksum verification is skipped unless -LocalArchiveSha256 is also given.

.PARAMETER LocalArchiveSha256
    Path to a .sha256 file for offline checksum verification of the archive
    passed via -LocalArchive.

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
    [string]$Version             = "",
    [string]$Prefix              = "",
    [string]$LocalArchive        = "",
    [string]$LocalArchiveSha256  = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Repo       = "oscardlfr/kmp-test-runner"
$Package    = "kmp-test-runner"
$BinName    = "kmp-test"

# TLS 1.2 -- required for PS 5.1; -bor preserves any other already-enabled protocols.
[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor [System.Net.SecurityProtocolType]::Tls12

# --------------------------------------------------------------------------
# Usage / help is handled by standard PowerShell Get-Help
# --------------------------------------------------------------------------

# --------------------------------------------------------------------------
# Resolve install prefix
# --------------------------------------------------------------------------
if ([string]::IsNullOrEmpty($Prefix)) {
    $Prefix = Join-Path $env:LOCALAPPDATA $Package
}
$InstallDir  = Join-Path $Prefix "lib"
$BinDir      = Join-Path $Prefix "bin"
$WrapperPath = Join-Path $BinDir "$BinName.cmd"
$MarkerPath  = Join-Path $Prefix ".kmp-test-runner-install.json"

# Track whether prefix/bin existed before this run (used by rollback).
$PrefixExisted = Test-Path $Prefix
$BinDirExisted = Test-Path $BinDir

# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------

# Cross-version Location-header reader.
# - Windows PowerShell 5.1: $Response.Headers is a [Hashtable]/[WebHeaderCollection], indexer returns [string].
# - PowerShell 7+: $Response.Headers is [System.Net.Http.Headers.HttpResponseHeaders], which has no indexer
#   (throws "Unable to index into an object of type ..."). Use GetValues() and take the first element.
function Get-LocationHeader {
    param($Headers)
    if ($null -eq $Headers) { return $null }
    try {
        # Try the PS 5.1 indexer path first; if Headers is a Hashtable / WebHeaderCollection this returns
        # a [string]. If Headers is HttpResponseHeaders, the indexer either throws (caught below) or
        # returns [string[]] in some intermediate runtimes - we then collapse to the first value.
        $value = $Headers['Location']
        if ($value -is [System.Collections.IEnumerable] -and -not ($value -is [string])) {
            $value = ($value | Select-Object -First 1)
        }
        if (-not [string]::IsNullOrEmpty($value)) { return [string]$value }
    } catch {
        # PS 7 fallthrough below.
    }
    # PS 7 path: HttpResponseHeaders exposes GetValues(name) returning IEnumerable<string>.
    if ($Headers.GetType().GetMethod('GetValues') -and $Headers.Contains('Location')) {
        $values = $Headers.GetValues('Location')
        $first  = $values | Select-Object -First 1
        if (-not [string]::IsNullOrEmpty($first)) { return [string]$first }
    }
    # HttpResponseHeaders also exposes a typed Location property of [Uri].
    if ($Headers.PSObject.Properties.Name -contains 'Location' -and $null -ne $Headers.Location) {
        return $Headers.Location.ToString()
    }
    return $null
}

function Get-Sha256Hash {
    param([string]$FilePath)
    return (Get-FileHash -LiteralPath $FilePath -Algorithm SHA256).Hash.ToLower()
}

function Test-Checksum {
    param([string]$ArchivePath, [string]$ChecksumFile)
    $raw = (Get-Content -LiteralPath $ChecksumFile -Raw -Encoding UTF8).Trim()
    if ([string]::IsNullOrEmpty($raw)) {
        Write-Error "Malformed checksum file -- file is empty."
        exit 1
    }
    $expected = ($raw -split '\s+')[0].ToLower()
    if ($expected -notmatch '^[0-9a-f]{64}$') {
        Write-Error "Malformed checksum file -- expected a 64-character hex hash, got: $expected"
        exit 1
    }
    $actual = Get-Sha256Hash $ArchivePath
    if ($actual -ne $expected) {
        Write-Error ("Checksum mismatch. The archive may be corrupt or tampered with.`n" +
                     "  Expected: $expected`n  Got: $actual`nTry re-running the installer.")
        exit 1
    }
    Write-Host "Checksum verified."
}

function Test-Layout {
    param([string]$Dir)
    if (-not (Test-Path (Join-Path $Dir "bin\kmp-test.js"))) {
        Write-Error "Archive layout invalid -- missing required file: bin\kmp-test.js"
        return $false
    }
    if (-not (Test-Path (Join-Path $Dir "package.json"))) {
        Write-Error "Archive layout invalid -- missing required file: package.json"
        return $false
    }
    try {
        $pkg = Get-Content (Join-Path $Dir "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($pkg.name -ne "kmp-test-runner") {
            Write-Error "Archive layout invalid -- package.json name must be 'kmp-test-runner', got '$($pkg.name)'."
            return $false
        }
    } catch {
        Write-Error "Archive layout invalid -- cannot parse package.json: $_"
        return $false
    }
    return $true
}

function Resolve-LatestVersion {
    # Primary: follow redirect URL - avoids 60/hr API rate limit
    $RedirectUrl = "https://github.com/$Repo/releases/latest"
    try {
        $Response = Invoke-WebRequest -Uri $RedirectUrl -UseBasicParsing -MaximumRedirection 0 -ErrorAction SilentlyContinue
        $Location = Get-LocationHeader $Response.Headers
        if (-not [string]::IsNullOrEmpty($Location)) {
            $Tag = Split-Path $Location -Leaf
            return $Tag.TrimStart("v")
        }
    }
    catch {
        # Redirect throws on non-2xx; extract from exception's Response
        $Ex = $_.Exception
        if ($null -ne $Ex.Response) {
            $Location = Get-LocationHeader $Ex.Response.Headers
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

# --------------------------------------------------------------------------
# Resolve version
# --------------------------------------------------------------------------
if ([string]::IsNullOrEmpty($Version)) {
    Write-Host "Resolving latest version..."
    $Version = Resolve-LatestVersion
}

Write-Host "Installing $Package v$Version (windows)..."

# --------------------------------------------------------------------------
# Atomic install -- nullable tracking vars set before try; commit flags track
# which components this run has written so rollback is precise.
# --------------------------------------------------------------------------
$TempFolder        = $null
$OldInstallBackup  = $null
$OldLauncherBackup = $null
$OldMarkerBackup   = $null
$StagingCommitted  = $false
$LauncherCommitted = $false
$InstallComplete   = $false

try {
    $TempFolder  = Join-Path ([System.IO.Path]::GetTempPath()) ([System.IO.Path]::GetRandomFileName())
    New-Item -ItemType Directory -Path $TempFolder | Out-Null

    $ArchiveName = "$Package-$Version-windows.zip"
    $ArchivePath = Join-Path $TempFolder $ArchiveName

    # --- Download / copy archive ---
    if (-not [string]::IsNullOrEmpty($LocalArchive)) {
        Copy-Item -Path $LocalArchive -Destination $ArchivePath
    } else {
        $PrimaryUrl   = "https://github.com/$Repo/releases/latest/download/$ArchiveName"
        $VersionedUrl = "https://github.com/$Repo/releases/download/v$Version/$ArchiveName"

        $Downloaded = $false
        foreach ($Url in @($PrimaryUrl, $VersionedUrl)) {
            Write-Host "Downloading from $Url ..."
            try {
                Invoke-WebRequest -Uri $Url -OutFile $ArchivePath -UseBasicParsing
                $Downloaded = $true
                break
            } catch {
                Write-Host "URL failed, trying next..."
            }
        }
        if (-not $Downloaded) {
            Write-Error "Download failed. Check your network or try -Version."
            exit 1
        }
    }

    # --- Checksum verification ---
    $ChecksumName = "$ArchiveName.sha256"
    $ChecksumPath = Join-Path $TempFolder $ChecksumName

    if ([string]::IsNullOrEmpty($LocalArchive)) {
        Write-Host "Downloading checksum..."
        $csOk = $false
        foreach ($Url in @(
            "https://github.com/$Repo/releases/latest/download/$ChecksumName",
            "https://github.com/$Repo/releases/download/v$Version/$ChecksumName"
        )) {
            try {
                Invoke-WebRequest -Uri $Url -OutFile $ChecksumPath -UseBasicParsing
                $csOk = $true
                break
            } catch { }
        }
        if (-not $csOk) {
            Write-Error "Could not download checksum file. Refusing to install without verification."
            exit 1
        }
        Test-Checksum -ArchivePath $ArchivePath -ChecksumFile $ChecksumPath
    } elseif (-not [string]::IsNullOrEmpty($LocalArchiveSha256)) {
        Test-Checksum -ArchivePath $ArchivePath -ChecksumFile $LocalArchiveSha256
    }
    # Local archive with no -LocalArchiveSha256: skip verification (documented).

    # --- Extract to staging, validate layout ---
    $StagingDir = Join-Path $TempFolder "staging"
    New-Item -ItemType Directory -Path $StagingDir | Out-Null
    Expand-Archive -LiteralPath $ArchivePath -DestinationPath $StagingDir -Force
    $Extracted  = Get-ChildItem -Path $StagingDir -Directory | Select-Object -First 1
    $SourceDir  = if ($null -ne $Extracted) { $Extracted.FullName } else { $StagingDir }
    if (-not (Test-Layout $SourceDir)) { exit 1 }

    # --- Back up existing components before any modification (upgrade case) ---
    if (-not (Test-Path $BinDir)) {
        New-Item -ItemType Directory -Path $BinDir | Out-Null
    }
    if (Test-Path $InstallDir) {
        $OldInstallBackup = Join-Path $TempFolder "old_lib"
        Move-Item -LiteralPath $InstallDir -Destination $OldInstallBackup
    }
    if (Test-Path $WrapperPath) {
        $OldLauncherBackup = Join-Path $TempFolder "old_launcher.cmd"
        Copy-Item -LiteralPath $WrapperPath -Destination $OldLauncherBackup
    }
    if (Test-Path $MarkerPath) {
        $OldMarkerBackup = Join-Path $TempFolder "old_marker.json"
        Move-Item -LiteralPath $MarkerPath -Destination $OldMarkerBackup
    }

    # --- Commit: lib ---
    Write-Host "Installing to $InstallDir ..."
    Move-Item -LiteralPath $SourceDir -Destination $InstallDir
    $StagingCommitted = $true

    # --- Commit: launcher ---
    $NodeBin        = Join-Path $InstallDir "bin\$BinName.js"
    $WrapperContent = "@echo off`r`nnode `"$NodeBin`" %*"
    Set-Content -Path $WrapperPath -Value $WrapperContent -Encoding ASCII
    $LauncherCommitted = $true

    # --- Commit: marker (staged move = final commit point) ---
    $StagedMarker  = Join-Path $TempFolder ".kmp-test-runner-install.json"
    $MarkerContent = '{"tool":"kmp-test-runner","schema":1,"version":"' + $Version + '"}'
    Set-Content -Path $StagedMarker -Value $MarkerContent -Encoding UTF8
    Move-Item -LiteralPath $StagedMarker -Destination $MarkerPath

    $InstallComplete = $true

} finally {
    if (-not $InstallComplete) {
        Write-Host "Install failed -- rolling back..." -ForegroundColor Yellow
        # Only remove components that this run actually wrote; never remove
        # pre-existing files when a failure occurred before any backup was taken.
        if ($StagingCommitted) {
            Remove-Item -Recurse -Force $InstallDir -ErrorAction SilentlyContinue
        }
        if ($LauncherCommitted) {
            Remove-Item -Force $WrapperPath -ErrorAction SilentlyContinue
        }
        # Restore previous components (upgrade case).
        if ($null -ne $OldInstallBackup -and (Test-Path $OldInstallBackup)) {
            Move-Item -LiteralPath $OldInstallBackup -Destination $InstallDir -ErrorAction SilentlyContinue
        }
        if ($null -ne $OldLauncherBackup -and (Test-Path $OldLauncherBackup)) {
            Move-Item -LiteralPath $OldLauncherBackup -Destination $WrapperPath -ErrorAction SilentlyContinue
        }
        if ($null -ne $OldMarkerBackup -and (Test-Path $OldMarkerBackup)) {
            Move-Item -LiteralPath $OldMarkerBackup -Destination $MarkerPath -ErrorAction SilentlyContinue
        }
        # Remove empty dirs created by this installer (no -Recurse = safe on non-empty dirs).
        if (-not $BinDirExisted) {
            Remove-Item -Path $BinDir -ErrorAction SilentlyContinue
        }
        if (-not $PrefixExisted) {
            Remove-Item -Path $Prefix -ErrorAction SilentlyContinue
        }
    }
    if ($null -ne $TempFolder -and (Test-Path $TempFolder)) {
        Remove-Item -Recurse -Force $TempFolder -ErrorAction SilentlyContinue
    }
}

# --------------------------------------------------------------------------
# PATH setup - HKCU only, never Machine
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

# Also update current session PATH so kmp-test is immediately usable.
$env:PATH = $BinDir + ";" + $env:PATH

# --------------------------------------------------------------------------
# Done - Bug D fix (v0.5.0): old message said "Restart your shell to pick
# up the PATH change" without acknowledging that this session is already
# usable. Make the distinction explicit so users don't waste a shell
# restart they don't need.
# --------------------------------------------------------------------------
Write-Host ""
Write-Host "$Package v$Version installed successfully."
Write-Host "  Wrapper : $WrapperPath"
Write-Host "  Runtime : $InstallDir"
Write-Host ""
Write-Host "kmp-test is ready in this PowerShell session - verify with:"
Write-Host "  kmp-test --version"
Write-Host ""
Write-Host "New PowerShell / cmd.exe sessions pick up the user PATH automatically."
Write-Host "If you ran this from cmd.exe, restart cmd to refresh its PATH."
