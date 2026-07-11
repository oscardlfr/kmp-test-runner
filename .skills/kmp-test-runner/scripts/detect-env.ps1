<#
.SYNOPSIS
    Detect whether Google's `android` CLI is available + reachable.

.DESCRIPTION
    Exports Get-KmpAndroidCliStatus, which returns HAS_ANDROID_CLI when the
    binary is on PATH AND `android info` succeeds; NO_ANDROID_CLI otherwise.

    When executed directly (not dot-sourced), prints the result to stdout and
    exits 0 -- the value is the signal, not the exit code (so callers can
    branch on stdout without retry logic or special-casing exit codes).

    When dot-sourced, only defines the function. Callers can then invoke
    Get-KmpAndroidCliStatus without spawning a subprocess.

    Used by run-tests.ps1 as an env preamble and by SKILL.md workflows that
    branch on the enriched-vs-fallback instrumented test surface.

.EXAMPLE
    pwsh .skills/kmp-test-runner/scripts/detect-env.ps1
    # exits 0; prints HAS_ANDROID_CLI or NO_ANDROID_CLI to stdout

.EXAMPLE
    . .skills/kmp-test-runner/scripts/detect-env.ps1
    Get-KmpAndroidCliStatus   # returns the sentinel without calling exit
#>
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-KmpAndroidCliStatus {
    $cmd = Get-Command android -ErrorAction SilentlyContinue
    if ($cmd) {
        # Pipe `android info` stdout+stderr to $null. $LASTEXITCODE reflects
        # the final exit; SilentlyContinue suppresses the non-terminating error
        # stream that Get-Command would emit on missing-binary.
        & $cmd.Source info *>$null
        if ($LASTEXITCODE -eq 0) { return 'HAS_ANDROID_CLI' }
    }
    return 'NO_ANDROID_CLI'
}

# Thin standalone wrapper -- only runs when executed directly, not dot-sourced.
# $MyInvocation.InvocationName is '.' when dot-sourced; the script path otherwise.
if ($MyInvocation.InvocationName -ne '.') {
    Write-Output (Get-KmpAndroidCliStatus)
    exit 0
}
