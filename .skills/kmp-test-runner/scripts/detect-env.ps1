<#
.SYNOPSIS
    Detect whether Google's `android` CLI is available + reachable.

.DESCRIPTION
    Prints HAS_ANDROID_CLI to stdout when the binary is on PATH AND
    `android info` succeeds; NO_ANDROID_CLI otherwise. Exits 0 either way —
    the value is the signal, not the exit code (so callers can branch on
    stdout without retry logic or special-casing exit codes).

    Used by run-tests.ps1 as an env preamble and by SKILL.md workflows that
    branch on the enriched-vs-fallback instrumented test surface.

.EXAMPLE
    pwsh .skills/kmp-test-runner/scripts/detect-env.ps1
    # → exits 0; prints HAS_ANDROID_CLI or NO_ANDROID_CLI to stdout
#>
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$cmd = Get-Command android -ErrorAction SilentlyContinue
if ($cmd) {
    # Pipe `android info` stdout+stderr to $null. $LASTEXITCODE reflects the
    # final exit; SilentlyContinue suppresses the non-terminating error stream
    # that Get-Command would emit on missing-binary.
    & $cmd.Source info *>$null
    if ($LASTEXITCODE -eq 0) {
        Write-Output 'HAS_ANDROID_CLI'
        exit 0
    }
}
Write-Output 'NO_ANDROID_CLI'
exit 0
