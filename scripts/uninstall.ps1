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
$BinDir = Join-Path $Prefix "bin"

# --------------------------------------------------------------------------
# Verify installed
# --------------------------------------------------------------------------
if (-not (Test-Path $Prefix)) {
    Write-Error "$Package does not appear to be installed at $Prefix"
    exit 1
}

Write-Host "Removing $Package from $Prefix ..."

# --------------------------------------------------------------------------
# Remove installation directory
# --------------------------------------------------------------------------
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
